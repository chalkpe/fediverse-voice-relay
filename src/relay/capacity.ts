// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

export type CapacityUsage = { maxSlots: number; maxRooms: number; usedSlots: number; usedRooms: number }

export function calculateCapacity(client: CapacityUsage & { enabled: boolean }, provider: CapacityUsage) {
  const remainingSlots = Math.max(0, Math.min(client.maxSlots - client.usedSlots, provider.maxSlots - provider.usedSlots))
  const remainingRooms = Math.max(0, Math.min(client.maxRooms - client.usedRooms, provider.maxRooms - provider.usedRooms))
  return { accepting: client.enabled && remainingSlots > 0 && remainingRooms > 0, remainingSlots, remainingRooms }
}
