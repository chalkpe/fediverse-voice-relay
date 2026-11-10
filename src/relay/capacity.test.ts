// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest'
import { calculateCapacity } from './capacity.ts'

describe('capacity limits', () => {
  const client = { enabled: true, maxSlots: 10, maxRooms: 4, usedSlots: 2, usedRooms: 1 }
  const provider = { maxSlots: 20, maxRooms: 8, usedSlots: 5, usedRooms: 2 }

  test.each([
    ['client limit', client, provider, { accepting: true, remainingSlots: 8, remainingRooms: 3 }],
    ['disabled client', { ...client, enabled: false }, provider, { accepting: false, remainingSlots: 8, remainingRooms: 3 }],
    ['at slot limit', { ...client, usedSlots: 10 }, provider, { accepting: false, remainingSlots: 0, remainingRooms: 3 }],
    ['at room limit', { ...client, usedRooms: 4 }, provider, { accepting: false, remainingSlots: 8, remainingRooms: 0 }],
    ['provider limit', client, { ...provider, usedSlots: 19, usedRooms: 7 }, { accepting: true, remainingSlots: 1, remainingRooms: 1 }],
    [
      'provider above reduced limits',
      client,
      { ...provider, usedSlots: 21, usedRooms: 9 },
      { accepting: false, remainingSlots: 0, remainingRooms: 0 },
    ],
    ['reduced limits', { ...client, usedSlots: 11, usedRooms: 5 }, provider, { accepting: false, remainingSlots: 0, remainingRooms: 0 }],
  ])('%s', (_name, client, global, expected) => {
    expect(calculateCapacity(client, global)).toEqual(expected)
  })
})
