// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { LiveKit, roomName } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import type { Store } from '../infra/store.ts'
import { addTestClient, exhaustGenerationBytes, exhaustGenerationCount } from '../infra/test-data.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { createTestPostgresProxy } from '../infra/test-postgres-proxy.ts'
import { createTestRoomScope } from '../infra/test-rooms.ts'
import { Provider } from './provider.ts'

const base = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let store: Store
let provider: Provider
const roomScope = createTestRoomScope()
const limits = { maxSlots: 10, maxRooms: 10, mediaProvider: 'https://relay.test', iceServers: null }
const livekit = testLiveKit

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: base,
    initialize: async (fixture) => {
      await fixture.store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 10, maxRooms: 10 })
    },
  })
  store = database.store
  provider = new Provider(store, roomScope.attach(new LiveKit(livekit)), limits)
})
afterAll(async () => {
  try {
    if (provider) await roomScope.close(provider)
  } finally {
    await database?.close()
  }
})

test('a delayed creation cannot pass a cancellation committed first, including after restart', async () => {
  const input = { roomKey: `late-${randomUUID()}`, generation: 'g', slots: 1 }
  const entered = barrier()
  const proceed = barrier()
  const active = provider.active.bind(provider)
  provider.active = async (id) => {
    const client = await active(id)
    entered.release()
    await proceed.promise
    return client
  }
  try {
    const delayed = provider.allocate('client', input)
    const rejected = expect(delayed).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT', status: 409 })
    await entered.promise
    expect(await provider.cancel('client', input)).toEqual({ state: 'ended' })
    proceed.release()
    await rejected
  } finally {
    proceed.release()
    provider.active = active
  }
  const otherConnection = database.connect()
  const otherStore = otherConnection.store
  try {
    const restarted = new Provider(otherStore, roomScope.attach(new LiveKit(livekit)), limits)
    await expect(restarted.allocate('client', input)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' })
    expect(await restarted.cancel('client', input)).toEqual({ state: 'ended' })
  } finally {
    await otherConnection.close()
  }
})

test('cancellation waits for an in-flight real room creation and confirms removal', async () => {
  const input = { roomKey: `race-${randomUUID()}`, generation: 'g', slots: 2 }
  const entered = barrier()
  const proceed = barrier()
  const ensure = provider.livekit.ensure.bind(provider.livekit)
  provider.livekit.ensure = async (a, installation) => {
    entered.release()
    await proceed.promise
    await ensure(a, installation)
  }
  const otherConnection = database.connect()
  const otherStore = otherConnection.store
  const otherProvider = new Provider(otherStore, roomScope.attach(new LiveKit(livekit)), limits)
  const committed = barrier()
  const originalTx = otherStore.tx.bind(otherStore)
  otherStore.tx = async (...args) => {
    const result = await originalTx(...args)
    committed.release()
    return result
  }
  try {
    const allocating = provider.allocate('client', input)
    await entered.promise
    const cancelling = otherProvider.cancel('client', input)
    await committed.promise
    proceed.release()
    const allocation = await allocating
    expect(await cancelling).toEqual({ state: 'ended' })
    expect((await provider.allocation('client', allocation.id)).state).toBe('ended')
    expect(await provider.livekit.client.listRooms([roomName(allocation)])).toHaveLength(0)
    await expect(provider.allocate('client', input)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' })
  } finally {
    proceed.release()
    provider.livekit.ensure = ensure
    await otherConnection.close()
  }
})

test('failed SFU removal keeps the reservation and cancellation can be retried', async () => {
  const input = { roomKey: `retry-${randomUUID()}`, generation: 'g', slots: 3 }
  const allocation = await provider.allocate('client', input)
  const remove = provider.livekit.remove.bind(provider.livekit)
  provider.livekit.remove = async () => {
    throw new Error('simulated SFU failure')
  }
  try {
    await expect(provider.cancel('client', input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 })
    expect((await provider.allocation('client', allocation.id)).state).toBe('ending')
    expect((await provider.capacity('client')).reservedSlots).toBe(3)
    await expect(provider.allocate('client', input)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' })
  } finally {
    provider.livekit.remove = remove
  }
  expect(await provider.cancel('client', input)).toEqual({ state: 'ended' })
  expect(await provider.livekit.client.listRooms([roomName(allocation)])).toHaveLength(0)
})

test('cancellation accepts a maximum-length Unicode room key', async () => {
  const { randomBytes } = await import('node:crypto')
  const bytes = randomBytes(4096)
  const roomKey = Array.from({ length: 2048 }, (_, index) => String.fromCodePoint(0x4e00 + (bytes.readUInt16BE(index * 2) % 20000))).join(
    '',
  )
  expect(await provider.cancel('client', { roomKey, generation: 'g' })).toEqual({ state: 'ended' })
})

test('creation and cancellation support an uncompressible maximum-length room key', async () => {
  const { randomBytes } = await import('node:crypto')
  const bytes = randomBytes(4096)
  const roomKey = Array.from({ length: 2048 }, (_, index) => String.fromCodePoint(0x4e00 + (bytes.readUInt16BE(index * 2) % 20000))).join(
    '',
  )
  const input = { roomKey, generation: 'g', slots: 1 }
  const allocated = await provider.allocate('client', input)
  expect((await provider.lookup('client', roomKey, 'g')).id).toBe(allocated.id)
  expect(await provider.cancel('client', input)).toEqual({ state: 'ended' })
})

test('concurrent cancellation writes one permanent record across separate pools', async () => {
  const input = { roomKey: `concurrent-${randomUUID()}`, generation: 'g', slots: 1 }
  const otherConnection = database.connect()
  const otherStore = otherConnection.store
  try {
    const other = new Provider(otherStore, roomScope.attach(new LiveKit(livekit)), limits)
    expect(await Promise.all([provider.cancel('client', input), other.cancel('client', input)])).toEqual([
      { state: 'ended' },
      { state: 'ended' },
    ])
    await expect(other.allocate('client', input)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' })
  } finally {
    await otherConnection.close()
  }
})

test('a lost database connection cannot confirm cancellation while room creation is in flight', async () => {
  const input = { roomKey: `lost-lock-${randomUUID()}`, generation: 'g', slots: 1 }
  const entered = barrier()
  const proceed = barrier()
  const proxy = await createTestPostgresProxy(base)
  const interruptedConnection = database.connect({ connectionString: proxy.connectionString })
  const interruptedStore = interruptedConnection.store
  const interrupted = new Provider(interruptedStore, roomScope.attach(new LiveKit(livekit)), limits)
  const otherConnection = database.connect()
  const otherStore = otherConnection.store
  const other = new Provider(otherStore, roomScope.attach(new LiveKit(livekit)), limits)
  const disconnected = interruptedConnection.nextDisconnect()
  const ensure = interrupted.livekit.ensure.bind(interrupted.livekit)
  let ownRoom = ''
  interrupted.livekit.ensure = async (allocation, installation) => {
    ownRoom = roomName(allocation)
    entered.release()
    await proceed.promise
    await ensure(allocation, installation)
  }
  const allocating = interrupted.allocate('client', input).catch(() => undefined)
  try {
    await entered.promise
    proxy.disconnect()
    await disconnected
    await expect(other.cancel('client', input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 })
    proceed.release()
    await allocating
    expect(await other.cancel('client', input)).toEqual({ state: 'ended' })
    expect((await other.lookup('client', input.roomKey, input.generation)).state).toBe('ended')
    expect(await interrupted.livekit.client.listRooms([ownRoom])).toHaveLength(0)
  } finally {
    proceed.release()
    await allocating
    if (ownRoom) await interrupted.livekit.client.deleteRoom(ownRoom).catch(() => {})
    await otherConnection.close()
    await interruptedConnection.close()
    await proxy.close()
  }
})

test('an ambiguous SFU creation failure remains reserved and cannot be declared cancelled after restart', async () => {
  const input = { roomKey: `ambiguous-${randomUUID()}`, generation: 'g', slots: 1 }
  const ensure = provider.livekit.ensure.bind(provider.livekit)
  provider.livekit.ensure = async () => {
    throw new Error('ambiguous SFU failure')
  }
  try {
    await expect(provider.allocate('client', input)).rejects.toThrow('ambiguous SFU failure')
  } finally {
    provider.livekit.ensure = ensure
  }
  const otherConnection = database.connect()
  const otherStore = otherConnection.store
  try {
    const other = new Provider(otherStore, roomScope.attach(new LiveKit(livekit)), limits)
    await expect(other.cancel('client', input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 })
    expect((await other.lookup('client', input.roomKey, input.generation)).state).toBe('pending')
    await expect(other.allocate('client', input)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' })
    await expect(other.cancel('client', input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 })
  } finally {
    await otherConnection.close()
  }
})

test('room_finished is published only after confirmed room termination and is retried', async () => {
  const a = await provider.allocate('client', { roomKey: `webhook-${randomUUID()}`, generation: 'g', slots: 1 })
  const webhook = provider.livekit.webhook.bind(provider.livekit)
  const remove = provider.livekit.remove.bind(provider.livekit)
  provider.livekit.webhook = async () =>
    ({ id: randomUUID(), event: 'room_finished', room: { name: roomName(a) } }) as Awaited<ReturnType<LiveKit['webhook']>>
  provider.livekit.remove = async () => {
    throw new Error('SFU unavailable')
  }
  try {
    await expect(provider.webhook('{}', 'valid')).rejects.toThrow()
    expect(
      (await provider.events('client')).events.filter((event) => event.allocationId === a.id && event.type === 'room_finished'),
    ).toHaveLength(0)
    provider.livekit.remove = remove
    await provider.webhook('{}', 'valid')
    expect((await provider.allocation('client', a.id)).state).toBe('ended')
    expect(
      (await provider.events('client')).events.filter((event) => event.allocationId === a.id && event.type === 'room_finished'),
    ).toHaveLength(1)
  } finally {
    provider.livekit.webhook = webhook
    provider.livekit.remove = remove
    await provider.end('client', a.id).catch(() => {})
  }
})

test('moderation reports that a missing participant or microphone was not changed', async () => {
  const a = await provider.allocate('client', { roomKey: `moderation-${randomUUID()}`, generation: 'g', slots: 1 })
  try {
    expect(await provider.participant('client', a.id, 'mute', { identity: 'missing' })).toEqual({ accepted: false })
    expect(await provider.participant('client', a.id, 'kick', { identity: 'missing' })).toEqual({ accepted: false })
  } finally {
    await provider.end('client', a.id)
  }
})

test('generation storage limit preserves existing retries and serializes concurrent new generations', async () => {
  const otherConnection = database.connect()
  const otherStore = otherConnection.store
  const other = new Provider(otherStore, roomScope.attach(new LiveKit(livekit)), limits)
  const id = `quota-${randomUUID()}`
  await addTestClient(store, id)
  const existing = { roomKey: `quota-${randomUUID()}`, generation: 'g', slots: 1 }
  try {
    const first = await provider.allocate(id, existing)
    await exhaustGenerationCount(store, id)
    const candidates = [0, 1].map((n) => ({ roomKey: `quota-new-${n}-${randomUUID()}`, generation: 'g', slots: 1 }))
    const results = await Promise.allSettled([provider.allocate(id, candidates[0]), other.allocate(id, candidates[1])])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await provider.allocate(id, existing)).id).toBe(first.id)
    await expect(provider.cancel(id, { roomKey: `missing-${randomUUID()}`, generation: 'g' })).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    })
    expect(await provider.cancel(id, existing)).toEqual({ state: 'ended' })
  } finally {
    await otherConnection.close()
  }
})

test('generation byte quota blocks new records but permits existing cancellation', async () => {
  const id = `quota-${randomUUID()}`
  await addTestClient(store, id)
  const input = { roomKey: '실제 방', generation: 'g', slots: 1 }
  const allocated = await provider.allocate(id, input)
  await exhaustGenerationBytes(store, id)
  await expect(provider.allocate(id, { roomKey: 'new', generation: 'g', slots: 1 })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
  expect((await provider.allocate(id, input)).id).toBe(allocated.id)
  expect(await provider.cancel(id, input)).toEqual({ state: 'ended' })
})
