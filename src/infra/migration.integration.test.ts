// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { addTestClient } from './test-data.ts'
import { createTestDatabase, legacyClientExists, prepareLegacyClient } from './test-database.ts'

const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'

test('repeated relay initialization preserves the client and installation identity', async () => {
  const database = await createTestDatabase({ connectionString: url, migrate: false })
  try {
    await database.store.migrate()
    const installationId = await database.store.installationId()
    await addTestClient(database.store, 'client')

    await database.store.migrate()
    await database.store.migrate()

    expect(await database.store.installationId()).toBe(installationId)
    expect((await database.store.client('client')).enabled).toBe(true)
  } finally {
    await database.close()
  }
})

test('relay refuses an untracked legacy schema and preserves its data', async () => {
  const database = await createTestDatabase({ connectionString: url, migrate: false })
  try {
    await prepareLegacyClient(database, 'preserve')

    await expect(database.store.migrate()).rejects.toThrow('Existing schema has no Drizzle migration history')

    expect(await legacyClientExists(database, 'preserve')).toBe(true)
  } finally {
    await database.close()
  }
})
