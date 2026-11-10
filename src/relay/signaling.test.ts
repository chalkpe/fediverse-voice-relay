// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import { Hono } from 'hono'
import { expect, test, vi } from 'vitest'
import type { Provider } from './provider.ts'
import { createSignaling, rtcTarget } from './signaling.ts'

function signalingServer(
  provider: Provider,
  authenticate: (request: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, body: string) => Promise<string>,
) {
  const app = new Hono()
  const signaling = createSignaling(provider, authenticate)
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  return { server, close: signaling.close }
}

test('RTC proxy cannot escape the fixed upstream or RTC path', () => {
  for (const path of [
    '/voice-relay/v1/allocations/a/rtc/../admin',
    '/voice-relay/v1/allocations/a/rtc/%2e%2e/admin',
    '/voice-relay/v1/allocations/a/rtc/%252e%252e/admin',
    '/voice-relay/v1/allocations/a/rtc/%2fother',
    '/voice-relay/v1/allocations/a//evil.test/rtc',
  ])
    expect(() => rtcTarget(path, 'a', 'http://livekit:7880')).toThrow()
  expect(rtcTarget('/voice-relay/v1/allocations/a/rtc/validate?access_token=token', 'a', 'http://livekit:7880').href).toBe(
    'http://livekit:7880/rtc/validate?access_token=token',
  )
})

test('streaming byte limits stop oversized upstream responses before buffering them', async () => {
  const { readLimited } = await import('./signaling.ts')
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10))
      controller.enqueue(new Uint8Array(10))
    },
    cancel() {
      canceled = true
    },
  })
  await expect(readLimited(stream, 15)).rejects.toMatchObject({ status: 413 })
  expect(canceled).toBe(true)
})

test('an incomplete streaming body is rejected and canceled after its deadline', async () => {
  vi.useFakeTimers()
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => {
      canceled = true
    },
  })
  try {
    const { readLimited } = await import('./signaling.ts')
    const result = expect(readLimited(stream, 100, 15000)).rejects.toMatchObject({ status: 408 })
    await vi.advanceTimersByTimeAsync(15000)
    await result
    expect(canceled).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test.each(['/voice-relay/v1/allocations/a/rtc', '/unrelated-path'])('raw upgrade sockets handle errors immediately: %s', async (path) => {
  const { connect } = await import('node:net')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { server, close } = signalingServer({} as Provider, async () => {
    await gate
    throw new Error('denied')
  })
  const handled = new Promise<boolean>((resolve) => server.on('upgrade', (_request, socket) => resolve(socket.listenerCount('error') > 0)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const socket = connect((server.address() as import('node:net').AddressInfo).port, '127.0.0.1')
  socket.on('error', () => {})
  socket.on('data', () => {})
  try {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: aGVsbG9oZWxsb2hlbGxvIQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    expect(await handled).toBe(true)
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.resetAndDestroy()
    await closed
  } finally {
    release()
    socket.destroy()
    close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('established signaling connections have a per-client ceiling and free it on close', async () => {
  const { WebSocket, WebSocketServer } = await import('ws')
  const { createServer } = await import('node:http')
  const upstreamServer = createServer()
  const upstream = new WebSocketServer({ server: upstreamServer })
  let upstreamAuthorization: string | undefined
  let upstreamCookie: string | undefined
  let responseCookie: string[] | undefined
  let responseLocation: string | undefined
  upstream.on('headers', (headers) => {
    headers.push('Set-Cookie: fixture=1', 'Location: /fixture')
  })
  upstream.on('connection', (socket, request) => {
    upstreamAuthorization = request.headers.authorization
    upstreamCookie = request.headers.cookie
    socket.send('ready')
  })
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve))
  const port = (upstreamServer.address() as import('node:net').AddressInfo).port
  const fake = {
    store: {
      admission: async (fn: () => Promise<unknown>) => fn(),
      serialized: async (_id: string, fn: () => Promise<unknown>) => fn(),
      installationId: async () => 'fixture',
    },
    livekit: { config: { url: `http://127.0.0.1:${port}` }, ensure: async () => {} },
    inspect: async () => ({ allocationId: 'a' }),
    usable: async () => ({}),
  } as unknown as import('./provider.ts').Provider
  const { server, close } = signalingServer(fake, async () => 'client')
  const firstServerClosed = new Promise<void>((resolve) => {
    server.once('upgrade', (_request, socket) => socket.once('close', () => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const relayPort = (server.address() as import('node:net').AddressInfo).port
  const clients: InstanceType<typeof WebSocket>[] = []
  const connect = () =>
    new Promise<boolean>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${relayPort}/voice-relay/v1/allocations/a/rtc?access_token=fixture`, {
        headers: { authorization: 'fixture', cookie: 'fixture=1' },
      })
      client.once('upgrade', (response) => {
        responseCookie = response.headers['set-cookie']
        responseLocation = response.headers.location
      })
      clients.push(client)
      client.once('open', () => resolve(true))
      client.once('error', () => resolve(false))
    })
  try {
    for (let i = 0; i < 128; i++) expect(await connect()).toBe(true)
    expect(upstreamAuthorization).toBeUndefined()
    expect(upstreamCookie).toBeUndefined()
    expect(responseCookie).toBeUndefined()
    expect(responseLocation).toBeUndefined()
    expect(await connect()).toBe(false)
    const closed = new Promise<void>((resolve) => clients[0].once('close', () => resolve()))
    clients[0].terminate()
    await closed
    await firstServerClosed
    expect(await connect()).toBe(true)
  } finally {
    for (const client of clients) client.terminate()
    close()
    for (const client of upstream.clients) client.terminate()
    upstream.close()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
    ])
  }
}, 15000)

test('shutdown destroys sockets waiting for upgrade authentication', async () => {
  const { connect } = await import('node:net')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { server, close } = signalingServer({} as Provider, async () => {
    await gate
    return 'client'
  })
  const accepted = new Promise<import('node:stream').Duplex>((resolve) => server.once('upgrade', (_req, socket) => resolve(socket)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const client = connect((server.address() as import('node:net').AddressInfo).port, '127.0.0.1')
  client.on('error', () => {})
  try {
    client.write('GET /voice-relay/v1/allocations/a/rtc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    const socket = await accepted
    close()
    expect(socket.destroyed).toBe(true)
  } finally {
    release()
    client.destroy()
    close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('upgrade preserves a rate-limit response', async () => {
  const { WebSocket } = await import('ws')
  const { RelayError } = await import('./types.ts')
  const { server, close } = signalingServer({} as Provider, async () => {
    throw new RelayError('RATE_LIMITED', 429)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=x`,
    )
    const status = await new Promise<number>((resolve) =>
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }),
    )
    expect(status).toBe(429)
  } finally {
    close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
