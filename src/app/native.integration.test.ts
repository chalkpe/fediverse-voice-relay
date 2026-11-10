// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { clients } from '../infra/schema.ts'
import { createTestDatabase, testSchemaExists } from '../infra/test-database.ts'
import { testLiveKitSettings } from '../infra/test-livekit.ts'
import { clientToken } from '../relay/fixtures/client-token.ts'

type Address = { address: string; port: number }
type Ready = { event: 'voice-relay-listening'; api: Address; metrics: Address }
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error }

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end()
  child.stderr.resume()
  let exit: Exit | undefined
  const stopped = new Promise<Exit>((resolve) => {
    const finish = (result: Exit) => {
      exit = result
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(result)
    }
    const onError = (error: Error) => finish({ code: null, signal: null, error })
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal })
    child.once('error', onError)
    child.once('exit', onExit)
  })

  function ready(): Promise<Ready> {
    return new Promise((resolve, reject) => {
      let pending = ''
      const timer = setTimeout(() => finish(new Error('Native server startup timed out')), 5000)
      const onData = (chunk: Buffer) => {
        pending += chunk.toString('utf8')
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as Ready
            if (value.event === 'voice-relay-listening' && value.api?.port > 0 && value.metrics?.port > 0) {
              finish(undefined, value)
              return
            }
          } catch {
            // 다른 운영 로그는 준비 신호가 아닙니다.
          }
        }
        if (pending.length > 65536) finish(new Error('Native server produced an oversized log line'))
      }
      const finish = (error?: Error, value?: Ready) => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        child.off('error', onError)
        child.stdout.resume()
        if (error) reject(error)
        else if (value) resolve(value)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`Native server exited before readiness: ${code ?? signal}`))
      }
      const onError = (error: Error) => finish(error)
      child.stdout.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
      if (exit) finish(exit.error ?? new Error(`Native server exited before readiness: ${exit.code ?? exit.signal}`))
    })
  }

  async function close() {
    if (exit) return
    child.kill('SIGTERM')
    const graceful = await Promise.race([
      stopped.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000)
        void stopped.then(() => clearTimeout(timer))
      }),
    ])
    if (!graceful && !exit) {
      child.kill('SIGKILL')
      await Promise.race([
        stopped,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Native child did not exit after SIGKILL')), 1000)
          void stopped.then(() => clearTimeout(timer))
        }),
      ])
    }
  }

  return { child, ready, close, stopped }
}

const databaseUrl = process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://voice-relay:voice-relay-test-only@127.0.0.1:17832/voice-relay'
const secret = 'native-fixture-secret-native-fixture-secret'

