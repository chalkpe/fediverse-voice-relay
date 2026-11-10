// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig, secretLoader } from './config.ts'

test('screen share limits are optional, validate, and reload independently of connection settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-screen-limits-'))
  const file = join(dir, 'config.json')
  const base = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/tmp/clients.json',
    publicUrl: 'https://relay.test',
    maxSlots: 1,
    maxRooms: 1,
    livekit: { url: 'http://livekit:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  try {
    writeFileSync(file, JSON.stringify(base))
    const initial = loadConfig(file)
    expect(initial.screenShareLimits).toBeUndefined()
    const lower = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, maxBitrate: 2000000 }
    writeFileSync(file, JSON.stringify({ ...base, screenShareLimits: lower }))
    expect(loadConfig(file, initial).screenShareLimits).toEqual(lower)
    const higher = { maxWidth: 3840, maxHeight: 2160, maxFrameRate: 120, maxBitrate: 16000000 }
    writeFileSync(file, JSON.stringify({ ...base, screenShareLimits: higher }))
    expect(loadConfig(file, initial).screenShareLimits).toEqual(higher)
    const maximum = {
      maxWidth: Number.MAX_SAFE_INTEGER,
      maxHeight: Number.MAX_SAFE_INTEGER,
      maxFrameRate: Number.MAX_SAFE_INTEGER,
      maxBitrate: Number.MAX_SAFE_INTEGER,
    }
    writeFileSync(file, JSON.stringify({ ...base, screenShareLimits: maximum }))
    expect(loadConfig(file, initial).screenShareLimits).toEqual(maximum)
    for (const invalid of [null, {}, { maxWidth: 1, maxHeight: 1, maxFrameRate: 1 }]) {
      writeFileSync(file, JSON.stringify({ ...base, screenShareLimits: invalid }))
      expect(() => loadConfig(file, initial)).toThrow('Invalid screenShareLimits configuration')
    }
    for (const change of [
      { maxWidth: 0 },
      { maxHeight: 0 },
      { maxFrameRate: 0 },
      { maxBitrate: 0 },
      { maxWidth: -1 },
      { maxHeight: 1.5 },
      { maxFrameRate: '30' },
      { maxBitrate: Number.MAX_SAFE_INTEGER + 1 },
      { maxWidth: Number.MAX_SAFE_INTEGER + 1 },
      { maxHeight: Number.MAX_SAFE_INTEGER + 1 },
      { maxFrameRate: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      writeFileSync(file, JSON.stringify({ ...base, screenShareLimits: { ...lower, ...change } }))
      expect(() => loadConfig(file, initial)).toThrow('Invalid screenShareLimits configuration')
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('rejects unsafe public origins and weak LiveKit secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-relay-'))
  const file = join(dir, 'config.json')
  const base = {
    databaseUrl: 'postgres://relay:password@db:5432/relay',
    clientSecretFile: '/tmp/clients.json',
    publicUrl: 'https://relay.test',
    maxSlots: 102,
    maxRooms: 2,
    livekit: {
      url: 'http://livekit:7880',
      apiKey: 'key',
      apiSecret: 'a'.repeat(32),
    },
  }
  try {
    for (const publicUrl of [
      'http://relay.test',
      'https://user:pass@relay.test',
      'https://relay.test/path',
      'https://127.0.0.1',
      'https://[::1]',
      'https://localhost',
    ]) {
      writeFileSync(file, JSON.stringify({ ...base, publicUrl }))
      expect(() => loadConfig(file)).toThrow()
    }
    writeFileSync(file, JSON.stringify(base))
    expect(loadConfig(file).publicUrl).toBe('https://relay.test')
    expect(loadConfig(file).metrics).toEqual({ host: '127.0.0.1', port: 9090 })
    writeFileSync(file, JSON.stringify({ ...base, publicUrl: 'https://RELAY.TEST:443/' }))
    expect(loadConfig(file).publicUrl).toBe('https://relay.test')
    writeFileSync(file, JSON.stringify({ ...base, metrics: { host: '127.0.0.1', port: 65536 } }))
    expect(() => loadConfig(file)).toThrow()
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        livekit: { ...base.livekit, apiSecret: 'weak' },
      }),
    )
    expect(() => loadConfig(file)).toThrow()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('cached keys immediately follow atomic file replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-relay-keys-'))
  const file = join(dir, 'keys.json')
  const replacement = join(dir, 'new.json')
  try {
    writeFileSync(file, JSON.stringify({ client: 'first' }))
    const keys = secretLoader(file)
    expect((await keys()).client).toBe('first')
    writeFileSync(replacement, JSON.stringify({ client: 'second' }))
    renameSync(replacement, file)
    expect((await keys()).client).toBe('second')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('the example configuration cannot run with its placeholder LiveKit credentials', () => {
  expect(() => loadConfig('docs/examples/config.json')).toThrow()
})

test('malformed settings and key files do not expose their contents in errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-relay-invalid-'))
  const file = join(dir, 'bad.json')
  try {
    const secret = 'TOPSECRET'
    writeFileSync(file, `${secret}_NOPE`)
    await expect(Promise.resolve().then(() => loadConfig(file))).rejects.not.toThrow(secret)
    await expect(secretLoader(file)()).rejects.not.toThrow(secret)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('validates optional Cloudflare TURN settings without echoing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-relay-turn-'))
  const file = join(dir, 'config.json')
  const base = {
    databaseUrl: 'postgres://relay:password@db:5432/relay',
    clientSecretFile: '/tmp/clients.json',
    publicUrl: 'https://relay.test',
    maxSlots: 1,
    maxRooms: 1,
    livekit: { url: 'http://livekit:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  try {
    writeFileSync(file, JSON.stringify({ ...base, cloudflareTurn: { tokenId: 'key-id', apiToken: 'example-secret' } }))
    expect(loadConfig(file).cloudflareTurn?.tokenId).toBe('key-id')
    for (const cloudflareTurn of [
      { tokenId: '../bad', apiToken: 'example-secret' },
      { tokenId: 'id', apiToken: 'secret\nheader' },
      { tokenId: 'id' },
    ]) {
      writeFileSync(file, JSON.stringify({ ...base, cloudflareTurn }))
      expect(() => loadConfig(file)).toThrow('Invalid Cloudflare TURN configuration')
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('validates every reloadable setting and rejects unknown fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-relay-settings-'))
  const file = join(dir, 'config.json')
  const base = {
    databaseUrl: 'postgres://relay:password@db:5432/relay',
    clientSecretFile: '/tmp/clients.json',
    publicUrl: 'https://relay.test',
    maxSlots: 5,
    maxRooms: 2,
    livekit: { url: 'http://livekit:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  try {
    for (const change of [
      { databaseUrl: 'http://db/relay' },
      { clientSecretFile: '' },
      { host: '' },
      { port: 65536 },
      { iceServers: [{ urls: 'not-an-array' }] },
      { iceServers: [{ urls: [] }] },
      { iceServers: [{ urls: ['https://not-a-stun-server.test'] }] },
      { iceServers: [{ urls: ['turn:turn.test'] }] },
      { iceServers: [{ urls: ['stun:stun.test?unexpected=1'] }] },
      { iceServers: [{ urls: ['stun:stun.test:65536'] }] },
      { iceServers: [], cloudflareTurn: { tokenId: 'id', apiToken: 'token' } },
      { unexpected: true },
    ]) {
      writeFileSync(file, JSON.stringify({ ...base, ...change }))
      expect(() => loadConfig(file)).toThrow()
    }
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        iceServers: [{ urls: ['turn:turn.test?transport=udp', 'stun:[::1]:3478'], username: 'user', credential: 'password' }],
      }),
    )
    expect(loadConfig(file).databaseUrl).toBe(base.databaseUrl)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a malformed replacement key file retains the last valid authentication keys', async () => {
  const { validatedSecretLoader } = await import('./config.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-key-reload-'))
  const file = join(dir, 'keys.json')
  const secret = 's'.repeat(64)
  try {
    writeFileSync(file, JSON.stringify({ client: secret }))
    const loader = await validatedSecretLoader(file)
    writeFileSync(file, '{broken')
    expect((await loader()).client).toBe(secret)
    await expect(validatedSecretLoader(file)).rejects.toThrow()
    writeFileSync(file, JSON.stringify({ client: secret }))
    expect((await loader()).client).toBe(secret)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validates trusted LiveKit verification keys and requires restart when they change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-verification-'))
  const file = join(dir, 'config.json')
  const base = {
    databaseUrl: 'postgres://relay:password@db:5432/relay',
    clientSecretFile: '/tmp/clients.json',
    publicUrl: 'https://relay.test',
    maxSlots: 1,
    maxRooms: 1,
    livekit: { url: 'http://livekit:7880', apiKey: 'active', apiSecret: 'a'.repeat(32) },
  }
  try {
    writeFileSync(file, JSON.stringify(base))
    const previous = loadConfig(file)
    const verificationKeys = [{ apiKey: 'refresh', apiSecret: 'r'.repeat(32) }]
    writeFileSync(file, JSON.stringify({ ...base, livekit: { ...base.livekit, verificationKeys } }))
    expect(loadConfig(file).livekit.verificationKeys).toEqual(verificationKeys)
    expect(() => loadConfig(file, previous)).toThrow('Restart required: livekit.verificationKeys')
    const current = loadConfig(file)
    expect(loadConfig(file, current).livekit.verificationKeys).toEqual(verificationKeys)
    writeFileSync(file, JSON.stringify(base))
    expect(() => loadConfig(file, current)).toThrow('Restart required: livekit.verificationKeys')
    for (const keys of [[{ apiKey: '', apiSecret: 'r'.repeat(32) }], [{ apiKey: 'k', apiSecret: 'weak' }]]) {
      writeFileSync(file, JSON.stringify({ ...base, livekit: { ...base.livekit, verificationKeys: keys } }))
      expect(() => loadConfig(file)).toThrow('Invalid configuration')
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('secret file contains exactly one secret per client and rejects the old key map', async () => {
  const { validatedSecretLoader } = await import('./config.ts')
  const directory = mkdtempSync(join(tmpdir(), 'voice-secret-model-'))
  const file = join(directory, 'clients.json')
  try {
    writeFileSync(file, JSON.stringify({ client: 's'.repeat(64) }))
    const loader = await validatedSecretLoader(file)
    await expect(loader()).resolves.toEqual({ client: 's'.repeat(64) })
    writeFileSync(file, JSON.stringify({ client: { key: { secret: 's'.repeat(64) } } }))
    await expect(validatedSecretLoader(file)).rejects.toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
