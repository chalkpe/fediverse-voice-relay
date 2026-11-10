// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vitest'
import type { Store } from '../infra/store.ts'
import { createServer } from './server.ts'

const config = {
  databaseUrl: '',
  host: '127.0.0.1',
  port: 0,
  publicUrl: 'https://relay.test',
  clientSecretFile: '',
  livekit: { url: 'http://127.0.0.1:1', apiKey: 'fixture', apiSecret: 'fixture' },
  maxSlots: 10,
  maxRooms: 10,
  iceServers: null,
}

function serviceWithProbe(probe: () => Promise<unknown>) {
  const store = { pool: {}, query: probe } as unknown as Store
  return createServer(config, { store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
}

test('concurrent health requests share one pending adapter probe', async () => {
  let release: () => void = () => {}
  let started: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const probe = vi.fn(async () => {
    started()
    await gate
    return {}
  })
  const service = await serviceWithProbe(probe)
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const port = (service.server.address() as AddressInfo).port
  let arrivals = 0
  let allArrived: () => void = () => {}
  const all = new Promise<void>((resolve) => {
    allArrived = resolve
  })
  service.server.on('request', () => {
    if (++arrivals === 10) allArrived()
  })
  try {
    const responses = Promise.all(Array.from({ length: 10 }, () => fetch(`http://127.0.0.1:${port}/health`)))
    await Promise.all([ready, all])
    release()
    expect((await responses).every((response) => response.status === 200)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await service.close()
  }
})

test('health caches successful adapter results but retries failures', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const probe = vi.fn().mockRejectedValueOnce(new Error('injected adapter failure')).mockResolvedValue({})
  const service = await serviceWithProbe(probe)
  try {
    expect((await service.app.request('/health')).status).toBe(503)
    for (let index = 0; index < 10; index++) expect((await service.app.request('/health')).status).toBe(200)
    expect(probe).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
    await service.close()
  }
})

test('an incomplete webhook body is closed at the request deadline', async () => {
  const { connect } = await import('node:net')
  const service = await serviceWithProbe(async () => ({}))
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const port = (service.server.address() as AddressInfo).port
  const socket = connect(port, '127.0.0.1')
  const response = new Promise<string>((resolve, reject) => {
    let body = ''
    socket.on('data', (data) => {
      body += data.toString()
    })
    socket.once('close', () => resolve(body))
    socket.once('error', reject)
    socket.setTimeout(20000, () => reject(new Error('Body deadline did not close the request')))
  })
  try {
    await once(socket, 'connect')
    socket.write('POST /livekit/webhook HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{')
    expect(await response).toMatch(/^HTTP\/1\.1 408/)
  } finally {
    socket.destroy()
    await service.close()
  }
}, 25000)
