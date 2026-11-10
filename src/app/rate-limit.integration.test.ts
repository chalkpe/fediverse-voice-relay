// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { clients } from '../infra/schema.ts'
import { expireClientRequestWindow } from '../infra/test-data.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { createTestPostgresProxy } from '../infra/test-postgres-proxy.ts'
import { startTestProcess } from '../infra/test-process.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'
import { createServer } from './server.ts'

test('client request limit is shared by independent server instances', async () => {
  const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const database = await createTestDatabase({
    connectionString: url,
    initialize: async ({ store }) => {
      await store.db.insert(clients).values([
        { id: 'a', origin: 'https://a.test', enabled: true, maxSlots: 1, maxRooms: 1 },
        { id: 'b', origin: 'https://b.test', enabled: true, maxSlots: 1, maxRooms: 1 },
      ])
    },
  })
  const second = database.connect({ max: 4 })
  const secret = 's'.repeat(64)
  const config = {
    databaseUrl: url,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://relay.test',
    clientSecretFile: 'unused',
    livekit: testLiveKit,
    maxSlots: 1,
    maxRooms: 1,
    iceServers: null,
  }
  const options = { migrate: false, startWorkers: false, loadSecrets: () => ({ a: secret, b: secret }) }
  const firstServer = await createServer(config, { ...options, store: database.store })
  const secondServer = await createServer(config, { ...options, store: second.store })
  try {
    const auth = `Bearer ${await clientToken(secret, 'https://a.test')}`
    const responses = await Promise.all(
      Array.from({ length: 310 }, (_, index) =>
        (index % 2 ? firstServer : secondServer).app.request('/voice-relay/v1/events', { headers: { authorization: auth } }),
      ),
    )
    expect(responses.filter((response) => response.status === 200)).toHaveLength(300)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(10)
    await expireClientRequestWindow(database.store, 'a')
    expect((await firstServer.app.request('/voice-relay/v1/events', { headers: { authorization: auth } })).status).toBe(200)
    const other = await secondServer.app.request('/voice-relay/v1/events', {
      headers: { authorization: `Bearer ${await clientToken(secret, 'https://b.test')}` },
    })
    expect(other.status).toBe(200)
  } finally {
    await firstServer.close()
    await secondServer.close()
    await second.close()
    await database.close()
  }
}, 30000)

test('independent Node processes share one client request limit', async () => {
  const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const database = await createTestDatabase({
    connectionString: url,
    initialize: async ({ store }) => {
      await store.db.insert(clients).values({ id: 'a', origin: 'https://a.test', enabled: true, maxSlots: 1, maxRooms: 1 })
    },
  })
  type Message = { type: 'ready' } | { type: 'result'; accepted: number; limited: number }
  const children = Array.from({ length: 2 }, () =>
    startTestProcess<Message>(new URL('./fixtures/rate-limit-process.ts', import.meta.url), {
      env: { ...process.env, VOICE_RELAY_TEST_DATABASE_URL: url, TEST_SCHEMA: database.schema },
    }),
  )
  try {
    for (const child of children) expect(await child.next()).toEqual({ type: 'ready' })
    for (const child of children) child.send({ type: 'start' })
    const results = await Promise.all(children.map((child) => child.next()))
    expect(results.every((result) => result.type === 'result')).toBe(true)
    const counts = results.filter((result): result is Extract<Message, { type: 'result' }> => result.type === 'result')
    expect(counts.reduce((total, result) => total + result.accepted, 0)).toBe(300)
    expect(counts.reduce((total, result) => total + result.limited, 0)).toBe(10)
    for (const child of children) expect((await child.waitForExit()).code).toBe(0)
  } finally {
    await Promise.all(children.map((child) => child.close()))
    await database.close()
  }
}, 30000)

test('database outage does not bypass client authentication or request limits', async () => {
  const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const database = await createTestDatabase({
    connectionString: url,
    initialize: async ({ store }) => {
      await store.db.insert(clients).values({ id: 'a', origin: 'https://a.test', enabled: true, maxSlots: 1, maxRooms: 1 })
    },
  })
  const proxy = await createTestPostgresProxy(url)
  const connection = database.connect({ connectionString: proxy.connectionString, connectionTimeoutMillis: 500 })
  const secret = 's'.repeat(64)
  const server = await createServer(
    {
      databaseUrl: url,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'https://relay.test',
      clientSecretFile: 'unused',
      livekit: testLiveKit,
      maxSlots: 1,
      maxRooms: 1,
      iceServers: null,
    },
    { store: connection.store, migrate: false, startWorkers: false, loadSecrets: () => ({ a: secret }) },
  )
  let proxyClosed = false
  try {
    const headers = { authorization: `Bearer ${await clientToken(secret, 'https://a.test')}` }
    expect((await server.app.request('/voice-relay/v1/events', { headers })).status).toBe(200)
    await proxy.close()
    proxyClosed = true
    expect((await server.app.request('/voice-relay/v1/events', { headers })).status).toBe(503)
  } finally {
    await server.close()
    await connection.close()
    if (!proxyClosed) await proxy.close()
    await database.close()
  }
})
