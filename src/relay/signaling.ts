// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { upgradeWebSocket } from '@hono/node-server'
import type { MiddlewareHandler } from 'hono'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import type { Provider } from './provider.ts'
import { RelayError } from './types.ts'

const MAX_BYTES = 1024 * 1024
export function rtcTarget(raw: string, allocationId: string, base: string): URL {
  const prefix = `/voice-relay/v1/allocations/${allocationId}`
  const rest = raw.slice(prefix.length)
  const path = rest.split('?')[0]
  if (!raw.startsWith(`${prefix}/rtc`) || path.includes('\\') || /%(?:2f|5c|25)/i.test(path)) {
    throw new RelayError('NOT_FOUND', 404)
  }
  let parts: string[]
  try {
    parts = decodeURIComponent(path).split('/')
  } catch {
    throw new RelayError('NOT_FOUND', 404)
  }
  if (parts.some((x) => x === '.' || x === '..')) throw new RelayError('NOT_FOUND', 404)
  const target = new URL(rest, base)
  if (
    target.origin !== new URL(base).origin ||
    (target.pathname !== '/rtc' && !target.pathname.startsWith('/rtc/')) ||
    target.searchParams.getAll('access_token').length !== 1
  )
    throw new RelayError('NOT_FOUND', 404)
  return target
}

export async function admit<T>(provider: Provider, tenant: string, id: string, raw: string, connect: (url: URL) => Promise<T>): Promise<T> {
  return provider.store.admission(() =>
    provider.store.serialized(id, async () => {
      const url = rtcTarget(raw, id, provider.livekit.config.url)
      const inspected = await provider.inspect(tenant, url.searchParams.get('access_token') ?? '')
      if (inspected.allocationId !== id) throw new RelayError('FORBIDDEN', 403)
      const a = await provider.usable(tenant, id)
      await provider.livekit.ensure(a, await provider.store.installationId())
      return connect(url)
    }),
  )
}

export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number, timeoutMs?: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RelayError('REQUEST_TIMEOUT', 408)), timeoutMs)
        })
  try {
    while (true) {
      const chunk = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read())
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) {
        await reader.cancel()
        throw new RelayError('PAYLOAD_TOO_LARGE', 413)
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

type Authenticate = (req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, body: string) => Promise<string>

type Frame = { data: RawData; binary: boolean }

function frameSize(data: RawData): number {
  return Array.isArray(data) ? data.reduce((sum, item) => sum + item.length, 0) : data.byteLength
}

function forward(to: WebSocket, other: WebSocket, data: RawData, binary: boolean): void {
  if (to.bufferedAmount + frameSize(data) > MAX_BYTES) {
    to.terminate()
    other.terminate()
    return
  }
  if (to.readyState === WebSocket.OPEN) to.send(data, { binary })
}

function installHeartbeat(client: WebSocket): void {
  let alive = true
  const heartbeat = setInterval(() => {
    if (!alive) {
      client.terminate()
      return
    }
    alive = false
    client.ping()
  }, 30000)
  heartbeat.unref()
  client.on('pong', () => {
    alive = true
  })
  client.once('close', () => clearInterval(heartbeat))
}

function relayFrames(client: WebSocket, remote: WebSocket, frames: Frame[]): void {
  installHeartbeat(client)
  client.on('message', (data, binary) => forward(remote, client, data, binary))
  client.on('close', () => remote.close())
  client.on('error', () => remote.terminate())
  for (const frame of frames) forward(client, remote, frame.data, frame.binary)
}

function openUpstream(url: URL, abandon: () => void) {
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const remote = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: MAX_BYTES })
  const frames: Frame[] = []
  let buffered = 0
  let client: WebSocket | undefined
  let resolveReady: () => void = () => {}
  let rejectReady: (error: unknown) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  remote.on('message', (data, binary) => {
    if (client) {
      forward(client, remote, data, binary)
      return
    }
    buffered += frameSize(data)
    if (buffered > MAX_BYTES) {
      rejectReady(new Error('Upstream buffer exceeded'))
      abandon()
      return
    }
    frames.push({ data, binary })
    resolveReady()
  })
  remote.on('error', (error) => {
    rejectReady(error)
    abandon()
  })
  remote.once('close', () => {
    rejectReady(new Error('Upstream closed'))
    if (client) client.close()
    else abandon()
  })
  return {
    remote,
    ready,
    attach(downstream: WebSocket) {
      client = downstream
      relayFrames(downstream, remote, frames)
    },
  }
}

