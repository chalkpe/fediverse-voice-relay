// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { z } from 'zod'
import type { allocationSchema, iceServerSchema, participantSchema, screenShareLimitsSchema, snapshotSchema } from './schema.ts'

export type IceServer = z.infer<typeof iceServerSchema>
export type Allocation = z.infer<typeof allocationSchema>
export type Participant = z.infer<typeof participantSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type ScreenShareLimits = z.infer<typeof screenShareLimitsSchema>

export type Client = {
  id: string
  origin: string
  enabled: boolean
  maxSlots: number
  maxRooms: number
  allowScreenShare: boolean
}

export type RelayConfig = {
  databaseUrl: string
  host: string
  port: number
  publicUrl: string
  clientSecretFile: string
  metrics?: { host: string; port: number }
  livekit: { url: string; apiKey: string; apiSecret: string; verificationKeys?: { apiKey: string; apiSecret: string }[] }
  maxSlots: number
  maxRooms: number
  screenShareLimits?: ScreenShareLimits
  iceServers: IceServer[] | null
  cloudflareTurn?: { tokenId: string; apiToken: string } | null
  reconcileOrphans?: boolean
}

export class RelayError extends Error {
  public code: string
  public status: number
  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

export const LEASE_MS = 120000
export const PREFIX = '/voice-relay/v1'
