// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'init', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, VOICE_RELAY_CONFIG: '/nonexistent/relay-init-config' },
  })
}

test('init creates matching private settings without connecting to the database or printing secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-init-'))
  try {
    const result = run(dir, '--public-url', 'https://voice.example.org')
    expect(result.status).toBe(0)
    const env = readFileSync(join(dir, '.env'), 'utf8')
    const config = JSON.parse(readFileSync(join(dir, 'secrets/config.json'), 'utf8'))
    const livekit = readFileSync(join(dir, 'secrets/livekit.yaml'), 'utf8')
    const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(env)?.[1]
    expect(password).toBeTruthy()
    expect(new URL(config.databaseUrl).password).toBe(password)
    expect(config.publicUrl).toBe('https://voice.example.org')
    expect(config.maxSlots).toBe(100)
    expect(config.maxRooms).toBe(10)
    expect(config.clientSecretFile).toBe('/run/relay-keys/clients.json')
    expect(config.metrics).toEqual({ host: '0.0.0.0', port: 9090 })
    expect(livekit).toContain(`  ${config.livekit.apiKey}: ${config.livekit.apiSecret}`)
    expect(livekit).toContain(`  api_key: ${config.livekit.apiKey}`)
    for (const secret of [password, config.livekit.apiSecret, config.livekit.apiKey]) {
      expect(result.stdout + result.stderr).not.toContain(secret)
    }
    for (const file of ['.env', 'secrets/config.json', 'secrets/livekit.yaml']) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test.each(['http://voice.example.org', 'https://127.0.0.1', 'https://voice.example.org/path', 'https://localhost'])(
  'init rejects invalid public URL %s before writing',
  (url) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-init-'))
    try {
      expect(run(dir, '--public-url', url).status).not.toBe(0)
      expect(() => statSync(join(dir, '.env'))).toThrow()
      expect(() => statSync(join(dir, 'secrets'))).toThrow()
    } finally {
      rmSync(dir, { recursive: true })
    }
  },
)

test.each(['.env', 'secrets/config.json', 'secrets/livekit.yaml'])('init refuses a partial installation containing %s', (file) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-init-'))
  try {
    mkdirSync(join(dir, 'secrets'))
    writeFileSync(join(dir, file), 'keep')
    expect(run(dir, '--public-url', 'https://voice.example.org').status).not.toBe(0)
    expect(readFileSync(join(dir, file), 'utf8')).toBe('keep')
    for (const other of ['.env', 'secrets/config.json', 'secrets/livekit.yaml'].filter((name) => name !== file))
      expect(() => statSync(join(dir, other))).toThrow()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('init removes files it created if a write fails partway through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-init-'))
  try {
    const preload = fileURLToPath(new URL('./fixtures/init-write-failure.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', preload, cli, 'init', '--public-url', 'https://voice.example.org'], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(() => statSync(join(dir, '.env'))).toThrow()
    expect(() => statSync(join(dir, 'secrets'))).toThrow()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test.each([
  [],
  ['--public-url'],
  ['--public-url', 'https://voice.example.org', '--public-url', 'https://other.example.org'],
  ['--public-url', 'https://voice.example.org', '--unknown'],
  ['https://voice.example.org'],
  ['--url', 'https://voice.example.org'],
])('init rejects invalid options without writing files: %s', (...args) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-init-invalid-'))
  try {
    expect(run(dir, ...args).status).not.toBe(0)
    expect(() => statSync(join(dir, '.env'))).toThrow()
    expect(() => statSync(join(dir, 'secrets'))).toThrow()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('init help identifies the public URL as the relay public HTTPS address', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-init-help-'))
  try {
    const result = run(dir, '--help')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--public-url HTTPS_ORIGIN  운영할 릴레이의 공개 HTTPS 주소')
  } finally {
    rmSync(dir, { recursive: true })
  }
})
