// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { capacitySchema, joinSchema } from './schema.ts'

test('capacity contract rejects incompatible version, negative slots and missing approval state', () => {
  const capacity = {
    protocolVersion: 1,
    enabled: true,
    accepting: true,
    maxSlots: 102,
    reservedSlots: 51,
    remainingSlots: 51,
    remainingRooms: 1,
    allowScreenShare: false,
    screenShareLimits: { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrate: 8000000 },
    mediaProvider: 'https://relay.test',
  }

  expect(capacitySchema.safeParse(capacity).success).toBe(true)
  const { allowScreenShare, ...otherFields } = capacity
  expect(capacitySchema.safeParse({ ...otherFields, canScreenShare: allowScreenShare }).success).toBe(false)
  expect(capacitySchema.safeParse({ ...capacity, protocolVersion: 2 }).success).toBe(false)
  expect(capacitySchema.safeParse({ ...capacity, reservedSlots: -1 }).success).toBe(false)
  const { enabled: _enabled, ...missing } = capacity
  expect(capacitySchema.safeParse(missing).success).toBe(false)
})

test('capacity and join accept optional screen share limits with safe positive integers', () => {
  const limits = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, maxBitrate: 2000000 }
  const capacity = {
    protocolVersion: 1,
    enabled: true,
    accepting: true,
    maxSlots: 1,
    reservedSlots: 0,
    remainingSlots: 1,
    remainingRooms: 1,
    allowScreenShare: false,
    mediaProvider: 'https://relay.test',
    screenShareLimits: limits,
  }
  const join = {
    token: 'token',
    allocationId: 'id',
    generation: 'g',
    iceServers: null,
    mediaProvider: 'https://relay.test',
    screenShareLimits: limits,
  }
  expect(capacitySchema.safeParse(capacity).success).toBe(true)
  expect(joinSchema.safeParse(join).success).toBe(true)
  const higher = { maxWidth: 3840, maxHeight: 2160, maxFrameRate: 120, maxBitrate: 16000000 }
  expect(capacitySchema.safeParse({ ...capacity, screenShareLimits: higher }).success).toBe(true)
  expect(joinSchema.safeParse({ ...join, screenShareLimits: higher }).success).toBe(true)
  const { screenShareLimits: _joinLimits, ...joinWithoutLimits } = join
  const { screenShareLimits: _capacityLimits, ...capacityWithoutLimits } = capacity
  expect(joinSchema.safeParse(joinWithoutLimits).success).toBe(true)
  expect(capacitySchema.safeParse(capacityWithoutLimits).success).toBe(true)
  expect(joinSchema.safeParse({ ...join, screenShareLimits: { ...limits, maxFrameRate: 0 } }).success).toBe(false)
})
