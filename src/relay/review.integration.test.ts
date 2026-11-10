// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from '../app/server.ts'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import type { Store } from '../infra/store.ts'
import { expireAllocationEvents, expireClientEvents } from '../infra/test-data.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { createTestPostgresProxy } from '../infra/test-postgres-proxy.ts'
import { startTestProcess } from '../infra/test-process.ts'
import { createTestRoomScope } from '../infra/test-rooms.ts'
import { clientToken } from './fixtures/client-token.ts'
import { Provider } from './provider.ts'
import { roomName } from './room.ts'
import { admit } from './signaling.ts'

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let schema: string
let database: Awaited<ReturnType<typeof createTestDatabase>>
let store: Store
let provider: Provider
const roomScope = createTestRoomScope()
beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 500,
    initialize: async (fixture) => {
      await fixture.store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 100, maxRooms: 20, allowScreenShare: true })
    },
  })
  store = database.store
  schema = database.schema
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

test.each(['idle', 'checked-out'])('a terminated %s backend does not kill the Node process and the pool recovers', async (mode) => {
  const proxy = await createTestPostgresProxy(url)
  const child = startTestProcess<{ type: 'ready' } | { type: 'recovered'; status: number }>(
    new URL('./fixtures/process/backend-disconnect.ts', import.meta.url),
    { args: [mode], env: { ...process.env, VOICE_RELAY_TEST_DATABASE_URL: proxy.connectionString, TEST_SCHEMA: schema } },
  )
  try {
    expect(await child.next()).toEqual({ type: 'ready' })
    proxy.disconnect()
    child.send({ type: 'resume' })
    expect(await child.next()).toEqual({ type: 'recovered', status: 200 })
    expect((await child.waitForExit()).code).toBe(0)
  } finally {
    await child.close()
    await proxy.close()
  }
})

test('slow RTC admission preserves pool capacity for a real Node HTTP health request', async () => {
  const calls = []
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  const gate = new Promise<void>((r) => {
    release = r
  })
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
  try {
    const allocations = []
    for (let i = 0; i < 3; i++) {
      const a = await provider.allocate('client', { roomKey: `slow-${i}`, generation: 'g1', slots: 1 })
      const token = await provider.join('client', a.id, { identity: `user-${i}`, userId: `user-${i}`, allowScreenShare: false })
      allocations.push({ a, token: token.token })
    }
    for (const { a, token } of allocations) {
      calls.push(
        admit(provider, 'client', a.id, `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(token)}`, async () => {
          entered()
          await gate
        }).catch((error) => error),
      )
    }
    await started
    const address = service.server.address()
    if (!address || typeof address === 'string') throw new Error('missing listener')
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(1000) })
    expect(response.status).toBe(200)
    const path = '/voice-relay/v1/events'
    const api = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      signal: AbortSignal.timeout(1000),
      headers: {
        authorization: `Bearer ${await clientToken('fixture-secret-fixture-secret-fixture-secret')}`,
      },
    })
    expect(api.status).toBe(200)
  } finally {
    release()
    await Promise.allSettled(calls)
    await service.close()
  }
})

test('snapshot cursor cannot include an event committed after participant listing began', async () => {
  const a = await provider.allocate('client', { roomKey: 'snapshot-race', generation: 'g1', slots: 1 })
  const original = provider.livekit.participants.bind(provider.livekit)
  let eventId = '0'
  provider.livekit.participants = async (allocation) => {
    const list = await original(allocation)
    const webhook = provider.livekit.webhook
    provider.livekit.webhook = async () =>
      ({ id: randomUUID(), event: 'participant_joined', room: { name: roomName(allocation) } }) as Awaited<ReturnType<LiveKit['webhook']>>
    try {
      await provider.webhook('{}', 'fixture')
    } finally {
      provider.livekit.webhook = webhook
    }
    const feed = await provider.events('client')
    eventId = feed.events.at(-1)?.revision ?? '0'
    return list
  }
  try {
    const snapshot = await provider.snapshot('client', a.id)
    expect(BigInt(snapshot.revision)).toBeLessThan(BigInt(eventId))
  } finally {
    provider.livekit.participants = original
  }
})

