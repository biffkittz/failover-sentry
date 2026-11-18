import { z } from 'zod';
import type { Peer } from './peer-client.js';

const secretList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((secret) => secret.trim())
      .filter(Boolean),
  )
  .refine((secrets) => secrets.length > 0 && secrets.every((secret) => secret.length >= 16), {
    message: 'needs at least one secret of 16 or more characters (comma-separated during a rotation)',
  });

/** `id=url,id=url`: the other regions' base URLs. */
const peersSchema = z
  .string()
  .default('')
  .transform((value, context): Peer[] =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=');
        const regionId = entry.slice(0, separator).trim();
        const baseUrl = entry
          .slice(separator + 1)
          .trim()
          .replace(/\/+$/, '');
        if (separator <= 0 || !URL.canParse(baseUrl)) {
          context.addIssue({ code: 'custom', message: `PEERS entry "${entry}" is not id=url` });
        }
        return { regionId, baseUrl };
      }),
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  REGION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  REGION_NAME: z.string().min(1).optional(),
  APP_VERSION: z.string().default('dev'),
  PEERS: peersSchema,
  ADMIN_SHARED_SECRET: secretList,
  WEBHOOK_URL: z.url().optional(),
  WEBHOOK_SECRET: z.string().min(16).optional(),
  PLANNED_SWITCH_DELAY_SECONDS: z.coerce.number().min(0).max(600).default(12),
  FORCED_SWITCH_DELAY_SECONDS: z.coerce.number().min(0).max(600).default(5),
  PLANNED_PEER_TIMEOUT_SECONDS: z.coerce.number().min(1).max(3_600).default(45),
  TICK_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  WRITES_PER_SECOND: z.coerce.number().min(0).max(10_000).default(4),
  REPLICATION_BATCH: z.coerce.number().int().min(1).max(1_000_000).default(40),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type RegionalAppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RegionalAppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  if (result.data.WEBHOOK_URL && !result.data.WEBHOOK_SECRET) {
    throw new Error('Invalid configuration: WEBHOOK_URL needs WEBHOOK_SECRET to sign the webhook');
  }
  return result.data;
}
