// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from 'drizzle-orm'
import { allocations, clientGenerationUsage, clientRequestLimits, clients, events } from './schema.ts'
import type { Store } from './store.ts'

export async function expireClientEvents(store: Store, clientId: string) {
  await store.db
    .update(events)
    .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(events.clientId, clientId))
}

export async function expireAllocationEvents(store: Store, allocationId: string) {
  await store.db
    .update(events)
    .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(events.allocationId, allocationId))
}

export async function exhaustGenerationCount(store: Store, clientId: string) {
  await store.db.update(clientGenerationUsage).set({ generations: 99999 }).where(eq(clientGenerationUsage.clientId, clientId))
}

export async function exhaustGenerationBytes(store: Store, clientId: string) {
  await store.db.update(clientGenerationUsage).set({ bytes: 16777216 }).where(eq(clientGenerationUsage.clientId, clientId))
}

export async function addTestClient(store: Store, id: string) {
  await store.db.insert(clients).values({ id, origin: `https://${id}.test`, enabled: true, maxSlots: 10, maxRooms: 10 })
}

export async function prepareOverflowReservations(store: Store) {
  for (const id of ['client-a', 'client-b']) {
    await addTestClient(store, id)
    await store.db.insert(allocations).values({
      id: `${id}-overflow`,
      clientId: id,
      roomKey: `${id}-room`,
      generation: 'g',
      slots: 1500000000,
      state: 'pending',
      leaseExpiresAt: new Date(),
    })
  }
}

export async function expireClientRequestWindow(store: Store, clientId: string) {
  await store.db
    .update(clientRequestLimits)
    .set({ timestamps: [new Date(Date.now() - 61000)] })
    .where(eq(clientRequestLimits.clientId, clientId))
}
