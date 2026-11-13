// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { SignalResponse } from '@livekit/protocol'
import { RoomServiceClient } from 'livekit-server-sdk'
import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest'
import { WebSocket } from 'ws'
import { createServer, type RelayService } from '../app/server.ts'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import type { Store } from '../infra/store.ts'
import { testParticipantRecordings } from '../infra/test-data.ts'
import { createTestDatabase, testAllocationLockPid } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { createTestPostgresProxy } from '../infra/test-postgres-proxy.ts'
import { createTestPostgresReadGate } from '../infra/test-postgres-read-gate.ts'
import { createTestRoomScope } from '../infra/test-rooms.ts'
import { clientToken } from './fixtures/client-token.ts'
import { createLiveKitGate } from './fixtures/livekit-gate.ts'
import { Provider } from './provider.ts'
import { roomName } from './room.ts'
import type { Allocation, Participant } from './types.ts'

type Tenant = 'client' | 'other'
type Session = { socket: WebSocket; sid: string }
// 시험에서 읽는 응답 필드만 둡니다.
type ResponseBody = {
  accepted: boolean
  code: string
  token: string
  cursor: string
  revision: string
  generation: string
  state: string
  capabilities: Record<string, boolean>
  participants: Participant[]
  events: { allocationId: string; type: string; revision: string }[]
}

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
const secrets: Record<Tenant, string> = { client: 'c'.repeat(64), other: 'o'.repeat(64) }
const origins: Record<Tenant, string> = { client: 'https://a.test', other: 'https://b.test' }
const rtcQuery = 'protocol=16&sdk=js&version=2.23.0&auto_subscribe=0'
const accepted = { status: 200, body: { accepted: true } }
const roomScope = createTestRoomScope()
const rooms = new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret)
let database: Awaited<ReturnType<typeof createTestDatabase>>
let provider: Provider
let service: RelayService
let port: number

beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: url,
    initialize: async (fixture) => {
      await fixture.store.db.insert(clients).values([
        { id: 'client', origin: origins.client, enabled: true, maxSlots: 20, maxRooms: 10, allowScreenShare: false },
        { id: 'other', origin: origins.other, enabled: true, maxSlots: 20, maxRooms: 10, allowScreenShare: false },
      ])
    },
  })
  provider = new Provider(database.store, new LiveKit(testLiveKit), {
    maxSlots: 20,
    maxRooms: 10,
    mediaProvider: 'https://relay.test',
    iceServers: null,
  })
  roomScope.attach(provider.livekit)
  service = await startRelay(testLiveKit)
  port = (service.server.address() as AddressInfo).port
})

async function startRelay(livekit: typeof testLiveKit, store: Store = database.store): Promise<RelayService> {
  const relay = await createServer(
    {
      databaseUrl: url,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'https://relay.test',
      clientSecretFile: '',
      livekit,
      maxSlots: 20,
      maxRooms: 10,
      iceServers: null,
    },
    { store, migrate: false, startWorkers: false, loadSecrets: () => secrets },
  )
  relay.server.listen(0, '127.0.0.1')
  await once(relay.server, 'listening')
  return relay
}

afterAll(async () => {
  try {
    await service?.close()
  } finally {
    try {
      if (provider) await roomScope.close(provider)
    } finally {
      await database?.close()
    }
  }
})

