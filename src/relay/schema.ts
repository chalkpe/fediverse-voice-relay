// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { isIP } from 'node:net'
import { z } from '@hono/zod-openapi'

// JSON Schema의 maxLength는 Unicode code point 수를 기준으로 합니다.

export const textSchema = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= max)
    .openapi({ maxLength: max })

export const allocationRequestSchema = z.strictObject({
  roomKey: textSchema(2048),
  generation: textSchema(128),
  slots: z.number().int().min(1).max(10000),
})

export const cancelRequestSchema = z.strictObject({
  roomKey: textSchema(2048),
  generation: textSchema(128),
})

export const joinRequestSchema = z.strictObject({
  identity: textSchema(2048),
  userId: textSchema(128),
  allowScreenShare: z.boolean(),
  includeIceServers: z.boolean().optional(),
})

export const emptyRequestSchema = z.strictObject({})

export const tokenRequestSchema = z.strictObject({ token: textSchema(16384) })

export const statusRequestSchema = z.strictObject({
  identity: textSchema(2048),
  sessionId: textSchema(2048),
  micMuted: z.boolean(),
  deafened: z.boolean(),
})

export const identityRequestSchema = z.strictObject({ identity: textSchema(2048) })

export const permissionsRequestSchema = z.strictObject({
  identity: textSchema(2048),
  allowScreenShare: z.boolean(),
})

export const stateSchema = z.enum(['pending', 'active', 'ending', 'ended'])

export const screenShareLimitsSchema = z
  .strictObject({
    maxWidth: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('Maximum captured width in pixels'),
    maxHeight: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('Maximum captured height in pixels'),
    maxFrameRate: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('Maximum frames per second'),
    maxBitrate: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('Maximum screen-share video encoding bitrate in bit/s'),
  })
  .openapi('ScreenShareLimits')

export const screenShareLimitsConfigSchema = screenShareLimitsSchema.optional()

export const allocationSchema = z
  .strictObject({
    id: z.string(),
    clientId: z.string(),
    roomKey: z.string(),
    generation: z.string(),
    reservedSlots: z.number().int().min(1),
    leaseExpiresAt: z.string(),
    state: stateSchema,
    createdAt: z.string(),
  })
  .openapi('Allocation')

export const capacitySchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    capabilities: z
      .object({
        cancelPending: z.boolean().optional(),
        includeIceServers: z.boolean().optional(),
      })
      .optional(),
    enabled: z.boolean(),
    accepting: z.boolean(),
    maxSlots: z.number().int().min(1),
    reservedSlots: z.number().int().min(0),
    remainingSlots: z.number().int().min(0),
    remainingRooms: z.number().int().min(0).describe('Additional rooms that can be reserved concurrently'),
    allowScreenShare: z.boolean(),
    screenShareLimits: screenShareLimitsSchema.optional(),
    mediaProvider: z.string(),
    activeParticipants: z.number().int().min(0).optional(),
  })
  .openapi('Capacity')

export const eventSchema = z
  .strictObject({
    id: z.string().regex(/^[0-9]+$/),
    allocationId: z.string(),
    generation: z.string(),
    type: z.string(),
    revision: z.string().regex(/^[0-9]+$/),
  })
  .openapi('Event')

export const participantSchema = z.strictObject({
  identity: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  screenSharing: z.boolean(),
  micMuted: z.boolean().optional(),
  deafened: z.boolean().optional(),
  allowScreenShare: z.boolean(),
  micTrackSid: z.string().nullable(),
})

export const iceServerSchema = z.strictObject({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
})

export const snapshotSchema = z.strictObject({
  allocationId: z.string(),
  generation: z.string(),
  state: stateSchema,
  participants: z.array(participantSchema),
  revision: z.string(),
})

export const joinSchema = z.strictObject({
  token: z.string(),
  allocationId: z.string(),
  generation: z.string(),
  iceServers: z.array(iceServerSchema).nullable().describe('null means no provider list; [] explicitly supplies an empty list'),
  mediaProvider: z.string(),
  screenShareLimits: screenShareLimitsSchema.optional(),
})

export const inspectedSchema = z.strictObject({
  allocationId: z.string(),
  generation: z.string(),
  expiresAt: z.number().optional(),
  identity: z.string().optional(),
})

export const eventsSchema = z.strictObject({
  events: z.array(eventSchema),
  cursor: z.string(),
  gap: z.boolean(),
})

export const healthSchema = z.object({ ok: z.literal(true) })

export const endedSchema = z.object({ state: z.literal('ended') })

export const allocationQuerySchema = z.object({
  roomKey: textSchema(2048),
  generation: textSchema(128),
})

export const eventsQuerySchema = z.object({ cursor: z.string().max(256).optional() })

export const allocationParamsSchema = z.object({ id: z.string() })

export const acceptedSchema = z.strictObject({ accepted: z.boolean() })

export const errorSchema = z
  .strictObject({
    code: z.enum([
      'INVALID_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'CLIENT_DISABLED',
      'NOT_FOUND',
      'ALLOCATION_CONFLICT',
      'REQUEST_TIMEOUT',
      'PAYLOAD_TOO_LARGE',
      'CAPACITY_EXCEEDED',
      'RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
    ]),
  })
  .openapi('RelayError')

export const publicHttpsOriginSchema = z.string().transform((value, context) => {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid HTTPS origin' })
    return z.NEVER
  }
  const host = origin.hostname.toLowerCase().replace(/\.$/, '')
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    isIP(host.replace(/^\[|\]$/g, '')) ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  ) {
    context.addIssue({ code: 'custom', message: 'Invalid HTTPS origin' })
    return z.NEVER
  }
  return origin
})

export const cloudflareTurnConfigSchema = z.strictObject({
  tokenId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  apiToken: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\x21-\x7e]+$/),
})
