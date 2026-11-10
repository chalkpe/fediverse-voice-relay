// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { SignJWT, UnsecuredJWT } from 'jose'
import { AccessToken } from 'livekit-server-sdk'
import { expect, test } from 'vitest'
import { createAuthenticator } from './auth.ts'

const secret = 's'.repeat(64)
const audience = 'https://relay.test'
const origin = 'https://client.test'
const now = Math.floor(Date.now() / 1000)
const authenticate = createAuthenticator({
  audience,
  loadClient: async (issuer) =>
    issuer === origin ? { id: 'client', secret } : issuer === 'https://other.test' ? { id: 'other', secret: 'o'.repeat(64) } : undefined,
})

async function token(
  options: {
    issuer?: string
    subject?: string
    audience?: string | string[]
    algorithm?: string
    typ?: string
    kid?: string
    issuedAt?: number
    expiresAt?: number
    key?: string
    header?: Record<string, string>
  } = {},
) {
  const jwt = new SignJWT({})
    .setProtectedHeader({
      alg: options.algorithm ?? 'HS256',
      typ: options.typ ?? 'voice-relay-client+jwt',
      ...(options.kid ? { kid: options.kid } : {}),
      ...options.header,
    })
    .setIssuer(options.issuer ?? origin)
    .setAudience(options.audience ?? audience)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 60)
  if (options.subject) jwt.setSubject(options.subject)
  return jwt.sign(new TextEncoder().encode(options.key ?? secret))
}
async function authorize(value: string) {
  return authenticate({ headers: { authorization: `Bearer ${value}` } }, '')
}

test('accepts a valid short-lived bearer token, including repeated use', async () => {
  const signed = await token()
  await expect(authorize(signed)).resolves.toBe('client')
  await expect(authorize(signed)).resolves.toBe('client')
})

test('rejects origin, secret, audience, header and time violations', async () => {
  const bad = [
    await token({ algorithm: 'HS512' }),
    await token({ key: 'z'.repeat(64) }),
    await token({ issuer: 'https://other.test' }),
    await token({ issuer: 'https://unknown.test' }),
    await token({ issuer: 'https://CLIENT.test' }),
    await token({ subject: 'old-key' }),
    await token({ kid: 'old-key' }),
    await token({ audience: 'https://other.test' }),
    await token({ audience: [audience, 'https://other.test'] }),
    await token({ typ: 'JWT' }),
    await token({ expiresAt: now - 20 }),
    await token({ expiresAt: now + 1000 }),
    await token({ issuedAt: now - 120, expiresAt: now + 1 }),
    await token({ issuedAt: now + 10 }),
    await token({ header: { jku: 'https://evil.test/keys' } }),
  ]
  for (const value of bad) await expect(authorize(value)).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
  const unsecured = new UnsecuredJWT({ iss: origin, aud: audience, iat: now, exp: now + 60 }).encode()
  await expect(authorize(unsecured)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(authenticate({ headers: {} }, '')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('rejects a LiveKit participant token at the client authentication boundary', async () => {
  const participant = new AccessToken('key', secret, { identity: 'client' })
  participant.addGrant({ roomJoin: true, room: 'room' })
  await expect(authorize(await participant.toJwt())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})
