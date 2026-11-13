// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto'
import { and, eq, gt, ne, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import type { LiveKit } from '../infra/livekit.ts'
import {
  allocations,
  allocationTombstones,
  clientGenerationUsage,
  clients,
  eventRetention,
  events,
  participantTokens,
  receivedWebhooks,
} from '../infra/schema.ts'
import { type Store, typedAllocation } from '../infra/store.ts'
import { calculateCapacity } from './capacity.ts'
import { ownsRoom, parseTokenMetadata, roomName } from './room.ts'
import { type Allocation, type IceServer, LEASE_MS, RelayError, type ScreenShareLimits, type Snapshot } from './types.ts'

function identityHash(identity: string): string {
  return createHash('sha256').update(identity).digest('hex')
}

export class Provider {
  private participantCounts = new Map<string, Promise<number>>()
  public store: Store
  public livekit: LiveKit
  public limits: {
    maxSlots: number
    maxRooms: number
    screenShareLimits?: ScreenShareLimits
    mediaProvider: string
    iceServers: IceServer[] | null
    getIceServers?: () => Promise<IceServer[] | null>
    reconcileOrphans?: boolean
  }

  constructor(store: Store, livekit: LiveKit, limits: Provider['limits']) {
    this.store = store
    this.livekit = livekit
    this.limits = limits
  }

  async active(clientId: string) {
    const c = await this.store.client(clientId)
    if (!c.enabled) throw new RelayError('CLIENT_DISABLED', 403)
    return c
  }

  async allocation(clientId: string, id: string) {
    return this.store.get(clientId, id)
  }

  async usable(clientId: string, id: string) {
    await this.active(clientId)
    const a = await this.allocation(clientId, id)
    if (a.state !== 'active' || Date.parse(a.leaseExpiresAt) <= Date.now()) throw new RelayError('ALLOCATION_CONFLICT', 409)
    return a
  }

  private participantCount(a: Allocation): Promise<number> {
    const existing = this.participantCounts.get(a.id)
    if (existing) return existing
    const pending = this.livekit.participants(a).then((list) => list.length)
    this.participantCounts.set(a.id, pending)
    void pending.then(
      () => {
        const timer = setTimeout(() => this.participantCounts.delete(a.id), 2000)
        timer.unref()
      },
      () => this.participantCounts.delete(a.id),
    )
    return pending
  }

  async capacity(clientId: string) {
    const c = await this.store.client(clientId)
    const [own] = await this.store.db
      .select({ slots: sql<number>`coalesce(sum(${allocations.slots}),0)::bigint`.mapWith(Number), rooms: sql<number>`count(*)::int` })
      .from(allocations)
      .where(and(eq(allocations.clientId, clientId), ne(allocations.state, 'ended')))
    const [global] = await this.store.db
      .select({ slots: sql<number>`coalesce(sum(${allocations.slots}),0)::bigint`.mapWith(Number), rooms: sql<number>`count(*)::int` })
      .from(allocations)
      .where(ne(allocations.state, 'ended'))
    const ownRooms = await this.store.db
      .select()
      .from(allocations)
      .where(and(eq(allocations.clientId, clientId), eq(allocations.state, 'active')))
    const counts = await Promise.all(ownRooms.map((row) => this.participantCount(typedAllocation(row))))
    const capacity = calculateCapacity(
      { enabled: c.enabled, maxSlots: c.maxSlots, maxRooms: c.maxRooms, usedSlots: own.slots, usedRooms: own.rooms },
      { maxSlots: this.limits.maxSlots, maxRooms: this.limits.maxRooms, usedSlots: global.slots, usedRooms: global.rooms },
    )
    return {
      protocolVersion: 1 as const,
      capabilities: { cancelPending: true as const, includeIceServers: true as const, recordingStatus: true as const },
      activeParticipants: counts.reduce((total, count) => total + count, 0),
      enabled: c.enabled,
      accepting: capacity.accepting,
      maxSlots: c.maxSlots,
      reservedSlots: own.slots,
      remainingSlots: capacity.remainingSlots,
      remainingRooms: capacity.remainingRooms,
      allowScreenShare: c.allowScreenShare,
      ...(this.limits.screenShareLimits ? { screenShareLimits: this.limits.screenShareLimits } : {}),
      mediaProvider: this.limits.mediaProvider,
    }
  }

  async lookup(clientId: string, roomKey: string, generation: string): Promise<Allocation> {
    const [row] = await this.store.db
      .select()
      .from(allocations)
      .where(and(eq(allocations.clientId, clientId), eq(allocations.roomKey, roomKey), eq(allocations.generation, generation)))
    if (!row) throw new RelayError('NOT_FOUND', 404)
    return typedAllocation(row)
  }

  private async chargeGeneration(db: PoolClient, clientId: string, roomKey: string, generation: string) {
    const bytes = Buffer.byteLength(roomKey, 'utf8') + Buffer.byteLength(generation, 'utf8')
    const result = await drizzle(db)
      .insert(clientGenerationUsage)
      .values({ clientId, generations: 1, bytes })
      .onConflictDoUpdate({
        target: clientGenerationUsage.clientId,
        set: { generations: sql`${clientGenerationUsage.generations}+1`, bytes: sql`${clientGenerationUsage.bytes}+excluded.bytes` },
        setWhere: sql`${clientGenerationUsage.generations}<100000 AND ${clientGenerationUsage.bytes}+excluded.bytes<=16777216`,
      })
      .returning({ clientId: clientGenerationUsage.clientId })
    if (!result.length) throw new RelayError('CAPACITY_EXCEEDED', 429)
  }

  async allocate(clientId: string, p: { roomKey: string; generation: string; slots: number }): Promise<Allocation> {
    return this.store.lifecycle(() => this.allocateReserved(clientId, p))
  }

  private async allocateReserved(clientId: string, p: { roomKey: string; generation: string; slots: number }): Promise<Allocation> {
    await this.active(clientId)
    if (
      !p.roomKey ||
      Array.from(p.roomKey).length > 2048 ||
      !p.generation ||
      Array.from(p.generation).length > 128 ||
      !Number.isSafeInteger(p.slots) ||
      p.slots < 1
    )
      throw new RelayError('INVALID_REQUEST', 400)
    const reserved = await this.store.tx(async (db) => {
      const orm = drizzle(db)
      const key = and(eq(allocations.clientId, clientId), eq(allocations.roomKey, p.roomKey), eq(allocations.generation, p.generation))
      const cancelled = await orm
        .select({ id: allocationTombstones.id })
        .from(allocationTombstones)
        .where(
          and(
            eq(allocationTombstones.clientId, clientId),
            eq(allocationTombstones.roomKey, p.roomKey),
            eq(allocationTombstones.generation, p.generation),
          ),
        )
        .limit(1)
      if (cancelled.length) throw new RelayError('ALLOCATION_CONFLICT', 409)
      const [existing] = await orm.select().from(allocations).where(key).limit(1)
      if (existing) {
        if (existing.slots !== p.slots) throw new RelayError('ALLOCATION_CONFLICT', 409)
        return typedAllocation(existing)
      }
      const current = await orm
        .select({ id: allocations.id })
        .from(allocations)
        .where(and(eq(allocations.clientId, clientId), eq(allocations.roomKey, p.roomKey), ne(allocations.state, 'ended')))
        .limit(1)
      if (current.length) throw new RelayError('ALLOCATION_CONFLICT', 409)
      const totals = {
        slots: sql<number>`coalesce(sum(${allocations.slots}),0)::bigint`.mapWith(Number),
        rooms: sql<number>`count(*)::int`,
      }
      const [capacity] = await orm.select(totals).from(allocations).where(ne(allocations.state, 'ended'))
      const [own] = await orm
        .select(totals)
        .from(allocations)
        .where(and(ne(allocations.state, 'ended'), eq(allocations.clientId, clientId)))
      const [c] = await orm.select().from(clients).where(eq(clients.id, clientId))
      if (!c?.enabled) throw new RelayError('CLIENT_DISABLED', 403)
      const available = calculateCapacity(
        { enabled: c.enabled, maxSlots: c.maxSlots, maxRooms: c.maxRooms, usedSlots: own.slots, usedRooms: own.rooms },
        { maxSlots: this.limits.maxSlots, maxRooms: this.limits.maxRooms, usedSlots: capacity.slots, usedRooms: capacity.rooms },
      )
      if (!available.accepting || p.slots > available.remainingSlots) throw new RelayError('CAPACITY_EXCEEDED', 429)
      await this.chargeGeneration(db, clientId, p.roomKey, p.generation)
      const [row] = await orm
        .insert(allocations)
        .values({
          id: randomUUID(),
          clientId,
          roomKey: p.roomKey,
          generation: p.generation,
          mediaProvider: this.limits.mediaProvider,
          slots: p.slots,
          state: 'pending',
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          emptySince: sql`now()`,
        })
        .returning()
      return typedAllocation(row)
    })
    return this.store.serialized(reserved.id, async () => {
      const a = await this.allocation(clientId, reserved.id)
      if (a.state !== 'pending') return a
      await this.active(clientId)
      const started = await this.store.db
        .update(allocations)
        .set({ creationInflight: true })
        .where(and(eq(allocations.id, a.id), eq(allocations.state, 'pending'), eq(allocations.creationInflight, false)))
        .returning({ id: allocations.id })
      if (!started.length) throw new RelayError('PROVIDER_UNAVAILABLE', 503)
      let confirmed = false
      try {
        await this.livekit.ensure(a, await this.store.installationId())
        confirmed = true
        return await this.store.tx(async (db) => {
          const [row] = await drizzle(db)
            .update(allocations)
            .set({ state: 'active', creationInflight: false })
            .where(and(eq(allocations.id, a.id), eq(allocations.state, 'pending')))
            .returning()
          const result = typedAllocation(row)
          await this.store.event(db, result, 'allocated')
          return result
        })
      } finally {
        if (confirmed) await drizzle(this.store.pool).update(allocations).set({ creationInflight: false }).where(eq(allocations.id, a.id))
      }
    })
  }

  async cancel(clientId: string, p: { roomKey: string; generation: string }) {
    await this.store.client(clientId)
    const id = await this.store.tx(async (db) => {
      const orm = drizzle(db)
      const [existing] = await orm
        .select({ id: allocations.id })
        .from(allocations)
        .where(and(eq(allocations.clientId, clientId), eq(allocations.roomKey, p.roomKey), eq(allocations.generation, p.generation)))
        .limit(1)
      const tombstone = await orm
        .select({ id: allocationTombstones.id })
        .from(allocationTombstones)
        .where(
          and(
            eq(allocationTombstones.clientId, clientId),
            eq(allocationTombstones.roomKey, p.roomKey),
            eq(allocationTombstones.generation, p.generation),
          ),
        )
        .limit(1)
      if (!tombstone.length) {
        if (!existing) await this.chargeGeneration(db, clientId, p.roomKey, p.generation)
        await orm.insert(allocationTombstones).values({ clientId, roomKey: p.roomKey, generation: p.generation })
      }
      return existing?.id
    })
    if (id) {
      try {
        await this.end(clientId, id)
      } catch {
        throw new RelayError('PROVIDER_UNAVAILABLE', 503)
      }
    }
    return { state: 'ended' as const }
  }

  async join(
    clientId: string,
    id: string,
    p: { identity: string; userId: string; allowScreenShare: boolean; includeIceServers?: boolean },
  ) {
    return this.store.serialized(id, async () => {
      const a = await this.usable(clientId, id)
      const c = await this.active(clientId)
      const hash = identityHash(p.identity)
      let [tokenState] = await this.store.db
        .select({ generation: participantTokens.generation })
        .from(participantTokens)
        .where(and(eq(participantTokens.allocationId, id), eq(participantTokens.identityHash, hash)))
      if (!tokenState) {
        const [usage] = await this.store.db
          .select({ count: sql<number>`count(*)::int` })
          .from(participantTokens)
          .where(eq(participantTokens.allocationId, id))
        if (usage.count >= a.reservedSlots * 32) throw new RelayError('CAPACITY_EXCEEDED', 429)
        ;[tokenState] = await this.store.db
          .insert(participantTokens)
          .values({ allocationId: id, identityHash: hash, generation: randomUUID() })
          .returning({ generation: participantTokens.generation })
      }
      const [stored] = await this.store.db
        .select({ mediaProvider: allocations.mediaProvider })
        .from(allocations)
        .where(eq(allocations.id, id))
      return {
        token: await this.livekit.token(a, {
          ...p,
          tokenGeneration: tokenState.generation,
          allowScreenShare: p.allowScreenShare && c.allowScreenShare,
        }),
        allocationId: id,
        generation: a.generation,
        iceServers:
          p.includeIceServers === false ? null : this.limits.getIceServers ? await this.limits.getIceServers() : this.limits.iceServers,
        mediaProvider: stored?.mediaProvider ?? this.limits.mediaProvider,
        ...(this.limits.screenShareLimits ? { screenShareLimits: this.limits.screenShareLimits } : {}),
      }
    })
  }

  async inspect(clientId: string, token: string) {
    let claims: Awaited<ReturnType<LiveKit['verify']>>
    try {
      claims = await this.livekit.verify(token)
    } catch {
      throw new RelayError('FORBIDDEN', 403)
    }
    const m = parseTokenMetadata(claims.metadata ?? '')
    if (!m || m.clientId !== clientId || !claims.sub) throw new RelayError('FORBIDDEN', 403)
    const a = await this.usable(clientId, m.allocationId)
    if (claims.video?.room !== roomName(a) || m.generation !== a.generation || claims.video.roomJoin !== true)
      throw new RelayError('FORBIDDEN', 403)
    const [tokenState] = await this.store.db
      .select({ generation: participantTokens.generation })
      .from(participantTokens)
      .where(and(eq(participantTokens.allocationId, a.id), eq(participantTokens.identityHash, identityHash(claims.sub))))
    if (!tokenState || tokenState.generation !== m.tokenGeneration) throw new RelayError('FORBIDDEN', 403)
    return {
      allocationId: a.id,
      generation: a.generation,
      expiresAt: claims.exp,
      identity: claims.sub,
    }
  }

  async snapshot(clientId: string, id: string): Promise<Snapshot> {
    // 참가자 조회 전에 배정과 녹음 상태, revision을 같은 DB 경계에서 읽습니다.
    const [result] = await this.store.db
      .select({
        allocation: allocations,
        recordings: sql<{ identityHash: string; sessionId: string; recording: boolean }[]>`
          coalesce(json_agg(json_build_object(
            'identityHash', ${participantTokens.identityHash},
            'sessionId', ${participantTokens.recordingSessionId},
            'recording', ${participantTokens.recording}
          )) filter (where ${participantTokens.recordingSessionId} is not null), '[]'::json)
        `,
      })
      .from(allocations)
      .leftJoin(participantTokens, eq(participantTokens.allocationId, allocations.id))
      .where(and(eq(allocations.id, id), eq(allocations.clientId, clientId)))
      .groupBy(allocations.id)
    if (!result) throw new RelayError('NOT_FOUND', 404)
    const a = typedAllocation(result.allocation)
    const recording = new Map(result.recordings.map((state) => [state.identityHash, state]))
    const participants = a.state === 'ended' ? [] : await this.livekit.participants(a)
    for (const participant of participants) {
      const state = recording.get(identityHash(participant.identity))
      participant.recording = state?.sessionId === participant.sessionId && state.recording
    }
    return {
      allocationId: id,
      generation: a.generation,
      state: a.state,
      participants,
      revision: String(result.allocation.revision),
    }
  }

  async renew(clientId: string, id: string) {
    return this.store.serialized(id, async () => {
      await this.active(clientId)
      return this.store.tx(async (db) => {
        const [row] = await drizzle(db)
          .update(allocations)
          .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
          .where(
            and(
              eq(allocations.id, id),
              eq(allocations.clientId, clientId),
              eq(allocations.state, 'active'),
              sql`${allocations.leaseExpiresAt}>now()`,
            ),
          )
          .returning()
        if (!row) throw new RelayError('ALLOCATION_CONFLICT', 409)
        return typedAllocation(row)
      })
    })
  }

  async end(clientId: string, id: string) {
    return this.store.serialized(id, async () => {
      const a = await this.allocation(clientId, id)
      const [inFlight] = await this.store.db
        .select({ creationInflight: allocations.creationInflight })
        .from(allocations)
        .where(and(eq(allocations.id, id), eq(allocations.clientId, clientId)))
      if (inFlight.creationInflight) throw new RelayError('PROVIDER_UNAVAILABLE', 503)
      if (a.state === 'ended') return a
      await this.store.db.update(allocations).set({ state: 'ending' }).where(eq(allocations.id, id))
      await this.livekit.remove(a, await this.store.installationId())
      return this.store.tx(async (db) => {
        const [row] = await drizzle(db).update(allocations).set({ state: 'ended' }).where(eq(allocations.id, id)).returning()
        const result = typedAllocation(row)
        await this.store.event(db, result, 'ended')
        await drizzle(db).delete(participantTokens).where(eq(participantTokens.allocationId, id))
        return result
      })
    })
  }

  async participant(
    clientId: string,
    id: string,
    action: string,
    p: { identity: string; sessionId?: string; micMuted?: boolean; deafened?: boolean; recording?: boolean; allowScreenShare?: boolean },
  ) {
    return this.store.serialized(id, async () => {
      const a = await this.usable(clientId, id)
      if (action === 'kick' || (action === 'permissions' && p.allowScreenShare === false)) {
        await this.store.db
          .update(participantTokens)
          .set({ generation: randomUUID() })
          .where(and(eq(participantTokens.allocationId, id), eq(participantTokens.identityHash, identityHash(p.identity))))
      }
      const name = roomName(a)
      const service = this.livekit.client
      try {
        if (action === 'kick') {
          await this.livekit.request(() => service.removeParticipant(name, p.identity), true)
        } else if (action === 'status') {
          if (!(await this.livekit.updateStatus(a, p))) return { accepted: false }
        } else if (action === 'mute') {
          const participant = (await this.livekit.participants(a)).find((x) => x.identity === p.identity)
          const micTrackSid = participant?.micTrackSid
          if (!micTrackSid) return { accepted: false }
          await this.livekit.request(() => service.mutePublishedTrack(name, p.identity, micTrackSid, true), true)
        } else if (action === 'permissions') {
          const c = await this.active(clientId)
          await this.livekit.request(
            () =>
              service.updateParticipant(name, p.identity, {
                permission: {
                  canPublish: true,
                  canSubscribe: true,
                  canPublishData: false,
                  canPublishSources: p.allowScreenShare && c.allowScreenShare ? [2, 3, 4] : [2],
                },
              }),
            true,
          )
        } else throw new RelayError('NOT_FOUND', 404)
      } catch (error) {
        if (this.livekit.isMissing(error)) return { accepted: false }
        throw error
      }
      await this.store.tx(async (db) => {
        if (action === 'status' && p.recording !== undefined && p.sessionId !== undefined) {
          const updated = await drizzle(db)
            .update(participantTokens)
            .set({ recordingSessionId: p.sessionId, recording: p.recording })
            .where(and(eq(participantTokens.allocationId, id), eq(participantTokens.identityHash, identityHash(p.identity))))
            .returning({ identityHash: participantTokens.identityHash })
          if (updated.length !== 1) throw new RelayError('PROVIDER_UNAVAILABLE', 503)
        }
        await this.store.event(db, a, 'participant')
      })
      return { accepted: true }
    })
  }

  async events(clientId: string, cursor?: string) {
    let after = '0'
    if (cursor) {
      const parts = cursor.split(':')
      const [tenant, id] = parts
      if (parts.length !== 2 || tenant !== clientId || !/^\d+$/.test(id ?? '')) throw new RelayError('FORBIDDEN', 403)
      if (id.length > 19 || BigInt(id) > 9223372036854775807n) throw new RelayError('INVALID_REQUEST', 400)
      after = id
    }
    const [bounds] = await this.store.db
      .select({ latest: sql<string | null>`max(${events.id})` })
      .from(events)
      .where(eq(events.clientId, clientId))
    const rows = await this.store.db
      .select()
      .from(events)
      .where(and(eq(events.clientId, clientId), gt(events.id, BigInt(after))))
      .orderBy(events.id)
      .limit(100)
    const [watermark] = await this.store.db
      .select({ prunedThrough: eventRetention.prunedThrough })
      .from(eventRetention)
      .where(eq(eventRetention.clientId, clientId))
    return {
      events: rows.map((r) => ({
        id: String(r.id),
        allocationId: r.allocationId,
        generation: r.generation,
        type: r.type,
        revision: String(r.id),
      })),
      cursor: `${clientId}:${rows.at(-1)?.id ?? (cursor == null ? (bounds.latest ?? after) : after)}`,
      gap: cursor != null && watermark != null && BigInt(after) <= watermark.prunedThrough,
    }
  }

  async webhook(body: string, auth?: string) {
    let event: Awaited<ReturnType<LiveKit['webhook']>>
    try {
      event = await this.livekit.webhook(body, auth)
    } catch {
      throw new RelayError('FORBIDDEN', 403)
    }
    const room = event.room?.name
    if (!room?.startsWith('voice-relay:')) return
    const [row] = await this.store.db
      .select()
      .from(allocations)
      .where(eq(allocations.id, room.split(':')[2]))
    if (!row) return
    const a = typedAllocation(row)
    if (room !== roomName(a) || (a.state === 'ended' && event.event !== 'room_finished')) return
    if (event.event === 'room_finished') await this.end(a.clientId, a.id)
    await this.store.tx(async (db) => {
      const inserted = await drizzle(db)
        .insert(receivedWebhooks)
        .values({ id: event.id })
        .onConflictDoNothing()
        .returning({ id: receivedWebhooks.id })
      if (!inserted.length) return
      await this.store.event(db, a, event.event)
    })
  }

  async sweep(retention = true) {
    if (retention) await this.prune()
    const rows = await this.store.db
      .select({ id: allocations.id, clientId: allocations.clientId })
      .from(allocations)
      .where(ne(allocations.state, 'ended'))
    for (const row of rows) {
      try {
        await this.store.serialized(row.id, async () => {
          const a = await this.allocation(row.clientId, row.id)
          const c = await this.store.client(a.clientId)
          if (a.state === 'ended') return
          if (!c.enabled || a.state === 'ending' || Date.parse(a.leaseExpiresAt) <= Date.now()) {
            await this.end(a.clientId, a.id)
            return
          }
          const participants = await this.livekit.participants(a)
          const [fresh] = await this.store.db
            .select({ emptySince: allocations.emptySince })
            .from(allocations)
            .where(eq(allocations.id, a.id))
          if (participants.length) await this.store.db.update(allocations).set({ emptySince: null }).where(eq(allocations.id, a.id))
          else if (fresh.emptySince && Date.now() - fresh.emptySince.getTime() > 60000) await this.end(a.clientId, a.id)
          else
            await this.store.db
              .update(allocations)
              .set({ emptySince: sql`coalesce(${allocations.emptySince},now())` })
              .where(eq(allocations.id, a.id))
        })
      } catch {
        /* SFU 종료를 확인할 때까지 예약을 유지합니다. */
      }
    }
    if (!this.limits.reconcileOrphans) return
    // 이전 경합이나 비정상 종료로 남은 이 설치의 방도 정리합니다.
    try {
      const installationId = await this.store.installationId()
      for (const room of await this.livekit.request(() => this.livekit.client.listRooms())) {
        const match = /^voice-relay:([^:]+):([^:]+)$/.exec(room.name)
        if (!match || !ownsRoom(room.metadata, installationId)) continue
        await this.store.serialized(match[2], async () => {
          const [record] = await this.store.db
            .select({ state: allocations.state })
            .from(allocations)
            .where(and(eq(allocations.id, match[2]), eq(allocations.clientId, match[1])))
          if (!record || record.state === 'ended') {
            const current = (await this.livekit.request(() => this.livekit.client.listRooms([room.name]), true))[0]
            if (current && ownsRoom(current.metadata, installationId))
              await this.livekit.request(() => this.livekit.client.deleteRoom(room.name), true)
          }
        })
      }
    } catch {
      /* SFU 연결이 복구되면 다시 정리합니다. */
    }
  }

  async prune() {
    await this.store.tx(async (db) => {
      await db.query("SET LOCAL statement_timeout='2s'")
      await db.query(
        "WITH removed AS (DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at<now()-interval '24 hours' ORDER BY id LIMIT 1000) RETURNING client_id,id) INSERT INTO event_retention(client_id,pruned_through) SELECT client_id,max(id) FROM removed GROUP BY client_id ON CONFLICT(client_id) DO UPDATE SET pruned_through=greatest(event_retention.pruned_through,excluded.pruned_through)",
      )
      await db.query(
        "DELETE FROM received_webhooks WHERE ctid IN (SELECT ctid FROM received_webhooks WHERE created_at<now()-interval '24 hours' LIMIT 1000)",
      )
    }, 1789102027)
  }
}
