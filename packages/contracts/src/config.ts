/**
 * The sentry's configuration schema. Terraform renders the configuration as JSON into the SENTRY_CONFIG_JSON
 * environment variable of the worker and the console; both validate it with this schema at startup, so a typo fails
 * fast instead of half-configuring a failover.
 */
import { z } from 'zod';
import type { SentryConfig } from './domain.js';

const regionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'region ids are 1-31 lower-case letters, digits or hyphens');

const httpUrlSchema = z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ''));

export const regionConfigSchema = z.object({
  id: regionIdSchema,
  displayName: z.string().trim().min(1).max(60),
  provider: z.enum(['azure', 'local']),
  baseUrl: httpUrlSchema,
  azureResourceId: z
    .string()
    .regex(
      /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.App\/containerApps\/[^/]+$/i,
      'azureResourceId must be the resource ID of a Container App',
    )
    .optional(),
});

export const healthPolicySchema = z.object({
  probeIntervalSeconds: z.number().int().min(1).max(3600).default(30),
  probeTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  degradedLatencyMs: z.number().int().min(10).max(60_000).default(1_500),
  windowSize: z.number().int().min(3).max(50).default(10),
  reportEveryProbes: z.number().int().min(1).max(1_000).default(10),
});

export const failoverPolicySchema = z.object({
  autoFailoverEnabled: z.boolean().default(true),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(600),
  replicationTimeoutSeconds: z.number().int().min(1).max(3_600).default(120),
  stallEscalationSeconds: z.number().int().min(1).max(86_400).default(600),
  edgePropagationTimeoutSeconds: z.number().int().min(1).max(3_600).default(180),
  stabilizationSeconds: z.number().int().min(0).max(3_600).default(90),
  stabilizationProbeIntervalSeconds: z.number().int().min(1).max(600).default(10),
  stabilizationFailureThreshold: z.number().int().min(1).max(20).default(3),
  fenceComputeOnForcedFailover: z.boolean().default(true),
});

export const sentryConfigSchema = z
  .object({
    serviceName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'serviceName is 1-41 lower-case letters, digits or hyphens'),
    edgePublicUrl: httpUrlSchema,
    consoleUrl: httpUrlSchema,
    regions: z.array(regionConfigSchema).min(2, 'a failover needs at least two regions').max(6),
    initialPrimaryRegionId: regionIdSchema,
    health: healthPolicySchema.prefault({}),
    failover: failoverPolicySchema.prefault({}),
  })
  .superRefine((config, context) => {
    const ids = config.regions.map((region) => region.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['regions'],
        message: `duplicate region ids: ${[...new Set(duplicates)].join(', ')}`,
      });
    }
    if (!ids.includes(config.initialPrimaryRegionId)) {
      context.addIssue({
        code: 'custom',
        path: ['initialPrimaryRegionId'],
        message: `initialPrimaryRegionId "${config.initialPrimaryRegionId}" is not one of the regions (${ids.join(', ')})`,
      });
    }
    config.regions.forEach((region, index) => {
      if (region.provider === 'azure' && !region.azureResourceId) {
        context.addIssue({
          code: 'custom',
          path: ['regions', index, 'azureResourceId'],
          message: `region "${region.id}" runs on Azure, so it needs azureResourceId (its Container App)`,
        });
      }
    });
  });

/** Validates configuration given as a JSON string or an already-parsed object. Throws a readable error. */
export function parseSentryConfig(input: unknown): SentryConfig {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      throw new Error(`Sentry configuration is not valid JSON: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  const result = sentryConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid sentry configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** JSON with object keys sorted, so equal configurations always serialise identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

/** A short, stable fingerprint of a configuration (first 16 hex characters of its SHA-256). */
export async function computeConfigVersion(config: SentryConfig): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableStringify(config)),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
