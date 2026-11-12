// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
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

// 장애 주입 대상이 실제 배정 잠금 연결인지 확인합니다.
export async function testAllocationLockPid(database: TestDatabase, id: string): Promise<number | undefined> {
  const result = await database.admin.query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=1
      AND classid=((hashtextextended($1,1789102026)>>32)&4294967295)::oid
      AND objid=(hashtextextended($1,1789102026)&4294967295)::oid`,
    [id],
  )
  return result.rows[0]?.pid
}

export async function migrateTestDatabaseBeforeRecording(database: TestDatabase) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-before-recording-'))
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url))
  try {
    await mkdir(join(directory, 'meta'))
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'))
    journal.entries = journal.entries.slice(0, 1)
    await writeFile(join(directory, 'meta/_journal.json'), JSON.stringify(journal))
    await copyFile(join(migrations, '001-initial.sql'), join(directory, '001-initial.sql'))
    await migrate(drizzle(database.store.pool), { migrationsFolder: directory, migrationsSchema: database.schema })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function prepareRecordingMigrationParticipant(database: TestDatabase) {
  const generation = randomUUID()
  await database.store.query(
    `INSERT INTO allocations (id,client_id,room_key,generation,slots,state,lease_expires_at)
      VALUES ('preserved-allocation','preserve-recording','room','g1',1,'active',now()+interval '2 minutes')`,
  )
  await database.store.query(
    `INSERT INTO participant_tokens (allocation_id,identity_hash,generation)
      VALUES ('preserved-allocation','preserved-identity',$1)`,
    [generation],
  )
  return generation
}

export async function prepareLegacyClient(database: TestDatabase, clientId: string) {
  await database.store.pool.query('CREATE TABLE clients(id text PRIMARY KEY)')
  await database.store.pool.query('INSERT INTO clients(id) VALUES($1)', [clientId])
}

export async function legacyClientExists(database: TestDatabase, clientId: string): Promise<boolean> {
  return (await database.store.pool.query('SELECT id FROM clients WHERE id=$1', [clientId])).rowCount === 1
}
