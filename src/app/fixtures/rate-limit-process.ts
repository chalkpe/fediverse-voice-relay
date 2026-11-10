// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { Pool } from 'pg'
import { Store } from '../../infra/store.ts'
import { testLiveKit } from '../../infra/test-livekit.ts'
import { clientToken } from '../../relay/fixtures/client-token.ts'
import { createServer } from '../server.ts'

const schema = process.env.TEST_SCHEMA ?? ''
if (!/^relay_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid test schema')
const url = process.env.VOICE_RELAY_TEST_DATABASE_URL
if (!url) throw new Error('Missing test database')
const store = new Store(new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 }))
const secret = 's'.repeat(64)
const app = await createServer(
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
  { store, migrate: false, startWorkers: false, loadSecrets: () => ({ a: secret }) },
)
const authorization = `Bearer ${await clientToken(secret, 'https://a.test')}`
process.send?.({ type: 'ready' })
await new Promise<void>((resolve) => process.once('message', () => resolve()))
try {
  const responses = await Promise.all(
    Array.from({ length: 155 }, () => app.app.request('/voice-relay/v1/events', { headers: { authorization } })),
  )
  process.send?.({
    type: 'result',
    accepted: responses.filter((response) => response.status === 200).length,
    limited: responses.filter((response) => response.status === 429).length,
  })
} finally {
  await app.close()
  await store.pool.end()
  process.disconnect?.()
}
