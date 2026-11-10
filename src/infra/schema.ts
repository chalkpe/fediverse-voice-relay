// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

export const clients = pgTable(
  'clients',
  {
    id: text('id').primaryKey(),
    origin: text('origin').notNull().unique(),
    enabled: boolean('enabled').notNull().default(false),
    maxSlots: integer('max_slots').notNull(),
    maxRooms: integer('max_rooms').notNull(),
    allowScreenShare: boolean('allow_screen_share').notNull().default(false),
  },
  (t) => [check('clients_max_slots_check', sql`${t.maxSlots} > 0`), check('clients_max_rooms_check', sql`${t.maxRooms} > 0`)],
)

export const allocations = pgTable(
  'allocations',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id),
    roomKey: text('room_key').notNull(),
    generation: text('generation').notNull(),
    mediaProvider: text('media_provider'),
    slots: integer('slots').notNull(),
    state: text('state').$type<'pending' | 'active' | 'ending' | 'ended'>().notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    emptySince: timestamp('empty_since', { withTimezone: true }),
    revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`0`),
    creationInflight: boolean('creation_inflight').notNull().default(false),
  },
  (t) => [
    check('allocations_slots_check', sql`${t.slots} > 0`),
    check('allocations_state_check', sql`${t.state} IN ('pending','active','ending','ended')`),
    index('allocations_live_room').on(t.clientId).where(sql`${t.state} <> 'ended'`),
    index('allocations_room_key_hash').using('hash', t.roomKey),
  ],
)

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id),
    allocationId: text('allocation_id')
      .notNull()
      .references(() => allocations.id),
    generation: text('generation').notNull(),
    type: text('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_tenant_id').on(t.clientId, t.id), index('events_created_at').on(t.createdAt)],
)

export const receivedWebhooks = pgTable(
  'received_webhooks',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('received_webhooks_created_at').on(t.createdAt)],
)

export const eventRetention = pgTable('event_retention', {
  clientId: text('client_id')
    .primaryKey()
    .references(() => clients.id),
  prunedThrough: bigint('pruned_through', { mode: 'bigint' }).notNull().default(sql`0`),
})

export const relayInstallation = pgTable(
  'relay_installation',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    installationId: uuid('installation_id').notNull(),
  },
  (t) => [
    check('relay_installation_singleton_check', sql`${t.singleton}`),
    unique('relay_installation_installation_id_key').on(t.installationId),
  ],
)

export const allocationTombstones = pgTable(
  'allocation_tombstones',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id),
    roomKey: text('room_key').notNull(),
    generation: text('generation').notNull(),
  },
  (t) => [index('allocation_tombstones_room_key_hash').using('hash', t.roomKey), index('allocation_tombstones_client').on(t.clientId)],
)

export const clientGenerationUsage = pgTable(
  'client_generation_usage',
  {
    clientId: text('client_id')
      .primaryKey()
      .references(() => clients.id),
    generations: integer('generations').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('client_generation_usage_generations_check', sql`${t.generations} >= 0`),
    check('client_generation_usage_bytes_check', sql`${t.bytes} >= 0`),
  ],
)

export const participantTokens = pgTable(
  'participant_tokens',
  {
    allocationId: text('allocation_id')
      .notNull()
      .references(() => allocations.id),
    identityHash: text('identity_hash').notNull(),
    generation: uuid('generation').notNull(),
  },
  (t) => [primaryKey({ columns: [t.allocationId, t.identityHash] })],
)

export const clientRequestLimits = pgTable('client_request_limits', {
  clientId: text('client_id')
    .primaryKey()
    .references(() => clients.id),
  timestamps: timestamp('timestamps', { withTimezone: true }).array().notNull(),
})
