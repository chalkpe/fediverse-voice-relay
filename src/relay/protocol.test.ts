// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest'
import { capacitySchema, joinSchema, snapshotSchema, statusRequestSchema } from './schema.ts'

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

test('participant status accepts an optional recording flag and still rejects other fields', () => {
  const status = { identity: 'https://a.test/users/user', sessionId: 'PA_session', micMuted: false, deafened: false }

  expect(statusRequestSchema.safeParse(status).success).toBe(true)
  expect(statusRequestSchema.safeParse({ ...status, recording: true }).success).toBe(true)
  expect(statusRequestSchema.safeParse({ ...status, recording: false }).success).toBe(true)

  const recordingId = '12345678-1234-4123-8123-123456789abc'
  for (const invalid of [
    { recording: null },
    { recording: 'true' },
    { recordingId },
    { recording: true, recordingId },
    { recording: true, extra: true },
  ]) {
    expect(statusRequestSchema.safeParse({ ...status, ...invalid }).success).toBe(false)
  }
})

test('snapshot participants report recording beside the existing session fields', () => {
  const participant = {
    identity: 'https://a.test/users/user',
    userId: 'user',
    sessionId: 'PA_session',
    screenSharing: false,
    micMuted: false,
    deafened: false,
    allowScreenShare: false,
    micTrackSid: null,
  }
  const snapshot = { allocationId: 'allocation', generation: 'g', state: 'active', revision: '1' }

  expect(snapshotSchema.safeParse({ ...snapshot, participants: [{ ...participant, recording: true }] }).success).toBe(true)
  expect(snapshotSchema.safeParse({ ...snapshot, participants: [participant] }).success).toBe(true)
  expect(snapshotSchema.safeParse({ ...snapshot, participants: [{ ...participant, recording: 'true' }] }).success).toBe(false)
})

test('capacity advertises recording status beside the existing capabilities', () => {
  const capacity = {
    protocolVersion: 1,
    enabled: true,
    accepting: true,
    maxSlots: 2,
    reservedSlots: 0,
    remainingSlots: 2,
    remainingRooms: 1,
    allowScreenShare: false,
    mediaProvider: 'https://relay.test',
  }
  const capabilities = { cancelPending: true, includeIceServers: true, recordingStatus: true }

  expect(capacitySchema.safeParse({ ...capacity, capabilities }).success).toBe(true)
  expect(capacitySchema.safeParse({ ...capacity, capabilities: { cancelPending: true, includeIceServers: true } }).success).toBe(true)
  expect(capacitySchema.safeParse({ ...capacity, capabilities: { ...capabilities, recordingStatus: 'true' } }).success).toBe(false)
})
