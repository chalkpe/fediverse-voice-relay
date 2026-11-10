// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { startTestProcess } from '../infra/test-process.ts'
import { Provider } from './provider.ts'
import { roomMetadata, roomName } from './room.ts'
import type { Allocation } from './types.ts'

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = []
const providers: Provider[] = []
const names = new Set<string>()
const allocated: { provider: Provider; allocation: Allocation }[] = []
const limits = { maxSlots: 10, maxRooms: 10, mediaProvider: 'https://relay.test', iceServers: null }
const sfu = new LiveKit(testLiveKit)

async function allocate(index: number): Promise<Allocation> {
  const provider = providers[index]
  const allocation = await provider.allocate('client', { roomKey: randomUUID(), generation: '1', slots: 1 })
  names.add(roomName(allocation))
  allocated.push({ provider, allocation })
  return allocation
}

async function createOrphan(installationId: string): Promise<string> {
  const name = `voice-relay:client:${randomUUID()}`
  names.add(name)
  await sfu.client.createRoom({ name, metadata: roomMetadata(installationId) })
  return name
}

async function rooms(...requested: string[]) {
  return requested.length ? sfu.client.listRooms(requested) : []
}

async function metadata(name: string): Promise<string> {
  const room = (await rooms(name))[0]
  if (!room) throw new Error('Test room not found')
  return room.metadata
}

beforeAll(async () => {
  const list = sfu.client.listRooms.bind(sfu.client)
  sfu.client.listRooms = async (requested) => {
    const safe = requested?.length ? requested.filter((name) => names.has(name)) : [...names]
    return safe.length ? list(safe) : []
  }

  for (let index = 0; index < 2; index++) {
    const database = await createTestDatabase({
      connectionString: url,
      max: 4,
      initialize: async (fixture) => {
        await fixture.store.db
          .insert(clients)
          .values({ id: 'client', origin: 'https://test.example', enabled: true, maxSlots: 10, maxRooms: 10 })
      },
    })
    databases.push(database)
    providers.push(new Provider(database.store, sfu, { ...limits, reconcileOrphans: true }))
  }
})

afterEach(async () => {
  try {
    for (const item of allocated) await item.provider.end('client', item.allocation.id).catch(() => {})
  } finally {
    for (const name of names) await sfu.client.deleteRoom(name).catch(() => {})
    allocated.length = 0
    names.clear()
  }
})

afterAll(async () => {
  for (const database of databases) await database.close()
})

test('concurrent initialization uses one persistent ID per installation', async () => {
  const connection = databases[0].connect({ max: 8 })
  const other = connection.store
  try {
    const processes = [0, 1].map(async () => {
      const child = startTestProcess<{ type: 'installation'; id: string }>(
        new URL('./fixtures/process/installation-id.ts', import.meta.url),
        {
          env: { ...process.env, TEST_URL: url, TEST_SCHEMA: databases[0].schema },
        },
      )
      try {
        const message = await child.next()
        expect(message.type).toBe('installation')
        expect((await child.waitForExit()).code).toBe(0)
        return message.id
      } finally {
        await child.close()
      }
    })

    const ids = await Promise.all([
      ...processes,
      ...Array.from({ length: 20 }, (_, i) => (i % 2 ? other : databases[0].store).installationId()),
    ])
    expect(new Set(ids).size).toBe(1)
    expect(await databases[1].store.installationId()).not.toBe(ids[0])
  } finally {
    await connection.close()
  }
})

test('a sweep cannot delete another installation room for the same client', async () => {
  const own = await allocate(0)
  const foreign = await allocate(1)
  const expected = [roomName(own), roomName(foreign)].sort()

  await providers[0].sweep(false)

  expect((await rooms(...expected)).map((room) => room.name).sort()).toEqual(expected)
})

test('another installation cannot claim an existing room', async () => {
  const allocation = await allocate(0)
  const name = roomName(allocation)
  const original = await metadata(name)

  await expect(providers[1].livekit.ensure(allocation, await databases[1].store.installationId())).rejects.toMatchObject({
    code: 'ALLOCATION_CONFLICT',
  })
  expect(await metadata(name)).toBe(original)
})

test('a room with foreign ownership cannot be deleted by the previous owner', async () => {
  const allocation = await allocate(0)
  const name = roomName(allocation)
  const original = await metadata(name)
  const foreign = roomMetadata(await databases[1].store.installationId())
  try {
    await sfu.client.updateRoomMetadata(name, foreign)
    await expect(providers[0].end('client', allocation.id)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' })
    expect((await providers[0].allocation('client', allocation.id)).state).toBe('ending')
    expect(await metadata(name)).toBe(foreign)
  } finally {
    await sfu.client.updateRoomMetadata(name, original)
  }
})

test('sweep removes its own orphan and preserves another installation orphan', async () => {
  const own = await createOrphan(await databases[0].store.installationId())
  const foreign = await createOrphan(await databases[1].store.installationId())

  await providers[0].sweep(false)

  expect((await rooms(own, foreign)).map((room) => room.name)).toEqual([foreign])
})

test('a legacy allocation with empty metadata can still end', async () => {
  const allocation = await allocate(1)
  const name = roomName(allocation)
  await sfu.client.updateRoomMetadata(name, '')

  await providers[1].livekit.ensure(allocation, await databases[1].store.installationId())
  expect(await metadata(name)).toBe('')
  await providers[1].end('client', allocation.id)
  expect(await rooms(name)).toHaveLength(0)
})

test('a different installation preserves old and unowned orphan rooms', async () => {
  const name = await createOrphan(await databases[0].store.installationId())

  await providers[1].sweep(false)
  expect(await rooms(name)).toHaveLength(1)
  await sfu.client.updateRoomMetadata(name, '')
  await providers[1].sweep(false)
  expect(await rooms(name)).toHaveLength(1)
})

test('orphan deletion stays disabled unless explicitly enabled', async () => {
  const name = await createOrphan(await databases[0].store.installationId())
  const cautious = new Provider(databases[0].store, sfu, limits)

  await cautious.sweep(false)

  expect(await rooms(name)).toHaveLength(1)
})
