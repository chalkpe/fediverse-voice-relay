// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { createTestDatabase, testSchemaExists } from './test-database.ts'

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'

test('a failed initialization closes its pool and removes only its own schema', async () => {
  let schema = ''
  let pool: Pool | undefined
  try {
    await expect(
      createTestDatabase({
        connectionString: url,
        max: 2,
        connectionTimeoutMillis: 500,
        initialize: async (database) => {
          schema = database.schema
          pool = database.store.pool
          throw new Error('fixture initialization failed')
        },
      }),
    ).rejects.toThrow('fixture initialization failed')
    expect(schema).not.toBe('')
    expect(pool?.ended).toBe(true)
    expect(await testSchemaExists(url, schema)).toBe(false)
  } finally {
    if (schema) expect(await testSchemaExists(url, schema)).toBe(false)
  }
})
