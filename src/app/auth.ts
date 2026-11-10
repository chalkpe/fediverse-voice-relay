// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage } from 'node:http'
import type { HttpBindings } from '@hono/node-server'
import { createMiddleware } from 'hono/factory'
import { readLimited } from '../relay/signaling.ts'
import { RelayError } from '../relay/types.ts'

export type AuthEnvironment = { Bindings: HttpBindings; Variables: { tenant: string; rawBody: string } }
export type Authenticate = (req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, body: string) => Promise<string>

export function requestAuthentication(authenticate: Authenticate) {
  return createMiddleware<AuthEnvironment>(async (c, next) => {
    if (Number(c.req.header('content-length') ?? 0) > 65536) throw new RelayError('PAYLOAD_TOO_LARGE', 413)
    const bytes = await readLimited(c.req.raw.body, 65536, 15000)
    let raw: string
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new RelayError('INVALID_REQUEST', 400)
    }
    c.set('rawBody', raw)
    if (!['/health', '/livekit/webhook', '/docs', '/icon.png', '/openapi.json'].includes(c.req.path)) {
      const url = new URL(c.req.url)
      c.set(
        'tenant',
        await authenticate(
          {
            method: c.req.method,
            url: c.env?.incoming?.url ?? `${url.pathname}${url.search}`,
            headers: Object.fromEntries(c.req.raw.headers),
          },
          raw,
        ),
      )
    }
    try {
      const value = raw ? JSON.parse(raw) : {}
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    } catch {
      throw new RelayError('INVALID_REQUEST', 400)
    }
    if (c.req.method === 'POST' && c.req.path !== '/livekit/webhook') {
      const headers = new Headers(c.req.raw.headers)
      headers.set('content-type', 'application/json')
      c.req.raw = new Request(c.req.url, { method: 'POST', headers, body: raw || '{}' })
    }
    await next()
  })
}
