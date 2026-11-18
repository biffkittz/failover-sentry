/**
 * Zod schemas for the messages the components exchange, in one place so that every side validates the same shape:
 * region IDs, epochs, chaos settings, the regions' admin orders and the replication webhook.
 */
import { z } from 'zod';
import { MAX_EPOCH } from './constants.js';

export const regionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'region ids are 1-31 lower-case letters, digits or hyphens');

/** A fencing epoch: a non-negative integer, capped (see MAX_EPOCH). */
export const epochSchema = z.number().int().min(0).max(MAX_EPOCH);

export const chaosSettingsSchema = z.object({
  health: z.enum(['healthy', 'degraded', 'down']),
  latencyMs: z.number().int().min(0).max(30_000),
  errorRate: z.number().min(0).max(1),
  replication: z.enum(['normal', 'slow', 'stalled', 'drop-webhook', 'fail']),
});

/** What an operator changes: any subset of the chaos settings. */
export const chaosUpdateSchema = chaosSettingsSchema.partial().strict();

// ---------------------------------------------------------------------------------------------------------------------
// Admin orders to a region. Each names the region it is for inside the signed body, so a captured order can't be
// replayed against another region (they share the admin secret).
// ---------------------------------------------------------------------------------------------------------------------

export const promoteOrderSchema = z
  .object({
    regionId: regionIdSchema,
    failoverId: z.string().min(1).max(100),
    epoch: epochSchema.min(1),
    mode: z.enum(['planned', 'forced', 'restore']),
  })
  .strict();

export const demoteOrderSchema = z
  .object({
    regionId: regionIdSchema,
    failoverId: z.string().min(1).max(100).nullable(),
    epoch: epochSchema,
    reason: z.string().max(300),
  })
  .strict();

export const powerOrderSchema = z.object({ regionId: regionIdSchema, state: z.enum(['on', 'off']) }).strict();

export const chaosOrderSchema = z.object({ regionId: regionIdSchema, ...chaosUpdateSchema.shape }).strict();

// ---------------------------------------------------------------------------------------------------------------------
// The replication webhook (region → console's webhook gateway)
// ---------------------------------------------------------------------------------------------------------------------

export const replicationWebhookEventSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    type: z.enum(['replication.promotion.completed', 'replication.promotion.failed']),
    failoverId: z.string().min(1).max(100),
    epoch: epochSchema,
    regionId: regionIdSchema,
    lsn: z.number().int().min(0),
    dataLossTransactions: z.number().int().min(0),
    occurredAt: z.string().max(40),
    error: z.string().max(500).nullable(),
  })
  .strict();
