// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import type { Allocation } from './types.ts'

const roomMetadataSchema = z.object({
  voiceRelay: z.object({ version: z.literal(1), installationId: z.string() }),
})

const tokenMetadataSchema = z.object({
  clientId: z.string(),
  allocationId: z.string(),
  generation: z.string(),
})

const participantMetadataSchema = tokenMetadataSchema.extend({ userId: z.string(), tokenGeneration: z.uuid().optional() })
const verifiedTokenMetadataSchema = participantMetadataSchema.extend({ tokenGeneration: z.uuid() })

type ParticipantMetadata = z.infer<typeof participantMetadataSchema>

export function roomName(allocation: Pick<Allocation, 'clientId' | 'id'>): string {
  return `voice-relay:${allocation.clientId}:${allocation.id}`
}

export function roomMetadata(installationId: string): string {
  return JSON.stringify({ voiceRelay: { version: 1, installationId } })
}

export function ownsRoom(metadata: string, installationId: string): boolean {
  try {
    const parsed = roomMetadataSchema.safeParse(JSON.parse(metadata))
    return parsed.success && parsed.data.voiceRelay.installationId === installationId
  } catch {
    return false
  }
}

export function participantMetadata(metadata: ParticipantMetadata): string {
  return JSON.stringify(metadata)
}

export function parseParticipantMetadata(metadata: string): ParticipantMetadata | undefined {
  try {
    const parsed = participantMetadataSchema.safeParse(JSON.parse(metadata))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function allocationParticipant(
  metadata: string,
  allocation: Pick<Allocation, 'clientId' | 'id' | 'generation'>,
): ParticipantMetadata | undefined {
  const parsed = parseParticipantMetadata(metadata)
  return parsed?.clientId === allocation.clientId && parsed.allocationId === allocation.id && parsed.generation === allocation.generation
    ? parsed
    : undefined
}

// 이전 제공자가 남긴 세션별 녹음 속성을 읽거나 정리할 때 사용합니다.
export function recordingAttribute(sessionId: string): string {
  return `cherrypick.recording:${sessionId}`
}

export function parseTokenMetadata(metadata: string): z.infer<typeof verifiedTokenMetadataSchema> | undefined {
  try {
    const parsed = verifiedTokenMetadataSchema.safeParse(JSON.parse(metadata))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
