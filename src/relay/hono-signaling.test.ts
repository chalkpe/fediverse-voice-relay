// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'
import { Hono } from 'hono'
import { expect, test, vi } from 'vitest'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import type { Provider } from './provider.ts'
import { createSignaling } from './signaling.ts'

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function basicProvider(upstreamPort: number, hooks: { enter?: () => void; exit?: () => void } = {}): Provider {
  return {
    store: {
      admission: async (fn: () => Promise<unknown>) => fn(),
      serialized: async (_id: string, fn: () => Promise<unknown>) => {
        hooks.enter?.()
        try {
          return await fn()
        } finally {
          hooks.exit?.()
        }
      },
      installationId: async () => 'fixture',
    },
    livekit: { config: { url: `http://127.0.0.1:${upstreamPort}` }, ensure: async () => {} },
    inspect: async () => ({ allocationId: 'a' }),
    usable: async () => ({}),
  } as unknown as Provider
}

async function closeServers(
  server: ReturnType<typeof createAdaptorServer>,
  upstreamServer: ReturnType<typeof createServer>,
  upstreamSockets: WebSocketServer,
  signaling: ReturnType<typeof createSignaling>,
) {
  signaling.close()
  for (const socket of upstreamSockets.clients) socket.terminate()
  upstreamSockets.close()
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
  ])
}

test('Hono upgrade keeps admission locked until the first upstream message and forwards its frame', async () => {
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  const port = (upstreamServer.address() as AddressInfo).port
  let locked = false
  const fake = basicProvider(port, {
    enter: () => {
      locked = true
    },
    exit: () => {
      locked = false
    },
  })
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const relayPort = (server.address() as AddressInfo).port
  const upstreamConnected = once(upstreamSockets, 'connection')
  const client = new WebSocket(`ws://127.0.0.1:${relayPort}/voice-relay/v1/allocations/a/rtc?access_token=fixture`)
  try {
    const [remote] = await upstreamConnected

    expect(locked).toBe(true)
    const message = once(client, 'message')
    remote.send(Buffer.from([1, 2, 3]), { binary: true })
    const [data, binary] = await message
    expect(binary).toBe(true)
    expect(data).toEqual(Buffer.from([1, 2, 3]))
    expect(locked).toBe(false)
  } finally {
    client.terminate()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 5000)

test('client disconnect before the first upstream frame settles the Hono request and releases admission', async () => {
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  let locked = false
  let releaseObserved: () => void = () => {}
  const unlocked = new Promise<void>((resolve) => {
    releaseObserved = resolve
  })
  const fake = basicProvider((upstreamServer.address() as AddressInfo).port, {
    enter: () => {
      locked = true
    },
    exit: () => {
      locked = false
      releaseObserved()
    },
  })
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  let requestFinished: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    requestFinished = resolve
  })
  const server = createAdaptorServer({
    fetch: async (request, env) => {
      try {
        return await app.fetch(request, env)
      } finally {
        requestFinished()
      }
    },
    websocket: { server: signaling.wss },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const upstreamConnected = once(upstreamSockets, 'connection')
  const client = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=fixture`,
  )
  client.on('error', () => {})
  try {
    await upstreamConnected
    expect(locked).toBe(true)
    client.terminate()
    await finished
    await unlocked
    expect(locked).toBe(false)
  } finally {
    client.terminate()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 1000)

test('frames sent with the upgrade request retain their boundaries and types', async () => {
  const { connect } = await import('node:net')
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  const fake = basicProvider((upstreamServer.address() as AddressInfo).port)
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const upstreamConnected = once(upstreamSockets, 'connection')
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1')
  socket.on('error', () => {})
  socket.on('data', () => {})
  try {
    await once(socket, 'connect')
    const request = Buffer.from(
      'GET /voice-relay/v1/allocations/a/rtc?access_token=fixture HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: aGVsbG9oZWxsb2hlbGxvIQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    const textFrame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b])
    const binaryFrame = Buffer.from([0x82, 0x82, 1, 2, 3, 4, 0xfe, 0x02])
    socket.write(Buffer.concat([request, textFrame, binaryFrame]))
    const [remote] = await upstreamConnected
    const received: [Buffer, boolean][] = []
    const complete = new Promise<void>((resolve) => {
      remote.on('message', (data: RawData, binary: boolean) => {
        received.push([Buffer.from(data as Buffer), binary])
        if (received.length === 3) resolve()
      })
    })
    socket.write(textFrame)
    remote.send('ready')
    await complete
    expect(received).toEqual([
      [Buffer.from('hi'), false],
      [Buffer.from([0xff, 0]), true],
      [Buffer.from('hi'), false],
    ])
  } finally {
    socket.destroy()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 3000)

test('the pending deadline terminates both sockets and releases admission', async () => {
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  let releaseObserved: () => void = () => {}
  const unlocked = new Promise<void>((resolve) => {
    releaseObserved = resolve
  })
  const fake = basicProvider((upstreamServer.address() as AddressInfo).port, { exit: releaseObserved })
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const upstreamConnected = once(upstreamSockets, 'connection')
  const client = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=fixture`,
  )
  client.on('error', () => {})
  try {
    const [remote] = await upstreamConnected
    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()))
    const remoteClosed = once(remote, 'close')
    await vi.advanceTimersByTimeAsync(10000)
    await Promise.all([clientClosed, remoteClosed, unlocked])
  } finally {
    vi.useRealTimers()
    client.terminate()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 3000)

test('heartbeat terminates an unresponsive client and closes the upstream', async () => {
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  const fake = basicProvider((upstreamServer.address() as AddressInfo).port)
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const upstreamConnected = once(upstreamSockets, 'connection')
  const client = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=fixture`,
    { autoPong: false },
  )
  client.on('error', () => {})
  try {
    const [remote] = await upstreamConnected
    const first = once(client, 'message')
    remote.send('ready')
    await first

    const clientClosed = once(client, 'close')
    const upstreamClosed = once(remote, 'close')
    await vi.advanceTimersByTimeAsync(60000)
    await Promise.all([clientClosed, upstreamClosed])
  } finally {
    vi.useRealTimers()
    client.terminate()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 3000)

test.each([false, true])(
  'upstream termination settles the client and admission (after first frame: %s)',
  async (afterFirst) => {
    const upstreamServer = createServer()
    const upstreamSockets = new WebSocketServer({ server: upstreamServer })
    await listen(upstreamServer)
    let unlock: () => void = () => {}
    const unlocked = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const fake = basicProvider((upstreamServer.address() as AddressInfo).port, { exit: unlock })
    const app = new Hono()
    const signaling = createSignaling(fake, async () => 'client')
    app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const upstreamConnected = once(upstreamSockets, 'connection')
    const client = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=fixture`,
    )
    client.on('error', () => {})
    try {
      const [remote] = await upstreamConnected
      if (afterFirst) {
        const first = once(client, 'message')
        remote.send('ready')
        await first
      }
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
      remote.terminate()
      await Promise.all([closed, unlocked])
    } finally {
      client.terminate()
      await closeServers(server, upstreamServer, upstreamSockets, signaling)
    }
  },
  3000,
)