export function createSignaling(
  provider: Provider,
  authenticate: Authenticate,
): {
  wss: WebSocketServer
  createWebSocketServer: () => WebSocketServer
  middleware: MiddlewareHandler
  close: () => void
} {
  const servers = new Set<WebSocketServer>()
  const createWebSocketServer = () => {
    const server = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES })
    servers.add(server)
    server.once('close', () => servers.delete(server))
    return server
  }
  const wss = createWebSocketServer()
  const pendingTenants = new Map<string, number>()
  const connectionsByTenant = new Map<string, number>()
  const pendingSockets = new Set<Duplex>()
  let pending = 0
  let connections = 0
  let shuttingDown = false

  const middleware: MiddlewareHandler = async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return next()
    const req = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming
    if (!req) return c.body(null, 500)
    const socket = req.socket
    const raw = req.url ?? ''
    const match = /^\/voice-relay\/v1\/allocations\/([a-zA-Z0-9-]+)\/rtc(?:\/|\?|$)/.exec(raw)
    if (!match) return c.body(null, 404)
    if (shuttingDown || pending >= 64) return c.body(null, 429)

    pending++
    pendingSockets.add(socket)
    let tenant: string | undefined
    let registered = false
    let reserved = false
    let closed = false
    let remote: WebSocket | undefined
    let releaseLock: (() => void) | undefined
    let donePending = false
    const earlyData: Buffer[] = []
    let earlyBytes = 0
    let cancel: (error: Error) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = reject
    })
    void aborted.catch(() => {})
    const finishPending = () => {
      if (donePending) return
      donePending = true
      clearTimeout(deadline)
      pendingSockets.delete(socket)
      pending--
      if (tenant && registered) {
        const count = (pendingTenants.get(tenant) ?? 1) - 1
        if (count) pendingTenants.set(tenant, count)
        else pendingTenants.delete(tenant)
      }
    }
    const abandon = () => {
      if (closed) return
      closed = true
      cancel(new Error('Connection closed'))
      finishPending()
      releaseLock?.()
      remote?.terminate()
      if (!socket.destroyed) socket.destroy()
    }
    const collectEarlyData = (data: Buffer) => {
      earlyBytes += data.length
      if (earlyBytes > 65536) {
        abandon()
        return
      }
      earlyData.push(data)
    }
    socket.on('data', collectEarlyData)
    socket.resume()
    const deadline = setTimeout(abandon, 10000)
    deadline.unref()
    socket.once('close', () => {
      abandon()
      if (tenant && reserved) {
        connections--
        const count = (connectionsByTenant.get(tenant) ?? 1) - 1
        if (count) connectionsByTenant.set(tenant, count)
        else connectionsByTenant.delete(tenant)
        reserved = false
      }
    })
    socket.once('end', abandon)
    socket.on('error', abandon)
    try {
      tenant = await Promise.race([authenticate(req, ''), aborted])
      if (closed) return c.body(null, 503)
      if (connections >= 1024 || (connectionsByTenant.get(tenant) ?? 0) >= 128) throw new RelayError('RATE_LIMITED', 429)
      connections++
      connectionsByTenant.set(tenant, (connectionsByTenant.get(tenant) ?? 0) + 1)
      reserved = true
      if ((pendingTenants.get(tenant) ?? 0) >= 8) throw new RelayError('RATE_LIMITED', 429)
      pendingTenants.set(tenant, (pendingTenants.get(tenant) ?? 0) + 1)
      registered = true

      let resolveReady: (session: ReturnType<typeof openUpstream>) => void = () => {}
      let rejectReady: (error: unknown) => void = () => {}
      const ready = new Promise<ReturnType<typeof openUpstream>>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const lock = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const admission = admit(provider, tenant, match[1], raw, async (url) => {
        if (closed) throw new Error('Client closed')
        const session = openUpstream(url, abandon)
        remote = session.remote
        await session.ready
        resolveReady(session)
        await lock
      })
      void admission.catch(rejectReady)
      const session = await Promise.race([ready, aborted])
      if (closed) throw new Error('Connection closed')
      socket.pause()
      socket.off('data', collectEarlyData)
      for (let i = earlyData.length - 1; i >= 0; i--) socket.unshift(earlyData[i])
      let opened = false
      const upgrade = upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          try {
            finishPending()
            session.attach(ws.raw as WebSocket)
            opened = true
            socket.resume()
          } catch {
            abandon()
          } finally {
            releaseLock?.()
          }
        },
        onError() {
          if (opened) remote?.terminate()
          else abandon()
        },
      }))
      return await upgrade(c, next)
    } catch (error) {
      finishPending()
      releaseLock?.()
      remote?.terminate()
      if (closed) return c.body(null, 503)
      const status = error instanceof RelayError && error.status >= 400 && error.status <= 599 ? error.status : 503
      return new Response(null, { status })
    }
  }

  return {
    wss,
    createWebSocketServer,
    middleware,
    close() {
      shuttingDown = true
      for (const socket of pendingSockets) socket.destroy()
      for (const server of servers) {
        for (const client of server.clients) client.terminate()
        server.close()
      }
    },
  }
}
