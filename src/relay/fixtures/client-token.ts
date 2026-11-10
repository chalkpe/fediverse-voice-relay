// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { SignJWT } from 'jose'

export async function clientToken(secret: string, origin = 'https://client.test', audience = 'https://relay.test'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'voice-relay-client+jwt' })
    .setIssuer(origin)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(secret))
}