async function call(method: string, path: string, body?: unknown, tenant: Tenant = 'client', requestPort = port) {
  const response = await fetch(`http://127.0.0.1:${requestPort}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await clientToken(secrets[tenant], origins[tenant])}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return { status: response.status, body: (await response.json()) as ResponseBody }
}

async function allocation(): Promise<Allocation> {
  const a = await provider.allocate('client', { roomKey: `status-${randomUUID()}`, generation: 'g1', slots: 2 })
  onTestFinished(async () => {
    await provider.end('client', a.id)
  })
  return a
}

async function issue(a: Allocation, identity: string, userId: string): Promise<string> {
  const joined = await call('POST', `/voice-relay/v1/allocations/${a.id}/join`, { identity, userId, allowScreenShare: false })
  expect(joined.status).toBe(200)
  return joined.body.token
}

function nextSignal(socket: WebSocket, kind: SignalResponse['message']['case']): Promise<SignalResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${kind}`)), 10000)
    socket.on('message', function message(data) {
      const signal = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
      if (signal.message.case !== kind) return
      clearTimeout(timer)
      socket.off('message', message)
      resolve(signal)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function joined(socket: WebSocket): Promise<Session> {
  onTestFinished(() => {
    socket.terminate()
  })
  socket.on('error', () => {})
  const signal = await nextSignal(socket, 'join')
  const sid = signal.message.case === 'join' ? signal.message.value.participant?.sid : undefined
  if (!sid) throw new Error('LiveKit did not assign a session ID')
  return { socket, sid }
}

// 이용 서버처럼 릴레이 RTC 경로로 참가자를 연결합니다.
async function connect(a: Allocation, token: string): Promise<Session> {
  const path = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(token)}&${rtcQuery}`
  const authorization = `Bearer ${await clientToken(secrets.client, origins.client)}`
  return joined(new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization } }))
}

// 릴레이의 배정 잠금과 무관한 시점에 같은 identity의 새 세션이 LiveKit에 들어오는 경우입니다.
function connectToLiveKit(token: string): Promise<Session> {
  const base = testLiveKit.url.replace(/^http/, 'ws')
  return joined(new WebSocket(`${base}/rtc?access_token=${encodeURIComponent(token)}&${rtcQuery}`))
}

function replaced(previous: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The previous session stayed connected')), 10000)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    previous.socket.once('close', done)
    previous.socket.on('message', (data) => {
      if (SignalResponse.fromBinary(new Uint8Array(data as Buffer)).message.case === 'leave') done()
    })
  })
}

function status(a: Allocation, body: Record<string, unknown>, tenant: Tenant = 'client', requestPort = port) {
  return call('POST', `/voice-relay/v1/allocations/${a.id}/participants/status`, body, tenant, requestPort)
}

async function snapshotParticipant(a: Allocation, identity: string) {
  const snapshot = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
  expect(snapshot.status).toBe(200)
  return snapshot.body.participants.find((participant) => participant.identity === identity)
}

async function liveKitParticipant(a: Allocation, identity: string) {
  const participant = await rooms.getParticipant(roomName(a), identity)
  return { sid: participant.sid, attributes: { ...participant.attributes } }
}

async function participantEvents(a: Allocation, cursor: string) {
  const feed = await call('GET', `/voice-relay/v1/events?cursor=${encodeURIComponent(cursor)}`)
  expect(feed.status).toBe(200)
  const events = feed.body.events.filter((event) => event.allocationId === a.id)
  return { cursor: feed.body.cursor, count: events.filter((event) => event.type === 'participant').length }
}

test('capacity advertises recording status beside the existing capabilities', async () => {
  const capacity = await call('GET', '/voice-relay/v1/capacity')

  expect(capacity.status).toBe(200)
  expect(capacity.body.capabilities).toEqual({ cancelPending: true, includeIceServers: true, recordingStatus: true })
})

test('an earlier consumer status body is accepted and the snapshot keeps the session fields', async () => {
  const a = await allocation()
  const identity = 'https://a.test/users/earlier'
  const session = await connect(a, await issue(a, identity, 'earlier'))

  const response = await status(a, { identity, sessionId: session.sid, micMuted: true, deafened: true })

  expect(response).toEqual(accepted)
  expect(await snapshotParticipant(a, identity)).toEqual({
    identity,
    userId: 'earlier',
    sessionId: session.sid,
    screenSharing: false,
    micMuted: true,
    deafened: true,
    recording: false,
    allowScreenShare: false,
    micTrackSid: null,
  })
})

test('recording follows true and false reports and an omitted flag keeps the current state', async () => {
  const a = await allocation()
  const identity = 'https://a.test/users/recording'
  const { sid } = await connect(a, await issue(a, identity, 'recording'))
  let cursor = (await call('GET', '/voice-relay/v1/events')).body.cursor
  const steps: [Record<string, boolean>, { recording: boolean; micMuted: boolean; deafened: boolean }][] = [
    [{ recording: true }, { recording: true, micMuted: false, deafened: false }],
    [{ micMuted: true }, { recording: true, micMuted: true, deafened: false }],
    [{ recording: false }, { recording: false, micMuted: false, deafened: false }],
    [{ deafened: true }, { recording: false, micMuted: false, deafened: true }],
  ]

  for (const [fields, expected] of steps) {
    const response = await status(a, { identity, sessionId: sid, micMuted: false, deafened: false, ...fields })
    const feed = await participantEvents(a, cursor)
    cursor = feed.cursor

    expect(response).toEqual(accepted)
    expect(await snapshotParticipant(a, identity)).toMatchObject({ sessionId: sid, ...expected })
    expect(feed.count).toBe(1)
  }
})

test('provider-foreign status fields are rejected without changing LiveKit attributes', async () => {
  const a = await allocation()
  const identity = 'https://a.test/users/foreign-fields'
  const { sid } = await connect(a, await issue(a, identity, 'foreign-fields'))
  expect(await status(a, { identity, sessionId: sid, micMuted: false, deafened: false, recording: true })).toEqual(accepted)
  const before = await liveKitParticipant(a, identity)
  const recordingId = randomUUID()

  for (const fields of [{ recordingId }, { recording: false, recordingId }, { recording: null }, { recording: 'false' }, { extra: true }]) {
    const response = await status(a, { identity, sessionId: sid, micMuted: true, deafened: true, ...fields })

    expect(response).toEqual({ status: 400, body: { code: 'INVALID_REQUEST' } })
  }

  expect(await liveKitParticipant(a, identity)).toEqual(before)
  expect(await snapshotParticipant(a, identity)).toMatchObject({ recording: true, micMuted: false, deafened: false })
})

test('another client cannot write the participant status of an allocation', async () => {
  const a = await allocation()
  const identity = 'https://a.test/users/tenant'
  const { sid } = await connect(a, await issue(a, identity, 'tenant'))
  const before = await liveKitParticipant(a, identity)

  const response = await status(a, { identity, sessionId: sid, micMuted: true, deafened: true, recording: true }, 'other')

  expect(response).toEqual({ status: 404, body: { code: 'NOT_FOUND' } })
  expect(await liveKitParticipant(a, identity)).toEqual(before)
})

test('a reconnected identity starts without recording and its previous session cannot write', async () => {
  const a = await allocation()
  const identity = 'https://a.test/users/reconnect'
  const previous = await connect(a, await issue(a, identity, 'reconnect'))
  expect(await status(a, { identity, sessionId: previous.sid, micMuted: false, deafened: false, recording: true })).toEqual(accepted)

  const leaving = replaced(previous)
  const current = await connect(a, await issue(a, identity, 'reconnect'))
  await leaving

  expect(current.sid).not.toBe(previous.sid)
  expect(await snapshotParticipant(a, identity)).toMatchObject({ sessionId: current.sid, recording: false })

  expect(await status(a, { identity, sessionId: current.sid, micMuted: false, deafened: false, recording: true })).toEqual(accepted)
  const stale = await status(a, { identity, sessionId: previous.sid, micMuted: true, deafened: true, recording: false })

  expect(stale).toEqual({ status: 200, body: { accepted: false } })
  expect(await snapshotParticipant(a, identity)).toMatchObject({
    sessionId: current.sid,
    recording: true,
    micMuted: false,
    deafened: false,
  })
})

test.each([true, false])('a replaced session rejects a stale recording %s update', async (recording) => {
  const a = await allocation()
  const identity = 'https://a.test/users/race'
  const previous = await connect(a, await issue(a, identity, 'race'))
  // 배정 잠금을 잡은 요청 안에서는 새 참여 토큰을 받을 수 없으므로 미리 받아 둡니다.
  const reconnectToken = await issue(a, identity, 'race')
  const replacement: { session?: Session } = {}
  const gate = await createLiveKitGate(testLiveKit.url, async () => {
    const leaving = replaced(previous)
    replacement.session = await connectToLiveKit(reconnectToken)
    await leaving
  })
  onTestFinished(() => gate.close())
  const relay = await startRelay({ ...testLiveKit, url: gate.url })
  onTestFinished(() => relay.close())
  const requestPort = (relay.server.address() as AddressInfo).port

  const result = await status(a, { identity, sessionId: previous.sid, micMuted: true, deafened: true, recording }, 'client', requestPort)

  gate.verify()
  expect(result).toEqual({ status: 200, body: { accepted: false } })
  const current = replacement.session
  if (!current) throw new Error('The replacement session did not join')
  expect(gate.methods).toEqual(['GetParticipant', 'UpdateParticipant', 'UpdateParticipant'])
  expect(await snapshotParticipant(a, identity)).toMatchObject({ sessionId: current.sid, recording: false })
  expect(await status(a, { identity, sessionId: current.sid, micMuted: false, deafened: false, recording: true })).toEqual(accepted)
  expect(await snapshotParticipant(a, identity)).toMatchObject({ sessionId: current.sid, recording: true })
})

test.each([true, false])('a status write that lost its PostgreSQL lock cannot reverse a newer recording %s report', async (recording) => {
  const a = await allocation()
  const identity = 'https://a.test/users/lost-lock'
  const { sid } = await connect(a, await issue(a, identity, 'lost-lock'))
  const before = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
  const cursor = (await call('GET', '/voice-relay/v1/events')).body.cursor
  const proxy = await createTestPostgresProxy(url)
  const interrupted = database.connect({ connectionString: proxy.connectionString })
  const disconnected = interrupted.nextDisconnect()
  let lockPid: number | undefined
  let newer: Awaited<ReturnType<typeof call>> | undefined
  let newerStored: Awaited<ReturnType<typeof liveKitParticipant>> | undefined
  const gate = await createLiveKitGate(
    testLiveKit.url,
    async () => {},
    async () => {
      // 과거 요청의 HTTP 쓰기를 받은 뒤 실제 PostgreSQL 연결을 끊습니다.
      lockPid = await testAllocationLockPid(database, a.id)
      expect(lockPid).toBeGreaterThan(0)
      proxy.disconnect()
      await disconnected
      const response = await status(a, { identity, sessionId: sid, micMuted: false, deafened: false, recording })
      expect(response).toEqual(accepted)
      newer = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
      expect(newer.body.participants.find((p) => p.identity === identity)).toMatchObject({ sessionId: sid, recording })
      newerStored = await liveKitParticipant(a, identity)
      expect(await testAllocationLockPid(database, a.id)).toBeUndefined()
      // 다른 연결의 요청이 성공한 다음에만 보류한 SFU 쓰기를 전달합니다.
    },
  )
  const relay = await startRelay({ ...testLiveKit, url: gate.url }, interrupted.store)
  const requestPort = (relay.server.address() as AddressInfo).port

  try {
    const original = await status(
      a,
      { identity, sessionId: sid, micMuted: false, deafened: false, recording: !recording },
      'client',
      requestPort,
    )
    gate.verify()
    const after = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
    const stored = await liveKitParticipant(a, identity)
    const recordingState = await testParticipantRecordings(database.store, a.id)
    const feed = await participantEvents(a, cursor)
    console.info(
      'lock-loss evidence',
      JSON.stringify({
        lockPid,
        original,
        before: before.body,
        newer: newer?.body,
        newerStored,
        after: after.body,
        stored,
        recordingState,
        feed,
      }),
    )

    expect(original).toEqual({ status: 503, body: { code: 'PROVIDER_UNAVAILABLE' } })
    expect(newer).toBeDefined()
    expect(BigInt(newer?.body.revision ?? '0')).toBeGreaterThan(BigInt(before.body.revision))
    expect(after.body.revision).toBe(newer?.body.revision)
    expect(feed.count).toBe(1)
    expect(feed.cursor).toBe(`client:${after.body.revision}`)
    expect.soft(after.body.participants.find((p) => p.identity === identity)).toMatchObject({ sessionId: sid, recording })
    expect.soft(stored).toEqual(newerStored)
    expect(recordingState).toEqual([{ sessionId: sid, recording }])
  } finally {
    await relay.close()
    await interrupted.close()
    await proxy.close()
    await gate.close()
  }
})

test('a snapshot paused after its first database read can recover a concurrent HTTP end', async () => {
  const a = await allocation()
  const before = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
  expect(before.body.state).toBe('active')
  const gate = await createTestPostgresReadGate(url)
  const reader = database.connect({ connectionString: gate.connectionString })
  const relay = await startRelay(testLiveKit, reader.store)
  const readerPort = (relay.server.address() as AddressInfo).port
  const pending = call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`, undefined, 'client', readerPort)

  try {
    const firstQuery = await gate.next()
    const ended = await call('DELETE', `/voice-relay/v1/allocations/${a.id}`)
    expect(ended.status).toBe(200)
    const committed = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
    expect(committed.body.state).toBe('ended')

    gate.release()
    const snapshot = await pending
    const feed = await call('GET', `/voice-relay/v1/events?cursor=client:${snapshot.body.revision}`)
    const endEvents = feed.body.events.filter((event) => event.allocationId === a.id && event.type === 'ended')
    console.info('snapshot-end evidence', JSON.stringify({ firstQuery, before, committed, snapshot, feed, endEvents }))

    expect(snapshot.status).toBe(200)
    expect(snapshot.body.generation).toBe(a.generation)
    expect(snapshot.body.participants).toEqual([])
    expect.soft(snapshot.body.state === 'ended' || BigInt(snapshot.body.revision) < BigInt(committed.body.revision)).toBe(true)
    expect.soft(snapshot.body.state === 'ended' || endEvents.length === 1).toBe(true)
    if (endEvents.length) {
      expect(BigInt(endEvents[0].revision)).toBeGreaterThan(BigInt(snapshot.body.revision))
      const recovered = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
      expect(recovered.body.state).toBe('ended')
    }
  } finally {
    gate.release()
    await pending.catch(() => {})
    await relay.close()
    await reader.close()
    await gate.close()
  }
}, 20000)

