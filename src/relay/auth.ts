// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage } from 'node:http'
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import { publicHttpsOriginSchema } from './schema.ts'
import { RelayError } from './types.ts'

export const CLIENT_TOKEN_TYPE = 'voice-relay-client+jwt'
const MAX_LIFETIME_SECONDS = 60
const CLOCK_TOLERANCE_SECONDS = 5

export function createAuthenticator(options: {
  loadClient: (origin: string) => Promise<{ id: string; secret: string } | undefined>
  audience: string
}) {
  return async (req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, _body: string): Promise<string> => {
    const authorization = req.headers.authorization
    if (
      typeof authorization !== 'string' ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)
    ) {
      throw new RelayError('UNAUTHORIZED', 401)
    }
    const encoded = authorization.slice(7)
    let issuer: string
    try {
      const header = decodeProtectedHeader(encoded)
      const payload = decodeJwt(encoded)
      if (header.alg !== 'HS256' || header.typ !== CLIENT_TOKEN_TYPE || Object.keys(header).some((key) => !['alg', 'typ'].includes(key)))
        throw new Error('Invalid token header')
      const parsed = publicHttpsOriginSchema.safeParse(payload.iss)
      if (!parsed.success || parsed.data.origin !== payload.iss) throw new Error('Invalid issuer')
      issuer = payload.iss as string
    } catch {
      throw new RelayError('UNAUTHORIZED', 401)
    }
    const client = await options.loadClient(issuer)
    if (!client || typeof client.secret !== 'string' || client.secret.length < 32) throw new RelayError('UNAUTHORIZED', 401)
    try {
      const { payload } = await jwtVerify(encoded, new TextEncoder().encode(client.secret), {
        algorithms: ['HS256'],
        typ: CLIENT_TOKEN_TYPE,
        issuer,
        audience: options.audience,
        requiredClaims: ['iat', 'exp'],
        maxTokenAge: MAX_LIFETIME_SECONDS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      })
      if (
        payload.sub !== undefined ||
        payload.aud !== options.audience ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat === undefined ||
        payload.exp === undefined ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > MAX_LIFETIME_SECONDS
      )
        throw new Error('Invalid token claims')
      return client.id
    } catch {
      throw new RelayError('UNAUTHORIZED', 401)
    }
  }
}
