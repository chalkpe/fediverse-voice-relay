// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit, testLiveKitConfigured } from '../infra/test-livekit.ts'
import { Provider } from './provider.ts'

const dbUrl = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let provider: Provider

beforeAll(async () => {
  if (!testLiveKitConfigured) return
  database = await createTestDatabase({
    connectionString: dbUrl,
    initialize: async ({ store }) => {
      await store.db
        .insert(clients)
        .values({ id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 5, maxRooms: 5, allowScreenShare: true })
    },
  })
  provider = new Provider(database.store, new LiveKit(testLiveKit), {
    maxSlots: 5,
    maxRooms: 5,
    mediaProvider: 'https://relay.test',
    iceServers: null,
  })
})

afterAll(async () => {
  await database?.close()
})

test.skipIf(!testLiveKitConfigured)(
  'missing kicks consume no budget, concurrent joins respect the limit, and existing tokens can always be revoked',
  async () => {
    const a = await provider.allocate('client', { roomKey: 'token-budget', generation: 'g', slots: 1 })
    const join = (identity: string) => provider.join('client', a.id, { identity, userId: identity, allowScreenShare: false })
    const otherConnection = database.connect()
    const other = new Provider(otherConnection.store, provider.livekit, provider.limits)
    try {
      const original = await join('existing')
      for (let i = 0; i < 40; i++) {
        expect(await provider.participant('client', a.id, 'kick', { identity: `missing-${i}` })).toEqual({ accepted: false })
      }
      for (let i = 0; i < 30; i++) await join(`participant-${i}`)
      const results = await Promise.allSettled([
        join('last-a'),
        other.join('client', a.id, { identity: 'last-b', userId: 'last-b', allowScreenShare: false }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected')
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'CAPACITY_EXCEEDED', status: 429 })
      await expect(join('new')).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
      expect(await provider.participant('client', a.id, 'permissions', { identity: 'existing', allowScreenShare: false })).toEqual({
        accepted: false,
      })
      await expect(provider.inspect('client', original.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const afterPermissions = await join('existing')
      expect(await provider.participant('client', a.id, 'kick', { identity: 'existing' })).toEqual({ accepted: false })
      await expect(provider.inspect('client', afterPermissions.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const renewed = await join('existing')
      expect((await provider.inspect('client', renewed.token)).identity).toBe('existing')
    } finally {
      await provider.end('client', a.id)
      await otherConnection.close()
    }
  },
  30000,
)

test.skipIf(!testLiveKitConfigured)(
  'repeated capacity reads share a recent SFU participant count',
  async () => {
    const a = await provider.allocate('client', { roomKey: 'capacity-cache', generation: 'g', slots: 1 })
    const participants = vi.spyOn(provider.livekit, 'participants')
    try {
      expect((await provider.capacity('client')).activeParticipants).toBe(0)
      expect((await provider.capacity('client')).activeParticipants).toBe(0)
      expect(participants).toHaveBeenCalledTimes(1)
    } finally {
      participants.mockRestore()
      await provider.end('client', a.id)
    }
  },
  30000,
)

test.skipIf(!testLiveKitConfigured)(
  'revoked tokens cannot reconnect to the real SFU through the relay after the budget is full',
  async () => {
    if (!testLiveKitConfigured) throw new Error('Missing private test fixture')
    const { createServer } = await import('../app/server.ts')
    const { clientToken } = await import('./fixtures/client-token.ts')
    const { SignalResponse } = await import('@livekit/protocol')
    const { WebSocket } = await import('ws')
    const secret = 'fixture-client-secret-for-budget-testing-123456789'
    const service = await createServer(
      {
        databaseUrl: dbUrl,
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'https://relay.test',
        clientSecretFile: '',
        livekit: testLiveKit,
        maxSlots: 5,
        maxRooms: 5,
        iceServers: null,
      },
      { store: database.store, migrate: false, startWorkers: false, loadSecrets: () => ({ client: secret }) },
    )
    const a = await provider.allocate('client', { roomKey: 'token-budget-live', generation: 'g', slots: 1 })
    const join = (identity: string) => provider.join('client', a.id, { identity, userId: identity, allowScreenShare: false })
    let socket: InstanceType<typeof WebSocket> | undefined
    try {
      const original = await join('connected')
      for (let i = 0; i < 31; i++) await join(`participant-${i}`)
      await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
      const address = service.server.address()
      if (!address || typeof address === 'string') throw new Error('Missing relay address')
      const port = address.port
      const authorization = `Bearer ${await clientToken(secret)}`
      function connect(token: string) {
        const path = `/voice-relay/v1/allocations/${a.id}/rtc?access_token=${encodeURIComponent(token)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`
        return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization } })
      }
      function signal(ws: InstanceType<typeof WebSocket>, kind: string) {
        return new Promise<InstanceType<typeof SignalResponse>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Missing ${kind} signal`)), 5000)
          ws.on('message', function receive(data) {
            const response = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
            if (response.message.case !== kind) return
            clearTimeout(timer)
            ws.off('message', receive)
            resolve(response)
          })
          ws.once('error', reject)
        })
      }
      socket = connect(original.token)
      expect((await signal(socket, 'join')).message.case).toBe('join')
      const refresh = signal(socket, 'refreshToken')
      await provider.livekit.client.updateParticipant(`voice-relay:client:${a.id}`, 'connected', { attributes: { probe: 'refresh' } })
      const refreshed = await refresh
      if (refreshed.message.case !== 'refreshToken') throw new Error('Missing refreshed token')
      const disconnected = new Promise<void>((resolve) => socket?.once('close', () => resolve()))
      expect(await provider.participant('client', a.id, 'kick', { identity: 'connected' })).toEqual({ accepted: true })
      await disconnected
      for (const token of [original.token, refreshed.message.value]) {
        await expect(provider.inspect('client', token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
        const status = await new Promise<number>((resolve, reject) => {
          const retry = connect(token)
          retry.once('unexpected-response', (_request, response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
          })
          retry.once('open', () => {
            retry.terminate()
            reject(new Error('Revoked token connected'))
          })
          retry.once('error', reject)
        })
        expect(status).toBe(403)
      }
      const renewed = await join('connected')
      socket = connect(renewed.token)
      expect((await signal(socket, 'join')).message.case).toBe('join')
    } finally {
      socket?.terminate()
      await provider.end('client', a.id)
      await service.close()
    }
  },
  30000,
)

test.skipIf(!testLiveKitConfigured)(
  'HTTP join and kick enforce the shared budget across relay instances',
  async () => {
    if (!testLiveKitConfigured) throw new Error('Missing private test fixture')
    const { createServer } = await import('../app/server.ts')
    const { clientToken } = await import('./fixtures/client-token.ts')
    const secret = 'fixture-client-secret-for-http-testing-123456789'
    const settings = {
      databaseUrl: dbUrl,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'https://relay.test',
      clientSecretFile: '',
      livekit: testLiveKit,
      maxSlots: 5,
      maxRooms: 5,
      iceServers: null,
    }
    const other = database.connect()
    const options = { migrate: false, startWorkers: false, loadSecrets: () => ({ client: secret }) }
    const first = await createServer(settings, { ...options, store: database.store })
    const second = await createServer(settings, { ...options, store: other.store })
    let allocationId: string | undefined
    try {
      await new Promise<void>((resolve) => first.server.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve) => second.server.listen(0, '127.0.0.1', resolve))
      const firstAddress = first.server.address()
      const secondAddress = second.server.address()
      if (!firstAddress || typeof firstAddress === 'string' || !secondAddress || typeof secondAddress === 'string')
        throw new Error('Missing relay address')
      const authorization = `Bearer ${await clientToken(secret)}`
      const call = (port: number, method: string, path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { authorization, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      const base = '/voice-relay/v1/allocations'
      const allocated = await call(firstAddress.port, 'POST', base, { roomKey: 'http-budget', generation: 'g', slots: 1 })
      expect(allocated.status).toBe(200)
      allocationId = ((await allocated.json()) as { id: string }).id
      const path = `${base}/${allocationId}`
      const join = (port: number, identity: string) =>
        call(port, 'POST', `${path}/join`, { identity, userId: identity, allowScreenShare: false })
      const original = await join(firstAddress.port, 'existing')
      expect(original.status).toBe(200)
      const token = ((await original.json()) as { token: string }).token
      for (let i = 0; i < 35; i++) {
        const kicked = await call(firstAddress.port, 'POST', `${path}/participants/kick`, { identity: `missing-${i}` })
        expect(await kicked.json()).toEqual({ accepted: false })
      }
      for (let i = 0; i < 30; i++) expect((await join(firstAddress.port, `user-${i}`)).status).toBe(200)
      const simultaneous = await Promise.all([join(firstAddress.port, 'last-a'), join(secondAddress.port, 'last-b')])
      expect(simultaneous.map((result) => result.status).sort()).toEqual([200, 429])
      const rejected = simultaneous.find((result) => result.status === 429)
      expect(await rejected?.json()).toEqual({ code: 'CAPACITY_EXCEEDED' })
      expect(await (await call(secondAddress.port, 'POST', `${path}/participants/kick`, { identity: 'existing' })).json()).toEqual({
        accepted: false,
      })
      expect((await call(firstAddress.port, 'POST', '/voice-relay/v1/tokens/inspect', { token })).status).toBe(403)
      expect((await join(secondAddress.port, 'existing')).status).toBe(200)
    } finally {
      if (allocationId) await provider.end('client', allocationId)
      await first.close()
      await second.close()
      await other.close()
    }
  },
  30000,
)
