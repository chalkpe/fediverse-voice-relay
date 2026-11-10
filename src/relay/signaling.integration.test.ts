// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'
import { SignalResponse } from '@livekit/protocol'
import { Hono } from 'hono'
import { AccessToken, RoomServiceClient, TokenVerifier, TrackSource } from 'livekit-server-sdk'
import { expect, test } from 'vitest'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import { testLiveKit } from '../infra/test-livekit.ts'
import type { Provider } from './provider.ts'
import { createSignaling } from './signaling.ts'

// 변경하지 않은 /livekit URL을 릴레이와 실제 SFU에 연결해 확인합니다.
function proxy(target: string, path: (value: string) => string) {
  const http = createServer()
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const upstream = new WebSocket(`${target}${path(req.url ?? '')}`)
    upstream.once('open', () =>
      wss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data, binary) => upstream.send(data, { binary }))
        upstream.on('message', (data, binary) => client.send(data, { binary }))
        client.on('close', () => upstream.close())
        upstream.on('close', () => client.close())
        client.on('error', () => upstream.terminate())
      }),
    )
    upstream.on('error', () => socket.destroy())
  })
  return { http, wss }
}

function nextSignal(ws: WebSocket, kind: string): Promise<SignalResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', message)
      reject(new Error(`No ${kind}`))
    }, 7000)
    function message(data: RawData) {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data
      const msg = SignalResponse.fromBinary(bytes)
      if (msg.message.case !== kind) return
      clearTimeout(timer)
      ws.off('message', message)
      resolve(msg)
    }
    ws.on('message', message)
  })
}

test('SFU refreshed tokens preserve client allocation through two signaling proxies', async () => {
  const service = new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret)
  const room = `voice-relay:client-spike:${randomUUID()}`
  const fixture = {
    store: {
      admission: async (fn: () => Promise<unknown>) => fn(),
      serialized: async (_id: string, fn: () => Promise<unknown>) => fn(),
      installationId: async () => 'fixture',
    },
    livekit: { config: testLiveKit, ensure: async () => {} },
    inspect: async (_client: string, value: string) => {
      const claims = await new TokenVerifier(testLiveKit.apiKey, testLiveKit.apiSecret).verify(value)
      const metadata = JSON.parse(claims.metadata ?? '{}')
      if (claims.video?.room !== room || metadata.clientId !== 'client-spike') throw new Error('Invalid fixture token')
      return { allocationId: metadata.allocationId }
    },
    usable: async () => ({}),
  } as unknown as Provider
  const app = new Hono()
  const relay = createSignaling(fixture, async () => 'client-spike')
  app.get('/voice-relay/v1/allocations/:id/rtc*', relay.middleware)
  const relayServer = createAdaptorServer({ fetch: app.fetch, websocket: { server: relay.wss } })
  await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
  const relayPort = (relayServer.address() as AddressInfo).port
  const consumer = proxy(`ws://127.0.0.1:${relayPort}`, (p) => p.replace(/^\/livekit/, '/voice-relay/v1/allocations/spike'))
  await new Promise<void>((resolve) => consumer.http.listen(0, '127.0.0.1', resolve))
  const port = (consumer.http.address() as AddressInfo).port
  const token = new AccessToken(testLiveKit.apiKey, testLiveKit.apiSecret, {
    identity: 'https://consumer.test/users/u1',
    ttl: '2m',
    metadata: JSON.stringify({
      clientId: 'client-spike',
      allocationId: 'spike',
      userId: 'u1',
    }),
  })
  token.addGrant({
    room,
    roomJoin: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canUpdateOwnMetadata: false,
  })
  const jwt = await token.toJwt()
  const connect = (value: string) =>
    new WebSocket(
      `ws://127.0.0.1:${port}/livekit/rtc?access_token=${encodeURIComponent(value)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`,
    )
  let ws: WebSocket | undefined
  try {
    ws = connect(jwt)
    const joined = await nextSignal(ws, 'join')
    expect(joined.message.case === 'join' && joined.message.value.room?.name).toBe(room)
    const refresh = nextSignal(ws, 'refreshToken')
    await service.updateParticipant(room, 'https://consumer.test/users/u1', {
      attributes: { probe: 'changed' },
    })
    const response = await refresh
    if (response.message.case !== 'refreshToken') throw new Error('Wrong signal')
    const refreshed = response.message.value
    expect(refreshed).not.toBe(jwt)
    const claims = await new TokenVerifier(testLiveKit.apiKey, testLiveKit.apiSecret).verify(refreshed)
    expect(claims.video?.room).toBe(room)
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({
      clientId: 'client-spike',
      allocationId: 'spike',
      userId: 'u1',
    })
    ws.close()
    await once(ws, 'close')
    ws = connect(refreshed)
    const rejoined = await nextSignal(ws, 'join')
    expect(rejoined.message.case === 'join' && rejoined.message.value.room?.name).toBe(room)
  } finally {
    ws?.terminate()
    for (const client of consumer.wss.clients) client.terminate()
    consumer.wss.close()
    consumer.http.close()
    relay.close()
    relayServer.close()
    await service.deleteRoom(room).catch(() => {})
  }
}, 20000)
