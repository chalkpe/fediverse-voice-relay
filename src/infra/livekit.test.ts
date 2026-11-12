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

const statusAllocation: Allocation = {
  id: 'allocation',
  clientId: 'client',
  roomKey: 'room',
  generation: 'generation',
  reservedSlots: 2,
  state: 'active',
  createdAt: '',
  leaseExpiresAt: '',
}

const member = JSON.stringify({ clientId: 'client', allocationId: 'allocation', generation: 'generation', userId: 'user' })

function participantInfo(identity: string, sid: string, attributes: Record<string, string>) {
  return { identity, sid, metadata: member, attributes, tracks: [], permission: undefined }
}

function recordStatusWrites(livekit: LiveKit, sessions: { read: string; written: string; metadata?: string }) {
  const writes: Record<string, string>[] = []
  livekit.client.getParticipant = async () => ({ sid: sessions.read, metadata: sessions.metadata ?? member }) as never
  livekit.client.updateParticipant = async (
    _room: string,
    _identity: string,
    options?: string | { attributes?: Record<string, string> },
  ) => {
    writes.push({ ...(typeof options === 'object' ? options.attributes : {}) })
    return { sid: sessions.written } as never
  }
  return writes
}

test('snapshot recording reads only the key of the current LiveKit session', async () => {
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' })
  livekit.client.listParticipants = async () =>
    [
      participantInfo('reconnected', 'PA_current', { 'cherrypick.recording:PA_previous': 'true', 'cherrypick.recording': 'true' }),
      participantInfo('recording', 'PA_recording', { 'cherrypick.recording:PA_recording': 'true' }),
      participantInfo('stopped', 'PA_stopped', { 'cherrypick.recording:PA_stopped': 'false' }),
    ] as never

  const participants = await livekit.participants(statusAllocation)

  expect(participants.map((p) => [p.identity, p.sessionId, p.recording])).toEqual([
    ['reconnected', 'PA_current', false],
    ['recording', 'PA_recording', true],
    ['stopped', 'PA_stopped', false],
  ])
})

test('a status write without recording leaves the recording state untouched', async () => {
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' })
  const writes = recordStatusWrites(livekit, { read: 'PA_session', written: 'PA_session' })

  const accepted = await livekit.updateStatus(statusAllocation, {
    identity: 'user',
    sessionId: 'PA_session',
    micMuted: true,
    deafened: false,
  })

  expect(accepted).toBe(true)
  expect(writes).toEqual([{ 'cherrypick.micMuted': 'true', 'cherrypick.deafened': 'false' }])
})

test.each([true, false])('recording %s is written under the verified session key', async (recording) => {
  const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' })
  const writes = recordStatusWrites(livekit, { read: 'PA_session', written: 'PA_session' })

  const accepted = await livekit.updateStatus(statusAllocation, {
    identity: 'user',
    sessionId: 'PA_session',
    micMuted: false,
    deafened: false,
    recording,
  })

  expect(accepted).toBe(true)
  expect(writes).toEqual([
    { 'cherrypick.micMuted': 'false', 'cherrypick.deafened': 'false', 'cherrypick.recording:PA_session': String(recording) },
  ])
})

test('a stale session or a participant of another allocation is not written', async () => {
  const foreign = JSON.stringify({ clientId: 'client', allocationId: 'allocation', generation: 'previous', userId: 'user' })

  for (const sessions of [
    { read: 'PA_current', written: 'PA_current' },
    { read: 'PA_session', written: 'PA_session', metadata: foreign },
    { read: 'PA_session', written: 'PA_session', metadata: '' },
  ]) {
    const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' })
    const writes = recordStatusWrites(livekit, sessions)

    const accepted = await livekit.updateStatus(statusAllocation, {
      identity: 'user',
      sessionId: 'PA_session',
      micMuted: true,
      deafened: true,
      recording: true,
    })

    expect(accepted).toBe(false)
    expect(writes).toEqual([])
  }
})

test.each([undefined, false, true])(
  'a write with recording %s that reaches a newer session clears only the requesting session keys',
  async (recording) => {
    const livekit = new LiveKit({ ...testLiveKit, url: 'http://127.0.0.1:1' })
    const writes = recordStatusWrites(livekit, { read: 'PA_previous', written: 'PA_current' })

    const accepted = await livekit.updateStatus(statusAllocation, {
      identity: 'user',
      sessionId: 'PA_previous',
      micMuted: false,
      deafened: false,
      recording,
    })

    const recorded = recording === undefined ? {} : { 'cherrypick.recording:PA_previous': String(recording) }
    const cleared = recording === undefined ? {} : { 'cherrypick.recording:PA_previous': '' }
    expect(accepted).toBe(false)
    expect(writes).toEqual([
      { 'cherrypick.micMuted': 'false', 'cherrypick.deafened': 'false', ...recorded },
      { 'cherrypick.micMuted': '', 'cherrypick.deafened': '', ...cleared },
    ])
    expect(writes.flatMap((attributes) => Object.keys(attributes))).not.toContain('cherrypick.recording:PA_current')
  },
)