test('event recovery either receives a retained event or detects a pruned gap', async () => {
  const a = await provider.allocate('client', { roomKey: 'prune-race', generation: 'g1', slots: 1 })
  const prior = await provider.events('client')
  const webhook = provider.livekit.webhook
  provider.livekit.webhook = async () =>
    ({ id: randomUUID(), event: 'participant_joined', room: { name: roomName(a) } }) as Awaited<ReturnType<LiveKit['webhook']>>
  try {
    await provider.webhook('{}', 'fixture')
  } finally {
    provider.livekit.webhook = webhook
  }
  await expireClientEvents(store, 'client')
  const before = await provider.events('client', prior.cursor)
  expect(before.events.some((event) => event.type === 'participant_joined')).toBe(true)

  await provider.prune()

  const after = await provider.events('client', prior.cursor)
  expect(after.gap).toBe(true)
})

test('capacity declines new rooms when the client limit is full', async () => {
  const isolated = await createTestDatabase({
    connectionString: url,
    initialize: async (fixture) => {
      await fixture.store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://limited.test', enabled: true, maxSlots: 1, maxRooms: 2 })
    },
  })
  const limited = new Provider(isolated.store, roomScope.attach(new LiveKit(testLiveKit)), provider.limits)
  let allocation: Awaited<ReturnType<typeof limited.allocate>> | undefined
  try {
    allocation = await limited.allocate('client', { roomKey: 'client-limit', generation: 'g1', slots: 1 })
    expect((await limited.capacity('client')).accepting).toBe(false)
  } finally {
    if (allocation) await limited.end('client', allocation.id)
    await isolated.close()
  }
})

test('authentication does not synchronously read the key file on the event loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-key-trace-'))
  const keyfile = join(dir, 'keys.json')
  await writeFile(keyfile, '{}')
  const child = startTestProcess<{ type: 'result'; status: number; reads: number }>(
    new URL('./fixtures/process/key-read.ts', import.meta.url),
    { env: { ...process.env, TEST_DB: url, TEST_SCHEMA: schema, TEST_KEYS: keyfile }, execArgv: ['--trace-sync-io'] },
  )
  try {
    expect(await child.next()).toEqual({ type: 'result', status: 401, reads: 0 })
    expect((await child.waitForExit()).code).toBe(0)
  } finally {
    await child.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('RTC HTTP requests traverse the real Node adapter to LiveKit', async () => {
  const secret = 'fixture-secret-fixture-secret-fixture-secret'
  const a = await provider.allocate('client', { roomKey: 'node-rtc', generation: 'g1', slots: 1 })
  const token = await provider.join('client', a.id, { identity: 'node-rtc', userId: 'node-rtc', allowScreenShare: false })
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
    { store, migrate: false, startWorkers: false, loadSecrets: () => ({ client: secret }) },
  )
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  try {
    const address = service.server.address()
    if (!address || typeof address === 'string') throw new Error('missing listener')
    const path = `/voice-relay/v1/allocations/${a.id}/rtc/validate?access_token=${encodeURIComponent(token.token)}`
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: {
        authorization: `Bearer ${await clientToken(secret)}`,
      },
    })
    expect(response.status).toBe(200)
  } finally {
    await service.close()
    await provider.end('client', a.id)
  }
})

test('a sweep can defer retention while continuing allocation reconciliation', async () => {
  const a = await provider.allocate('client', { roomKey: 'deferred-retention', generation: 'g1', slots: 1 })
  await expireAllocationEvents(store, a.id)
  await provider.sweep(false)
  expect((await provider.events('client')).events.some((event) => event.allocationId === a.id)).toBe(true)
  await provider.sweep(true)
  expect((await provider.events('client')).events.some((event) => event.allocationId === a.id)).toBe(false)
})
