// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from 'node:events'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from '../app/server.ts'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import type { Store } from '../infra/store.ts'
import { expireAllocationEvents } from '../infra/test-data.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { createTestRoomScope } from '../infra/test-rooms.ts'
import { clientToken } from './fixtures/client-token.ts'
import { Provider } from './provider.ts'

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let store: Store
let provider: Provider
const roomScope = createTestRoomScope()
beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 350,
    initialize: async (fixture) => {
      await fixture.store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 100, maxRooms: 20, allowScreenShare: true })
    },
  })
  store = database.store
  provider = new Provider(store, new LiveKit(testLiveKit), {
    maxSlots: 100,
    maxRooms: 20,
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

test('slow independent allocations leave real HTTP health and authenticated API responsive', async () => {
  const service = await createServer(
    {
      databaseUrl: url,
      publicUrl: 'https://relay.test',
      clientSecretFile: '',
      host: '127.0.0.1',
      port: 0,
      livekit: testLiveKit,
      maxSlots: 100,
      maxRooms: 20,
      iceServers: null,
    },
    {
      store,
      migrate: false,
      startWorkers: false,
      loadSecrets: () => ({ client: 'fixture-secret-fixture-secret-fixture-secret' }),
    },
  )
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const addr = service.server.address()
  if (!addr || typeof addr === 'string') throw new Error('missing address')
  const base = `http://127.0.0.1:${addr.port}`
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = 0
  let settled = 0
  let signalEntered!: () => void
  const enteredFirst = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  const original = provider.livekit.ensure.bind(provider.livekit)
  provider.livekit.ensure = async (a, installationId) => {
    await original(a, installationId)
    entered++
    signalEntered()
    await gate
  }
  const jobs = Array.from({ length: 3 }, (_, i) =>
    provider
      .allocate('client', { roomKey: `slow-${i}`, generation: 'g1', slots: 1 })
      .then(
        () => 'ok',
        (error) => error.code ?? 'error',
      )
      .finally(() => {
        settled++
      }),
  )
  try {
    await enteredFirst
    expect({ entered, settled }).toEqual({ entered: 1, settled: 0 })
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    const path = '/voice-relay/v1/events'
    const api = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(1500),
      headers: {
        authorization: `Bearer ${await clientToken('fixture-secret-fixture-secret-fixture-secret')}`,
      },
    })
    expect({ health: health.status, api: api.status }).toEqual({ health: 200, api: 200 })
  } finally {
    release()
    const results = await Promise.all(jobs)
    console.log('slow allocations', { entered, results })
    provider.livekit.ensure = original
    await service.close()
  }
})

test('real HTTP and WebSocket RTC reject saturation and HTTP reenters after release', async () => {
  const { WebSocket } = await import('ws')
  const a = await provider.allocate('client', { roomKey: 'saturated-rtc', generation: 'g1', slots: 1 })
  const issued = await provider.join('client', a.id, { identity: 'rtc', userId: 'rtc', allowScreenShare: false })
  const service = await createServer(
    {
      databaseUrl: url,
      publicUrl: 'https://relay.test',
      clientSecretFile: '',
      host: '127.0.0.1',
      port: 0,
      livekit: testLiveKit,
      maxSlots: 100,
      maxRooms: 20,
      iceServers: null,
    },
    {
      store,
      migrate: false,
      startWorkers: false,
      loadSecrets: () => ({ client: 'fixture-secret-fixture-secret-fixture-secret' }),
    },
  )
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const addr = service.server.address()
  if (!addr || typeof addr === 'string') throw new Error('missing address')
  const base = `127.0.0.1:${addr.port}`
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = store.serialized('saturation-hold', async () => {
    entered()
    await gate
  })
  const headers = { authorization: `Bearer ${await clientToken('fixture-secret-fixture-secret-fixture-secret')}` }
  try {
    await ready
    const path = `/voice-relay/v1/allocations/${a.id}/rtc/validate?access_token=${encodeURIComponent(issued.token)}`
    const result = await fetch(`http://${base}${path}`, { headers, signal: AbortSignal.timeout(1500) })
    expect(result.status).toBe(429)
    expect(await result.json()).toEqual({ code: 'RATE_LIMITED' })
    const wsPath = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(issued.token)}&protocol=16&sdk=js&version=2.23.0`
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}${wsPath}`, { headers })
      ws.once('unexpected-response', (_req, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
      })
      ws.once('open', () => {
        ws.terminate()
        reject(new Error('unexpected upgrade'))
      })
      ws.once('error', reject)
    })
    expect(status).toBe(429)
    release()
    await held
    expect((await fetch(`http://${base}${path}`, { headers, signal: AbortSignal.timeout(3000) })).status).toBe(200)
  } finally {
    release()
    await held
    await service.close()
    await provider.end('client', a.id)
  }
})

