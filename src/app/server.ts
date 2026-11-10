// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { SwaggerUI } from '@hono/swagger-ui'
import { OpenAPIHono, z } from '@hono/zod-openapi'
import { isNull } from 'drizzle-orm'
import type { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { routePath } from 'hono/route'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Pool } from 'pg'
import { CloudflareTurn } from '../infra/cloudflare-turn.ts'
import { LiveKit } from '../infra/livekit.ts'
import { createMetrics } from '../infra/metrics.ts'
import { allocations } from '../infra/schema.ts'
import { Store } from '../infra/store.ts'
import { createAuthenticator } from '../relay/auth.ts'
import { Provider } from '../relay/provider.ts'
import { admit, createSignaling, readLimited } from '../relay/signaling.ts'
import { PREFIX, type RelayConfig, RelayError } from '../relay/types.ts'
import { requestAuthentication } from './auth.ts'
import { loadConfig, RestartSettingsError, ScreenShareLimitsError, validatedSecretLoader } from './config.ts'
import { errors, params, routes, security } from './openapi.ts'
import { ReloadController } from './reload.ts'
import { createReloadControl, ReloadFailure } from './reload-control.ts'

export type RelayService = {
  app: Hono<{ Bindings: HttpBindings; Variables: { tenant: string; rawBody: string } }>
  server: Server
  metricsServer: Server
  reload: () => Promise<void>
  close: () => Promise<void>
}

