// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import { Store } from '../../../infra/store.ts'
import { testLiveKit } from '../../../infra/test-livekit.ts'
import { clientToken } from '../client-token.ts'

const { TEST_DB, TEST_SCHEMA, TEST_KEYS } = process.env
if (!TEST_DB || !TEST_SCHEMA || !/^[a-z0-9_]+$/.test(TEST_SCHEMA) || !TEST_KEYS) throw new Error('Invalid test process arguments')
let reads = 0
fs.readFileSync = new Proxy(fs.readFileSync, {
  apply(target, thisArg, args: unknown[]) {
    if (args[0] === TEST_KEYS) reads++
    return Reflect.apply(target, thisArg, args)
  },
})
syncBuiltinESMExports()
const { createServer } = await import('../../../app/server.ts')
const pool = new Pool({ connectionString: TEST_DB, options: `-c search_path=${TEST_SCHEMA}` })
const service = await createServer(
  {
    databaseUrl: TEST_DB,
    publicUrl: 'https://relay.test',
    clientSecretFile: TEST_KEYS,
    host: '127.0.0.1',
    port: 0,
    livekit: testLiveKit,
    maxSlots: 100,
    maxRooms: 20,
    iceServers: null,
  },
  { store: new Store(pool), migrate: false, startWorkers: false },
)
try {
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
  const port = (service.server.address() as AddressInfo).port
  const token = await clientToken('fixture-secret-fixture-secret-fixture-secret', 'https://missing.test')
  const headers = { authorization: `Bearer ${token}` }
  const response = await fetch(`http://127.0.0.1:${port}/voice-relay/v1/capacity`, { headers })
  await fetch(`http://127.0.0.1:${port}/voice-relay/v1/capacity`, { headers })
  process.send?.({ type: 'result', status: response.status, reads })
} finally {
  await service.close()
  await pool.end()
  process.disconnect?.()
}
