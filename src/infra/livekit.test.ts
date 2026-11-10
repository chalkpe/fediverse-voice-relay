// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { TrackSource } from 'livekit-server-sdk'
import { expect, test } from 'vitest'
import type { Allocation } from '../relay/types.ts'
import { LiveKit } from './livekit.ts'
import { testLiveKit } from './test-livekit.ts'

test('a muted microphone track overrides a stale unmuted participant attribute', async () => {
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' })
  const a: Allocation = {
    id: 'allocation',
    clientId: 'client',
    roomKey: 'room',
    generation: 'generation',
    reservedSlots: 1,
    state: 'active',
    createdAt: new Date().toISOString(),
    leaseExpiresAt: new Date().toISOString(),
  }
  livekit.client.listParticipants = async () =>
    [
      {
        identity: 'user',
        sid: 'session',
        metadata: JSON.stringify({ clientId: 'client', allocationId: 'allocation', generation: 'generation', userId: 'user' }),
        attributes: { 'cherrypick.micMuted': 'false' },
        tracks: [{ sid: 'mic', source: TrackSource.MICROPHONE, muted: true }],
        permission: undefined,
      },
    ] as never
  expect((await livekit.participants(a))[0].micMuted).toBe(true)
})

test('failed LiveKit service calls increment the injected failure counter', async () => {
  let failures = 0
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' }, () => {
    failures++
  })
  livekit.client.listRooms = async () => {
    throw new Error('upstream failed')
  }
  await expect(livekit.request(() => livekit.client.listRooms())).rejects.toThrow()
  expect(failures).toBe(1)
})

test('SDK failures retain the original error even if metrics collection fails', async () => {
  const { LiveKit } = await import('./livekit.ts')
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' }, () => {
    throw new Error('metrics failure')
  })
  const failure = new Error('original SDK failure')
  livekit.client.createRoom = async () => {
    throw failure
  }
  await expect(
    livekit.ensure(
      { id: 'a', clientId: 'c', roomKey: 'r', generation: 'g', reservedSlots: 1, state: 'pending', leaseExpiresAt: '', createdAt: '' },
      'installation',
    ),
  ).rejects.toBe(failure)
})

test('an expected missing room is not counted as an SFU failure', async () => {
  const { LiveKit } = await import('./livekit.ts')
  const { TwirpError } = await import('livekit-server-sdk')
  let failures = 0
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' }, () => {
    failures++
  })
  livekit.client.listParticipants = async () => {
    throw new TwirpError('missing', 'missing', 404, 'not_found')
  }
  expect(
    await livekit.participants({
      id: 'a',
      clientId: 'c',
      roomKey: 'r',
      generation: 'g',
      reservedSlots: 1,
      state: 'pending',
      leaseExpiresAt: '',
      createdAt: '',
    }),
  ).toEqual([])
  expect(failures).toBe(0)
})

test('a client-authentication JWT is rejected even if LiveKit keys happen to match', async () => {
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const secret = 's'.repeat(64)
  const livekit = new LiveKit({ url: 'http://127.0.0.1:1', apiKey: 'voice-relay-client', apiSecret: secret })

  await expect(livekit.verify(await clientToken(secret))).rejects.toThrow()
})

test('trusted refresh keys verify alongside the active key without accepting unknown issuers or bad signatures', async () => {
  const { AccessToken } = await import('livekit-server-sdk')
  const active = { apiKey: 'active', apiSecret: 'a'.repeat(32) }
  const refresh = { apiKey: 'refresh', apiSecret: 'r'.repeat(32) }
  const livekit = new LiveKit({ url: 'http://127.0.0.1:1', ...active, verificationKeys: [refresh] })
  const token = (key: string, secret: string) => new AccessToken(key, secret, { identity: 'user' }).toJwt()
  expect((await livekit.verify(await token(active.apiKey, active.apiSecret))).sub).toBe('user')
  expect((await livekit.verify(await token(refresh.apiKey, refresh.apiSecret))).sub).toBe('user')
  await expect(livekit.verify(await token('unknown', refresh.apiSecret))).rejects.toThrow()
  await expect(livekit.verify(await token(refresh.apiKey, 'x'.repeat(32)))).rejects.toThrow()
})