test('a snapshot and its revision share the recording database read during a concurrent status update', async () => {
  const a = await allocation()
  const identity = 'https://a.test/users/snapshot-recording'
  const { sid } = await connect(a, await issue(a, identity, 'snapshot-recording'))
  const gate = await createTestPostgresReadGate(url)
  const reader = database.connect({ connectionString: gate.connectionString })
  const relay = await startRelay(testLiveKit, reader.store)
  const readerPort = (relay.server.address() as AddressInfo).port
  const pending = call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`, undefined, 'client', readerPort)

  try {
    await gate.next()
    expect(await status(a, { identity, sessionId: sid, micMuted: false, deafened: false, recording: true })).toEqual(accepted)
    const committed = await call('GET', `/voice-relay/v1/allocations/${a.id}/snapshot`)
    expect(committed.body.participants.find((participant) => participant.identity === identity)).toMatchObject({ recording: true })

    gate.release()
    const snapshot = await pending
    const feed = await call('GET', `/voice-relay/v1/events?cursor=client:${snapshot.body.revision}`)
    expect(snapshot.status).toBe(200)
    expect(snapshot.body.participants.find((participant) => participant.identity === identity)).toMatchObject({
      sessionId: sid,
      recording: false,
    })
    expect(BigInt(snapshot.body.revision)).toBeLessThan(BigInt(committed.body.revision))
    expect(feed.body.events.some((event) => event.allocationId === a.id && event.type === 'participant')).toBe(true)
  } finally {
    gate.release()
    await pending.catch(() => {})
    await relay.close()
    await reader.close()
    await gate.close()
  }
}, 20000)
