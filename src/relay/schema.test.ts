// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { allocationRequestSchema, joinRequestSchema, permissionsRequestSchema, publicHttpsOriginSchema } from './schema.ts'

test('shared origin validation rejects local addresses and preserves URL normalization', () => {
  for (const origin of [
    'http://example.org',
    'https://127.0.0.1',
    'https://[::1]',
    'https://foo.localhost.',
    'https://example.org/path',
    'https://user@example.org',
  ]) {
    expect(publicHttpsOriginSchema.safeParse(origin).success).toBe(false)
  }

  expect(publicHttpsOriginSchema.parse('https://EXAMPLE.org:443/').origin).toBe('https://example.org')
})

test('wire request schema counts Unicode code points and rejects extra fields', () => {
  expect(allocationRequestSchema.safeParse({ roomKey: '😀'.repeat(2048), generation: 'g', slots: 1 }).success).toBe(true)
  expect(allocationRequestSchema.safeParse({ roomKey: '😀'.repeat(2049), generation: 'g', slots: 1 }).success).toBe(false)
  expect(allocationRequestSchema.safeParse({ roomKey: 'r', generation: 'g', slots: 1, extra: true }).success).toBe(false)
})

test('wire screen share permissions use the allowScreenShare field', () => {
  expect(joinRequestSchema.safeParse({ identity: 'user', userId: 'user', allowScreenShare: true }).success).toBe(true)
  expect(joinRequestSchema.safeParse({ identity: 'user', userId: 'user', canScreenShare: true }).success).toBe(false)
  expect(permissionsRequestSchema.safeParse({ identity: 'user', allowScreenShare: false }).success).toBe(true)
})
