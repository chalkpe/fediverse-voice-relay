// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { ReloadController } from './reload.ts'

test('reload publishes current screen share limits on capacity and new joins to an existing allocation', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const { createServer } = await import('./server.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-screen-reload-'))
  const file = join(dir, 'config.json')
  const secret = 's'.repeat(64)
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/unused',
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: 'http://localhost:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  const client = { id: 'client', origin: 'https://client.test', enabled: true, maxSlots: 10, maxRooms: 5, allowScreenShare: false }
  const allocation = {
    id: 'room',
    clientId: 'client',
    roomKey: 'room',
    generation: 'g',
    reservedSlots: 1,
    state: 'active' as const,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: new Date().toISOString(),
  }
  const rows: unknown[][] = []
  const store = {
    pool: {},
    client: async () => client,
    clientByOrigin: async () => client,
    limitClientRequests: async () => {},
    get: async () => allocation,
    serialized: async (_id: string, run: () => Promise<unknown>) => run(),
    db: { select: () => ({ from: () => ({ where: async () => rows.shift() }) }) },
  } as unknown as import('../infra/store.ts').Store
  writeFileSync(file, JSON.stringify(settings))
  const service = await createServer(settings, {
    store,
    migrate: false,
    startWorkers: false,
    configFile: file,
    loadSecrets: () => ({ client: secret }),
  })
  const token = await clientToken(secret)
  const request = (path: string, body?: unknown) =>
    service.app.request(path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const readLimits = async () => {
    rows.push([{ slots: 1, rooms: 1 }], [{ slots: 1, rooms: 1 }], [])
    const capacity = await request('/voice-relay/v1/capacity')
    expect(capacity.status).toBe(200)
    rows.push([{ generation: 'token-generation' }], [{ mediaProvider: settings.publicUrl }])
    const joined = await request('/voice-relay/v1/allocations/room/join', {
      identity: 'https://client.test/users/a',
      userId: 'a',
      allowScreenShare: false,
    })
    expect(joined.status).toBe(200)
    return [await capacity.json(), await joined.json()]
  }
  try {
    for (const response of await readLimits()) expect(response).not.toHaveProperty('screenShareLimits')
    const limits = { maxWidth: 3840, maxHeight: 2160, maxFrameRate: 120, maxBitrate: 16000000 }
    writeFileSync(file, JSON.stringify({ ...settings, screenShareLimits: limits }))
    await service.reload()
    for (const response of await readLimits()) expect(response.screenShareLimits).toEqual(limits)
    writeFileSync(file, JSON.stringify({ ...settings, screenShareLimits: { ...limits, maxWidth: 0 } }))
    await expect(service.reload()).rejects.toThrow('Invalid screenShareLimits configuration')
    for (const response of await readLimits()) expect(response.screenShareLimits).toEqual(limits)
    writeFileSync(file, JSON.stringify(settings))
    await service.reload()
    for (const response of await readLimits()) expect(response).not.toHaveProperty('screenShareLimits')
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('serializes reload and commits only successfully prepared settings', async () => {
  const events: string[] = []
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const controller = new ReloadController(async () => {
    const call = ++calls
    events.push(`prepare ${call}`)
    if (call === 1) await wait
    if (call === 2) throw new Error('invalid configuration')
    return {
      commit: async () => {
        events.push(`commit ${call}`)
      },
      rollback: async () => {
        events.push(`rollback ${call}`)
      },
    }
  })
  const first = controller.reload()
  const second = controller.reload()
  await Promise.resolve()
  expect(events).toEqual(['prepare 1'])
  release()
  await first
  await expect(second).rejects.toThrow('invalid configuration')
  expect(events).toEqual(['prepare 1', 'commit 1', 'prepare 2'])
})

test('shutdown waits for preparation, rolls it back, and rejects later reloads', async () => {
  const events: string[] = []
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new ReloadController(async () => {
    await wait
    return {
      commit: async () => {
        events.push('commit')
      },
      rollback: async () => {
        events.push('rollback')
      },
    }
  })
  const reload = controller.reload()
  await Promise.resolve()
  const close = controller.close()
  release()
  await expect(reload).rejects.toThrow('shutting down')
  await close
  await expect(controller.reload()).rejects.toThrow('shutting down')
  expect(events).toEqual(['rollback'])
})

test('local control returns the actual reload result to the caller', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createReloadControl, requestReload, ReloadFailure } = await import('./reload-control.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-control-'))
  const path = join(dir, 'control.sock')
  let fail = false
  const control = await createReloadControl(path, async () => {
    if (fail) throw new ReloadFailure('restart required: databaseUrl')
  })
  try {
    await expect(requestReload(path)).resolves.toBeUndefined()
    fail = true
    await expect(requestReload(path)).rejects.toThrow('restart required: databaseUrl')
  } finally {
    await control.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reload control requires a private directory and cannot replace a running socket', async () => {
  const { chmodSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createReloadControl, requestReload } = await import('./reload-control.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-control-permission-'))
  const path = join(dir, 'control.sock')
  try {
    chmodSync(dir, 0o755)
    await expect(createReloadControl(path, async () => {})).rejects.toThrow('private and owned')
    chmodSync(dir, 0o700)
    let reloads = 0
    const control = await createReloadControl(path, async () => {
      reloads++
    })
    try {
      await expect(createReloadControl(path, async () => {})).rejects.toThrow()
      await requestReload(path)
      expect(reloads).toBe(1)
    } finally {
      await control.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reload retains a running HTTP request, applies new limits, and rejects restart settings', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Pool } = await import('pg')
  const { Store } = await import('../infra/store.ts')
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const { createServer } = await import('./server.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-reload-'))
  const file = join(dir, 'config.json')
  const secret = 's'.repeat(64)
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/unused',
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: 'http://localhost:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  writeFileSync(file, JSON.stringify(settings))
  const pool = new Pool({ connectionString: settings.databaseUrl })
  const store = new Store(pool)
  store.client = async () => ({
    id: 'client',
    origin: 'https://client.test',
    enabled: true,
    maxSlots: 10,
    maxRooms: 5,
    allowScreenShare: false,
  })
  store.clientByOrigin = async (origin) => (origin === 'https://client.test' ? store.client('client') : undefined)
  store.limitClientRequests = async () => {}
  const service = await createServer(settings, {
    store,
    migrate: false,
    startWorkers: false,
    configFile: file,
    loadSecrets: () => ({ client: secret }),
  })
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = () => {}
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  service.app.get('/hold', async (c) => {
    started()
    await waiting
    return c.text('finished')
  })
  try {
    await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
    const port = (service.server.address() as import('node:net').AddressInfo).port
    const token = await clientToken(secret)
    const response = fetch(`http://127.0.0.1:${port}/hold`, { headers: { authorization: `Bearer ${token}` } })
    await pending
    writeFileSync(file, JSON.stringify({ ...settings, host: 'localhost', maxSlots: 1 }))
    await service.reload()
    expect((service.server.address() as import('node:net').AddressInfo).port).not.toBe(port)
    release()
    expect(await (await response).text()).toBe('finished')
    const currentPort = (service.server.address() as import('node:net').AddressInfo).port
    writeFileSync(file, JSON.stringify({ ...settings, databaseUrl: 'postgres://other:secret@elsewhere/other' }))
    await expect(service.reload()).rejects.toThrow('Restart required: databaseUrl')
    expect((service.server.address() as import('node:net').AddressInfo).port).toBe(currentPort)
    writeFileSync(file, JSON.stringify({ ...settings, livekit: { ...settings.livekit, apiSecret: 'another-secret'.repeat(4) } }))
    await expect(service.reload()).rejects.toThrow('Restart required: livekit.apiSecret')
    writeFileSync(file, JSON.stringify({ ...settings, livekit: { ...settings.livekit, apiSecret: 'weak' } }))
    await expect(service.reload()).rejects.toThrow('Restart required: livekit.apiSecret')
    writeFileSync(file, JSON.stringify({ ...settings, maxSlots: 0 }))
    await expect(service.reload()).rejects.toThrow('Invalid configuration')
    expect((service.server.address() as import('node:net').AddressInfo).port).toBe(currentPort)
  } finally {
    release()
    await service.close()
    await pool.end()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the reload CLI reports control completion and failure', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createReloadControl, ReloadFailure } = await import('./reload-control.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-cli-'))
  const path = join(dir, 'control.sock')
  let fail = false
  const control = await createReloadControl(path, async () => {
    if (fail) throw new ReloadFailure('Restart required: livekit.apiSecret')
  })
  const cli = () =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['src/app/cli.ts', 'reload'], {
        env: { ...process.env, VOICE_RELAY_CONTROL: path },
      })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, output }))
    })
  try {
    expect(await cli()).toMatchObject({ code: 0, output: expect.stringContaining('Configuration reloaded.') })
    fail = true
    expect(await cli()).toMatchObject({ code: 1, output: expect.stringContaining('Restart required: livekit.apiSecret') })
  } finally {
    await control.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an established WebSocket remains usable when the API listener changes', async () => {
  const { createServer: createHttpServer } = await import('node:http')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Pool } = await import('pg')
  const { WebSocket, WebSocketServer } = await import('ws')
  const { vi } = await import('vitest')
  const { LiveKit } = await import('../infra/livekit.ts')
  const { Provider } = await import('../relay/provider.ts')
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const { createServer } = await import('./server.ts')
  const upstreamServer = createHttpServer()
  const upstream = new WebSocketServer({ server: upstreamServer })
  upstream.on('connection', (socket) => {
    socket.send('ready')
    socket.on('message', (data) => socket.send(data))
  })
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstreamServer.address() as import('node:net').AddressInfo).port
  const dir = mkdtempSync(join(tmpdir(), 'relay-ws-'))
  const file = join(dir, 'config.json')
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/unused',
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: `http://127.0.0.1:${upstreamPort}`, apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  writeFileSync(file, JSON.stringify(settings))
  const pool = new Pool({ connectionString: settings.databaseUrl })
  const fakeStore = {
    pool,
    admission: async <T>(fn: () => Promise<T>) => fn(),
    serialized: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    installationId: async () => 'fixture',
    client: async () => ({}),
    clientByOrigin: async () => ({ id: 'client' }),
    limitClientRequests: async () => {},
  } as unknown as import('../infra/store.ts').Store
  const inspect = vi
    .spyOn(Provider.prototype, 'inspect')
    .mockResolvedValue({ allocationId: 'a', generation: 'g', expiresAt: 1, identity: 'u' })
  const usable = vi.spyOn(Provider.prototype, 'usable').mockResolvedValue({
    id: 'a',
    clientId: 'client',
    roomKey: 'r',
    generation: 'g',
    reservedSlots: 1,
    state: 'active',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: new Date().toISOString(),
  })
  const ensure = vi.spyOn(LiveKit.prototype, 'ensure').mockResolvedValue()
  const closeWebSocketServer = vi.spyOn(WebSocketServer.prototype, 'close')
  const secret = 's'.repeat(64)
  const service = await createServer(settings, {
    store: fakeStore,
    migrate: false,
    startWorkers: false,
    configFile: file,
    loadSecrets: () => ({ client: secret }),
  })
  let socket: InstanceType<typeof WebSocket> | undefined
  try {
    await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
    const port = (service.server.address() as import('node:net').AddressInfo).port
    socket = new WebSocket(`ws://127.0.0.1:${port}/voice-relay/v1/allocations/a/rtc?access_token=test`, {
      headers: { authorization: `Bearer ${await clientToken(secret)}` },
    })
    const message = () =>
      new Promise<string>((resolve, reject) => {
        socket?.once('message', (value) => resolve(value.toString()))
        socket?.once('error', reject)
      })
    expect(await message()).toBe('ready')
    const oldListener = service.server
    const retired = new Promise<void>((resolve) => oldListener.once('close', () => resolve()))
    writeFileSync(file, JSON.stringify({ ...settings, host: 'localhost', maxRooms: 1 }))
    await service.reload()
    const reply = message()
    socket.send('still-connected')
    expect(await reply).toBe('still-connected')
    socket.terminate()
    await retired
    expect(closeWebSocketServer).toHaveBeenCalledTimes(1)
    const current = service.server.address() as import('node:net').AddressInfo
    const host = current.family === 'IPv6' ? `[${current.address}]` : current.address
    socket = new WebSocket(`ws://${host}:${current.port}/voice-relay/v1/allocations/a/rtc?access_token=test`, {
      headers: { authorization: `Bearer ${await clientToken(secret)}` },
    })
    expect(await message()).toBe('ready')
  } finally {
    socket?.terminate()
    await service.close()
    for (const peer of upstream.clients) peer.terminate()
    upstream.close()
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()))
    await pool.end()
    inspect.mockRestore()
    usable.mockRestore()
    ensure.mockRestore()
    closeWebSocketServer.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid key replacement keeps authentication enforced and valid key rotation takes effect', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Pool } = await import('pg')
  const { Store } = await import('../infra/store.ts')
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const { createServer } = await import('./server.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-reload-'))
  const file = join(dir, 'config.json')
  const keys = join(dir, 'keys.json')
  const oldSecret = 'a'.repeat(64)
  const newSecret = 'b'.repeat(64)
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: keys,
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: 'http://127.0.0.1:7880', apiKey: 'key', apiSecret: 'c'.repeat(32) },
  }
  writeFileSync(file, JSON.stringify(settings))
  writeFileSync(keys, JSON.stringify({ client: oldSecret }))
  const pool = new Pool({ connectionString: settings.databaseUrl })
  const store = new Store(pool)
  store.client = async () => ({
    id: 'client',
    origin: 'https://client.test',
    enabled: true,
    maxSlots: 10,
    maxRooms: 5,
    allowScreenShare: false,
  })
  store.clientByOrigin = async (origin) => (origin === 'https://client.test' ? store.client('client') : undefined)
  store.limitClientRequests = async () => {}
  const service = await createServer(settings, { store, migrate: false, startWorkers: false, configFile: file })
  service.app.get('/protected', (c) => c.text('allowed'))
  const request = async (secret: string, _keyId: string) =>
    service.app.request('/protected', { headers: { authorization: `Bearer ${await clientToken(secret)}` } })
  try {
    expect((await service.app.request('/reload', { method: 'POST' })).status).toBe(401)
    writeFileSync(keys, '{TOP_SECRET_INVALID')
    const failed = service.reload()
    await expect(failed).rejects.toThrow('Invalid or unavailable client secret file')
    await expect(failed).rejects.not.toThrow('TOP_SECRET_INVALID')
    expect((await request(oldSecret, 'old')).status).toBe(200)
    const authorized = await clientToken(oldSecret)
    const publicReload = await service.app.request('/reload', { method: 'POST', headers: { authorization: `Bearer ${authorized}` } })
    expect(publicReload.status).toBe(404)
    expect((await request(newSecret, 'new')).status).toBe(401)
    writeFileSync(keys, JSON.stringify({ client: newSecret }))
    expect((await request(oldSecret, 'old')).status).toBe(401)
    expect((await request(newSecret, 'new')).status).toBe(200)
  } finally {
    await service.close()
    await pool.end()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed listener preparation rolls back the entire reload', async () => {
  const { createServer: createHttpServer } = await import('node:http')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Pool } = await import('pg')
  const { Store } = await import('../infra/store.ts')
  const { createServer } = await import('./server.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-rollback-'))
  const file = join(dir, 'config.json')
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/unused',
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: 'http://127.0.0.1:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  const pool = new Pool({ connectionString: settings.databaseUrl })
  const service = await createServer(settings, {
    store: new Store(pool),
    migrate: false,
    startWorkers: false,
    configFile: file,
    loadSecrets: () => ({}),
  })
  const occupied = createHttpServer()
  try {
    await Promise.all([
      new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => service.metricsServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve)),
    ])
    const previous = service.server
    const busyPort = (occupied.address() as import('node:net').AddressInfo).port
    writeFileSync(
      file,
      JSON.stringify({
        ...settings,
        host: 'localhost',
        publicUrl: 'https://new-relay.test',
        metrics: { host: '127.0.0.1', port: busyPort },
      }),
    )
    await expect(service.reload()).rejects.toThrow('Unable to prepare listener')
    expect(service.server).toBe(previous)
    writeFileSync(file, JSON.stringify({ ...settings, port: busyPort, publicUrl: 'https://new-relay.test' }))
    await expect(service.reload()).rejects.toThrow('Unable to prepare listener')
    expect(service.server).toBe(previous)
    const document = await (await service.app.request('/openapi.json')).json()
    expect(document.servers[0].url).toBe('https://relay.test')
  } finally {
    await service.close()
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
    await pool.end()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI applies a file change through the running service control socket', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Pool } = await import('pg')
  const { Store } = await import('../infra/store.ts')
  const { createServer } = await import('./server.ts')
  const { createReloadControl } = await import('./reload-control.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-'))
  const file = join(dir, 'config.json')
  const path = join(dir, 'relay.sock')
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/unused',
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: 'http://127.0.0.1:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  const pool = new Pool({ connectionString: settings.databaseUrl })
  const service = await createServer(settings, {
    store: new Store(pool),
    migrate: false,
    startWorkers: false,
    configFile: file,
    loadSecrets: () => ({}),
  })
  const control = await createReloadControl(path, () => service.reload())
  try {
    writeFileSync(file, JSON.stringify({ ...settings, publicUrl: 'https://new-relay.test' }))
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['src/app/cli.ts', 'reload'], { env: { ...process.env, VOICE_RELAY_CONTROL: path } })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, output }))
    })
    expect(result.code).toBe(0)
    expect(result.output).toContain('Configuration reloaded.')
    const document = await (await service.app.request('/openapi.json')).json()
    expect(document.servers[0].url).toBe('https://new-relay.test')
  } finally {
    await control.close()
    await service.close()
    await pool.end()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reduced limit denies new capacity without dropping an existing reservation', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Pool } = await import('pg')
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const { createServer } = await import('./server.ts')
  const dir = mkdtempSync(join(tmpdir(), 'relay-limit-'))
  const file = join(dir, 'config.json')
  const settings = {
    databaseUrl: 'postgres://relay:password@db/relay',
    clientSecretFile: '/unused',
    publicUrl: 'https://relay.test',
    host: '127.0.0.1',
    port: 0,
    metrics: { host: '127.0.0.1', port: 0 },
    maxSlots: 10,
    maxRooms: 5,
    iceServers: null,
    livekit: { url: 'http://127.0.0.1:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) },
  }
  const pool = new Pool({ connectionString: settings.databaseUrl })
  let selects = 0
  const reservation = { slots: 5, rooms: 1 }
  let enabled = true
  const fakeStore = {
    pool,
    client: async () => ({ id: 'client', enabled, maxSlots: 20, maxRooms: 10, allowScreenShare: true }),
    clientByOrigin: async () => ({ id: 'client' }),
    limitClientRequests: async () => {},
    serialized: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    db: { select: () => ({ from: () => ({ where: async () => (++selects % 3 === 0 ? [] : [reservation]) }) }) },
  } as unknown as import('../infra/store.ts').Store
  const secret = 's'.repeat(64)
  const service = await createServer(settings, {
    store: fakeStore,
    migrate: false,
    startWorkers: false,
    configFile: file,
    loadSecrets: () => ({ client: secret }),
  })
  const capacity = async () => {
    const token = await clientToken(secret)
    const response = await service.app.request('/voice-relay/v1/capacity', { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    return response.json() as Promise<{ accepting: boolean; reservedSlots: number; remainingSlots: number; remainingRooms: number }>
  }
  try {
    expect(await capacity()).toMatchObject({ accepting: true, reservedSlots: 5, remainingSlots: 5 })
    writeFileSync(file, JSON.stringify({ ...settings, maxSlots: 3, maxRooms: 1 }))
    await service.reload()
    expect(await capacity()).toMatchObject({ accepting: false, reservedSlots: 5, remainingSlots: 0, remainingRooms: 0 })
    enabled = false
    const token = await clientToken(secret)
    const join = await service.app.request('/voice-relay/v1/allocations/a/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'u', userId: 'u', allowScreenShare: false }),
    })
    expect(join.status).toBe(403)
    expect(await join.json()).toMatchObject({ code: 'CLIENT_DISABLED' })
  } finally {
    await service.close()
    await pool.end()
    rmSync(dir, { recursive: true, force: true })
  }
})
