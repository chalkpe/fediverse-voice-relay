// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { clients } from '../infra/schema.ts'
import type { Store } from '../infra/store.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'
import { allocationSchema, capacitySchema, eventSchema } from '../relay/schema.ts'
import type { RelayService } from './server.ts'
import { createServer } from './server.ts'

let app: RelayService
const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let store: Store
let turnResolver: () => Promise<import('../relay/types.ts').IceServer[] | null> = async () => [
  { urls: ['turn:turn.example.org:3478'], username: 'fixture', credential: 'fixture' },
]
async function inject(input: { method: string; url: string; payload?: string; headers?: Record<string, string> }) {
  const response = await app.app.request(input.url, { method: input.method, headers: input.headers, body: input.payload })
  const body = await response.text()
  return { statusCode: response.status, body, json: () => JSON.parse(body) }
}
const secret = 's'.repeat(64)
const otherSecret = 't'.repeat(64)
beforeAll(async () => {
  database = await createTestDatabase({
    connectionString: url,
    initialize: async (fixture) => {
      await fixture.store.db.insert(clients).values([
        { id: 'client', origin: 'https://a.test', enabled: true, maxSlots: 102, maxRooms: 2, allowScreenShare: true },
        { id: 'other', origin: 'https://b.test', enabled: true, maxSlots: 102, maxRooms: 2, allowScreenShare: true },
      ])
    },
  })
  store = database.store
  app = await createServer(
    {
      databaseUrl: url,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'https://relay.test',
      clientSecretFile: 'unused',
      livekit: testLiveKit,
      maxSlots: 102,
      maxRooms: 2,
      iceServers: null,
    },
    {
      store,
      loadSecrets: () => ({ client: secret, other: otherSecret }),
      startWorkers: false,
      getIceServers: () => turnResolver(),
    },
  )
})
afterAll(async () => {
  try {
    await app?.close()
  } finally {
    await database?.close()
  }
})
async function call(method: string, path: string, body?: unknown, key = 'k1') {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return inject({
    method,
    url: path,
    payload: payload || undefined,
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${await clientToken(key === 'k1' ? secret : otherSecret, key === 'k1' ? 'https://a.test' : 'https://b.test')}`,
    },
  })
}

test('requires a bearer token and permits reuse during its validity', async () => {
  const path = '/voice-relay/v1/capacity'
  const token = await clientToken(secret, 'https://a.test')
  expect((await inject({ method: 'GET', url: path })).statusCode).toBe(401)
  expect((await inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200)
  expect((await inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200)
  expect((await call('POST', '/voice-relay/v1/allocations', { slots: -1, roomKey: 'r', generation: 'g' })).statusCode).toBe(400)
})

test('another client cannot query, join, moderate, inspect, or signal an allocation', async () => {
  const { WebSocket } = await import('ws')
  const roomKey = 'https://a.test/chat/private'
  const allocation = (await call('POST', '/voice-relay/v1/allocations', { slots: 1, roomKey, generation: 'private' })).json()
  try {
    const identity = 'https://a.test/users/private'
    const joined = (
      await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, { identity, userId: 'private', allowScreenShare: false })
    ).json()
    const other = 'k2'
    const lookup = `/voice-relay/v1/allocations?roomKey=${encodeURIComponent(roomKey)}&generation=private`
    expect((await call('GET', lookup, undefined, other)).statusCode).toBe(404)
    expect((await call('GET', `/voice-relay/v1/allocations/${allocation.id}/snapshot`, undefined, other)).statusCode).toBe(404)
    expect(
      (
        await call(
          'POST',
          `/voice-relay/v1/allocations/${allocation.id}/join`,
          { identity, userId: 'private', allowScreenShare: false },
          other,
        )
      ).statusCode,
    ).toBe(404)
    expect((await call('POST', `/voice-relay/v1/allocations/${allocation.id}/participants/kick`, { identity }, other)).statusCode).toBe(404)
    expect(
      (
        await call(
          'POST',
          `/voice-relay/v1/allocations/${allocation.id}/participants/permissions`,
          { identity, allowScreenShare: false },
          other,
        )
      ).statusCode,
    ).toBe(404)
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: joined.token }, other)).statusCode).toBe(403)
    expect((await call('DELETE', `/voice-relay/v1/allocations/${allocation.id}`, undefined, other)).statusCode).toBe(404)
    const feed = (await call('GET', '/voice-relay/v1/events')).json()
    expect((await call('GET', `/voice-relay/v1/events?cursor=${encodeURIComponent(feed.cursor)}`, undefined, other)).statusCode).toBe(403)
    expect((await call('GET', '/voice-relay/v1/events', undefined, other)).json().events).toEqual([])
    const path = `/voice-relay/v1/allocations/${allocation.id}/rtc?access_token=${encodeURIComponent(joined.token)}`
    expect((await call('GET', path, undefined, other)).statusCode).toBe(403)
    if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const port = (app.server.address() as import('node:net').AddressInfo).port
    const response = await new Promise<number>((resolve, reject) => {
      void clientToken(otherSecret, other === 'k2' ? 'https://b.test' : other).then((token) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } })
        socket.once('unexpected-response', (_request, result) => {
          result.resume()
          resolve(result.statusCode ?? 0)
        })
        socket.once('open', () => {
          socket.terminate()
          reject(new Error('Other client entered RTC'))
        })
        socket.once('error', reject)
      }, reject)
    })
    expect(response).toBe(403)
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: joined.token })).statusCode).toBe(200)
  } finally {
    await call('DELETE', `/voice-relay/v1/allocations/${allocation.id}`)
  }
})

test('real HTTP rejects invalid bearer claim and algorithm combinations', async () => {
  const { SignJWT } = await import('jose')
  const now = Math.floor(Date.now() / 1000)
  const issue = async (options: { alg?: string; typ?: string; iss?: string; sub?: string; aud?: string; exp?: number }) => {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: options.typ ?? 'voice-relay-client+jwt' })
      .setIssuer(options.iss ?? 'https://a.test')
      .setAudience(options.aud ?? 'https://relay.test')
      .setIssuedAt(now)
      .setExpirationTime(options.exp ?? now + 60)
    if (options.sub) jwt.setSubject(options.sub)
    return jwt.sign(new TextEncoder().encode(secret))
  }
  const invalid = [
    await issue({ alg: 'HS512' }),
    await issue({ typ: 'JWT' }),
    await issue({ iss: 'other' }),
    await issue({ sub: 'other' }),
    await issue({ aud: 'https://other.test' }),
    await issue({ exp: now - 10 }),
  ]
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = (app.server.address() as import('node:net').AddressInfo).port
  const valid = await fetch(`http://127.0.0.1:${port}/voice-relay/v1/capacity`, { headers: { authorization: `Bearer ${await issue({})}` } })
  expect(valid.status).toBe(200)
  for (const token of invalid) {
    const response = await fetch(`http://127.0.0.1:${port}/voice-relay/v1/capacity`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(401)
  }
})

test('routes an allocation lifecycle and does not expose secrets', async () => {
  const response = await call('POST', '/voice-relay/v1/allocations', {
    slots: 51,
    roomKey: 'https://a.test/chat/r',
    generation: 'g1',
  })
  expect(response.statusCode).toBe(200)
  const a = response.json()
  expect(allocationSchema.safeParse(a).success).toBe(true)
  const joined = await call('POST', `/voice-relay/v1/allocations/${a.id}/join`, {
    identity: 'https://a.test/users/u1',
    userId: 'u1',
    allowScreenShare: true,
  })
  expect(joined.statusCode).toBe(200)
  expect(
    (
      await call('POST', '/voice-relay/v1/tokens/inspect', {
        token: joined.json().token,
      })
    ).json().allocationId,
  ).toBe(a.id)
  const feed = await call('GET', '/voice-relay/v1/events')
  expect(feed.body).not.toContain(secret)
  expect(feed.json().events.every((item: unknown) => eventSchema.safeParse(item).success)).toBe(true)
  expect((await call('DELETE', `/voice-relay/v1/allocations/${a.id}`)).json().state).toBe('ended')
  const renewed = await call('POST', `/voice-relay/v1/allocations/${a.id}/lease`, {})
  expect(renewed.statusCode).toBe(409)
})

test('production RTC route accepts refreshed tokens on a new authenticated WebSocket', async () => {
  const { WebSocket } = await import('ws')
  const { SignalResponse } = await import('@livekit/protocol')
  const { RoomServiceClient } = await import('livekit-server-sdk')
  const a = (await call('POST', '/voice-relay/v1/allocations', { slots: 51, roomKey: 'https://a.test/chat/ws', generation: 'ws1' })).json()
  const issued = (
    await call('POST', `/voice-relay/v1/allocations/${a.id}/join`, {
      identity: 'https://a.test/users/ws',
      userId: 'ws',
      allowScreenShare: false,
    })
  ).json()
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = (app.server.address() as import('node:net').AddressInfo).port
  const connect = async (token: string) => {
    const path = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(token)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`
    return new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${await clientToken(secret, 'https://a.test')}` },
    })
  }
  const wait = (ws: InstanceType<typeof WebSocket>, kind: string): Promise<import('@livekit/protocol').SignalResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${kind}`)), 5000)
      ws.on('message', function message(data) {
        const signal = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
        if (signal.message.case === kind) {
          clearTimeout(timer)
          ws.off('message', message)
          resolve(signal)
        }
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  const rejected = await new Promise<number>((resolve, reject) => {
    const path = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(issued.token)}`
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${issued.token}` } })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('Participant token accepted as a client token'))
    })
    socket.once('error', reject)
  })
  expect(rejected).toBe(401)

  let ws = await connect(issued.token)
  try {
    expect((await wait(ws, 'join')).message.case).toBe('join')
    const refresh = wait(ws, 'refreshToken')
    await new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret).updateParticipant(
      `voice-relay:client:${a.id}`,
      'https://a.test/users/ws',
      { attributes: { probe: 'refresh' } },
    )
    const response = await refresh
    if (response.message.case !== 'refreshToken') throw new Error('Wrong signal')
    ws.terminate()
    ws = await connect(response.message.value)
    expect((await wait(ws, 'join')).message.case).toBe('join')
  } finally {
    ws.terminate()
    await call('DELETE', `/voice-relay/v1/allocations/${a.id}`)
  }
})

test('kick rejects original and refreshed participant tokens while a new join remains valid', async () => {
  const { WebSocket } = await import('ws')
  const { SignalResponse } = await import('@livekit/protocol')
  const { RoomServiceClient } = await import('livekit-server-sdk')
  const allocation = (await call('POST', '/voice-relay/v1/allocations', { slots: 51, roomKey: 'kick-test', generation: 'kick1' })).json()
  const identity = 'https://a.test/users/kick'
  const issued = (
    await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, { identity, userId: 'kick', allowScreenShare: false })
  ).json()
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = (app.server.address() as import('node:net').AddressInfo).port
  const token = await clientToken(secret, 'https://a.test')
  const path = (participantToken: string) =>
    `/voice-relay/v1/allocations/${allocation.id}/rtc?access_token=${encodeURIComponent(participantToken)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`
  const connect = (participantToken: string) =>
    new WebSocket(`ws://127.0.0.1:${port}${path(participantToken)}`, { headers: { authorization: `Bearer ${token}` } })
  const wait = (ws: InstanceType<typeof WebSocket>, kind: string): Promise<import('@livekit/protocol').SignalResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${kind}`)), 5000)
      ws.on('message', function message(data) {
        const response = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
        if (response.message.case === kind) {
          clearTimeout(timer)
          ws.off('message', message)
          resolve(response)
        }
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  const ws = connect(issued.token)
  try {
    expect((await wait(ws, 'join')).message.case).toBe('join')
    const refresh = wait(ws, 'refreshToken')
    await new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret).updateParticipant(
      `voice-relay:client:${allocation.id}`,
      identity,
      { attributes: { probe: 'refresh' } },
    )
    const refreshed = await refresh
    if (refreshed.message.case !== 'refreshToken') throw new Error('Wrong signal')
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kicked socket remained open')), 5000)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    expect((await call('POST', `/voice-relay/v1/allocations/${allocation.id}/participants/kick`, { identity })).json()).toEqual({
      accepted: true,
    })
    await disconnected
    for (const participantToken of [issued.token, refreshed.message.value]) {
      expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: participantToken })).statusCode).toBe(403)
      const rejected = await new Promise<number>((resolve, reject) => {
        const retry = connect(participantToken)
        retry.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        retry.once('open', () => {
          retry.terminate()
          reject(new Error('Kicked participant reconnected'))
        })
        retry.once('error', reject)
      })
      expect(rejected).toBe(403)
    }
    const renewed = (
      await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, { identity, userId: 'kick', allowScreenShare: false })
    ).json()
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: renewed.token })).statusCode).toBe(200)
    const retry = connect(renewed.token)
    try {
      expect((await wait(retry, 'join')).message.case).toBe('join')
    } finally {
      retry.terminate()
    }
  } finally {
    ws.terminate()
    await call('DELETE', `/voice-relay/v1/allocations/${allocation.id}`)
  }
})

test('permission reduction revokes old and automatically refreshed tokens', async () => {
  const { WebSocket } = await import('ws')
  const { SignalResponse } = await import('@livekit/protocol')
  const { RoomServiceClient, TrackSource } = await import('livekit-server-sdk')
  const allocation = (
    await call('POST', '/voice-relay/v1/allocations', { slots: 51, roomKey: 'permission-test', generation: 'permission1' })
  ).json()
  const identity = 'https://a.test/users/permission'
  const issued = (
    await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, { identity, userId: 'permission', allowScreenShare: true })
  ).json()
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = (app.server.address() as import('node:net').AddressInfo).port
  const path = `/voice-relay/v1/allocations/${allocation.id}/rtc?access_token=${encodeURIComponent(issued.token)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${await clientToken(secret, 'https://a.test')}` },
  })
  const wait = (kind: string): Promise<import('@livekit/protocol').SignalResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${kind}`)), 5000)
      ws.on('message', function message(data) {
        const response = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
        if (response.message.case === kind) {
          clearTimeout(timer)
          ws.off('message', message)
          resolve(response)
        }
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  try {
    expect((await wait('join')).message.case).toBe('join')
    const refresh = wait('refreshToken')
    expect(
      (
        await call('POST', `/voice-relay/v1/allocations/${allocation.id}/participants/permissions`, { identity, allowScreenShare: false })
      ).json(),
    ).toEqual({ accepted: true })
    const refreshed = await refresh
    if (refreshed.message.case !== 'refreshToken') throw new Error('Wrong signal')
    const remote = await new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret).getParticipant(
      `voice-relay:client:${allocation.id}`,
      identity,
    )
    expect(remote.permission?.canPublishSources).toEqual([TrackSource.MICROPHONE])
    for (const participantToken of [issued.token, refreshed.message.value]) {
      expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: participantToken })).statusCode).toBe(403)
      expect(
        (await call('GET', `/voice-relay/v1/allocations/${allocation.id}/rtc?access_token=${encodeURIComponent(participantToken)}`))
          .statusCode,
      ).toBe(403)
    }
    const renewed = (
      await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, { identity, userId: 'permission', allowScreenShare: false })
    ).json()
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: renewed.token })).statusCode).toBe(200)
  } finally {
    ws.terminate()
    await call('DELETE', `/voice-relay/v1/allocations/${allocation.id}`)
  }
})

