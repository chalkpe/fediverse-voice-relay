// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { SignJWT } from 'jose'
import { expect, test } from 'vitest'
import { createAuthenticator } from './auth.ts'

const origin = 'https://consumer.example.org'
const audience = 'https://relay.example.org'
const secret = 's'.repeat(64)
const now = Math.floor(Date.now() / 1000)

async function signed(
  options: {
    issuer?: string
    audience?: string
    secret?: string
    alg?: string
    typ?: string
    kid?: string
    iat?: number
    exp?: number
  } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({
      alg: options.alg ?? 'HS256',
      typ: options.typ ?? 'voice-relay-client+jwt',
      ...(options.kid ? { kid: options.kid } : {}),
    })
    .setIssuer(options.issuer ?? origin)
    .setAudience(options.audience ?? audience)
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 60)
    .sign(new TextEncoder().encode(options.secret ?? secret))
}

test('authenticates the registered origin with its secret and rejects mismatches', async () => {
  let current = secret
  const authenticate = createAuthenticator({
    audience,
    loadClient: async (issuer: string) => (issuer === origin ? { id: 'client', secret: current } : undefined),
  })
  const verify = async (token: string) => authenticate({ headers: { authorization: `Bearer ${token}` } }, '')
  await expect(verify(await signed())).resolves.toBe('client')
  for (const token of [
    await signed({ issuer: 'https://other.example.org' }),
    await signed({ secret: 'x'.repeat(64) }),
    await signed({ audience: 'https://other.example.org' }),
    await signed({ alg: 'HS512' }),
    await signed({ typ: 'JWT' }),
    await signed({ kid: 'old' }),
    await signed({ exp: now - 20 }),
    await signed({ exp: now + 61 }),
    await signed({ iat: now + 10 }),
  ]) {
    await expect(verify(token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  }
  current = 'n'.repeat(64)
  await expect(verify(await signed())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(verify(await signed({ secret: current }))).resolves.toBe('client')
})
