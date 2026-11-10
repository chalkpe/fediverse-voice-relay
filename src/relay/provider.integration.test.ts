// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import type { Store } from '../infra/store.ts'
import { prepareOverflowReservations } from '../infra/test-data.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { createTestRoomScope } from '../infra/test-rooms.ts'
import { Provider } from './provider.ts'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let store: Store
let provider: Provider
const roomScope = createTestRoomScope()

function barrier() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve() }
}
beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: url,
    initialize: async (fixture) => {
      await fixture.store.db.insert(clients).values([
        { id: 'client-a', origin: 'https://a.test', enabled: true, maxSlots: 51, maxRooms: 2, allowScreenShare: true },
        { id: 'client-b', origin: 'https://b.test', enabled: true, maxSlots: 51, maxRooms: 2, allowScreenShare: false },
      ])
    },
  })
  store = database.store
  provider = new Provider(store, new LiveKit(testLiveKit), {
    maxSlots: 102,
    maxRooms: 4,
    mediaProvider: 'https://relay.test',
    iceServers: null,
  })
  roomScope.attach(provider.livekit)
})

afterAll(async () => {
  try {
    if (provider) await roomScope.close(provider)
  } finally {
    await database?.close()
  }
})

test('capacity can sum reservations beyond the PostgreSQL integer range', async () => {
  const isolated = await createTestDatabase({
    connectionString: url,
    initialize: async (fixture) => prepareOverflowReservations(fixture.store),
  })
  try {
    const limited = new Provider(isolated.store, provider.livekit, provider.limits)
    const capacity = await limited.capacity('client-a')
    expect(capacity.reservedSlots).toBe(1500000000)
    expect(capacity.accepting).toBe(false)
  } finally {
    await isolated.close()
  }
})

test('capacity can accept a room while a larger slot request is rejected atomically', async () => {
  const first = await provider.allocate('client-a', { roomKey: `capacity-${randomUUID()}`, generation: 'g', slots: 50 })
  let second: Awaited<ReturnType<typeof provider.allocate>> | undefined
  try {
    const capacity = await provider.capacity('client-a')
    expect(capacity.accepting).toBe(true)
    expect(capacity.remainingSlots).toBe(1)
    await expect(provider.allocate('client-a', { roomKey: `too-large-${randomUUID()}`, generation: 'g', slots: 2 })).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    })
    second = await provider.allocate('client-a', { roomKey: `fits-${randomUUID()}`, generation: 'g', slots: 1 })
    expect(second.state).toBe('active')
  } finally {
    if (second) await provider.end('client-a', second.id)
    await provider.end('client-a', first.id)
  }
})

test('simultaneous full-room reservations cannot overbook and retry is idempotent', async () => {
  const results = await Promise.allSettled([
    provider.allocate('client-a', {
      roomKey: 'https://a.test/chat/r1',
      generation: 'g1',
      slots: 51,
    }),
    provider.allocate('client-a', {
      roomKey: 'https://a.test/chat/r2',
      generation: 'g1',
      slots: 51,
    }),
  ])
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  const good = results.find((x) => x.status === 'fulfilled')
  if (good?.status !== 'fulfilled') throw Error()
  const retry = await provider.allocate('client-a', {
    roomKey: good.value.roomKey,
    generation: 'g1',
    slots: 51,
  })
  expect(retry.id).toBe(good.value.id)
  expect((await provider.capacity('client-a')).reservedSlots).toBe(51)
  await provider.end('client-a', retry.id)
})