test('a BOM-prefixed JSON request is rejected with valid client authentication', async () => {
  const response = await inject({
    method: 'POST',
    url: '/voice-relay/v1/tokens/inspect',
    payload: `\ufeff{"token":"invalid"}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await clientToken(secret, 'https://a.test')}` },
  })
  expect(response.statusCode).toBe(400)
})

test('hosted providers return credentials from their dynamic TURN resolver', async () => {
  const allocation = (await call('POST', '/voice-relay/v1/allocations', { slots: 51, roomKey: 'turn-fixture', generation: 'turn1' })).json()
  try {
    const response = await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, {
      identity: 'https://a.test/users/turn',
      userId: 'turn',
      allowScreenShare: false,
    })
    expect(response.json().iceServers).toEqual([{ urls: ['turn:turn.example.org:3478'], username: 'fixture', credential: 'fixture' }])
  } finally {
    await call('DELETE', `/voice-relay/v1/allocations/${allocation.id}`)
  }
})

test('HTTP documentation and bearer request validation preserve the authentication boundary', async () => {
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = (app.server.address() as import('node:net').AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  const request = (path: string, options?: RequestInit) => fetch(origin + path, options)
  expect((await request('/docs')).status).toBe(200)
  expect(await (await request('/docs')).text()).toContain('/openapi.json')
  expect((await (await request('/openapi.json')).json()).openapi).toBe('3.1.0')
  expect((await request('/docs/other')).status).toBe(401)
  expect((await request('/voice-relay/v1/capacity')).status).toBe(401)

  const bearer = await clientToken(secret, 'https://a.test')
  const authenticated = (method: string, _path: string, body: string): RequestInit => ({
    method,
    headers: { authorization: `Bearer ${bearer}` },
    ...(body ? { body } : {}),
  })
  const capacityPath = '/voice-relay/v1/capacity'
  const capacity = await request(capacityPath, authenticated('GET', capacityPath, ''))
  expect(capacity.status).toBe(200)
  expect(capacitySchema.safeParse(await capacity.json()).success).toBe(true)
  const allocationPath = '/voice-relay/v1/allocations'
  for (const invalid of [
    '{',
    '\ufeff{}',
    '{"roomKey":"r","generation":"g","slots":1,"extra":true}',
    '{"roomKey":"r","generation":"g","slots":0}',
    '{"roomKey":"r","generation":"g","slots":1.5}',
    '{"roomKey":"r","generation":"g","slots":10001}',
  ]) {
    const response = await request(allocationPath, authenticated('POST', allocationPath, invalid))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' })
  }
  const invalidQuery = `${allocationPath}?roomKey=r&generation=${'g'.repeat(129)}`
  expect((await request(invalidQuery, authenticated('GET', invalidQuery, ''))).status).toBe(400)
  const unknownAction = `${allocationPath}/abc/participants/unknown`
  expect((await request(unknownAction, authenticated('POST', unknownAction, '{}'))).status).toBe(404)
  const oversized = 'x'.repeat(65537)
  expect((await request(allocationPath, authenticated('POST', allocationPath, oversized))).status).toBe(413)
  const invalidUtf8 = await new Promise<number>((resolve, reject) => {
    const req = import('node:http').then(({ request: nodeRequest }) => {
      const outbound = nodeRequest(origin + allocationPath, { method: 'POST' }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      outbound.on('error', reject)
      outbound.end(Buffer.from([0xff]))
    })
    req.catch(reject)
  })
  expect(invalidUtf8).toBe(400)
  expect((await request(allocationPath, authenticated('POST', allocationPath, '{'))).status).toBe(400)
  expect((await request(allocationPath, authenticated('POST', allocationPath, '{'))).status).toBe(400)
})

test('metrics use a private listener and bounded route labels', async () => {
  const { randomUUID } = await import('node:crypto')
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}`
  expect((await fetch(`${api}/metrics`)).status).toBe(404)
  expect((await fetch(`${api}/health`)).status).toBe(200)
  expect((await fetch(`${api}/voice-relay/v1/capacity`)).status).toBe(401)
  const unknown = `/voice-relay/v1/not-a-route-${randomUUID()}`
  expect((await call('GET', unknown)).statusCode).toBe(404)
  for (let i = 0; i < 5; i++) expect((await call('GET', `/voice-relay/v1/unknown-${randomUUID()}`)).statusCode).toBe(404)
  const allocation = await call('POST', '/voice-relay/v1/allocations', { roomKey: 'metrics-room', generation: 'm1', slots: 7 })
  expect(allocation.statusCode).toBe(200)
  const id = allocation.json().id
  try {
    const joined = (
      await call('POST', `/voice-relay/v1/allocations/${id}/join`, {
        identity: 'https://a.test/users/metrics',
        userId: 'metrics',
        allowScreenShare: false,
      })
    ).json()
    const bearer = await clientToken(secret, 'https://a.test')
    const queryMarker = `query-secret-${randomUUID()}`
    const rejected = await fetch(`${api}/voice-relay/v1/allocations/${id}/rtc?access_token=${queryMarker}`, {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(rejected.status).toBe(403)
    const failure = await rejected.text()
    for (const value of [secret, bearer, queryMarker, joined.token, joined.iceServers[0].credential]) expect(failure).not.toContain(value)
    await new Promise<void>((resolve) => app.metricsServer.listen(0, '127.0.0.1', resolve))
    const port = (app.metricsServer.address() as import('node:net').AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/metrics`)
    expect(response.status).toBe(200)
    const output = await response.text()
    expect(output).toContain('voice_relay_http_requests_total')
    expect(output).toContain('voice_relay_http_request_duration_seconds_bucket')
    expect(output).toContain('voice_relay_active_allocations')
    expect(output).toContain('voice_relay_reserved_slots')
    expect(output).toContain('voice_relay_pg_pool_connections')
    expect(output).toMatch(/voice_relay_active_allocations [1-9][0-9]*/)
    expect(output).toMatch(/voice_relay_reserved_slots (?:[7-9]|[1-9][0-9]+)/)
    expect(output).toContain('voice_relay_api_failures_total')
    expect(output).toContain('voice_relay_sfu_failures_total')
    expect(output).toContain('route="/health"')
    expect(output).toContain('status="401"')
    expect(output).toContain('status="404"')
    expect(output).toContain('route="unknown"')
    expect(output).not.toContain(unknown)
    expect(output).not.toContain('metrics-room')
    for (const value of [secret, bearer, queryMarker, joined.token, joined.iceServers[0].credential]) expect(output).not.toContain(value)
  } finally {
    await call('DELETE', `/voice-relay/v1/allocations/${id}`)
  }
})

