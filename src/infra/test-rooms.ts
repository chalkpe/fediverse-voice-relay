// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Provider } from '../relay/provider.ts'
import type { LiveKit } from './livekit.ts'

export function createTestRoomScope() {
  const names = new Set<string>()
  const services = new Set<LiveKit>()

  function attach(service: LiveKit) {
    if (services.has(service)) return service
    services.add(service)
    const create = service.client.createRoom.bind(service.client)
    const list = service.client.listRooms.bind(service.client)
    service.client.createRoom = async (options) => {
      names.add(options.name)
      return create(options)
    }
    service.client.listRooms = async (requested) => {
      const allowed = requested?.length ? requested.filter((name) => names.has(name)) : [...names]
      return allowed.length ? list(allowed) : []
    }
    return service
  }

  async function close(provider: Provider) {
    for (const name of names) {
      const match = /^voice-relay:([^:]+):([^:]+)$/.exec(name)
      if (match) await provider.end(match[1], match[2]).catch(() => {})
      await provider.livekit.client.deleteRoom(name).catch(() => {})
    }
    names.clear()
  }

  return { attach, close }
}
