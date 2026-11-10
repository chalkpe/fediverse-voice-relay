// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { LiveKit, roomName } from '../infra/livekit.ts'
import { createTestDatabase } from '../infra/test-database.ts'
import { testLiveKit, testLiveKitSettings } from '../infra/test-livekit.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'
import { Provider } from '../relay/provider.ts'
import { loadConfig } from './config.ts'
import { createServer } from './server.ts'

const exec = promisify(execFile)

test('CLI issues one-time credentials and supports enable, rotate and revoke without listing keys', async () => {
  const base = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const database = await createTestDatabase({ connectionString: base, migrate: false })
  const schema = database.schema
  const dir = await mkdtemp(join(tmpdir(), 'voice-relay-cli-'))
  const file = join(dir, 'config.json')
  const keyfile = join(dir, 'keys.json')
  const url = new URL(base)
  url.searchParams.set('options', `-c search_path=${schema}`)
  await writeFile(keyfile, '{}', { mode: 0o600 })
  await writeFile(
    file,
    JSON.stringify({
      databaseUrl: url.href,
      publicUrl: 'https://relay.test',
      clientSecretFile: keyfile,
      maxSlots: 102,
      maxRooms: 2,
      livekit: testLiveKitSettings,
    }),
    { mode: 0o600 },
  )
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec('node', ['src/app/cli.ts', 'client', ...args], {
          env: { ...process.env, VOICE_RELAY_CONFIG: file },
        })
      ).stdout,
    )
  try {
    const created = await cli('add', '--origin', 'https://consumer.test', '--max-slots', '102', '--max-rooms', '2', '--allow-screen-share')
    expect(created.secret.length).toBe(64)
    expect(Object.keys(created).sort()).toEqual(['origin', 'secret'])
    expect(created.origin).toBe('https://consumer.test')
    await expect(cli('add', '--origin', 'https://CONSUMER.test:443', '--max-slots', '1', '--max-rooms', '1')).rejects.toThrow(
      'Client origin already registered',
    )

    const connection = database.connect()
    const store = connection.store
    const clientId = (await store.clientByOrigin(created.origin))?.id
    if (!clientId) throw new Error('Client missing')
    const livekitConfig = testLiveKit
    const app = await createServer({ ...loadConfig(file), livekit: livekitConfig }, { store, startWorkers: false })
    const livekit = new LiveKit(livekitConfig)
    const provider = new Provider(store, livekit, { maxSlots: 102, maxRooms: 2, mediaProvider: 'https://relay.test', iceServers: null })
    let room: Awaited<ReturnType<typeof provider.allocate>> | undefined
    try {
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
      const port = (app.server.address() as AddressInfo).port
      let activeCredential = created
      const capacity = async (credential = activeCredential) => {
        const path = '/voice-relay/v1/capacity'
        return fetch(`http://127.0.0.1:${port}${path}`, {
          headers: {
            authorization: `Bearer ${await clientToken(credential.secret, credential.origin)}`,
          },
        })
      }
      const active = await capacity()
      expect(active.status).toBe(200)
      expect((await active.json()).accepting).toBe(true)
      room = await provider.allocate(clientId, { roomKey: `cli-${randomUUID()}`, generation: 'g', slots: 1 })
      const token = await provider.join(clientId, room.id, { identity: 'cli-user', userId: 'cli-user', allowScreenShare: false })
      const liveRotation = await cli('rotate-secret', '--origin', created.origin)
      expect((await capacity(created)).status).toBe(401)
      expect((await capacity(liveRotation)).status).toBe(200)
      expect((await provider.snapshot(clientId, room.id)).state).toBe('active')
      expect((await provider.inspect(clientId, token.token)).allocationId).toBe(room.id)
      activeCredential = liveRotation
      await exec('node', ['src/app/cli.ts', 'client', 'disable', '--origin', created.origin], {
        env: { ...process.env, VOICE_RELAY_CONFIG: file },
      })
      const revoked = await capacity()
      expect(revoked.status).toBe(200)
      expect((await revoked.json()).accepting).toBe(false)
      await expect(provider.inspect(clientId, token.token)).rejects.toMatchObject({ code: 'CLIENT_DISABLED' })
      await expect(provider.renew(clientId, room.id)).rejects.toMatchObject({ code: 'CLIENT_DISABLED' })
      const cancelled = await fetch(`http://127.0.0.1:${port}/voice-relay/v1/allocations/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await clientToken(activeCredential.secret, activeCredential.origin)}`,
        },
        body: JSON.stringify({ roomKey: room.roomKey, generation: room.generation }),
      })
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toEqual({ state: 'ended' })
      await provider.sweep(false)
      expect((await provider.snapshot(clientId, room.id)).state).toBe('ended')
      expect(await livekit.client.listRooms([roomName(room)])).toHaveLength(0)
      expect((await provider.events(clientId)).events.some((event) => event.allocationId === room?.id && event.type === 'ended')).toBe(true)
      await exec('node', ['src/app/cli.ts', 'client', 'enable', '--origin', created.origin], {
        env: { ...process.env, VOICE_RELAY_CONFIG: file },
      })
      const reenabled = await capacity()
      expect(reenabled.status).toBe(200)
      expect((await reenabled.json()).accepting).toBe(true)
    } finally {
      if (room) await provider.end(clientId, room.id).catch(() => {})
      await app.close()
      await connection.close()
    }

    const withoutSharing = await cli('add', '--origin', 'https://no-sharing.example.org', '--max-slots', '1', '--max-rooms', '1')
    const listed = await cli('list')
    expect(listed.find((client: { origin: string }) => client.origin === withoutSharing.origin).allow_screen_share).toBe(false)
    expect(listed.find((client: { origin: string }) => client.origin === created.origin).allow_screen_share).toBe(true)
    expect(JSON.stringify(listed).includes(created.secret)).toBe(false)
    expect(listed.find((client: { origin: string }) => client.origin === created.origin).enabled).toBe(true)

    const rotated = await cli('rotate-secret', '--origin', created.origin)
    expect(rotated.secret !== created.secret).toBe(true)
    const secrets = JSON.parse(await readFile(keyfile, 'utf8'))
    expect(secrets[clientId]).toBe(rotated.secret)

    await exec('node', ['src/app/cli.ts', 'client', 'disable', '--origin', created.origin], {
      env: { ...process.env, VOICE_RELAY_CONFIG: file },
    })
    expect((await cli('list')).find((client: { origin: string }) => client.origin === created.origin).enabled).toBe(false)
  } finally {
    await database.close()
    await rm(dir, { recursive: true })
  }
})

