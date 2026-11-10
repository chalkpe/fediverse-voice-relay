// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { createMetrics } from './metrics.ts'

test('isolated registries stay responsive when the pool never connects', async () => {
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 1, connect: () => new Promise(() => {}) } as unknown as Pool
  vi.useFakeTimers()
  const first = createMetrics(pool)
  const second = createMetrics(pool)
  try {
    first.observe('GET', 'unknown', 404, 0.01)
    const pending = Promise.all([first.scrape(), second.scrape()])
    await vi.advanceTimersByTimeAsync(200)
    const [a, b] = await pending
    expect(a).toContain('voice_relay_http_requests_total{method="GET",route="unknown",status="404"} 1')
    expect(b).not.toContain('voice_relay_http_requests_total{method=')
    expect(a).toContain('voice_relay_pg_pool_connections{state="waiting"} 1')
  } finally {
    first[Symbol.dispose]()
    second[Symbol.dispose]()
    vi.useRealTimers()
  }
})

test('discards a checked-out connection that emits an error and can refresh on a later scrape', async () => {
  const { EventEmitter } = await import('node:events')
  const failure = new Error('connection lost')
  const bad = Object.assign(new EventEmitter(), {
    query: async () => {
      expect(bad.listenerCount('error')).toBeGreaterThan(0)
      bad.emit('error', failure)
      throw failure
    },
    release: vi.fn(),
  })
  const good = Object.assign(new EventEmitter(), {
    query: async (query: { text: string }) =>
      query.text.toLowerCase().startsWith('select count') ? { rows: [{ active: 2, slots: 4 }] } : { rows: [] },
    release: vi.fn(),
  })
  const pool = {
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good),
  } as unknown as Pool
  vi.useFakeTimers()
  const metrics = createMetrics(pool)
  try {
    await metrics.scrape()
    expect(bad.release).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await metrics.scrape()).toContain('voice_relay_active_allocations 2')
    expect(good.release).toHaveBeenCalled()
  } finally {
    metrics[Symbol.dispose]()
    vi.useRealTimers()
  }
})

test('releases a connection that arrives after the checkout timeout and retries', async () => {
  const { EventEmitter } = await import('node:events')
  let connected!: (client: unknown) => void
  const late = Object.assign(new EventEmitter(), { release: vi.fn() })
  const good = Object.assign(new EventEmitter(), {
    query: async (query: { text: string }) =>
      query.text.toLowerCase().startsWith('select count') ? { rows: [{ active: 3, slots: 5 }] } : { rows: [] },
    release: vi.fn(),
  })
  const connect = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        connected = resolve
      }),
    )
    .mockResolvedValueOnce(good)
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 0, connect } as unknown as Pool
  vi.useFakeTimers()
  const metrics = createMetrics(pool)
  try {
    const scrape = metrics.scrape()
    await vi.advanceTimersByTimeAsync(200)
    await scrape
    connected(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.release).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4800)
    expect(await metrics.scrape()).toContain('voice_relay_active_allocations 3')
  } finally {
    metrics[Symbol.dispose]()
    vi.useRealTimers()
  }
})

test('concurrent scrapes share a refresh and retain failure status when the pool is busy', async () => {
  const { EventEmitter } = await import('node:events')
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  let aggregates = 0
  let notifyStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const client = Object.assign(new EventEmitter(), {
    query: async (query: { text: string }) => {
      if (query.text.toLowerCase().startsWith('select count')) {
        aggregates++
        notifyStarted()
        await gate
        return { rows: [{ active: 2, slots: 4 }] }
      }
      return { rows: [] }
    },
    release: vi.fn(),
  })
  const pool = {
    options: { max: 5 },
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool
  const metrics = createMetrics(pool)
  try {
    const scrapes = [metrics.scrape(), metrics.scrape(), metrics.scrape()]
    await started
    finish()
    const result = await Promise.all(scrapes)
    expect(aggregates).toBe(1)
    expect(result[0]).toContain('voice_relay_allocation_metrics_up 1')
    Object.defineProperty(pool, 'waitingCount', { value: 1, configurable: true })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 5000)
    const stale = await metrics.scrape()
    expect(stale).toContain('voice_relay_allocation_metrics_up 0')
    expect(stale).toContain('voice_relay_active_allocations 2')
    expect(aggregates).toBe(1)
  } finally {
    finish()
    metrics[Symbol.dispose]()
    vi.useRealTimers()
  }
})

test('disposal during a scrape does not update its registry or dispose shared collectors', async () => {
  const { EventEmitter } = await import('node:events')
  let finish!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const client = Object.assign(new EventEmitter(), {
    query: async (query: { text: string }) => {
      if (query.text.toLowerCase().startsWith('select count')) {
        started()
        await gate
        return { rows: [{ active: 2, slots: 4 }] }
      }
      return { rows: [] }
    },
    release: vi.fn(),
  })
  const pool = {
    options: { max: 5 },
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool
  const first = createMetrics(pool)
  const second = createMetrics(pool)
  try {
    const scrape = first.scrape()
    await entered
    first[Symbol.dispose]()
    first[Symbol.dispose]()
    finish()
    await expect(scrape).rejects.toThrow('Metrics disposed')
    await expect(first.scrape()).rejects.toThrow('Metrics disposed')
    expect(await second.scrape()).toContain('process_')
    expect(client.release).toHaveBeenCalledOnce()
  } finally {
    finish()
    second[Symbol.dispose]()
  }
})

test('using disposes metrics at the end of its scope', async () => {
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 1 } as unknown as Pool
  let metrics: ReturnType<typeof createMetrics>
  {
    using scoped = createMetrics(pool)
    metrics = scoped
    expect(await scoped.scrape()).toContain('voice_relay_allocation_metrics_up 0')
  }
  await expect(metrics.scrape()).rejects.toThrow('Metrics disposed')
})
