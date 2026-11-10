// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client'
import { ne, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { allocations } from './schema.ts'
import { checkout, discard, release } from './store.ts'

// 프로세스 수집기는 공유하고 요청 registry는 서비스별로 분리합니다.
type Aggregate = { pending?: Promise<void>; nextRefresh: number; active: number; slots: number; up: number; lastSuccess: number }
const aggregates = new WeakMap<Pool, Aggregate>()
const processRegistry = new Registry()
collectDefaultMetrics({ register: processRegistry })

export interface Metrics extends Disposable {
  sfuFailure(): void
  observe(method: string, route: string, status: number, seconds: number): void
  readonly contentType: string
  scrape(): Promise<string>
}

export function createMetrics(pool: Pool): Metrics {
  let disposed = false
  const registry = new Registry()
  const requests = new Counter({
    name: 'voice_relay_http_requests_total',
    help: 'HTTP requests by route and status',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  })
  const duration = new Histogram({
    name: 'voice_relay_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  })
  const apiFailures = new Counter({
    name: 'voice_relay_api_failures_total',
    help: 'HTTP responses with a client or server error',
    registers: [registry],
  })
  const sfuFailures = new Counter({ name: 'voice_relay_sfu_failures_total', help: 'Failed LiveKit API requests', registers: [registry] })
  const active = new Gauge({ name: 'voice_relay_active_allocations', help: 'Active allocations', registers: [registry] })
  const slots = new Gauge({ name: 'voice_relay_reserved_slots', help: 'Slots reserved by non-ended allocations', registers: [registry] })
  new Gauge({
    name: 'voice_relay_pg_pool_connections',
    help: 'PostgreSQL pool connections and waiters',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      if (disposed) return
      this.set({ state: 'total' }, pool.totalCount)
      this.set({ state: 'idle' }, pool.idleCount)
      this.set({ state: 'waiting' }, pool.waitingCount)
    },
  })
  const up = new Gauge({
    name: 'voice_relay_allocation_metrics_up',
    help: 'Whether the latest allocation aggregate succeeded',
    registers: [registry],
  })
  const lastSuccess = new Gauge({
    name: 'voice_relay_allocation_metrics_last_success_timestamp_seconds',
    help: 'Last successful allocation aggregate time',
    registers: [registry],
  })
  const shared = aggregates.get(pool) ?? { nextRefresh: 0, active: 0, slots: 0, up: 0, lastSuccess: 0 }
  aggregates.set(pool, shared)
  const combined = Registry.merge([processRegistry, registry])
  const timedQuery = (text: string) => ({ text, query_timeout: 150 })

  async function refresh() {
    if (!shared.pending && Date.now() >= shared.nextRefresh) {
      shared.nextRefresh = Date.now() + 5000
      const available = (pool.options?.max ?? 10) - pool.totalCount + pool.idleCount
      if (pool.waitingCount > 0 || available <= 2) shared.up = 0
      else {
        shared.pending = (async () => {
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            shared.up = 0
          }, 150)
          timer.unref()
          let client: Awaited<ReturnType<typeof checkout>> | undefined
          try {
            client = await checkout(pool)
            clearTimeout(timer)
            if (timedOut) return
            await client.query(timedQuery('BEGIN READ ONLY'))
            await client.query(timedQuery("SET LOCAL statement_timeout='150ms'"))
            await client.query(timedQuery('SET LOCAL enable_seqscan=off'))
            const aggregate = drizzle(client)
              .select({
                active: sql<number>`count(*) FILTER (WHERE ${allocations.state}='active')::int`.as('active'),
                slots: sql<string>`coalesce(sum(${allocations.slots}),0)::bigint`.as('slots'),
              })
              .from(allocations)
              .where(ne(allocations.state, 'ended'))
              .toSQL()
            const queryConfig = { text: aggregate.sql, values: aggregate.params, query_timeout: 150 }
            const result = await client.query<{ active: number; slots: string }>(queryConfig)
            await client.query(timedQuery('COMMIT'))
            shared.active = Number(result.rows[0].active)
            shared.slots = Number(result.rows[0].slots)
            shared.lastSuccess = Date.now() / 1000
            shared.up = 1
          } catch (error) {
            shared.up = 0
            if (client) discard(client, error)
          } finally {
            clearTimeout(timer)
            if (client) release(client)
          }
        })().finally(() => {
          shared.pending = undefined
        })
      }
    }
    if (shared.pending) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        shared.pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            shared.up = 0
            resolve()
          }, 200)
          timer.unref()
        }),
      ])
      if (timer) clearTimeout(timer)
    }
    if (disposed) throw new Error('Metrics disposed')
    active.set(shared.active)
    slots.set(shared.slots)
    up.set(shared.up)
    lastSuccess.set(shared.lastSuccess)
  }

  return {
    sfuFailure: () => {
      if (!disposed) sfuFailures.inc()
    },
    observe(method: string, route: string, status: number, seconds: number) {
      if (disposed) return
      const labels = { method, route, status: String(status) }
      requests.inc(labels)
      duration.observe(labels, seconds)
      if (status >= 400) apiFailures.inc()
    },
    contentType: combined.contentType,
    async scrape() {
      if (disposed) throw new Error('Metrics disposed')
      await refresh()
      if (disposed) throw new Error('Metrics disposed')
      const result = await combined.metrics()
      if (disposed) throw new Error('Metrics disposed')
      return result
    },
    [Symbol.dispose]() {
      if (disposed) return
      disposed = true
      registry.clear()
      combined.clear()
    },
  }
}
