// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { cloudflareTurnConfigSchema, iceServerSchema, publicHttpsOriginSchema, screenShareLimitsConfigSchema } from '../relay/schema.ts'
import type { RelayConfig } from '../relay/types.ts'

function parseJson(raw: string, description: string) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Invalid ${description} JSON`)
  }
}

function validateSecrets(value: unknown): Record<string, string> {
  const result = z.record(z.string().min(1), z.string().min(32)).safeParse(value)
  if (!result.success) throw new Error('Invalid secret file')
  return result.data
}

export function loadSecrets(file: string): Record<string, string> {
  return validateSecrets(parseJson(readFileSync(file, 'utf8'), 'secret file'))
}

export function secretLoader(file: string): () => Promise<Record<string, string>> {
  let cachedRaw: string | undefined
  let cache: Record<string, string> | undefined
  return async () => {
    // 파일 크기와 시각이 같아도 내용이 바뀔 수 있으므로 실제 바이트를 확인합니다.
    const raw = await readFile(file, 'utf8')
    if (cache && cachedRaw === raw) return cache
    const parsed = parseJson(raw, 'secret file') as Record<string, string>
    cachedRaw = raw
    cache = parsed
    return parsed
  }
}

export async function validatedSecretLoader(file: string): Promise<() => Promise<Record<string, string>>> {
  const read = secretLoader(file)
  let current = validateSecrets(await read())
  return async () => {
    try {
      current = validateSecrets(await read())
    } catch {
      // 읽을 수 없거나 손상된 파일은 마지막으로 확인한 시크릿을 덮어쓰지 않습니다.
    }
    return current
  }
}

function validIceUrl(value: string, credentials: { username?: string; credential?: string }): boolean {
  const match =
    /^(stun|stuns|turn|turns):(\[[0-9a-f:.]+\]|(?:[a-z0-9._~!$&'()*+,;=-]|%[0-9a-f]{2})+)(?::([0-9]+))?(?:\?transport=([a-z0-9._~-]+))?$/i.exec(
      value,
    )
  if (!match) return false
  const [, scheme, host, port, transport] = match
  if (host.startsWith('[') && isIP(host.slice(1, -1)) !== 6) return false
  if (port && (Number(port) < 1 || Number(port) > 65535)) return false
  const turn = scheme.toLowerCase().startsWith('turn')
  if (transport && !turn) return false
  return !turn || (Boolean(credentials.username) && Boolean(credentials.credential))
}

export class RestartSettingsError extends Error {
  constructor(fields: string[]) {
    super(`Restart required: ${fields.join(', ')}`)
  }
}

export class ScreenShareLimitsError extends Error {
  constructor() {
    super('Invalid screenShareLimits configuration')
  }
}

export function loadConfig(file: string, previous?: RelayConfig): RelayConfig {
  const raw = parseJson(readFileSync(file, 'utf8'), 'configuration')
  if (previous && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields: string[] = []
    if (Object.hasOwn(raw, 'databaseUrl') && raw.databaseUrl !== previous.databaseUrl) fields.push('databaseUrl')
    if (raw.livekit && typeof raw.livekit === 'object' && !Array.isArray(raw.livekit)) {
      for (const field of ['url', 'apiKey', 'apiSecret'] as const) {
        if (Object.hasOwn(raw.livekit, field) && raw.livekit[field] !== previous.livekit[field]) fields.push(`livekit.${field}`)
      }
      if (!isDeepStrictEqual(raw.livekit.verificationKeys ?? [], previous.livekit.verificationKeys ?? []))
        fields.push('livekit.verificationKeys')
    }
    if (fields.length) throw new RestartSettingsError(fields)
  }
  const schema = z.strictObject({
    databaseUrl: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
        } catch {
          return false
        }
      }),
    clientSecretFile: z.string().min(1),
    publicUrl: publicHttpsOriginSchema.transform((value) => value.origin),
    maxSlots: z.number().int().safe().min(1),
    maxRooms: z.number().int().safe().min(1),
    screenShareLimits: screenShareLimitsConfigSchema,
    host: z.string().min(1).max(255).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(7888),
    metrics: z
      .strictObject({ host: z.string().min(1).max(255).default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(9090) })
      .default({ host: '127.0.0.1', port: 9090 }),
    livekit: z.strictObject({
      url: z.string().refine((value) => {
        try {
          const url = new URL(value)
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        } catch {
          return false
        }
      }),
      apiKey: z.string().min(1),
      apiSecret: z.string().min(32),
      verificationKeys: z.array(z.strictObject({ apiKey: z.string().min(1), apiSecret: z.string().min(32) })).optional(),
    }),
    iceServers: z
      .array(iceServerSchema.refine((server) => server.urls.length > 0 && server.urls.every((url) => validIceUrl(url, server))))
      .nullable()
      .default(null),
    cloudflareTurn: cloudflareTurnConfigSchema.nullable().default(null),
    reconcileOrphans: z.boolean().default(false),
  })
  if (raw && typeof raw === 'object' && !cloudflareTurnConfigSchema.nullable().optional().safeParse(raw.cloudflareTurn).success)
    throw new Error('Invalid Cloudflare TURN configuration')
  if (raw && typeof raw === 'object' && !screenShareLimitsConfigSchema.safeParse(raw.screenShareLimits).success)
    throw new ScreenShareLimitsError()
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error('Invalid configuration')
  if (parsed.data.cloudflareTurn && parsed.data.iceServers !== null) throw new Error('Configure either Cloudflare TURN or iceServers')
  return parsed.data
}
