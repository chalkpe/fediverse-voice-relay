// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from 'node:events'
import type { Pool, PoolClient } from 'pg'
import { expect, test, vi } from 'vitest'
import { Store } from './store.ts'

test('a lifecycle body error survives an adapter unlock failure and discards the connection', async () => {
  const bodyFailure = new Error('body failure')
  const unlockFailure = new Error('unlock failure')
  const release = vi.fn()
  const query = vi.fn(async (statement: string) => {
    if (statement.startsWith('SHOW')) return { rows: [{ lock_timeout: '0' }] }
    if (statement.includes('pg_advisory_unlock')) throw unlockFailure
    return { rows: [] }
  })
  const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient
  const pool = Object.assign(new EventEmitter(), { connect: async () => client, options: { max: 3 } }) as unknown as Pool
  const store = new Store(pool)

  await expect(
    store.serialized('resource', async () => {
      throw bodyFailure
    }),
  ).rejects.toBe(bodyFailure)
  expect(release).toHaveBeenCalledWith(unlockFailure)
})

test('nested lifecycle preserves the body error and releases a failing adapter once', async () => {
  const bodyFailure = new Error('body failure')
  const release = vi.fn()
  const query = vi.fn(async (statement: string) => {
    if (statement.startsWith('SHOW')) return { rows: [{ lock_timeout: '0' }] }
    if (statement.includes('pg_advisory_unlock')) throw new Error('unlock failure')
    return { rows: [] }
  })
  const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient
  const pool = Object.assign(new EventEmitter(), { connect: async () => client, options: { max: 2 } }) as unknown as Pool
  const store = new Store(pool)

  await expect(
    store.serialized('outer', () =>
      store.serialized('inner', async () => {
        throw bodyFailure
      }),
    ),
  ).rejects.toBe(bodyFailure)
  expect(release).toHaveBeenCalledTimes(1)
})

test.each([1, 2])('admission honors the connection limit for a pool of %i', async (max) => {
  const pool = Object.assign(new EventEmitter(), { options: { max } }) as unknown as Pool
  const store = new Store(pool)
  if (max === 1) {
    await expect(store.admission(async () => {})).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    return
  }

  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = store.admission(() => gate)
  try {
    await expect(store.admission(async () => {})).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
  } finally {
    release()
    await first
  }
  await expect(store.admission(async () => 'ok')).resolves.toBe('ok')
})

test('a lifecycle restores the previous adapter lock timeout', async () => {
  const query = vi.fn(async (statement: string) => ({ rows: statement.startsWith('SHOW') ? [{ lock_timeout: '7s' }] : [] }))
  const client = Object.assign(new EventEmitter(), { query, release: vi.fn() }) as unknown as PoolClient
  const pool = Object.assign(new EventEmitter(), { connect: async () => client, options: { max: 2 } }) as unknown as Pool
  const store = new Store(pool)

  await store.serialized('resource', async () => {})

  expect(query).toHaveBeenCalledWith(expect.stringContaining('set_config'), ['7s'])
})
