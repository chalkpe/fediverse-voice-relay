// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicHttpsOriginSchema } from '../relay/schema.ts'

export function init(publicUrl: string) {
  const parsed = publicHttpsOriginSchema.safeParse(publicUrl)
  if (!parsed.success) throw new Error('public URL must be a public HTTPS origin')
  const origin = parsed.data
  const password = randomBytes(32).toString('hex')
  const key = `relay${randomBytes(16).toString('hex')}`
  const secret = randomBytes(32).toString('hex')
  const databaseUrl = new URL('postgres://voice-relay@db:5432/voice-relay')
  databaseUrl.password = password
  const config = {
    databaseUrl: databaseUrl.href,
    host: '0.0.0.0',
    metrics: { host: '0.0.0.0', port: 9090 },
    port: 7888,
    publicUrl: origin.origin,
    clientSecretFile: '/run/relay-keys/clients.json',
    cloudflareTurn: null,
    livekit: { url: 'http://livekit:7880', apiKey: key, apiSecret: secret },
    maxSlots: 100,
    maxRooms: 10,
  }
  const files = [
    ['.env', `POSTGRES_PASSWORD=${password}\n`],
    [join('secrets', 'config.json'), `${JSON.stringify(config, null, 2)}\n`],
    [
      join('secrets', 'livekit.yaml'),
      `port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: true\nkeys:\n  ${key}: ${secret}\nwebhook:\n  api_key: ${key}\n  urls:\n    - http://relay:7888/livekit/webhook\n`,
    ],
  ] as const
  for (const [file] of files) {
    try {
      lstatSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(`File already exists: ${file}`)
  }
  let createdDirectory = false
  const created: string[] = []
  try {
    try {
      mkdirSync('secrets', { mode: 0o700 })
      createdDirectory = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync('secrets').isDirectory()) throw error
    }
    for (const [file, content] of files) {
      const fd = openSync(file, 'wx', 0o600)
      created.push(file)
      try {
        writeFileSync(fd, content)
      } finally {
        closeSync(fd)
      }
    }
  } catch (error) {
    for (const file of created.reverse()) {
      try {
        unlinkSync(file)
      } catch {}
    }
    if (createdDirectory) {
      try {
        rmdirSync('secrets')
      } catch {}
    }
    throw error
  }
}
