// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { type Allocation, type Client, RelayError } from '../relay/types.ts'
import { allocations, clients, events, relayInstallation } from './schema.ts'

type LifecycleCount = { active: number; waiters: Array<() => void> }
const lifecycleCounts = new WeakMap<Pool, LifecycleCount>()
const failures = new WeakMap<PoolClient, { error?: Error; listener: (error: Error) => void }>()

export async function checkout(pool: Pool): Promise<PoolClient> {
  const db = await pool.connect()
  const state: { error?: Error; listener: (error: Error) => void } = {
    listener: (error) => {
      state.error = error
    },
  }
  failures.set(db, state)
  db.on('error', state.listener)
  return db
}

export function discard(db: PoolClient, error: unknown) {
  const state = failures.get(db)
  if (state) state.error = error instanceof Error ? error : new Error('Database connection failed')
}

export function release(db: PoolClient) {
  const state = failures.get(db)
  db.release(state?.error)
  if (state) db.removeListener('error', state.listener)
  failures.delete(db)
}

export class Store {
  private connection = new AsyncLocalStorage<PoolClient>()
  private transaction = new AsyncLocalStorage<boolean>()
  private lifecycleContext = new AsyncLocalStorage<boolean>()
  private lifecycleCount: LifecycleCount
  public pool: Pool
  private admissions = 0
  private installation?: Promise<string>
  constructor(pool: Pool) {
    this.pool = pool
    this.lifecycleCount = lifecycleCounts.get(pool) ?? { active: 0, waiters: [] }
    lifecycleCounts.set(pool, this.lifecycleCount)
    pool.on('error', () => console.error('PostgreSQL idle connection failed'))
  }
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    return (this.connection.getStore() ?? this.pool).query<R>(text, values)
  }

  get db() {
    return drizzle(this.connection.getStore() ?? this.pool)
  }

  async migrate() {
    const db = await checkout(this.pool)
    let locked = false
    let failed = false
    try {
      await db.query('SELECT pg_advisory_lock($1)', [1789102026])
      locked = true
      const result = await db.query(`SELECT current_schema() AS schema,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='clients') AS has_clients,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='__drizzle_migrations') AS has_ledger`)
      const { schema, has_clients: hasClients, has_ledger: hasLedger } = result.rows[0]
      if (!schema) throw new Error('No current database schema')
      if (hasClients && !hasLedger) throw new Error('Existing schema has no Drizzle migration history')
      await migrate(drizzle(db), {
        migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)),
        migrationsSchema: schema,
      })
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        if (locked) await this.unlockMigration(db, failed)
      } finally {
        release(db)
      }
    }
  }

  private async unlockMigration(db: PoolClient, failed: boolean) {
    try {
      await db.query('SELECT pg_advisory_unlock($1)', [1789102026])
    } catch (error) {
      discard(db, error)
      if (!failed) throw error
    }
  }

  async installationId(): Promise<string> {
    if (!this.installation) {
      const pending = this.db
        .insert(relayInstallation)
        .values({ singleton: true, installationId: randomUUID() })
        .onConflictDoUpdate({ target: relayInstallation.singleton, set: { singleton: true } })
        .returning({ id: relayInstallation.installationId })
        .then((rows) => rows[0].id)
      this.installation = pending
      void pending.catch(() => {
        if (this.installation === pending) this.installation = undefined
      })
    }
    return this.installation
  }

  async admission<T>(fn: () => Promise<T>): Promise<T> {
    // 인증, 상태 확인, 정리에 사용할 연결을 최소 하나 남깁니다.
    const max = this.pool.options.max ?? 10
    const limit = max < 2 ? 0 : Math.max(1, max - 2)
    if (this.admissions >= limit) throw new RelayError('RATE_LIMITED', 429)
    this.admissions++
    try {
      return await this.lifecycle(fn, false)
    } finally {
      this.admissions--
    }
  }

  async lifecycle<T>(fn: () => Promise<T>, wait = true): Promise<T> {
    if (this.lifecycleContext.getStore()) return fn()
    const max = this.pool.options.max ?? 10
    const limit = max < 2 ? 0 : Math.max(1, max - 2)
    if (limit === 0) throw new RelayError('RATE_LIMITED', 429)
    if (this.lifecycleCount.active >= limit) {
      if (!wait || this.lifecycleCount.waiters.length >= 64) throw new RelayError('RATE_LIMITED', 429)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          const index = this.lifecycleCount.waiters.indexOf(ready)
          if (index >= 0) this.lifecycleCount.waiters.splice(index, 1)
          reject(new RelayError('RATE_LIMITED', 429))
        }, 10000)
        this.lifecycleCount.waiters.push(ready)
      })
    } else this.lifecycleCount.active++
    try {
      return await this.lifecycleContext.run(true, fn)
    } finally {
      const next = this.lifecycleCount.waiters.shift()
      if (next) next()
      else this.lifecycleCount.active--
    }
  }

  async tx<T>(fn: (db: PoolClient) => Promise<T>, lock = 1789102026): Promise<T> {
    if (this.transaction.getStore()) throw new Error('Nested transactions are not supported')
    const existing = this.connection.getStore()
    const db = existing ?? (await checkout(this.pool))
    try {
      await db.query('BEGIN')
      await db.query('SELECT pg_advisory_xact_lock($1)', [lock])
      const result = await this.connection.run(db, () => this.transaction.run(true, () => fn(db)))
      await db.query('COMMIT')
      return result
    } catch (err) {
      try {
        await db.query('ROLLBACK')
      } catch (rollbackError) {
        discard(db, rollbackError)
      }
      throw err
    } finally {
      if (!existing) release(db)
    }
  }

  async serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.lifecycle(() => this.serializedLocked(id, fn))
  }

  private async serializedLocked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.connection.getStore()
    const db = existing ?? (await checkout(this.pool))
    let locked = false
    let failed = false
    let previousTimeout: string | undefined
    try {
      previousTimeout = (await db.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout
      await db.query("SET lock_timeout='5s'")
      await db.query('SELECT pg_advisory_lock(hashtextextended($1,1789102026))', [id])
      locked = true
      return await this.connection.run(db, fn)
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        await this.unlockAndRestore(db, id, locked, previousTimeout, failed)
      } finally {
        if (!existing) release(db)
      }
    }
  }

  private async unlockAndRestore(db: PoolClient, id: string, locked: boolean, timeout: string | undefined, failed: boolean) {
    let unlockError: unknown
    try {
      if (locked) await this.unlock(db, id, failed)
    } catch (error) {
      unlockError = error
    }
    if (timeout !== undefined) await this.restoreTimeout(db, timeout, failed || unlockError !== undefined)
    if (unlockError !== undefined) throw unlockError
  }

  private async restoreTimeout(db: PoolClient, timeout: string, failed: boolean) {
    try {
      await db.query("SELECT set_config('lock_timeout',$1,false)", [timeout])
    } catch (error) {
      discard(db, error)
      if (!failed) throw error
    }
  }

  private async unlock(db: PoolClient, id: string, failed: boolean) {
    try {
      await db.query('SELECT pg_advisory_unlock(hashtextextended($1,1789102026))', [id])
    } catch (err) {
      discard(db, err)
      if (!failed) throw err
    }
  }

  async limitClientRequests(clientId: string): Promise<void> {
    const result = await this.db.execute(sql`
      INSERT INTO client_request_limits (client_id, timestamps)
      VALUES (${clientId}, ARRAY[clock_timestamp()])
      ON CONFLICT (client_id) DO UPDATE
      SET timestamps = array_append(
        ARRAY(SELECT item FROM unnest(client_request_limits.timestamps) AS item WHERE item > clock_timestamp() - interval '60 seconds'),
        clock_timestamp()
      )
      WHERE cardinality(ARRAY(SELECT item FROM unnest(client_request_limits.timestamps) AS item WHERE item > clock_timestamp() - interval '60 seconds')) < 300
      RETURNING client_id
    `)
    if (result.rowCount === 0) throw new RelayError('RATE_LIMITED', 429)
  }

  async clientByOrigin(origin: string): Promise<Client | undefined> {
    const [row] = await this.db.select().from(clients).where(eq(clients.origin, origin))
    return row
  }

  async client(id: string): Promise<Client> {
    const [row] = await this.db.select().from(clients).where(eq(clients.id, id))
    if (!row) throw new RelayError('UNAUTHORIZED', 401)
    return row
  }

  async get(clientId: string, id: string): Promise<Allocation> {
    const [row] = await this.db
      .select()
      .from(allocations)
      .where(and(eq(allocations.clientId, clientId), eq(allocations.id, id)))
    if (!row) throw new RelayError('NOT_FOUND', 404)
    return typedAllocation(row)
  }

  async event(db: PoolClient, a: Allocation, type: string) {
    const orm = drizzle(db)
    const [event] = await orm
      .insert(events)
      .values({ clientId: a.clientId, allocationId: a.id, generation: a.generation, type })
      .returning({ id: events.id })
    await orm.update(allocations).set({ revision: event.id }).where(eq(allocations.id, a.id))
  }
}

export function typedAllocation(row: typeof allocations.$inferSelect): Allocation {
  return {
    id: row.id,
    clientId: row.clientId,
    roomKey: row.roomKey,
    generation: row.generation,
    reservedSlots: row.slots,
    state: row.state,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}
