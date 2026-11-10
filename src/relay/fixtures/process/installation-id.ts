// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { Pool } from 'pg'
import { Store } from '../../../infra/store.ts'

const { TEST_URL, TEST_SCHEMA } = process.env
if (!TEST_URL || !TEST_SCHEMA || !/^[a-z0-9_]+$/.test(TEST_SCHEMA)) throw new Error('Invalid test database settings')
const pool = new Pool({ connectionString: TEST_URL, options: `-c search_path=${TEST_SCHEMA}` })
try {
  const id = await new Store(pool).installationId()
  process.send?.({ type: 'installation', id })
} finally {
  await pool.end()
  process.disconnect?.()
}
