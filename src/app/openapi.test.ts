// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { Validator } from '@seriousme/openapi-schema-validator'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import type { Store } from '../infra/store.ts'
import { createServer } from './server.ts'

const config = {
  databaseUrl: '',
  host: '127.0.0.1',
  port: 0,
  publicUrl: 'https://relay.example',
  clientSecretFile: '',
  livekit: { url: 'http://localhost:7880', apiKey: 'test', apiSecret: 'test' },
  maxSlots: 100,
  maxRooms: 10,
  iceServers: null,
}

type Operation = { operationId: string; responses: Record<string, unknown>; security?: Record<string, string[]>[]; requestBody?: unknown }
type Document = { openapi: string; paths: Record<string, Record<string, Operation>>; servers: { url: string }[] }

type RegisteredRoute = { method: string; path: string }

function routeCoverage(routes: RegisteredRoute[], document: { paths: Record<string, Record<string, unknown>> }) {
  const registered = new Set<string>()
  for (const route of routes) {
    // 미들웨어, 별도 metrics listener, 문서 화면, 알 수 없는 참가자 작업의 404 처리입니다.
    if (
      (route.method === 'ALL' && route.path === '/*') ||
      route.path === '/metrics' ||
      route.path === '/docs' ||
      route.path === '/icon.png' ||
      route.path === '/openapi.json' ||
      (route.method === 'POST' && route.path === '/voice-relay/v1/allocations/:id/participants/:action')
    )
      continue
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    // Hono의 RTC 접미 와일드카드는 OpenAPI의 기본 경로와 하위 경로 두 개에 대응합니다.
    const paths = path.endsWith('/rtc*') ? [path.slice(0, -1), `${path.slice(0, -1)}/{rtcPath}`] : [path]
    for (const item of paths) registered.add(`${route.method.toUpperCase()} ${item}`)
  }
  const documented = new Set(
    Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)),
  )
  return {
    undocumented: [...registered].filter((route) => !documented.has(route)).sort(),
    unregistered: [...documented].filter((route) => !registered.has(route)).sort(),
  }
}

test('serves generated OpenAPI and Swagger without authentication', async () => {
  const service = await createServer(config, { store: { pool: {} } as Store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  try {
    const response = await service.app.request('/openapi.json')
    expect(response.status).toBe(200)
    const doc = (await response.json()) as Document
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/voice-relay/v1/allocations'].post.requestBody).toBeDefined()
    expect(doc.paths['/voice-relay/v1/allocations'].post.responses['408']).toBeDefined()
    const generated = doc as unknown as {
      components: { schemas: { Capacity: { required: string[]; properties: Record<string, unknown> }; ScreenShareLimits: unknown } }
      paths: Record<
        string,
        {
          post: {
            responses: Record<string, { content: Record<string, { schema: { required: string[]; properties: Record<string, unknown> } }> }>
          }
        }
      >
    }
    const capacity = generated.components.schemas.Capacity
    const joined = generated.paths['/voice-relay/v1/allocations/{id}/join'].post.responses['200'].content['application/json'].schema
    expect(capacity.required).not.toContain('screenShareLimits')
    expect(joined.required).not.toContain('screenShareLimits')
    expect(capacity.properties.screenShareLimits).toEqual({ $ref: '#/components/schemas/ScreenShareLimits' })
    expect(joined.properties.screenShareLimits).toEqual(capacity.properties.screenShareLimits)
    expect(generated.components.schemas.ScreenShareLimits).toMatchObject({
      properties: {
        maxWidth: { maximum: Number.MAX_SAFE_INTEGER },
        maxHeight: { maximum: Number.MAX_SAFE_INTEGER },
        maxFrameRate: { maximum: Number.MAX_SAFE_INTEGER },
        maxBitrate: { maximum: Number.MAX_SAFE_INTEGER },
      },
    })
    const checked = await new Validator().validate(doc)
    expect(checked.valid).toBe(true)
    expect(routeCoverage(service.app.routes, doc)).toEqual({ undocumented: [], unregistered: [] })
    const operations = Object.values(doc.paths).flatMap((path) => Object.values(path))
    const ids = operations.map((operation) => operation.operationId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation.responses).toBeDefined()
        if (path.startsWith('/voice-relay/')) expect(Object.keys(operation.security?.[0] ?? {}).sort()).toEqual(['Bearer'])
      }
    }
    expect(doc.paths['/health'].get.security).toBeUndefined()
    expect(doc.paths['/livekit/webhook'].post.security).toEqual([{ LiveKitAuthorization: [] }])
    const resolved = new Validator()
    expect((await resolved.validate(doc)).valid).toBe(true)
    expect(() => resolved.resolveRefs()).not.toThrow()
    expect(JSON.stringify(doc)).not.toContain('clientSecretFile')
    expect(doc.servers).toEqual([{ url: 'https://relay.example' }])
    const ui = await service.app.request('/docs')
    expect(ui.status).toBe(200)
    const html = await ui.text()
    expect(html).toContain('/openapi.json')
    expect(html).toContain('rel="icon"')
    expect(html).toContain('href="/icon.png"')
    expect(html).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui\.css" integrity="sha384-[^"]+" crossorigin="anonymous"/)
    expect(html).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js" integrity="sha384-[^"]+" crossorigin="anonymous"/)
    const icon = await service.app.request('/icon.png')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await icon.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect((await service.app.request('/icon.png/other')).status).toBe(401)
    expect((await service.app.request('/voice-relay/v1/capacity')).status).toBe(401)
  } finally {
    await service.close()
  }
})

