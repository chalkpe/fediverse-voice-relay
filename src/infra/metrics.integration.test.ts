// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vitest'
import { createServer } from '../app/server.ts'
import { createTestDatabase } from './test-database.ts'
import { createTestPostgresProxy } from './test-postgres-proxy.ts'

test('metrics recover after an actual database connection drops', async () => {
  const base = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const database = await createTestDatabase({ connectionString: base })
  const proxy = await createTestPostgresProxy(base)
  const connection = database.connect({ connectionString: proxy.connectionString })
  let service: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    service = await createServer(
      {
        databaseUrl: '',
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'https://relay.test',
        clientSecretFile: '',
        maxSlots: 10,
        maxRooms: 10,
        iceServers: null,
        livekit: { url: 'http://127.0.0.1:1', apiKey: 'unused', apiSecret: 'unused' },
      },
      { store: connection.store, migrate: false, startWorkers: false, loadSecrets: () => ({}) },
    )
    const running = service
    await new Promise<void>((resolve) => running.metricsServer.listen(0, '127.0.0.1', resolve))
    const port = (running.metricsServer.address() as AddressInfo).port
    vi.useFakeTimers({ toFake: ['Date'] })
    const acquired = connection.nextCheckout()
    const first = fetch(`http://127.0.0.1:${port}/metrics`)
    await acquired
    proxy.disconnect()
    const failed = await first
    expect(failed.status).toBe(200)
    expect(await failed.text()).toContain('voice_relay_allocation_metrics_up 0')

    vi.setSystemTime(Date.now() + 5000)
    const second = await fetch(`http://127.0.0.1:${port}/metrics`)
    expect(second.status).toBe(200)
    const output = await second.text()
    expect(output).toContain('voice_relay_active_allocations 0')
    expect(output).toContain('voice_relay_allocation_metrics_up 1')
  } finally {
    vi.useRealTimers()
    await service?.close()
    await connection.close()
    await proxy.close()
    await database.close()
  }
}, 15000)
