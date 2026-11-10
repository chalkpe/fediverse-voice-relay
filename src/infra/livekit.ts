// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeProtectedHeader } from 'jose'
import { AccessToken, RoomServiceClient, TokenVerifier, TrackSource, TwirpError, WebhookReceiver } from 'livekit-server-sdk'
import { CLIENT_TOKEN_TYPE } from '../relay/auth.ts'
import { ownsRoom, parseParticipantMetadata, participantMetadata, roomMetadata, roomName } from '../relay/room.ts'
import { type Allocation, type Participant, type RelayConfig, RelayError } from '../relay/types.ts'

export { ownsRoom, roomName } from '../relay/room.ts'

export class LiveKit {
  public client: RoomServiceClient
  public config: RelayConfig['livekit']
  private onFailure?: () => void
  constructor(config: RelayConfig['livekit'], onFailure?: () => void) {
    this.config = config
    this.onFailure = onFailure
    this.client = new RoomServiceClient(config.url, config.apiKey, config.apiSecret, { requestTimeout: 5000 })
  }
  async request<T>(fn: () => Promise<T>, ignoreMissing = false): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (!ignoreMissing || !this.isMissing(error)) {
        try {
          this.onFailure?.()
        } catch {}
      }
      throw error
    }
  }

  async ensure(a: Allocation, installationId: string) {
    const room = await this.request(() =>
      this.client.createRoom({
        name: roomName(a),
        maxParticipants: a.reservedSlots,
        emptyTimeout: 60,
        departureTimeout: 20,
        metadata: roomMetadata(installationId),
      }),
    )
    // 이전 버전에서 만든 방은 일치하는 배정이 있어도 metadata가 비어 있습니다.
    // 다른 설치의 표시가 있거나 확인할 수 없는 방은 변경하지 않습니다.
    if (room.metadata && !ownsRoom(room.metadata, installationId)) throw new RelayError('ALLOCATION_CONFLICT', 409)
  }

  async remove(a: Allocation, installationId: string) {
    try {
      const room = (await this.request(() => this.client.listRooms([roomName(a)]), true))[0]
      if (room?.metadata && !ownsRoom(room.metadata, installationId)) throw new RelayError('ALLOCATION_CONFLICT', 409)
      await this.request(() => this.client.deleteRoom(roomName(a)), true)
    } catch (err) {
      if (!this.isMissing(err)) throw err
    }
  }

  isMissing(err: unknown) {
    return err instanceof TwirpError && (err.status === 404 || err.code === 'not_found')
  }

  async token(a: Allocation, p: { identity: string; userId: string; allowScreenShare: boolean; tokenGeneration: string }) {
    const t = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: p.identity,
      ttl: '2m',
      metadata: participantMetadata({
        clientId: a.clientId,
        allocationId: a.id,
        generation: a.generation,
        userId: p.userId,
        tokenGeneration: p.tokenGeneration,
      }),
    })
    t.addGrant({
      room: roomName(a),
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: p.allowScreenShare
        ? [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
        : [TrackSource.MICROPHONE],
    })
    return t.toJwt()
  }

  async verify(token: string) {
    if (decodeProtectedHeader(token).typ === CLIENT_TOKEN_TYPE) throw new Error('Client authentication token is not a LiveKit token')
    for (const { apiKey, apiSecret } of [this.config, ...(this.config.verificationKeys ?? [])]) {
      try {
        return await new TokenVerifier(apiKey, apiSecret).verify(token)
      } catch {}
    }
    throw new Error('Invalid LiveKit token')
  }

  webhook(body: string, authorization?: string) {
    return new WebhookReceiver(this.config.apiKey, this.config.apiSecret).receive(body, authorization)
  }

  async participants(a: Allocation): Promise<Participant[]> {
    let list: Awaited<ReturnType<RoomServiceClient['listParticipants']>>
    try {
      list = await this.request(() => this.client.listParticipants(roomName(a)), true)
    } catch (err) {
      if (this.isMissing(err)) return []
      throw err
    }
    return list.flatMap((p) => {
      const m = parseParticipantMetadata(p.metadata)
      if (!m || m.clientId !== a.clientId || m.allocationId !== a.id || m.generation !== a.generation) return []
      const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE)
      return [
        {
          identity: p.identity,
          userId: m.userId,
          sessionId: p.sid,
          screenSharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
          micMuted: mic ? mic.muted : p.attributes['cherrypick.micMuted'] === 'true',
          deafened: p.attributes['cherrypick.deafened'] === 'true',
          allowScreenShare:
            p.permission?.canPublish === true &&
            (p.permission.canPublishSources.length === 0 || p.permission.canPublishSources.includes(TrackSource.SCREEN_SHARE)),
          micTrackSid: mic?.sid ?? null,
        },
      ]
    })
  }
}
