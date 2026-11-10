// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { createRoute, type z } from '@hono/zod-openapi'
import {
  acceptedSchema,
  allocationParamsSchema,
  allocationQuerySchema,
  allocationRequestSchema,
  allocationSchema,
  cancelRequestSchema,
  capacitySchema,
  emptyRequestSchema,
  endedSchema,
  errorSchema,
  eventsQuerySchema,
  eventsSchema,
  healthSchema,
  identityRequestSchema,
  inspectedSchema,
  joinRequestSchema,
  joinSchema,
  permissionsRequestSchema,
  snapshotSchema,
  statusRequestSchema,
  tokenRequestSchema,
} from '../relay/schema.ts'
import { PREFIX } from '../relay/types.ts'

const errors = Object.fromEntries(
  Object.entries({
    400: 'INVALID_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN or CLIENT_DISABLED',
    404: 'NOT_FOUND',
    408: 'REQUEST_TIMEOUT',
    409: 'ALLOCATION_CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    429: 'CAPACITY_EXCEEDED or RATE_LIMITED',
    503: 'PROVIDER_UNAVAILABLE',
  }).map(([status, description]) => [status, { description, content: { 'application/json': { schema: errorSchema } } }]),
)
const security = [{ Bearer: [] }]
const params = allocationParamsSchema
const response = <T extends z.ZodType>(schema: T) => ({ description: 'Success', content: { 'application/json': { schema } } })
const body = <T extends z.ZodType>(schema: T) => ({ required: true as const, content: { 'application/json': { schema } } })
const common = { security }
export const routes = {
  health: createRoute({
    method: 'get',
    path: '/health',
    operationId: 'health',
    responses: { 200: response(healthSchema), 400: errors[400], 408: errors[408], 413: errors[413], 503: errors[503] },
  }),
  capacity: createRoute({
    ...common,
    method: 'get',
    path: `${PREFIX}/capacity`,
    operationId: 'capacity',
    responses: { ...errors, 200: response(capacitySchema) },
  }),
  lookup: createRoute({
    ...common,
    method: 'get',
    path: `${PREFIX}/allocations`,
    operationId: 'lookupAllocation',
    request: { query: allocationQuerySchema },
    responses: { ...errors, 200: response(allocationSchema) },
  }),
  allocate: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations`,
    operationId: 'allocate',
    request: { body: body(allocationRequestSchema) },
    responses: { ...errors, 200: response(allocationSchema) },
  }),
  cancel: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/cancel`,
    operationId: 'cancelAllocation',
    request: { body: body(cancelRequestSchema) },
    responses: { ...errors, 200: response(endedSchema) },
  }),
  join: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/{id}/join`,
    operationId: 'join',
    request: { params, body: body(joinRequestSchema) },
    responses: { ...errors, 200: response(joinSchema) },
  }),
  snapshot: createRoute({
    ...common,
    method: 'get',
    path: `${PREFIX}/allocations/{id}/snapshot`,
    operationId: 'snapshot',
    request: { params },
    responses: { ...errors, 200: response(snapshotSchema) },
  }),
  lease: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/{id}/lease`,
    operationId: 'renewLease',
    request: { params, body: body(emptyRequestSchema) },
    responses: { ...errors, 200: response(allocationSchema) },
  }),
  end: createRoute({
    ...common,
    method: 'delete',
    path: `${PREFIX}/allocations/{id}`,
    operationId: 'endAllocation',
    request: { params },
    responses: { ...errors, 200: response(allocationSchema) },
  }),
  inspect: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/tokens/inspect`,
    operationId: 'inspectToken',
    request: { body: body(tokenRequestSchema) },
    responses: { ...errors, 200: response(inspectedSchema) },
  }),
  events: createRoute({
    ...common,
    method: 'get',
    path: `${PREFIX}/events`,
    operationId: 'events',
    request: { query: eventsQuerySchema },
    responses: { ...errors, 200: response(eventsSchema) },
  }),
  status: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/{id}/participants/status`,
    operationId: 'participantStatus',
    request: { params, body: body(statusRequestSchema) },
    responses: { ...errors, 200: response(acceptedSchema) },
  }),
  kick: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/{id}/participants/kick`,
    operationId: 'kickParticipant',
    request: { params, body: body(identityRequestSchema) },
    responses: { ...errors, 200: response(acceptedSchema) },
  }),
  mute: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/{id}/participants/mute`,
    operationId: 'muteParticipant',
    request: { params, body: body(identityRequestSchema) },
    responses: { ...errors, 200: response(acceptedSchema) },
  }),
  permissions: createRoute({
    ...common,
    method: 'post',
    path: `${PREFIX}/allocations/{id}/participants/permissions`,
    operationId: 'participantPermissions',
    request: { params, body: body(permissionsRequestSchema) },
    responses: { ...errors, 200: response(acceptedSchema) },
  }),
}
export { errors, params, security }
