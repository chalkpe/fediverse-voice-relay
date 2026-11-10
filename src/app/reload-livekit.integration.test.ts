// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalResponse } from '@livekit/protocol'
import { RoomServiceClient } from 'livekit-server-sdk'
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { clients } from '../infra/schema.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit, testLiveKitReloadConfigured } from '../infra/test-livekit.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'
import { createReloadControl } from './reload-control.ts'
import { createServer } from './server.ts'

function waitForSignal(socket: WebSocket, kind: string): Promise<SignalResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${kind} signal`)), 5000)
    socket.on('message', function receive(data) {
      const response = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
      if (response.message.case === kind) {
        clearTimeout(timer)
        socket.off('message', receive)
        resolve(response)
      }
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function executeReload(socketPath: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/app/cli.ts', 'reload'], {
      env: { ...process.env, VOICE_RELAY_CONTROL: socketPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}

test.skipIf(!testLiveKitReloadConfigured)(
  'real LiveKit signaling and PostgreSQL allocation survive successful and rejected reloads',
  async () => {
    const dbUrl = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
    const dir = await mkdtemp(join(tmpdir(), 'relay-real-reload-'))
    const database = await createTestDatabase({
      connectionString: dbUrl,
      initialize: async ({ store }) => {
        await store.db.insert(clients).values({
          id: 'client',
          origin: 'https://client.test',
          enabled: true,
          maxSlots: 10,
          maxRooms: 5,
          allowScreenShare: true,
        })
      },
    })
    try {
      const keyFile = join(dir, 'keys.json')
      const configFile = join(dir, 'config.json')
      const controlPath = join(dir, 'control.sock')
      const clientSecret = 'fixture-client-secret-for-reload-validation-123456789'
      const settings = {
        databaseUrl: dbUrl,
        host: '127.0.0.1',
        port: 0,
        metrics: { host: '127.0.0.1', port: 0 },
        publicUrl: 'https://old-relay.test',
        clientSecretFile: keyFile,
        livekit: testLiveKit,
        maxSlots: 10,
        maxRooms: 5,
        iceServers: null,
      }
      await writeFile(keyFile, JSON.stringify({ client: clientSecret }), { mode: 0o600 })
      await writeFile(configFile, JSON.stringify(settings), { mode: 0o600 })
      const service = await createServer(settings, { store: database.store, migrate: false, startWorkers: false, configFile })
      try {
        const control = await createReloadControl(controlPath, () => service.reload())
        const occupied = createHttpServer()
        let socket: WebSocket | undefined
        let allocationId: string | undefined
        let base = ''
        async function call(method: string, path: string, audience: string, body?: unknown) {
          const authorization = `Bearer ${await clientToken(clientSecret, 'https://client.test', audience)}`
          return fetch(base + path, {
            method,
            headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
        }
        function address() {
          const listener = service.server.address() as AddressInfo
          return `http://${listener.family === 'IPv6' ? `[${listener.address}]` : listener.address}:${listener.port}`
        }
        async function connect(participantToken: string, audience: string) {
          const authorization = `Bearer ${await clientToken(clientSecret, 'https://client.test', audience)}`
          const listener = service.server.address() as AddressInfo
          const host = listener.family === 'IPv6' ? `[${listener.address}]` : listener.address
          const path = `/voice-relay/v1/allocations/${allocationId}/rtc?access_token=${encodeURIComponent(participantToken)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`
          return new WebSocket(`ws://${host}:${listener.port}${path}`, { headers: { authorization } })
        }
        try {
          await Promise.all([
            new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve)),
            new Promise<void>((resolve) => service.metricsServer.listen(0, '127.0.0.1', resolve)),
            new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve)),
          ])
          base = address()
          const allocated = await call('POST', '/voice-relay/v1/allocations', settings.publicUrl, {
            roomKey: 'reload-live-room',
            generation: 'g',
            slots: 2,
          })
          expect(allocated.status).toBe(200)
          allocationId = ((await allocated.json()) as { id: string }).id
          const identity = 'https://client.test/users/live'
          const joined = await call('POST', `/voice-relay/v1/allocations/${allocationId}/join`, settings.publicUrl, {
            identity,
            userId: 'live',
            allowScreenShare: true,
          })
          expect(joined.status).toBe(200)
          const participant = (await joined.json()) as { token: string }
          socket = await connect(participant.token, settings.publicUrl)
          expect(
            (
              await waitForSignal(socket, 'join').catch(() => {
                throw new Error('Initial RTC join failed')
              })
            ).message.case,
          ).toBe('join')
          expect((await call('POST', `/voice-relay/v1/allocations/${allocationId}/lease`, settings.publicUrl, {})).status).toBe(200)

          const next = {
            ...settings,
            host: 'localhost',
            metrics: { host: 'localhost', port: 0 },
            publicUrl: 'https://new-relay.test',
            maxSlots: 1,
            iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
          }
          await writeFile(configFile, JSON.stringify(next), { mode: 0o600 })
          const changed = await executeReload(controlPath)
          expect(changed.code).toBe(0)
          if ([testLiveKit.apiKey, testLiveKit.apiSecret, clientSecret, participant.token].some((value) => changed.output.includes(value)))
            throw new Error('Reload output exposed credentials')
          base = address()
          const after = await call('POST', `/voice-relay/v1/allocations/${allocationId}/join`, next.publicUrl, {
            identity: 'https://client.test/users/new',
            userId: 'new',
            allowScreenShare: false,
          })
          expect(after.status).toBe(200)
          const joinAfter = (await after.json()) as { mediaProvider: string; iceServers: { urls: string[] }[] }
          expect(joinAfter.mediaProvider).toBe(settings.publicUrl)
          expect(joinAfter.iceServers[0].urls).toEqual(['stun:stun.example.test:3478'])
          expect(
            (await call('POST', '/voice-relay/v1/allocations', next.publicUrl, { roomKey: 'above-limit', generation: 'g', slots: 1 }))
              .status,
          ).toBe(429)
          expect((await call('POST', `/voice-relay/v1/allocations/${allocationId}/lease`, next.publicUrl, {})).status).toBe(200)
          const refresh = waitForSignal(socket, 'refreshToken')
          await new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret).updateParticipant(
            `voice-relay:client:${allocationId}`,
            identity,
            { attributes: { probe: 'reload' } },
          )
          const refreshed = await refresh
          if (refreshed.message.case !== 'refreshToken') throw new Error('Wrong signal')
          expect((await call('POST', '/voice-relay/v1/tokens/inspect', next.publicUrl, { token: refreshed.message.value })).status).toBe(
            200,
          )
          socket.terminate()
          socket = await connect(refreshed.message.value, next.publicUrl)
          expect(
            (
              await waitForSignal(socket, 'join').catch(() => {
                throw new Error('RTC reconnect after reload failed')
              })
            ).message.case,
          ).toBe('join')

          const busy = (occupied.address() as AddressInfo).port
          await writeFile(
            configFile,
            JSON.stringify({ ...next, metrics: { host: '127.0.0.1', port: busy }, maxSlots: 10, publicUrl: 'https://failed.test' }),
          )
          const rejected = await executeReload(controlPath)
          expect(rejected.code).toBe(1)
          if (!rejected.output.includes('Unable to prepare listener')) throw new Error('Listener rollback was not reported')
          expect(
            (await call('POST', '/voice-relay/v1/allocations', next.publicUrl, { roomKey: 'still-limited', generation: 'g', slots: 1 }))
              .status,
          ).toBe(429)
          for (const change of [
            { ...next, databaseUrl: 'postgres://other:secret@elsewhere/db' },
            { ...next, livekit: { ...next.livekit, url: 'http://127.0.0.1:1' } },
            { ...next, livekit: { ...next.livekit, apiKey: 'other-key' } },
            { ...next, livekit: { ...next.livekit, apiSecret: 'x'.repeat(64) } },
            { ...next, livekit: { ...next.livekit, verificationKeys: [{ apiKey: 'refresh-key', apiSecret: 'v'.repeat(64) }] } },
          ]) {
            await writeFile(configFile, JSON.stringify(change), { mode: 0o600 })
            const refused = await executeReload(controlPath)
            expect(refused.code).toBe(1)
            if (!refused.output.includes('Restart required')) throw new Error('Restart requirement was not reported')
            if (
              [testLiveKit.apiKey, testLiveKit.apiSecret, clientSecret, participant.token].some((value) => refused.output.includes(value))
            )
              throw new Error('Reload error exposed credentials')
          }
          expect((await call('POST', `/voice-relay/v1/allocations/${allocationId}/lease`, next.publicUrl, {})).status).toBe(200)
          const signal = waitForSignal(socket, 'refreshToken')
          await new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret).updateParticipant(
            `voice-relay:client:${allocationId}`,
            identity,
            { attributes: { probe: 'rollback' } },
          )
          expect((await signal).message.case).toBe('refreshToken')
        } finally {
          socket?.terminate()
          let cleaned = !allocationId
          try {
            if (allocationId) {
              if (base) {
                for (const audience of ['https://new-relay.test', settings.publicUrl]) {
                  const response = await call('DELETE', `/voice-relay/v1/allocations/${allocationId}`, audience).catch(() => undefined)
                  if (response?.ok) {
                    cleaned = true
                    break
                  }
                }
              }
              if (!cleaned) {
                await new RoomServiceClient(testLiveKit.url, testLiveKit.apiKey, testLiveKit.apiSecret).deleteRoom(
                  `voice-relay:client:${allocationId}`,
                )
              }
            }
          } finally {
            await Promise.all([
              control.close(),
              occupied.listening ? new Promise<void>((resolve) => occupied.close(() => resolve())) : Promise.resolve(),
            ])
          }
        }
      } finally {
        await service.close()
      }
    } finally {
      await database.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
  30000,
)
