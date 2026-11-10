// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import { createServer } from '../../../app/server.ts'
import { Store } from '../../../infra/store.ts'
import { testLiveKit } from '../../../infra/test-livekit.ts'
import { clientToken } from '../client-token.ts'

const connectionString = process.env.VOICE_RELAY_TEST_DATABASE_URL
const schema = process.env.TEST_SCHEMA
const mode = process.argv[2]
if (!connectionString || !schema || !/^[a-z0-9_]+$/.test(schema) || (mode !== 'idle' && mode !== 'checked-out')) {
  throw new Error('Invalid test process arguments')
}
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 })
const store = new Store(pool)
const service = await createServer(
  {
    databaseUrl: connectionString,
    publicUrl: 'https://relay.test',
    clientSecretFile: '',
    host: '127.0.0.1',
    port: 0,
    livekit: { ...testLiveKit, url: 'http://127.0.0.1:1' },
    maxSlots: 10,
    maxRooms: 10,
    iceServers: null,
  },
  {
    store,
    migrate: false,
    startWorkers: false,
    loadSecrets: () => ({ client: 'fixture-secret-fixture-secret-fixture-secret' }),
  },
)
try {
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
  const port = (service.server.address() as AddressInfo).port
  const capacity = async () => {
    const path = '/voice-relay/v1/capacity'
    return fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        authorization: `Bearer ${await clientToken('fixture-secret-fixture-secret-fixture-secret')}`,
      },
    })
  }
  if ((await capacity()).status !== 200) throw new Error('Capacity request failed before disconnect')
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const operation =
    mode === 'checked-out'
      ? store
          .serialized('test', async () => {
            entered()
            await gate
          })
          .catch(() => {})
      : undefined
  if (operation) await ready
  const removed = once(pool, 'remove')
  process.send?.({ type: 'ready' })
  const [message] = await once(process, 'message')
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'resume') throw new Error('Invalid test message')
  release()
  await operation
  await removed
  const response = await capacity()
  process.send?.({ type: 'recovered', status: response.status })
} finally {
  await service.close()
  await pool.end()
  process.disconnect?.()
}