type JsonSchema = {
  type?: string
  required?: string[]
  additionalProperties?: boolean
  properties: Record<string, JsonSchema>
  items: JsonSchema
}

test('generated participant status contract documents the optional recording flag', async () => {
  const service = await createServer(config, { store: { pool: {} } as Store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  try {
    const doc = (await (await service.app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody: { content: Record<string, { schema: JsonSchema }> } } & Operation>>
    }
    const status = doc.paths['/voice-relay/v1/allocations/{id}/participants/status'].post.requestBody.content['application/json'].schema
    const snapshot = (
      doc.paths['/voice-relay/v1/allocations/{id}/snapshot'].get.responses['200'] as { content: Record<string, { schema: JsonSchema }> }
    ).content['application/json'].schema

    expect(status.properties.recording).toMatchObject({ type: 'boolean' })
    expect(status.required).toEqual(['identity', 'sessionId', 'micMuted', 'deafened'])
    expect(status.additionalProperties).toBe(false)
    expect(snapshot.properties.participants.items.properties.recording).toMatchObject({ type: 'boolean' })
    expect(snapshot.properties.participants.items.required).not.toContain('recording')
    const capacity = (doc as unknown as { components: { schemas: { Capacity: JsonSchema } } }).components.schemas.Capacity
    expect(Object.keys(capacity.properties.capabilities.properties)).toEqual(['cancelPending', 'includeIceServers', 'recordingStatus'])
    expect(capacity.properties.capabilities.properties.recordingStatus).toMatchObject({ type: 'boolean' })
  } finally {
    await service.close()
  }
})

test('independent services bind ephemeral listeners and close both', async () => {
  const store = { pool: { totalCount: 0, idleCount: 0, waitingCount: 0 } } as unknown as Store
  const first = await createServer(config, { store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  const second = await createServer(config, { store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  try {
    for (const service of [first, second]) {
      await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve) => service.metricsServer.listen(0, '127.0.0.1', resolve))
    }
    const listeners = [first.server, first.metricsServer, second.server, second.metricsServer]
    expect(new Set(listeners.map((server) => (server.address() as import('node:net').AddressInfo).port)).size).toBe(4)
  } finally {
    await first.close()
    await second.close()
  }

  expect(first.server.listening || first.metricsServer.listening || second.server.listening || second.metricsServer.listening).toBe(false)
})

test('authenticated API responses and authentication errors are not cacheable', async () => {
  const service = await createServer(config, { store: { pool: {} } as Store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  try {
    const response = await service.app.request('/voice-relay/v1/capacity')
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
  } finally {
    await service.close()
  }
})

test('coverage detects a newly registered route and an extra documented method', async () => {
  const app = new Hono()
  app.get('/voice-relay/v1/new/:id', (c) => c.json({ ok: true }))
  expect((await app.request('/voice-relay/v1/new/one')).status).toBe(200)
  const document = { paths: {} }
  expect(routeCoverage(app.routes, document)).toEqual({
    undocumented: ['GET /voice-relay/v1/new/{id}'],
    unregistered: [],
  })
  const documented = { paths: { '/voice-relay/v1/new/{id}': { get: {} } } }
  expect(routeCoverage(app.routes, documented)).toEqual({ undocumented: [], unregistered: [] })
  const updated = { paths: { '/voice-relay/v1/new/{id}': { get: {}, post: {} } } }
  expect(routeCoverage(app.routes, updated)).toEqual({
    undocumented: [],
    unregistered: ['POST /voice-relay/v1/new/{id}'],
  })
})

test('a WebSocket middleware and HTTP proxy can share the RTC route', () => {
  const app = new Hono()
  app.get('/voice-relay/v1/allocations/:id/rtc*', async (_c, next) => next())
  app.get('/voice-relay/v1/allocations/:id/rtc*', (c) => c.text('proxy'))
  const document = {
    paths: {
      '/voice-relay/v1/allocations/{id}/rtc': { get: {} },
      '/voice-relay/v1/allocations/{id}/rtc/{rtcPath}': { get: {} },
    },
  }
  expect(routeCoverage(app.routes, document)).toEqual({ undocumented: [], unregistered: [] })
})

test('shutdown closes an HTTP request stalled during its body', async () => {
  const { connect } = await import('node:net')
  const { once } = await import('node:events')
  const service = await createServer(config, { store: { pool: {} } as Store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
  const request = once(service.server, 'request')
  const socket = connect((service.server.address() as import('node:net').AddressInfo).port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  socket.write('POST /voice-relay/v1/allocations HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{')
  await request
  const closing = service.close()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Shutdown did not settle')), 500)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    socket.destroy()
    await closing
  }
}, 3000)

test.each(['shutdown', 'disconnect'])(
  '%s aborts a stalled upstream HTTP response',
  async (mode) => {
    const { once } = await import('node:events')
    const { createServer: createHttpServer, request } = await import('node:http')
    const { vi } = await import('vitest')
    const { LiveKit } = await import('../infra/livekit.ts')
    const { Provider } = await import('../relay/provider.ts')
    const { clientToken } = await import('../relay/fixtures/client-token.ts')
    const upstream = createHttpServer()
    const upstreamRequest = once(upstream, 'request')
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const store = {
      pool: {},
      admission: async (fn: () => Promise<unknown>) => fn(),
      serialized: async (_id: string, fn: () => Promise<unknown>) => fn(),
      installationId: async () => 'fixture',
      client: async () => ({}),
      clientByOrigin: async () => ({ id: 'client' }),
      limitClientRequests: async () => {},
    } as unknown as Store
    const inspect = vi.spyOn(Provider.prototype, 'inspect').mockResolvedValue({ allocationId: 'a' } as never)
    const usable = vi.spyOn(Provider.prototype, 'usable').mockResolvedValue({} as never)
    const ensure = vi.spyOn(LiveKit.prototype, 'ensure').mockResolvedValue()
    const service = await createServer(
      {
        ...config,
        livekit: { ...config.livekit, url: `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}` },
      },
      {
        store,
        migrate: false,
        startWorkers: false,
        loadSecrets: () => ({ client: 'fixture-secret-fixture-secret-fixture-secret' }),
      },
    )
    await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
    const path = '/voice-relay/v1/allocations/a/rtc/validate?access_token=fixture'
    const client = request({
      hostname: '127.0.0.1',
      port: (service.server.address() as import('node:net').AddressInfo).port,
      path,
      headers: {
        authorization: `Bearer ${await clientToken('fixture-secret-fixture-secret-fixture-secret', 'https://client.test', config.publicUrl)}`,
      },
    })
    client.on('error', () => {})
    try {
      client.end()
      const [upstreamRequestObject] = await Promise.race([
        upstreamRequest,
        new Promise<never>((_resolve, reject) =>
          client.once('response', (response) => reject(new Error(`Unexpected response ${response.statusCode}`))),
        ),
      ])
      upstreamRequestObject.on('error', () => {})
      const upstreamClosed = new Promise<void>((resolve) => upstreamRequestObject.once('close', () => resolve()))
      if (mode === 'shutdown') await service.close()
      else client.destroy()
      await upstreamClosed
      if (mode === 'disconnect') await service.close()
    } finally {
      client.destroy()
      inspect.mockRestore()
      usable.mockRestore()
      ensure.mockRestore()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  },
  3000,
)

test('a non-WebSocket upgrade is handled as an ordinary HTTP request', async () => {
  const { connect } = await import('node:net')
  const { once } = await import('node:events')
  const service = await createServer(config, { store: { pool: {} } as Store, migrate: false, startWorkers: false, loadSecrets: () => ({}) })
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve))
  const socket = connect((service.server.address() as import('node:net').AddressInfo).port, '127.0.0.1')
  socket.on('error', () => {})
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await once(socket, 'connect')
    const response = once(socket, 'data')
    socket.write('GET /docs HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: other\r\n\r\n')
    const [data] = await Promise.race([
      response,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('No HTTP response')), 500)
      }),
    ])
    expect(data.toString()).toContain('HTTP/1.1 200')
  } finally {
    clearTimeout(timeout)
    socket.destroy()
    await service.close()
  }
}, 3000)

test('JWT audience uses the normalized public origin', async () => {
  const { clientToken } = await import('../relay/fixtures/client-token.ts')
  const secret = 'fixture-secret-fixture-secret-fixture-secret'
  const service = await createServer(
    { ...config, publicUrl: 'https://RELAY.EXAMPLE:443/' },
    {
      store: {
        pool: {},
        clientByOrigin: async () => ({ id: 'client' }),
        client: async () => {
          throw new Error('authenticated')
        },
      } as unknown as Store,
      migrate: false,
      startWorkers: false,
      loadSecrets: () => ({ client: secret }),
    },
  )
  try {
    const token = await clientToken(secret, 'https://client.test', 'https://relay.example')
    const response = await service.app.request('/voice-relay/v1/capacity', { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(503)
  } finally {
    await service.close()
  }
})
