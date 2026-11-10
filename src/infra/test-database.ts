// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Store } from './store.ts'

type TestDatabase = {
  schema: string
  admin: Pool
  store: Store
  close: () => Promise<void>
  connect: (options?: { connectionString?: string; max?: number; connectionTimeoutMillis?: number }) => TestConnection
}

type TestConnection = {
  store: Store
  close: () => Promise<void>
  nextCheckout: () => Promise<void>
  nextDisconnect: () => Promise<void>
}

export async function createTestDatabase(options: {
  connectionString: string
  max?: number
  migrate?: boolean
  connectionTimeoutMillis?: number
  initialize?: (database: TestDatabase) => Promise<void>
}): Promise<TestDatabase> {
  const schema = `relay_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: options.connectionString })
  const store = new Store(
    new Pool({
      connectionString: options.connectionString,
      options: `-c search_path=${schema}`,
      max: options.max,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
    }),
  )
  let created = false
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await store.pool.end()
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      } finally {
        await admin.end()
      }
    }
  }
  function connect(config: { connectionString?: string; max?: number; connectionTimeoutMillis?: number } = {}): TestConnection {
    const pool = new Pool({
      connectionString: config.connectionString ?? options.connectionString,
      options: `-c search_path=${schema}`,
      max: config.max,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    })
    return {
      store: new Store(pool),
      close: () => pool.end(),
      nextCheckout: () => new Promise<void>((resolve) => pool.once('acquire', () => resolve())),
      nextDisconnect: () => new Promise<void>((resolve) => pool.once('acquire', (client) => client.once('error', () => resolve()))),
    }
  }
  const database = { schema, admin, store, close, connect }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    created = true
    if (options.migrate !== false) await store.migrate()
    await options.initialize?.(database)
    return database
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

export async function testSchemaExists(connectionString: string, schema: string): Promise<boolean> {
  if (!/^relay_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid test schema')
  const admin = new Pool({ connectionString })
  try {
    return (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount === 1
  } finally {
    await admin.end()
  }
}

export async function prepareLegacyClient(database: TestDatabase, clientId: string) {
  await database.store.pool.query('CREATE TABLE clients(id text PRIMARY KEY)')
  await database.store.pool.query('INSERT INTO clients(id) VALUES($1)', [clientId])
}

export async function legacyClientExists(database: TestDatabase, clientId: string): Promise<boolean> {
  return (await database.store.pool.query('SELECT id FROM clients WHERE id=$1', [clientId])).rowCount === 1
}
