// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { ownsRoom, parseParticipantMetadata, participantMetadata, roomMetadata } from './room.ts'

test('room metadata only proves ownership when its marker matches', () => {
  expect(ownsRoom(roomMetadata('installation'), 'installation')).toBe(true)
  for (const value of ['', 'null', '[]', '{', '{}', '{"voiceRelay":{"version":2,"installationId":"installation"}}']) {
    expect(ownsRoom(value, 'installation')).toBe(false)
  }

  expect(ownsRoom(roomMetadata('other'), 'installation')).toBe(false)
})

test('participant metadata is round-tripped and unknown shapes are rejected', () => {
  const metadata = { clientId: 'c', allocationId: 'a', generation: 'g', userId: 'u' }
  expect(parseParticipantMetadata(participantMetadata(metadata))).toEqual(metadata)
  for (const value of ['null', '[]', '{}', '{']) expect(parseParticipantMetadata(value)).toBeUndefined()
})

test('token inspection requires a revocable participant generation', async () => {
  const { parseTokenMetadata } = await import('./room.ts')
  expect(parseTokenMetadata('{"clientId":"c","allocationId":"a","generation":"g"}')).toBeUndefined()
  const value = { clientId: 'c', allocationId: 'a', generation: 'g', userId: 'u', tokenGeneration: '9c859aa5-faa6-4195-8fea-a65e0cb94a14' }
  expect(parseTokenMetadata(JSON.stringify(value))).toEqual(value)
})
