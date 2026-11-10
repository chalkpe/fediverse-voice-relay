// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import { cloudflareTurnConfigSchema } from '../relay/schema.ts'
import { readLimited } from '../relay/signaling.ts'
import type { IceServer } from '../relay/types.ts'

export type CloudflareTurnConfig = z.infer<typeof cloudflareTurnConfigSchema>
const TTL_SECONDS = 86400
const REUSE_MS = 12 * 60 * 60 * 1000
const FAILURE_MS = 60000
const MAX_BODY = 65536

const responseSchema = z.object({
  iceServers: z
    .array(
      z.object({
        urls: z.array(z.string().min(1)).min(1),
        username: z.string().optional(),
        credential: z.string().optional(),
      }),
    )
    .min(1),
})

type Pending = { kind: 'pending'; config: CloudflareTurnConfig; started: number; generation: number; promise: Promise<IceServer[]> }
type State =
  | Pending
  | { kind: 'success'; config: CloudflareTurnConfig; until: number; value: IceServer[] }
  | { kind: 'failure'; config: CloudflareTurnConfig; until: number }
  | { kind: 'empty' }

function same(a: CloudflareTurnConfig | null | undefined, b: CloudflareTurnConfig) {
  return a?.tokenId === b.tokenId && a.apiToken === b.apiToken
}

export class CloudflareTurn {
  private state: State = { kind: 'empty' }
  private generation = 0
  private settings: () => CloudflareTurnConfig | null | undefined
  private request: typeof fetch

  constructor(settings: () => CloudflareTurnConfig | null | undefined, request: typeof fetch = fetch) {
    this.settings = settings
    this.request = request
  }

  async get(): Promise<IceServer[] | null> {
    const current = this.settings()
    if (!current) {
      this.generation++
      this.state = { kind: 'empty' }
      return null
    }
    const validated = cloudflareTurnConfigSchema.safeParse(current)
    if (!validated.success) throw new Error('TURN credentials unavailable')
    const state = this.state
    if (state.kind !== 'empty' && same(state.config, validated.data)) {
      if (state.kind === 'pending') return this.resolve(state)
      if (Date.now() < state.until) {
        if (state.kind === 'failure') throw new Error('TURN credentials unavailable')
        return state.value
      }
    }
    const config = validated.data
    const pending: Pending = {
      kind: 'pending',
      config,
      started: Date.now(),
      generation: ++this.generation,
      promise: this.generate(config),
    }
    this.state = pending
    return this.resolve(pending)
  }

  private async resolve(pending: Pending): Promise<IceServer[]> {
    try {
      const value = await pending.promise
      if (this.generation !== pending.generation || !same(this.settings(), pending.config)) throw new Error('settings changed')
      if (this.state === pending) this.state = { kind: 'success', config: pending.config, value, until: pending.started + REUSE_MS }
      return value
    } catch {
      if (this.state === pending && same(this.settings(), pending.config))
        this.state = { kind: 'failure', config: pending.config, until: pending.started + FAILURE_MS }
      throw new Error('TURN credentials unavailable')
    }
  }

  private async generate(config: CloudflareTurnConfig): Promise<IceServer[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    timer.unref()
    try {
      const response = await this.request(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.tokenId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ttl: TTL_SECONDS }),
          redirect: 'error',
          signal: controller.signal,
        },
      )
      if (response.status !== 201 || !response.body) throw new Error('bad response')
      const body = await readLimited(response.body, MAX_BODY)
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      return responseSchema.parse(value).iceServers
    } finally {
      clearTimeout(timer)
    }
  }
}