test('isolates identical user ids and rooms, constrains grants and rejects cross-client tokens', async () => {
  const a = await provider.allocate('client-a', {
    roomKey: 'room',
    generation: 'g2',
    slots: 51,
  })
  const b = await provider.allocate('client-b', {
    roomKey: 'room',
    generation: 'g2',
    slots: 51,
  })
  expect(a.id).not.toBe(b.id)
  const issued = await provider.join('client-b', b.id, {
    identity: 'https://b.test/users/u1',
    userId: 'u1',
    allowScreenShare: true,
  })
  const verified = await provider.inspect('client-b', issued.token)
  expect(verified.allocationId).toBe(b.id)
  await expect(provider.inspect('client-a', issued.token)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
  await expect(provider.snapshot('client-a', b.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
  const claims = await provider.livekit.verify(issued.token)
  expect(claims.video?.canPublishSources).toEqual(['microphone'])
  const allowed = await provider.join('client-a', a.id, {
    identity: 'https://a.test/users/u1',
    userId: 'u1',
    allowScreenShare: true,
  })
  expect((await provider.livekit.verify(allowed.token)).video?.canPublishSources).toEqual([
    'microphone',
    'screen_share',
    'screen_share_audio',
  ])
  const declined = await provider.join('client-a', a.id, {
    identity: 'https://a.test/users/u2',
    userId: 'u2',
    allowScreenShare: false,
  })
  expect((await provider.livekit.verify(declined.token)).video?.canPublishSources).toEqual(['microphone'])
  await provider.end('client-a', a.id)
  await provider.end('client-b', b.id)
})

test('lease expiry never confirms termination while LiveKit deletion is failing', async () => {
  const a = await provider.allocate('client-a', {
    roomKey: 'room',
    generation: 'g3',
    slots: 51,
  })
  const offline = new Provider(store, new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' }), {
    maxSlots: 102,
    maxRooms: 4,
    mediaProvider: 'https://relay.test',
    iceServers: null,
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date(Date.parse(a.leaseExpiresAt) + 1))
    await offline.sweep()
    expect((await provider.allocation('client-a', a.id)).state).not.toBe('ended')
  } finally {
    vi.useRealTimers()
  }
  expect((await provider.end('client-a', a.id)).state).toBe('ended')
})

test('a client event cursor cannot be used by another client', async () => {
  const a = await provider.allocate('client-a', {
    roomKey: 'room',
    generation: 'g4',
    slots: 51,
  })
  await provider.end('client-a', a.id)
  expect((await provider.snapshot('client-a', a.id)).state).toBe('ended')
  const events = await provider.events('client-a')
  expect(events.events.some((x) => x.allocationId === a.id && x.type === 'ended')).toBe(true)
  await expect(provider.events('client-b', events.cursor)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
})

test('event cursors never move backward and out-of-range cursors are rejected', async () => {
  const allocation = await provider.allocate('client-a', { roomKey: 'cursor-fixture', generation: 'g1', slots: 1 })
  try {
    expect((await provider.events('client-a', 'client-a:9223372036854775807')).cursor).toBe('client-a:9223372036854775807')
    await expect(provider.events('client-a', 'client-a:9223372036854775808')).rejects.toMatchObject({ status: 400 })
  } finally {
    await provider.end('client-a', allocation.id)
  }
})

test('join and kick serialize token issuance across connections', async () => {
  const allocation = await provider.allocate('client-a', { roomKey: `kick-race-${randomUUID()}`, generation: 'g', slots: 1 })
  const request = { identity: 'https://a.test/users/race', userId: 'race', allowScreenShare: false }
  const entered = barrier()
  const proceed = barrier()
  const original = provider.livekit.token.bind(provider.livekit)
  const spy = vi.spyOn(provider.livekit, 'token').mockImplementationOnce(async (...args) => {
    entered.resolve()
    await proceed.promise
    return original(...args)
  })
  try {
    const joining = provider.join('client-a', allocation.id, request)
    await entered.promise
    const checkout = new Promise<void>((resolve) => store.pool.once('acquire', () => resolve()))
    const kicking = provider.participant('client-a', allocation.id, 'kick', { identity: request.identity })
    await checkout
    proceed.resolve()
    const [issued] = await Promise.all([joining, kicking])
    await expect(provider.inspect('client-a', issued.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const renewed = await provider.join('client-a', allocation.id, request)
    expect((await provider.inspect('client-a', renewed.token)).identity).toBe(request.identity)
  } finally {
    proceed.resolve()
    spy.mockRestore()
    await provider.end('client-a', allocation.id)
  }
})

test('join queued behind kick receives a current token', async () => {
  const allocation = await provider.allocate('client-a', { roomKey: `join-race-${randomUUID()}`, generation: 'g', slots: 1 })
  const request = { identity: 'https://a.test/users/race', userId: 'race', allowScreenShare: false }
  const old = await provider.join('client-a', allocation.id, request)
  const entered = barrier()
  const proceed = barrier()
  const original = provider.livekit.client.removeParticipant.bind(provider.livekit.client)
  const spy = vi.spyOn(provider.livekit.client, 'removeParticipant').mockImplementationOnce(async (...args) => {
    entered.resolve()
    await proceed.promise
    return original(...args)
  })
  try {
    const kicking = provider.participant('client-a', allocation.id, 'kick', { identity: request.identity })
    await entered.promise
    const checkout = new Promise<void>((resolve) => store.pool.once('acquire', () => resolve()))
    const joining = provider.join('client-a', allocation.id, request)
    await checkout
    proceed.resolve()
    const [, renewed] = await Promise.all([kicking, joining])
    await expect(provider.inspect('client-a', old.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await provider.inspect('client-a', renewed.token)).identity).toBe(request.identity)
  } finally {
    proceed.resolve()
    spy.mockRestore()
    await provider.end('client-a', allocation.id)
  }
})

test('maximum-length Unicode participant identities can receive revocable tokens', async () => {
  const allocation = await provider.allocate('client-a', { roomKey: `unicode-${randomUUID()}`, generation: 'g', slots: 1 })
  try {
    const identity = Array.from({ length: 2048 }, (_, index) => String.fromCharCode(0x4e00 + ((index * 7919) % 20902))).join('')
    const issued = await provider.join('client-a', allocation.id, { identity, userId: 'long', allowScreenShare: false })
    expect((await provider.inspect('client-a', issued.token)).identity).toBe(identity)
  } finally {
    await provider.end('client-a', allocation.id)
  }
})

test('revoking one participant does not revoke other identities, rooms, or clients', async () => {
  const first = await provider.allocate('client-a', { roomKey: `scope-a-${randomUUID()}`, generation: 'g', slots: 1 })
  const otherRoom = await provider.allocate('client-a', { roomKey: `scope-b-${randomUUID()}`, generation: 'g', slots: 1 })
  const otherClient = await provider.allocate('client-b', { roomKey: `scope-c-${randomUUID()}`, generation: 'g', slots: 1 })
  const identity = 'https://example.test/users/same'
  const request = { identity, userId: 'u', allowScreenShare: false }
  try {
    const revoked = await provider.join('client-a', first.id, request)
    const otherIdentity = await provider.join('client-a', first.id, { ...request, identity: 'https://example.test/users/other' })
    const sameIdentityOtherRoom = await provider.join('client-a', otherRoom.id, request)
    const sameIdentityOtherClient = await provider.join('client-b', otherClient.id, request)
    await provider.participant('client-a', first.id, 'kick', { identity })
    await expect(provider.inspect('client-a', revoked.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await provider.inspect('client-a', otherIdentity.token)).allocationId).toBe(first.id)
    expect((await provider.inspect('client-a', sameIdentityOtherRoom.token)).allocationId).toBe(otherRoom.id)
    expect((await provider.inspect('client-b', sameIdentityOtherClient.token)).allocationId).toBe(otherClient.id)
    await expect(provider.inspect('client-a', sameIdentityOtherClient.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await provider.end('client-a', first.id)
    await provider.end('client-a', otherRoom.id)
    await provider.end('client-b', otherClient.id)
  }
})
