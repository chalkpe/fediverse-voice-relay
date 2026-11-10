// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

const config = '/nonexistent/voice-relay-cli-test-config'

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['src/app/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, VOICE_RELAY_CONFIG: config },
  })
}

test.each([['--help'], ['-h'], ['client', '--help'], ['client', 'add', '-h'], ['client', 'disable', '--help']])(
  'help works without loading configuration: %s',
  (...args) => {
    const result = cli(...args)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stderr).toBe('')
  },
)

test.each([
  [],
  ['client'],
  ['contracts', 'create'],
  ['clients', 'create'],
  ['client', 'create'],
  ['client', 'rotate'],
  ['client', 'revoke'],
  ['unknown'],
  ['constructor', '--help'],
  ['client', '__proto__', '--help'],
  ['client', 'unknown'],
  ['client', 'list', 'leftover'],
  ['client', 'list', '--id', 'id'],
  ['client', 'list', '--unknown'],
  ['client', 'add', 'https://consumer.example.org', '102', '2'],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '1'],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots'],
  ['client', 'add', '--origin', 'https://127.0.0.1', '--max-slots', '1', '--max-rooms', '1'],
  ['client', 'add', '--origin', 'https://sub.localhost', '--max-slots', '1', '--max-rooms', '1'],
  ['client', 'add', '--origin', 'http://consumer.example.org', '--max-slots', '1', '--max-rooms', '1'],
  ['client', 'add', '--origin', 'https://consumer.example.org/path', '--max-slots', '1', '--max-rooms', '1'],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '0', '--max-rooms', '1'],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '1.5', '--max-rooms', '1'],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '9007199254740992', '--max-rooms', '1'],
  [
    'client',
    'add',
    '--origin',
    'https://consumer.example.org',
    '--max-slots',
    '1',
    '--max-rooms',
    '1',
    '--allow-screen-share',
    '--allow-screen-share',
  ],
  [
    'client',
    'add',
    '--origin',
    'https://consumer.example.org',
    '--origin',
    'https://consumer.example.org',
    '--max-slots',
    '1',
    '--max-rooms',
    '1',
  ],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '1', '--max-rooms', '1', '--screen-share'],
  ['client', 'enable'],
  ['client', 'enable', '--id', ''],
  ['client', 'enable', 'id'],
  ['client', 'rotate-key', '--id', 'id', '--id', 'other'],
  ['client', 'disable', '--id', 'id', '--screen-share'],
])('invalid arguments are rejected before config access: %s', (...args) => {
  const result = cli(...args)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Usage:')
  expect(result.stderr).not.toContain(config)
})

test.each([
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '102', '--max-rooms', '2', '--allow-screen-share'],
  ['client', 'list'],
  ['client', 'add', '--origin', 'https://consumer.example.org', '--max-slots', '102', '--max-rooms', '2'],
  ['client', 'enable', '--origin', 'https://consumer.example.org'],
  ['client', 'rotate-secret', '--origin=https://consumer.example.org'],
  ['client', 'disable', '--origin', 'https://consumer.example.org'],
])('valid arguments reach configuration: %s', (...args) => {
  const result = cli(...args)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(config)
  expect(result.stderr).not.toContain('Usage:')
})

test('create help names the screen sharing permission explicitly', () => {
  const result = cli('client', 'add', '--help')
  expect(result.stdout).toContain('--allow-screen-share')
  expect(result.stdout).not.toContain('[--screen-share]')
})

const commandOptions = [
  { path: ['reload'], options: [] },
  { path: ['init'], options: ['public-url'] },
  { path: ['client', 'add'], options: ['origin', 'max-slots', 'max-rooms', 'allow-screen-share'] },
  { path: ['client', 'list'], options: [] },
  { path: ['client', 'enable'], options: ['origin'] },
  { path: ['client', 'rotate-secret'], options: ['origin'] },
  { path: ['client', 'disable'], options: ['origin'] },
]

test.each(commandOptions)('command help and parser agree for $path', ({ path, options }) => {
  const help = cli(...path, '--help')
  expect(help.status).toBe(0)
  expect(help.stdout.match(/node src\/app\/cli\.ts/g)).toHaveLength(1)
  const documented = [...help.stdout.matchAll(/^\s+(?:-h, )?--([\w-]+)/gm)].map((match) => match[1])
  expect(documented.sort()).toEqual(['help', ...options].sort())
  for (const option of options) {
    const value = option === 'allow-screen-share' ? [] : ['value']
    const result = cli(...path, `--${option}`, ...value, '--help')
    expect(result.status).toBe(0)
  }
  const invalid = cli(...path, '--not-an-option', '--help')
  expect(invalid.status).toBe(1)
  expect(invalid.stderr).not.toContain(config)
})

test('top-level and client help list only their immediate commands', () => {
  const top = cli('--help')
  const client = cli('client', '--help')
  expect(top.stdout.match(/node src\/app\/cli\.ts/g)).toHaveLength(1)
  expect(top.stdout).toContain('reload')
  expect(top.stdout).toContain('init')
  expect(top.stdout).toContain('client')
  expect(client.stdout.match(/node src\/app\/cli\.ts/g)).toHaveLength(1)
  for (const action of ['add', 'list', 'enable', 'rotate-secret', 'disable']) expect(client.stdout).toContain(action)
})

test.each([
  ['init'],
  ['init', '--public-url', ''],
  ['init', '--public-url', 'https://example.org', '--public-url', 'https://example.org'],
  ['init', '--help', '--unknown'],
  ['client', 'add', '--allow-screen-share=false'],
  ['client', 'enable', '--id', '   '],
  ['client', 'list', '--help', 'leftover'],
])('additional invalid arguments are rejected before configuration: %s', (...args) => {
  const result = cli(...args)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Usage:')
  expect(result.stderr).not.toContain(config)
})

test.each(commandOptions)('other commands’ options are rejected for $path', ({ path, options }) => {
  const allOptions = [...new Set(commandOptions.flatMap((command) => command.options))]
  for (const option of allOptions.filter((name) => !options.includes(name))) {
    const value = option === 'allow-screen-share' ? [] : ['value']
    const result = cli(...path, `--${option}`, ...value, '--help')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage:')
    expect(result.stderr).not.toContain(config)
  }
})

test('init runs from the CLI without loading the server configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-relay-cli-'))
  try {
    const result = spawnSync(process.execPath, [resolve('src/app/cli.ts'), 'init', '--public-url', 'https://relay.example.org'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, VOICE_RELAY_CONFIG: config },
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(join(directory, '.env'))).toBe(true)
    expect(existsSync(join(directory, 'secrets', 'config.json'))).toBe(true)
    expect(existsSync(join(directory, 'secrets', 'livekit.yaml'))).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('management commands target an origin and rotate a secret', () => {
  for (const action of ['enable', 'disable', 'rotate-secret']) {
    const result = cli('client', action, '--origin', 'https://consumer.example.org')
    expect(result.stderr).toContain(config)
    expect(result.stderr).not.toContain('Usage:')
  }
  expect(cli('client', 'rotate-key', '--id', 'client').stderr).toContain('Usage:')
})
