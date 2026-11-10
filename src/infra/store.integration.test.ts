// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { Provider } from '../relay/provider.ts'
import { LiveKit } from './livekit.ts'
import { clients } from './schema.ts'
import type { Store } from './store.ts'
import { expireClientEvents } from './test-data.ts'
import { createTestDatabase } from './test-database.ts'
import { testLiveKit } from './test-livekit.ts'
import { createTestRoomScope } from './test-rooms.ts'

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let store: Store
let provider: Provider
const roomScope = createTestRoomScope()
beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 1000,
    initialize: async (fixture) => {
      await fixture.store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 102, maxRooms: 10, allowScreenShare: true })
    },
  })
  store = database.store
  provider = new Provider(store, new LiveKit(testLiveKit), {
    maxSlots: 102,
    maxRooms: 10,
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

test('advisory waiters cannot starve the lock holder of a database connection', async () => {
  const a = await provider.allocate('client', { roomKey: 'deadlock', generation: 'g1', slots: 1 })
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.serialized(a.id, () => store.get('client', a.id))))
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  await provider.end('client', a.id)
})

test('a sweep uses the current lease after another allocation delayed the scan', async () => {
  const a = await provider.allocate('client', { roomKey: 'blocker', generation: 'g1', slots: 1 })
  const b = await provider.allocate('client', { roomKey: 'victim', generation: 'g1', slots: 1 })
  const oldExpiry = Date.parse(b.leaseExpiresAt)
  const original = provider.livekit.participants.bind(provider.livekit)
  let renewed = false
  vi.useFakeTimers({ toFake: ['Date'] })
  provider.livekit.participants = async (allocation) => {
    if (allocation.id === a.id && !renewed) {
      const result = await original(allocation)
      renewed = true
      vi.setSystemTime(new Date(oldExpiry - 60_000))
      await provider.renew('client', b.id)
      vi.setSystemTime(new Date(oldExpiry + 1))
      return result
    }
    if (allocation.id === b.id) return [{} as import('../relay/types.ts').Participant]
    return original(allocation)
  }
  try {
    await provider.sweep()
    expect((await provider.allocation('client', b.id)).state).toBe('active')
  } finally {
    vi.useRealTimers()
    provider.livekit.participants = original
    await provider.end('client', a.id)
    await provider.end('client', b.id)
  }
})

test('a consumer with a pruned cursor is told to recover a snapshot even with no events left', async () => {
  const a = await provider.allocate('client', { roomKey: 'history', generation: 'g1', slots: 1 })
  await provider.end('client', a.id)
  const feed = await provider.events('client')
  await expireClientEvents(store, 'client')
  await provider.sweep()
  expect((await provider.events('client', feed.cursor)).gap).toBe(true)
})

test('termination waits for in-flight SFU admission and leaves no unreserved room', async () => {
  const { admit } = await import('../relay/signaling.ts')
  const { WebSocket } = await import('ws')
  const { SignalResponse } = await import('@livekit/protocol')
  const a = await provider.allocate('client', { roomKey: 'late-admission', generation: 'g1', slots: 1 })
  const issued = await provider.join('client', a.id, {
    identity: 'https://client.test/users/late',
    userId: 'late',
    allowScreenShare: false,
  })
  let enter!: () => void
  let proceed!: () => void
  const entered = new Promise<void>((resolve) => {
      enter = resolve
    }),
    gate = new Promise<void>((resolve) => {
      proceed = resolve
    })
  const raw = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(issued.token)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`
  const connection = admit(provider, 'client', a.id, raw, async (url) => {
    enter()
    await gate
    url.protocol = 'ws:'
    const ws = new WebSocket(url)
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No join')), 5000)
        ws.on('error', reject)
        ws.on('message', (data) => {
          const signal = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
          if (signal.message.case === 'join') {
            clearTimeout(timeout)
            resolve()
          }
        })
      })
    } finally {
      ws.terminate()
    }
  })
  await entered
  const ending = provider.end('client', a.id)
  proceed()
  await connection
  await ending
  expect((await provider.allocation('client', a.id)).state).toBe('ended')
  expect(await provider.livekit.client.listRooms([`voice-relay:client:${a.id}`])).toHaveLength(0)
})