test('retention runs even while an allocation sweep waits for LiveKit', async () => {
  const a = await provider.allocate('client', { roomKey: 'retention-delay', generation: 'g1', slots: 1 })
  await expireAllocationEvents(store, a.id)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = provider.livekit.participants.bind(provider.livekit)
  provider.livekit.participants = async (allocation) => {
    if (allocation.id === a.id) {
      entered()
      await gate
    }
    return original(allocation)
  }
  const sweep = provider.sweep(true)
  try {
    await ready
    expect((await provider.events('client')).events.some((event) => event.allocationId === a.id)).toBe(false)
  } finally {
    release()
    await sweep
    provider.livekit.participants = original
    await provider.end('client', a.id)
  }
})

test('mixed RTC and end share a limit and end proceeds after RTC releases', async () => {
  const { admit } = await import('./signaling.ts')
  const a = await provider.allocate('client', { roomKey: 'mixed-rtc', generation: 'g1', slots: 1 })
  const b = await provider.allocate('client', { roomKey: 'mixed-end', generation: 'g1', slots: 1 })
  const token = await provider.join('client', a.id, { identity: 'mixed', userId: 'mixed', allowScreenShare: false })
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const rtc = admit(
    provider,
    'client',
    a.id,
    `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(token.token)}`,
    async () => {
      entered()
      await gate
    },
  )
  try {
    await ready
    let ended = false
    const end = provider.end('client', b.id).finally(() => {
      ended = true
    })
    const lifecycle = (store as unknown as { lifecycleCount: { waiters: unknown[] } }).lifecycleCount
    expect(lifecycle.waiters).toHaveLength(1)
    expect(ended).toBe(false)
    expect((await provider.allocation('client', b.id)).state).toBe('active')
    release()
    await rtc
    expect((await end).state).toBe('ended')
  } finally {
    release()
    await rtc
    await provider.end('client', a.id)
    await provider.end('client', b.id)
  }
})

test('separate pools still serialize the same allocation until the first lock is released', async () => {
  const a = await provider.allocate('client', { roomKey: 'cross-pool-lock', generation: 'g1', slots: 1 })
  const connection = database.connect({ max: 3, connectionTimeoutMillis: 1000 })
  const second = new Provider(connection.store, provider.livekit, provider.limits)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const hold = store.serialized(a.id, async () => {
    entered()
    await gate
  })
  try {
    await ready
    const end = second.end('client', a.id)
    expect((await provider.allocation('client', a.id)).state).toBe('active')
    release()
    await hold
    expect((await end).state).toBe('ended')
  } finally {
    release()
    await hold
    await connection.close()
  }
})

test('real HTTP and WebSocket report an unreachable upstream without leaking lifecycle permits', async () => {
  const { WebSocket } = await import('ws')
  const a = await provider.allocate('client', { roomKey: 'upstream-failure', generation: 'g1', slots: 1 })
  const issued = await provider.join('client', a.id, { identity: 'failure', userId: 'failure', allowScreenShare: false })
  const service = await createServer(
    {
      databaseUrl: url,
      publicUrl: 'https://relay.test',
      clientSecretFile: '',
      host: '127.0.0.1',
      port: 0,
      livekit: { ...testLiveKit, url: 'http://127.0.0.1:1' },
      maxSlots: 100,
      maxRooms: 20,
      iceServers: null,
    },
    {
      store,
      migrate: false,
      startWorkers: false,
      loadSecrets: () => ({ client: 'fixture-secret-fixture-secret-fixture-secret' }),
    },
  )
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const addr = service.server.address()
  if (!addr || typeof addr === 'string') throw new Error('missing address')
  const base = `127.0.0.1:${addr.port}`
  const headers = { authorization: `Bearer ${await clientToken('fixture-secret-fixture-secret-fixture-secret')}` }
  try {
    const path = `/voice-relay/v1/allocations/${a.id}/rtc/validate?access_token=${encodeURIComponent(issued.token)}`
    expect((await fetch(`http://${base}${path}`, { headers, signal: AbortSignal.timeout(2000) })).status).toBe(503)
    const wsPath = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(issued.token)}&protocol=16`
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}${wsPath}`, { headers })
      ws.once('unexpected-response', (_req, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
      })
      ws.once('open', () => {
        ws.terminate()
        reject(new Error('unexpected upgrade'))
      })
      ws.once('error', reject)
    })
    expect(status).toBe(503)
    expect((await provider.end('client', a.id)).state).toBe('ended')
  } finally {
    await service.close()
    await provider.end('client', a.id)
  }
})