test('concurrent CLI processes preserve creations and rotations and recover failed creates', async () => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const base = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
  const database = await createTestDatabase({ connectionString: base, migrate: false })
  const schema = database.schema
  const dir = await mkdtemp(join(tmpdir(), 'voice-relay-race-'))
  const config = join(dir, 'config.json')
  const keyfile = join(dir, 'keys.json')
  const preload = fileURLToPath(new URL('./fixtures/cli-barrier.ts', import.meta.url))
  const fifo = join(dir, 'gate')
  const url = new URL(base)
  url.searchParams.set('options', `-c search_path=${schema}`)
  await writeFile(keyfile, '{}', { mode: 0o600 })
  await writeFile(
    config,
    JSON.stringify({
      databaseUrl: url.href,
      publicUrl: 'https://relay.test',
      clientSecretFile: keyfile,
      maxSlots: 10,
      maxRooms: 10,
      livekit: testLiveKitSettings,
    }),
    { mode: 0o600 },
  )
  await exec('mkfifo', [fifo])
  const children = new Set<ReturnType<typeof spawn>>()
  const createArgs = () => ['add', '--origin', `https://${randomUUID()}.test`, '--max-slots', '2', '--max-rooms', '2']
  function start(args: string[], gate = false) {
    const child = spawn('node', ['--import', preload, 'src/app/cli.ts', 'client', ...args], {
      env: { ...process.env, VOICE_RELAY_CONFIG: config, TEST_KEYS: keyfile, TEST_FIFO: fifo, ...(gate ? { TEST_GATE: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.add(child)
    child.once('exit', () => children.delete(child))
    let out = ''
    let err = ''
    child.stdout?.on('data', (data) => {
      out += data
    })
    child.stderr?.on('data', (data) => {
      err += data
    })
    const messages: string[] = []
    const waiters: Array<() => void> = []
    child.on('message', (message) => {
      if (message && typeof message === 'object' && 'type' in message && typeof message.type === 'string') messages.push(message.type)
      for (const wake of waiters.splice(0)) wake()
    })
    const exit = once(child, 'exit')
    return {
      async wait(kind: string) {
        while (!messages.includes(kind)) {
          let wake: () => void = () => {}
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve
                waiters.push(wake)
              }),
              exit.then(() => {
                throw new Error('CLI exited before its test barrier')
              }),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('CLI barrier timed out')), 5000)
              }),
            ])
          } finally {
            clearTimeout(timer)
            const index = waiters.indexOf(wake)
            if (index >= 0) waiters.splice(index, 1)
          }
        }
      },
      async result() {
        const [code] = await exit
        if (code !== 0) throw new Error(`CLI failed: ${err}`)
        return JSON.parse(out)
      },
    }
  }
  try {
    const first = start(createArgs(), true)
    await first.wait('read')
    const second = start(createArgs())
    await second.wait('lock')
    await writeFile(fifo, 'go')
    const [a, b] = await Promise.all([first.result(), second.result()])
    const r1 = start(['rotate-secret', '--origin', a.origin], true)
    await r1.wait('read')
    const r2 = start(['rotate-secret', '--origin', a.origin])
    const r3 = start(['rotate-secret', '--origin', b.origin])
    const c = start(createArgs())
    await Promise.all([r2.wait('lock'), r3.wait('lock'), c.wait('lock')])
    await writeFile(fifo, 'go')
    const rotated = await Promise.all([r1.result(), r2.result(), r3.result(), c.result()])
    const keys = JSON.parse(await readFile(keyfile, 'utf8'))
    const listClients = async () =>
      JSON.parse(
        (await exec('node', ['src/app/cli.ts', 'client', 'list'], { env: { ...process.env, VOICE_RELAY_CONFIG: config } })).stdout,
      ) as { origin: string }[]
    try {
      expect((await listClients()).length).toBe(3)
      const serviceConnection = database.connect()
      const serviceStore = serviceConnection.store
      const service = await createServer(loadConfig(config), { store: serviceStore, migrate: false, startWorkers: false })
      try {
        for (const credential of rotated.slice(1)) {
          const path = '/voice-relay/v1/capacity'
          const response = await service.app.request(path, {
            headers: {
              authorization: `Bearer ${await clientToken(credential.secret, credential.origin)}`,
            },
          })
          expect(response.status).toBe(200)
        }
      } finally {
        await service.close()
        await serviceConnection.close()
      }
      const failInsert = fileURLToPath(new URL('./fixtures/cli-insert-failure.ts', import.meta.url))
      await expect(
        exec('node', ['--import', failInsert, 'src/app/cli.ts', 'client', ...createArgs()], {
          env: { ...process.env, VOICE_RELAY_CONFIG: config },
        }),
      ).rejects.toThrow()
      expect(JSON.parse(await readFile(keyfile, 'utf8'))).toEqual(keys)
      await expect(readFile(`${keyfile}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await listClients()).length).toBe(3)
      const failRename = fileURLToPath(new URL('./fixtures/cli-rename-failure.ts', import.meta.url))
      await expect(
        exec('node', ['--import', failRename, 'src/app/cli.ts', 'client', ...createArgs()], {
          env: { ...process.env, VOICE_RELAY_CONFIG: config, TEST_KEYS: keyfile },
        }),
      ).rejects.toThrow()
      expect(JSON.parse(await readFile(keyfile, 'utf8'))).toEqual(keys)
      expect((await listClients()).length).toBe(3)
      await expect(readFile(`${keyfile}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })

      const commitFailure = fileURLToPath(new URL('./fixtures/cli-commit-failure.ts', import.meta.url))
      for (const mode of ['rollback', 'committed']) {
        const before = JSON.parse(await readFile(keyfile, 'utf8'))
        await expect(
          exec('node', ['--import', commitFailure, 'src/app/cli.ts', 'client', ...createArgs()], {
            env: { ...process.env, VOICE_RELAY_CONFIG: config, TEST_COMMIT: mode },
          }),
        ).rejects.toThrow()
        const after = JSON.parse(await readFile(keyfile, 'utf8'))
        const rows = await listClients()
        expect(Object.keys(after)).toHaveLength(rows.length)
        expect(Object.keys(after).length).toBe(Object.keys(before).length + (mode === 'committed' ? 1 : 0))
        await expect(readFile(`${keyfile}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
      }

      const issued = JSON.parse(
        (await exec('node', ['src/app/cli.ts', 'client', ...createArgs()], { env: { ...process.env, VOICE_RELAY_CONFIG: config } })).stdout,
      )
      const issuedClient = await database.store.clientByOrigin(issued.origin)
      if (!issuedClient) throw new Error('Client missing')
      const pending = { id: issuedClient.id, secret: issued.secret }
      const currentKeys = JSON.parse(await readFile(keyfile, 'utf8'))
      delete currentKeys[pending.id]
      await writeFile(keyfile, JSON.stringify(currentKeys), { mode: 0o600 })
      await writeFile(`${keyfile}.pending`, JSON.stringify(pending), { mode: 0o600 })
      await exec('node', ['src/app/cli.ts', 'client', 'rotate-secret', '--origin', a.origin], {
        env: { ...process.env, VOICE_RELAY_CONFIG: config },
      })
      expect(JSON.parse(await readFile(keyfile, 'utf8'))[pending.id]).toBe(pending.secret)
      await expect(readFile(`${keyfile}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      // 자식 프로세스 정리는 바깥 finally에서 수행합니다.
    }
  } finally {
    const exits = [...children].map(async (child) => {
      const exited = once(child, 'exit').catch(() => [])
      child.kill('SIGKILL')
      await exited
    })
    await Promise.all(exits)
    await database.close()
    await rm(dir, { recursive: true })
  }
}, 30000)