export async function createServer(
  config: RelayConfig,
  options: {
    store?: Store
    loadSecrets?: () => Record<string, string> | Promise<Record<string, string>>
    startWorkers?: boolean
    migrate?: boolean
    getIceServers?: () => Promise<import('../relay/types.ts').IceServer[] | null>
    configFile?: string
  } = {},
): Promise<RelayService> {
  const initialKeys = options.loadSecrets ?? (await validatedSecretLoader(config.clientSecretFile))
  const store = options.store ?? new Store(new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10000 }))
  if (options.migrate !== false) {
    try {
      await store.migrate()
      await store.db
        .update(allocations)
        .set({ mediaProvider: new URL(config.publicUrl).origin })
        .where(isNull(allocations.mediaProvider))
    } catch (error) {
      if (!options.store) await store.pool.end()
      throw error
    }
  }
  const metrics = createMetrics(store.pool)
  let current = config
  let cloudflareTurn = config.cloudflareTurn ? new CloudflareTurn(() => config.cloudflareTurn) : undefined
  const initialTurn = cloudflareTurn
  const provider = new Provider(store, new LiveKit(config.livekit, metrics.sfuFailure), {
    ...config,
    mediaProvider: new URL(config.publicUrl).origin,
    getIceServers: options.getIceServers ?? (initialTurn ? () => initialTurn.get() : undefined),
  })
  let keys = initialKeys
  const app = new OpenAPIHono<RelayService['app'] extends Hono<infer E> ? E : never>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ code: 'INVALID_REQUEST' }, 400)
    },
  })
  const knownRoutes = new Set([
    ...Object.values(routes).map((route) => route.getRoutingPath()),
    '/livekit/webhook',
    `${PREFIX}/allocations/:id/rtc*`,
    '/docs',
    '/icon.png',
    '/openapi.json',
    '/metrics',
  ])
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith(`${PREFIX}/`)) c.header('Cache-Control', 'no-store')
    const started = process.hrtime.bigint()
    try {
      await next()
    } finally {
      const candidate = routePath(c, -1)
      const route = knownRoutes.has(candidate) ? candidate : 'unknown'
      const method = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'].includes(c.req.method) ? c.req.method : 'OTHER'
      metrics.observe(method, route, c.res.status, Number(process.hrtime.bigint() - started) / 1e9)
    }
  })
  app.all('/metrics', (c) => c.notFound())
  const authenticate: import('./auth.ts').Authenticate = async (req, body) => {
    const clientId = await createAuthenticator({
      audience: new URL(current.publicUrl).origin,
      loadClient: async (origin) => {
        const client = await store.clientByOrigin(origin)
        if (!client) return undefined
        const secrets = await keys()
        const secret = Object.hasOwn(secrets, client.id) ? secrets[client.id] : undefined
        return secret ? { id: client.id, secret } : undefined
      },
    })(req, body)
    await store.client(clientId)
    await store.limitClientRequests(clientId)
    return clientId
  }
  const signaling = createSignaling(provider, authenticate)
  app.use('*', async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      const raw = c.env?.incoming?.url ?? ''
      const rtcPath = /^\/voice-relay\/v1\/allocations\/([a-zA-Z0-9-]+)\/rtc(?:\/|\?|$)/
      if (!rtcPath.test(raw) || !rtcPath.test(c.req.path)) return c.notFound()
    }
    await next()
  })
  app.get(`${PREFIX}/allocations/:id/rtc*`, signaling.middleware)
  app.use('*', requestAuthentication(authenticate))
  app.onError((error, c) =>
    c.json(
      { code: error instanceof RelayError ? error.code : 'PROVIDER_UNAVAILABLE' },
      (error instanceof RelayError ? error.status : 503) as ContentfulStatusCode,
    ),
  )
  let healthProbe: Promise<unknown> | undefined
  let healthValidUntil = 0
  app.openapi(routes.health, async (c) => {
    if (Date.now() >= healthValidUntil) {
      healthProbe ??= store
        .query('SELECT 1')
        .then(() => {
          healthValidUntil = Date.now() + 250
        })
        .finally(() => {
          healthProbe = undefined
        })
      await healthProbe
    }
    return c.json({ ok: true }, 200)
  })
  app.openapi(routes.capacity, async (c) => c.json(await provider.capacity(c.get('tenant'))))
  app.openapi(routes.lookup, async (c) => {
    const { roomKey, generation } = c.req.valid('query')
    return c.json(await provider.lookup(c.get('tenant'), roomKey, generation))
  })
  app.openapi(routes.allocate, async (c) => c.json(await provider.allocate(c.get('tenant'), c.req.valid('json'))))
  app.openapi(routes.cancel, async (c) => c.json(await provider.cancel(c.get('tenant'), c.req.valid('json'))))
  app.openapi(routes.join, async (c) => c.json(await provider.join(c.get('tenant'), c.req.valid('param').id, c.req.valid('json'))))
  app.openapi(routes.snapshot, async (c) => c.json(await provider.snapshot(c.get('tenant'), c.req.valid('param').id)))
  app.openapi(routes.lease, async (c) => c.json(await provider.renew(c.get('tenant'), c.req.valid('param').id)))
  app.openapi(routes.end, async (c) => c.json(await provider.end(c.get('tenant'), c.req.valid('param').id)))
  app.openapi(routes.inspect, async (c) => c.json(await provider.inspect(c.get('tenant'), c.req.valid('json').token)))
  app.openapi(routes.events, async (c) => c.json(await provider.events(c.get('tenant'), c.req.valid('query').cursor)))
  app.openapi(routes.status, async (c) =>
    c.json(await provider.participant(c.get('tenant'), c.req.valid('param').id, 'status', c.req.valid('json'))),
  )
  app.openapi(routes.kick, async (c) =>
    c.json(await provider.participant(c.get('tenant'), c.req.valid('param').id, 'kick', c.req.valid('json'))),
  )
  app.openapi(routes.mute, async (c) =>
    c.json(await provider.participant(c.get('tenant'), c.req.valid('param').id, 'mute', c.req.valid('json'))),
  )
  app.openapi(routes.permissions, async (c) =>
    c.json(await provider.participant(c.get('tenant'), c.req.valid('param').id, 'permissions', c.req.valid('json'))),
  )
  app.post(`${PREFIX}/allocations/:id/participants/:action`, () => {
    throw new RelayError('NOT_FOUND', 404)
  })
  app.post('/livekit/webhook', async (c) => {
    await provider.webhook(c.get('rawBody'), c.req.header('authorization'))
    return c.body(null, 204)
  })
  const pendingHttp = new Set<AbortController>()
  app.get(`${PREFIX}/allocations/:id/rtc*`, async (c) => {
    const controller = new AbortController()
    pendingHttp.add(controller)
    const socket = c.env?.incoming?.socket
    const abort = () => controller.abort()
    socket?.once('close', abort)
    if (socket?.destroyed) abort()
    const raw = c.env?.incoming?.url ?? new URL(c.req.url).pathname + new URL(c.req.url).search
    try {
      return await admit(provider, c.get('tenant'), c.req.param('id'), raw, async (url) => {
        const headers: Record<string, string> = {}
        for (const h of ['accept', 'content-type', 'user-agent']) {
          const v = c.req.header(h)
          if (v) headers[h] = v
        }
        const response = await fetch(url, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        })
        if (response.status >= 300 && response.status < 400) throw new RelayError('PROVIDER_UNAVAILABLE', 503)
        const bytes = await readLimited(response.body, 1024 * 1024)
        return new Response(Buffer.from(bytes), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' },
        })
      })
    } finally {
      socket?.off('close', abort)
      pendingHttp.delete(controller)
    }
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'HS256 client JWT: typ voice-relay-client+jwt, iss is the registered client HTTPS origin, aud is the relay public HTTPS origin; iat and exp are at most 60 seconds apart.',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'LiveKitAuthorization', {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: 'LiveKit webhook authorization, verified against the raw request body.',
  })
  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/livekit/webhook',
    operationId: 'livekitWebhook',
    security: [{ LiveKitAuthorization: [] }],
    description: 'LiveKit webhook; Authorization is verified by the LiveKit SDK.',
    request: { body: { required: true, content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } } },
    responses: {
      204: { description: 'Accepted' },
      400: errors[400],
      403: errors[403],
      408: errors[408],
      413: errors[413],
      503: errors[503],
    },
  })
  for (const suffix of ['', '/{rtcPath}']) {
    app.openAPIRegistry.registerPath({
      method: 'get',
      path: `${PREFIX}/allocations/{id}/rtc${suffix}`,
      operationId: suffix ? 'rtcSubpath' : 'rtc',
      security,
      description:
        'HTTP proxy to the fixed LiveKit RTC endpoint; rtcPath represents the remaining path, including nested segments. WebSocket upgrade uses the same authenticated URL with an empty body and access token, and continues outside HTTP OpenAPI. HTTP upstream responses are forwarded as received.',
      request: {
        params: suffix ? params.extend({ rtcPath: params.shape.id }) : params,
        query: z.object({ access_token: z.string().describe('Allocation-scoped LiveKit access token') }).passthrough(),
      },
      responses: { 101: { description: 'WebSocket upgrade' }, 200: { description: 'Upstream response' }, ...errors },
    })
  }
  app.doc31('/openapi.json', () => ({
    openapi: '3.1.0',
    info: {
      title: 'Voice relay for the fediverse',
      version: '1',
      description: 'Use a short-lived client JWT in Authorization: Bearer over HTTPS. LiveKit participant tokens are separate.',
    },
    servers: [{ url: new URL(current.publicUrl).origin }],
  }))
  app.get('/icon.png', async (c) => {
    const image = await readFile(new URL('../../docs/assets/icon.png', import.meta.url))
    return c.body(new Uint8Array(image), 200, { 'content-type': 'image/png' })
  })
  app.get('/docs', (c) =>
    c.html(html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Voice relay for the fediverse API</title>
          <link rel="icon" type="image/png" href="/icon.png" />
        </head>
        <body>${raw(
          SwaggerUI({
            version: '5.34.1',
            url: '/openapi.json',
            manuallySwaggerUIHtml: ({ css, js }) => `
            <div id="swagger-ui"></div>
            <link rel="stylesheet" href="${css[0]}" integrity="sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF" crossorigin="anonymous" />
            <script src="${js[0]}" integrity="sha384-XFYN47VzPiDY6qPtxYKg0nqUeW/upo20xf1j2SUE7gT/i35FJB4cuS/71Iegzk8Z" crossorigin="anonymous"></script>
            <script>window.onload = () => { window.ui = SwaggerUIBundle({ dom_id: '#swagger-ui', url: '/openapi.json' }) }</script>
          `,
          }),
        )}</body>
      </html>`),
  )
  const createMetricsServer = () =>
    createHttpServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end()
        return
      }
      void metrics
        .scrape()
        .then((body) => {
          res.writeHead(200, { 'content-type': metrics.contentType })
          res.end(body)
        })
        .catch(() => {
          res.writeHead(503).end()
        })
    })
  const apiWebSockets = new Map<Server, typeof signaling.wss>()
  const createApiServer = (wss: typeof signaling.wss) => {
    const listener = createAdaptorServer({
      fetch: app.fetch,
      websocket: { server: wss },
      serverOptions: { shouldUpgradeCallback: (request) => request.headers.upgrade?.toLowerCase() === 'websocket' },
    }) as Server
    listener.requestTimeout = 15000
    listener.headersTimeout = 10000
    apiWebSockets.set(listener, wss)
    listener.once('close', () => apiWebSockets.delete(listener))
    return listener
  }
  let server = createApiServer(signaling.wss)
  let metricsServer = createMetricsServer()
  const listeners = new Set<Server>([server, metricsServer])
  const retired = new Map<Server, Promise<void>>()

  const listen = (listener: Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(port, host, () => {
        listener.off('error', reject)
        resolve()
      })
    })
  const retire = (listener: Server) => {
    if (!listener.listening) {
      apiWebSockets.get(listener)?.close()
      apiWebSockets.delete(listener)
      listeners.delete(listener)
      return
    }
    if (retired.has(listener)) return
    const closed = new Promise<void>((resolve) => listener.close(() => resolve()))
    retired.set(listener, closed)
    void closed.then(() => {
      retired.delete(listener)
      listeners.delete(listener)
    })
  }
  const reloads = new ReloadController(async () => {
    let next: RelayConfig
    try {
      next = loadConfig(options.configFile ?? process.env.VOICE_RELAY_CONFIG ?? 'config.json', current)
    } catch (error) {
      throw new ReloadFailure(
        error instanceof RestartSettingsError || error instanceof ScreenShareLimitsError ? error.message : 'Invalid configuration',
      )
    }
    const restart = [
      ...(next.databaseUrl !== current.databaseUrl ? ['databaseUrl'] : []),
      ...(next.livekit.url !== current.livekit.url ? ['livekit.url'] : []),
      ...(next.livekit.apiKey !== current.livekit.apiKey ? ['livekit.apiKey'] : []),
      ...(next.livekit.apiSecret !== current.livekit.apiSecret ? ['livekit.apiSecret'] : []),
    ]
    if (restart.length) throw new ReloadFailure(`Restart required: ${restart.join(', ')}`)
    let nextKeys: typeof initialKeys
    try {
      nextKeys = options.loadSecrets ?? (await validatedSecretLoader(next.clientSecretFile))
      if (options.loadSecrets) await nextKeys()
    } catch {
      throw new ReloadFailure('Invalid or unavailable client secret file')
    }
    const turnChanged = JSON.stringify(next.cloudflareTurn) !== JSON.stringify(current.cloudflareTurn)
    const nextTurn = turnChanged ? (next.cloudflareTurn ? new CloudflareTurn(() => next.cloudflareTurn) : undefined) : cloudflareTurn
    if (nextTurn && turnChanged && !options.getIceServers) {
      try {
        await nextTurn.get()
      } catch {
        throw new ReloadFailure('Cloudflare TURN preparation failed')
      }
    }
    let api: Server | undefined
    let metrics: Server | undefined
    try {
      if (server.listening && (next.host !== current.host || next.port !== current.port)) {
        api = createApiServer(signaling.createWebSocketServer())
        listeners.add(api)
        await listen(api, next.port, next.host)
      }
      if (metricsServer.listening && (next.metrics?.host !== current.metrics?.host || next.metrics?.port !== current.metrics?.port)) {
        metrics = createMetricsServer()
        listeners.add(metrics)
        await listen(metrics, next.metrics?.port ?? 9090, next.metrics?.host ?? '127.0.0.1')
      }
    } catch {
      if (api) retire(api)
      if (metrics) retire(metrics)
      throw new ReloadFailure('Unable to prepare listener')
    }
    return {
      commit: async () => {
        const previousApi = server
        const previousMetrics = metricsServer
        current = next
        keys = nextKeys
        cloudflareTurn = nextTurn
        provider.limits = {
          ...next,
          mediaProvider: next.publicUrl,
          getIceServers: options.getIceServers ?? (nextTurn ? () => nextTurn.get() : undefined),
        }
        if (api) {
          server = api
          retire(previousApi)
        }
        if (metrics) {
          metricsServer = metrics
          retire(previousMetrics)
        }
      },
      rollback: async () => {
        if (api) retire(api)
        if (metrics) retire(metrics)
      },
    }
  })
  let sweeping = false
  let pruning = false
  let nextRetention = Date.now() + 60000
  const timer =
    options.startWorkers === false
      ? undefined
      : setInterval(() => {
          if (!pruning && Date.now() >= nextRetention) {
            pruning = true
            provider
              .prune()
              .catch(() => {})
              .finally(() => {
                nextRetention = Date.now() + 60000
                pruning = false
              })
          }
          if (!sweeping) {
            sweeping = true
            provider
              .sweep(false)
              .catch(() => {})
              .finally(() => {
                sweeping = false
              })
          }
        }, 2000)
  timer?.unref()
  let closing: Promise<void> | undefined
  return {
    app,
    get server() {
      return server
    },
    get metricsServer() {
      return metricsServer
    },
    reload: () => reloads.reload(),
    close: () => {
      closing ??= (async () => {
        await reloads.close()
        if (timer) clearInterval(timer)
        signaling.close()
        for (const controller of pendingHttp) controller.abort()
        await Promise.all(
          Array.from(listeners, async (listener) => {
            const previousClose = retired.get(listener)
            if (previousClose) {
              listener.closeAllConnections()
              await previousClose
            } else if (listener.listening) {
              const closed = new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
              listener.closeAllConnections()
              await closed
            }
          }),
        )
        metrics[Symbol.dispose]()
        if (!options.store) await store.pool.end()
      })()
      return closing
    },
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(process.env.VOICE_RELAY_CONFIG ?? 'config.json'),
    service = await createServer(config)
  let control: Awaited<ReturnType<typeof createReloadControl>>
  try {
    control = await createReloadControl(process.env.VOICE_RELAY_CONTROL ?? '/tmp/voice-relay/relay.sock', () => service.reload())
  } catch (error) {
    await service.close()
    throw error
  }
  let listeningCount = 0
  const reportListening = () => {
    listeningCount += 1
    if (listeningCount !== 2) return
    const api = service.server.address()
    const metrics = service.metricsServer.address()
    if (!api || typeof api === 'string' || !metrics || typeof metrics === 'string') return
    console.log(
      JSON.stringify({
        event: 'voice-relay-listening',
        api: { address: api.address, port: api.port },
        metrics: { address: metrics.address, port: metrics.port },
      }),
    )
  }
  service.server.once('listening', reportListening)
  service.metricsServer.once('listening', reportListening)
  service.server.listen(config.port, config.host)
  service.metricsServer.listen(config.metrics?.port ?? 9090, config.metrics?.host ?? '127.0.0.1')
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      if (stopping) return
      stopping = true
      void service.close().finally(() => control.close())
    })
}