async function startFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-native-'))
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined
  let processHandle: ReturnType<typeof runChild> | undefined

  async function cleanup() {
    try {
      await processHandle?.close()
    } finally {
      try {
        await database?.close()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }

  try {
    database = await createTestDatabase({
      connectionString: databaseUrl,
      initialize: async (fixture) => {
        await fixture.store.db
          .insert(clients)
          .values({ id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 10, maxRooms: 2, allowScreenShare: true })
      },
    })
    const schema = database.schema
    const scoped = new URL(databaseUrl)
    scoped.searchParams.set('options', `-c search_path=${schema}`)
    const keyfile = join(dir, 'keys.json')
    const config = join(dir, 'config.json')
    await writeFile(keyfile, JSON.stringify({ client: secret }), { mode: 0o600 })
    await writeFile(
      config,
      JSON.stringify({
        databaseUrl: scoped.href,
        host: '127.0.0.1',
        port: 0,
        metrics: { port: 0 },
        publicUrl: 'https://relay.test',
        clientSecretFile: keyfile,
        livekit: { ...testLiveKitSettings, url: 'http://127.0.0.1:1' },
        maxSlots: 10,
        maxRooms: 2,
        iceServers: null,
      }),
      { mode: 0o600 },
    )
    processHandle = runChild(process.execPath, ['src/app/server.ts'], {
      NODE_ENV: 'production',
      VOICE_RELAY_CONFIG: config,
      VOICE_RELAY_CONTROL: join(dir, 'relay.sock'),
    })
    const addresses = await processHandle.ready()
    const base = `http://127.0.0.1:${addresses.api.port}`

    async function call(path: string) {
      return fetch(base + path, { headers: { authorization: `Bearer ${await clientToken(secret)}` } })
    }

    return { addresses, base, call, schema, stopped: processHandle.stopped, [Symbol.asyncDispose]: cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

test('native entrypoint starts an API on an assigned port', async () => {
  await using fixture = await startFixture()
  expect(fixture.addresses.api.address).toBe('127.0.0.1')
  expect((await fetch(`${fixture.base}/health`)).status).toBe(200)
}, 15000)

test('native HTTP serves the original icon and the documentation references it', async () => {
  await using fixture = await startFixture()
  const document = await fetch(`${fixture.base}/docs`)
  expect(document.status).toBe(200)
  expect(await document.text()).toContain('href="/icon.png"')
  const icon = await fetch(`${fixture.base}/icon.png`)
  expect(icon.status).toBe(200)
  expect(icon.headers.get('content-type')).toBe('image/png')
  const digest = createHash('sha256')
    .update(new Uint8Array(await icon.arrayBuffer()))
    .digest('hex')
  expect(digest).toBe('0bf61dc58a5c9a1e5001aa91283d492b7fa5e189f953a285b125a32ee2c3642a')
}, 15000)

test('native API authenticates bearer requests and rejects missing credentials', async () => {
  await using fixture = await startFixture()
  expect((await fetch(`${fixture.base}/voice-relay/v1/capacity`)).status).toBe(401)
  expect((await fixture.call('/voice-relay/v1/capacity')).status).toBe(200)
}, 15000)

test('native metrics listener is loopback-only and separate from the API', async () => {
  await using fixture = await startFixture()
  expect(fixture.addresses.metrics.address).toBe('127.0.0.1')
  expect(fixture.addresses.metrics.port).not.toBe(fixture.addresses.api.port)
  const metrics = await fetch(`http://127.0.0.1:${fixture.addresses.metrics.port}/metrics`)
  expect(metrics.status).toBe(200)
  expect(await metrics.text()).toContain('voice_relay_pg_pool_connections')
  expect((await fetch(`${fixture.base}/metrics`)).status).toBe(404)
}, 15000)

test('native API preserves cursor boundaries through the Node adapter', async () => {
  await using fixture = await startFixture()
  const future = await fixture.call('/voice-relay/v1/events?cursor=client%3A9223372036854775807')
  expect(future.status).toBe(200)
  expect((await future.json()).cursor).toBe('client:9223372036854775807')
  expect((await fixture.call('/voice-relay/v1/events?cursor=client%3A9223372036854775808')).status).toBe(400)
}, 15000)

test('fixture cleans up its child and schema when a test fails', async () => {
  let schema = ''
  let stopped: Promise<Exit> | undefined
  await expect(async () => {
    await using fixture = await startFixture()
    schema = fixture.schema
    stopped = fixture.stopped
    throw new Error('fixture failure')
  }).rejects.toThrow('fixture failure')
  expect(await stopped).toMatchObject({ code: 0, signal: null })
  expect(await testSchemaExists(databaseUrl, schema)).toBe(false)
}, 15000)

test('native entrypoint reports early startup failure and can be cleaned up', async () => {
  const child = runChild(process.execPath, ['src/app/server.ts'], {
    NODE_ENV: 'production',
    VOICE_RELAY_CONFIG: '/nonexistent-relay-config',
  })
  try {
    await expect(child.ready()).rejects.toThrow('exited before readiness')
    expect((await child.stopped).code).not.toBe(0)
  } finally {
    await child.close()
  }
})

test('spawn failure rejects readiness and cleanup completes', async () => {
  const child = runChild('/nonexistent-relay-node', [], {})
  try {
    await expect(child.ready()).rejects.toThrow()
  } finally {
    await child.close()
  }
})

test('signal before readiness rejects and cleanup completes', async () => {
  const child = runChild(process.execPath, [fileURLToPath(new URL('./fixtures/signal-before-ready.ts', import.meta.url))], {})
  try {
    await expect(child.ready()).rejects.toThrow('SIGTERM')
    expect((await child.stopped).signal).toBe('SIGTERM')
  } finally {
    await child.close()
  }
})

test('cleanup kills an unresponsive child after the graceful shutdown limit', async () => {
  const child = runChild(process.execPath, [fileURLToPath(new URL('./fixtures/ignore-termination.ts', import.meta.url))], {})
  try {
    await child.ready()
    await child.close()
    expect((await child.stopped).signal).toBe('SIGKILL')
  } finally {
    await child.close()
  }
})
