// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { SignalResponse } from '@livekit/protocol'
import { AccessToken, RoomServiceClient, TokenVerifier } from 'livekit-server-sdk'
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { clients } from '../infra/schema.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit } from '../infra/test-livekit.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'
import { createServer } from './server.ts'

const refreshKey = process.env.LIVEKIT_REFRESH_API_KEY
const refreshSecret = process.env.LIVEKIT_REFRESH_API_SECRET

test.skipIf(!refreshKey || !refreshSecret)(
  'two-key SFU refresh and reconnect preserve all relay authorization checks',
  async () => {
    if (!refreshKey || !refreshSecret) throw new Error('Missing refresh credentials')
    const databaseUrl =
      process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
    const database = await createTestDatabase({
      connectionString: databaseUrl,
      initialize: async ({ store }) => {
        await store.db.insert(clients).values([
          { id: 'rotation', origin: 'https://a.test', enabled: true, maxSlots: 2, maxRooms: 2, allowScreenShare: true },
          { id: 'other', origin: 'https://b.test', enabled: true, maxSlots: 2, maxRooms: 2, allowScreenShare: true },
        ])
      },
    })
    const clientSecret = 'c'.repeat(64)
    const app = await createServer(
      {
        databaseUrl,
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'https://relay.test',
        clientSecretFile: 'unused',
        livekit: { ...testLiveKit, verificationKeys: [{ apiKey: refreshKey, apiSecret: refreshSecret }] },
        maxSlots: 4,
        maxRooms: 4,
        iceServers: null,
      },
      {
        store: database.store,
        loadSecrets: () => ({ rotation: clientSecret, other: clientSecret }),
        startWorkers: false,
      },
    )
    const call = async (method: string, path: string, body?: unknown, key = 'k') => {
      const response = await app.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${await clientToken(clientSecret, key === 'k' ? 'https://a.test' : 'https://b.test')}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return response
    }
    const wait = (ws: WebSocket, kind: string): Promise<SignalResponse> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${kind}`)), 7000)
        ws.on('message', function handler(data) {
          const signal = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
          if (signal.message.case === kind) {
            clearTimeout(timer)
            ws.off('message', handler)
            resolve(signal)
          }
        })
        ws.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
    let socket: WebSocket | undefined
    let allocationId: string | undefined
    try {
      const allocated = await call('POST', '/voice-relay/v1/allocations', { slots: 1, roomKey: 'rotation-room', generation: 'g' })
      expect(allocated.status).toBe(200)
      const allocation = (await allocated.json()) as { id: string }
      allocationId = allocation.id
      const identity = 'https://a.test/users/rotation'
      const issuedResponse = await call('POST', `/voice-relay/v1/allocations/${allocation.id}/join`, {
        identity,
        userId: 'u',
        allowScreenShare: false,
      })
      const issued = (await issuedResponse.json()) as { token: string }
      expect(issuedResponse.status).toBe(200)
      const original = await new TokenVerifier(testLiveKit.apiKey, testLiveKit.apiSecret).verify(issued.token)
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
      const port = (app.server.address() as import('node:net').AddressInfo).port
      const auth = await clientToken(clientSecret, 'https://a.test')
      const connect = (token: string) =>
        new WebSocket(
          `ws://127.0.0.1:${port}/voice-relay/v1/allocations/${allocation.id}/rtc?access_token=${encodeURIComponent(token)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`,
          { headers: { authorization: `Bearer ${auth}` } },
        )
      socket = connect(issued.token)
      const joined = wait(socket, 'join')
      const automatic = wait(socket, 'refreshToken')
      expect((await joined).message.case).toBe('join')
      const first = await automatic
      if (first.message.case !== 'refreshToken') throw new Error('Missing automatic refresh')
      const service = new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret)
      let refreshed = first.message.value
      // LiveKit 1.13 iterates its key map. Wait for the other configured signer if needed.
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          await new TokenVerifier(refreshKey, refreshSecret).verify(refreshed)
          break
        } catch {
          const next = wait(socket, 'refreshToken')
          await service.updateParticipant(`voice-relay:rotation:${allocation.id}`, identity, { attributes: { probe: String(attempt) } })
          const signal = await next
          if (signal.message.case !== 'refreshToken') throw new Error('Missing refresh')
          refreshed = signal.message.value
        }
      }
      const claims = await new TokenVerifier(refreshKey, refreshSecret).verify(refreshed)
      await expect(new TokenVerifier(testLiveKit.apiKey, testLiveKit.apiSecret).verify(refreshed)).rejects.toThrow()
      expect(claims.metadata).toBe(original.metadata)
      expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: refreshed })).status).toBe(200)
      expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: refreshed }, 'o')).status).toBe(403)
      socket.terminate()
      socket = connect(refreshed)
      expect((await wait(socket, 'join')).message.case).toBe('join')

      const mint = async (
        key: string,
        secret: string,
        options: { room?: string; identity?: string; roomJoin?: boolean; metadata?: string } = {},
      ) => {
        const token = new AccessToken(key, secret, {
          identity: options.identity ?? identity,
          metadata: options.metadata ?? claims.metadata,
        })
        token.addGrant({ room: options.room ?? `voice-relay:rotation:${allocation.id}`, roomJoin: options.roomJoin ?? true })
        return token.toJwt()
      }
      for (const [key, secret] of [
        [testLiveKit.apiKey, testLiveKit.apiSecret],
        [refreshKey, refreshSecret],
      ]) {
        const valid = await mint(key, secret)
        expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: valid })).status).toBe(200)
        expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token: valid }, 'o')).status).toBe(403)
        const metadata = JSON.parse(claims.metadata ?? '{}') as Record<string, unknown>
        for (const token of [
          await mint(key, secret, { room: 'another-room' }),
          await mint(key, secret, { identity: 'another-user' }),
          await mint(key, secret, { roomJoin: false }),
          await mint(key, secret, { metadata: JSON.stringify({ ...metadata, tokenGeneration: '00000000-0000-4000-8000-000000000000' }) }),
          await mint(key, secret, { metadata: JSON.stringify({ ...metadata, generation: 'other-generation' }) }),
        ]) {
          expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token })).status).toBe(403)
        }
      }
      for (const token of [await mint('unknown', refreshSecret), await mint(refreshKey, 'x'.repeat(32))]) {
        expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token })).status).toBe(403)
      }
      expect((await call('POST', `/voice-relay/v1/allocations/${allocation.id}/participants/kick`, { identity })).status).toBe(200)
      for (const token of [issued.token, refreshed])
        expect((await call('POST', '/voice-relay/v1/tokens/inspect', { token })).status).toBe(403)
    } finally {
      socket?.terminate()
      if (allocationId) await call('DELETE', `/voice-relay/v1/allocations/${allocationId}`)
      await app.close()
      await database.close()
    }
  },
  30000,
)