test('a client frame larger than the payload limit closes both sides', async () => {
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  const fake = basicProvider((upstreamServer.address() as AddressInfo).port)
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const upstreamConnected = once(upstreamSockets, 'connection')
  const client = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=fixture`,
  )
  client.on('error', () => {})
  try {
    const [remote] = await upstreamConnected
    const first = once(client, 'message')
    remote.send('ready')
    await first

    const clientClosed = once(client, 'close')
    const remoteClosed = once(remote, 'close')
    client.send(Buffer.alloc(1024 * 1024 + 1))
    const [code] = await clientClosed
    await remoteClosed
    expect(code).toBe(1009)
  } finally {
    client.terminate()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 3000)

test('forwarding terminates both peers when the buffered-byte ceiling is exceeded', async () => {
  const upstreamServer = createServer()
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  await listen(upstreamServer)
  const fake = basicProvider((upstreamServer.address() as AddressInfo).port)
  const app = new Hono()
  const signaling = createSignaling(fake, async () => 'client')
  app.get('/voice-relay/v1/allocations/:id/rtc*', signaling.middleware)
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: signaling.wss } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const upstreamConnected = once(upstreamSockets, 'connection')
  const client = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-relay/v1/allocations/a/rtc?access_token=fixture`,
  )
  client.on('error', () => {})
  let pressure: ReturnType<typeof vi.spyOn> | undefined
  try {
    const [remote] = await upstreamConnected
    const first = once(client, 'message')
    remote.send('ready')
    await first

    const clientClosed = once(client, 'close')
    const remoteClosed = once(remote, 'close')
    pressure = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(1024 * 1024)
    client.send('x')
    await Promise.all([clientClosed, remoteClosed])
  } finally {
    pressure?.mockRestore()
    client.terminate()
    await closeServers(server, upstreamServer, upstreamSockets, signaling)
  }
}, 3000)
