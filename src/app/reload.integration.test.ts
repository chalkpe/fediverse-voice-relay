// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { LiveKit } from '../infra/livekit.ts'
import { clients } from '../infra/schema.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKitSettings } from '../infra/test-livekit.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'
import { createServer } from './server.ts'

test('reload requires the current relay audience while retaining existing allocations', async () => {
  const url = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const dir = await mkdtemp(join(tmpdir(), 'relay-reload-db-'))
  const database = await createTestDatabase({
    connectionString: url,
    initialize: async ({ store }) => {
      await store.db.insert(clients).values([
        { id: 'a', origin: 'https://a.test', enabled: true, maxSlots: 10, maxRooms: 3 },
        { id: 'b', origin: 'https://b.test', enabled: true, maxSlots: 10, maxRooms: 3 },
      ])
    },
  })
  const secretA = 'a'.repeat(64)
  const secretB = 'b'.repeat(64)
  const keyFile = join(dir, 'keys.json')
  const configFile = join(dir, 'config.json')
  const config = {
    databaseUrl: url,
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    publicUrl: 'https://old-relay.test',
    clientSecretFile: keyFile,
    livekit: testLiveKitSettings,
    maxSlots: 10,
    maxRooms: 3,
    iceServers: null,
  }
  await writeFile(keyFile, JSON.stringify({ a: secretA, b: secretB }), { mode: 0o600 })
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
  const ensure = vi.spyOn(LiveKit.prototype, 'ensure').mockResolvedValue()
  const remove = vi.spyOn(LiveKit.prototype, 'remove').mockResolvedValue()
  const participants = vi.spyOn(LiveKit.prototype, 'participants').mockResolvedValue([])
  const server = await createServer(config, { store: database.store, migrate: false, startWorkers: false, configFile })
  const allocations: string[] = []
  let base = ''
  async function call(method: string, path: string, key: 'a' | 'b', audience: string, body?: unknown) {
    const token = await clientToken(key === 'a' ? secretA : secretB, key === 'a' ? 'https://a.test' : 'https://b.test', audience)
    return fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }
  try {
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.server.address() as import('node:net').AddressInfo).port}`
    const old = await call('POST', '/voice-relay/v1/allocations', 'a', config.publicUrl, { roomKey: 'old-room', generation: 'g', slots: 1 })
    expect(old.status).toBe(200)
    const oldAllocation = (await old.json()) as { id: string }
    allocations.push(oldAllocation.id)
    const initialCapacity = await (await call('GET', '/voice-relay/v1/capacity', 'a', config.publicUrl)).json()
    const initialJoin = await (
      await call('POST', `/voice-relay/v1/allocations/${oldAllocation.id}/join`, 'a', config.publicUrl, {
        identity: 'https://a.test/users/a',
        userId: 'a',
        allowScreenShare: false,
      })
    ).json()
    expect(initialCapacity).not.toHaveProperty('screenShareLimits')
    expect(initialJoin).not.toHaveProperty('screenShareLimits')
    const lower = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, maxBitrate: 2000000 }
    const nextUrl = 'https://new-relay.test'
    await writeFile(configFile, JSON.stringify({ ...config, publicUrl: nextUrl, maxSlots: 2, screenShareLimits: lower }))
    await server.reload()
    const joined = await call('POST', `/voice-relay/v1/allocations/${oldAllocation.id}/join`, 'a', nextUrl, {
      identity: 'https://a.test/users/a',
      userId: 'a',
      allowScreenShare: false,
    })
    expect(joined.status).toBe(200)
    const oldJoin = await joined.json()
    expect(oldJoin.mediaProvider).toBe(config.publicUrl)
    expect(oldJoin.screenShareLimits).toEqual(lower)
    expect((await (await call('GET', '/voice-relay/v1/capacity', 'a', nextUrl)).json()).screenShareLimits).toEqual(lower)
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', 'a', nextUrl, { token: oldJoin.token })).status).toBe(200)
    const fresh = await call('POST', '/voice-relay/v1/allocations', 'a', nextUrl, { roomKey: 'new-room', generation: 'g', slots: 1 })
    expect(fresh.status).toBe(200)
    const newAllocation = (await fresh.json()) as { id: string }
    allocations.push(newAllocation.id)
    const newJoin = await call('POST', `/voice-relay/v1/allocations/${newAllocation.id}/join`, 'a', nextUrl, {
      identity: 'https://a.test/users/a',
      userId: 'a',
      allowScreenShare: false,
    })
    expect(newJoin.status).toBe(200)
    const newParticipant = await newJoin.json()
    expect(newParticipant.mediaProvider).toBe(nextUrl)
    expect(newParticipant.screenShareLimits).toEqual(lower)
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', 'a', config.publicUrl, { token: newParticipant.token })).status).toBe(401)
    expect((await call('POST', '/voice-relay/v1/tokens/inspect', 'b', config.publicUrl, { token: oldJoin.token })).status).toBe(401)
    expect((await call('GET', `/voice-relay/v1/allocations/${oldAllocation.id}/snapshot`, 'b', config.publicUrl)).status).toBe(401)
    expect((await call('GET', `/voice-relay/v1/allocations/${newAllocation.id}/snapshot`, 'a', config.publicUrl)).status).toBe(401)
    const oldToken = await clientToken(secretA, 'https://a.test', config.publicUrl)
    const { request } = await import('node:http')
    for (const segment of ['..', '%2e%2e', '.%2e', '%2e.']) {
      const traversalStatus = await new Promise<number>((resolve, reject) => {
        const raw = request(
          {
            host: '127.0.0.1',
            port: (server.server.address() as import('node:net').AddressInfo).port,
            path: `/voice-relay/v1/allocations/${oldAllocation.id}/${segment}/${newAllocation.id}/snapshot`,
            headers: { authorization: `Bearer ${oldToken}` },
          },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
          },
        )
        raw.once('error', reject)
        raw.end()
      })
      expect(traversalStatus).toBe(401)
    }

    expect((await call('GET', '/voice-relay/v1/events', 'a', config.publicUrl)).status).toBe(401)
    expect((await call('GET', `/voice-relay/v1/allocations/${oldAllocation.id}/snapshot`, 'a', nextUrl)).status).toBe(200)
    const limited = await call('POST', '/voice-relay/v1/allocations', 'b', nextUrl, { roomKey: 'over-limit', generation: 'g', slots: 1 })
    expect(limited.status).toBe(429)
    await writeFile(configFile, JSON.stringify({ ...config, publicUrl: nextUrl, databaseUrl: 'postgres://other:secret@elsewhere/db' }))
    await expect(server.reload()).rejects.toThrow('Restart required: databaseUrl')
    expect((await call('GET', '/voice-relay/v1/events', 'a', nextUrl)).status).toBe(200)
  } finally {
    for (const id of allocations) await call('DELETE', `/voice-relay/v1/allocations/${id}`, 'a', 'https://new-relay.test').catch(() => {})
    await server.close()
    ensure.mockRestore()
    remove.mockRestore()
    participants.mockRestore()
    await database.close()
    await rm(dir, { recursive: true, force: true })
  }
})