test('metrics count failed LiveKit API calls through a real HTTP listener', async () => {
  const isolated = await createTestDatabase({
    connectionString: url,
    initialize: async (fixture) => {
      await fixture.store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://metrics.test', enabled: true, maxSlots: 102, maxRooms: 2 })
    },
  })
  const service = await createServer(
    {
      databaseUrl: url,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'https://relay.test',
      clientSecretFile: '',
      livekit: { ...testLiveKit, url: 'http://127.0.0.1:1' },
      maxSlots: 102,
      maxRooms: 2,
      iceServers: null,
    },
    { store: isolated.store, migrate: false, startWorkers: false, loadSecrets: () => ({ client: secret }) },
  )
  try {
    await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => service.metricsServer.listen(0, '127.0.0.1', resolve))
    const port = (service.server.address() as import('node:net').AddressInfo).port
    const metricsPort = (service.metricsServer.address() as import('node:net').AddressInfo).port
    const path = '/voice-relay/v1/allocations'
    const body = JSON.stringify({ roomKey: 'metrics-failure', generation: 'failure', slots: 1 })
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await clientToken(secret, 'https://metrics.test')}` },
      body,
    })
    expect(response.status).toBe(503)
    const output = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text()
    expect(output).toContain('voice_relay_sfu_failures_total 1')
    expect(output).toContain('voice_relay_api_failures_total 1')
  } finally {
    await service.close()
    await isolated.close()
  }
})

test('allocation and lookup accept Unicode code points up to the documented maximum', async () => {
  for (const length of [65, 128]) {
    const generation = '🙂'.repeat(length)
    const request = { roomKey: `unicode-${randomUUID()}`, generation, slots: 1 }
    const created = await call('POST', '/voice-relay/v1/allocations', request)
    expect(created.statusCode).toBe(200)
    try {
      const query = new URLSearchParams({ roomKey: request.roomKey, generation })
      expect((await call('GET', `/voice-relay/v1/allocations?${query}`)).statusCode).toBe(200)
    } finally {
      await call('DELETE', `/voice-relay/v1/allocations/${created.json().id}`)
    }
  }
  const tooLong = { roomKey: 'unicode-boundary', generation: '🙂'.repeat(129), slots: 1 }
  expect((await call('POST', '/voice-relay/v1/allocations', tooLong)).statusCode).toBe(400)
  expect(
    (await call('GET', `/voice-relay/v1/allocations?${new URLSearchParams({ roomKey: tooLong.roomKey, generation: tooLong.generation })}`))
      .statusCode,
  ).toBe(400)
})

test('cancelling an unseen generation permanently prevents a delayed allocation', async () => {
  const roomKey = `cancel-${randomUUID()}`
  const generation = 'first'
  const capacity = await call('GET', '/voice-relay/v1/capacity')
  expect(capacity.json().capabilities.cancelPending).toBe(true)
  const cancelled = await call('POST', '/voice-relay/v1/allocations/cancel', { roomKey, generation })
  expect(cancelled.statusCode).toBe(200)
  expect(cancelled.json()).toEqual({ state: 'ended' })
  const delayed = await call('POST', '/voice-relay/v1/allocations', { roomKey, generation, slots: 1 })
  expect(delayed.statusCode).toBe(409)
  expect(delayed.json()).toEqual({ code: 'ALLOCATION_CONFLICT' })
})

test('prototype keys cannot be used as client credentials', async () => {
  const bearer = await clientToken(secret, 'constructor')
  const response = await inject({ method: 'GET', url: '/voice-relay/v1/capacity', headers: { authorization: `Bearer ${bearer}` } })
  expect(response.statusCode).toBe(401)
})

test('join skips provider TURN issuance when the client explicitly opts out', async () => {
  const allocation = (
    await call('POST', '/voice-relay/v1/allocations', { slots: 1, roomKey: `own-turn-${randomUUID()}`, generation: 'g' })
  ).json()
  const previous = turnResolver
  let calls = 0
  turnResolver = async () => {
    calls++
    throw new Error('TURN unavailable')
  }
  try {
    if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const port = (app.server.address() as import('node:net').AddressInfo).port
    const path = `/voice-relay/v1/allocations/${allocation.id}/join`
    const body = JSON.stringify({ identity: 'user', userId: 'user', allowScreenShare: false, includeIceServers: false })
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await clientToken(secret, 'https://a.test')}` },
    })
    expect(response.status).toBe(200)
    const value = await response.json()
    expect(value.iceServers).toBeNull()
    expect(value.token).toBeTruthy()
    expect(calls).toBe(0)
    expect((await call('POST', path, { identity: 'user', userId: 'user', allowScreenShare: false })).statusCode).toBe(503)
    expect(calls).toBe(1)
  } finally {
    turnResolver = previous
    await call('DELETE', `/voice-relay/v1/allocations/${allocation.id}`)
  }
})

test('concurrent requests can reuse a valid bearer token', async () => {
  if (!app.server.listening) await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = (app.server.address() as import('node:net').AddressInfo).port
  const headers = { authorization: `Bearer ${await clientToken(secret, 'https://a.test')}` }
  const replies = await Promise.all(Array.from({ length: 4 }, () => fetch(`http://127.0.0.1:${port}/voice-relay/v1/capacity`, { headers })))
  expect(replies.map((response) => response.status)).toEqual([200, 200, 200, 200])
})
