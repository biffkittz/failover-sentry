/**
 * Console configuration from the environment. Secrets (session key, GitHub client secret, webhook and admin HMAC
 * secrets) come from Key Vault in Azure, through Container App secrets; locally, from your shell or compose.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_TASK_QUEUE, type SentryConfig } from '@failover-sentry/contracts';
import { parseSentryConfig } from '@failover-sentry/contracts/config';
import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    /** Public origin of the console, e.g. https://sentry.biffkittz.com (OAuth callback, CSRF origin check). */
    PUBLIC_URL: z.url(),
    SENTRY_CONFIG_JSON: z.string().optional(),
    SENTRY_CONFIG_FILE: z.string().optional(),
    TASK_QUEUE: z.string().default(DEFAULT_TASK_QUEUE),
    /** 32+ bytes of entropy (base64 or hex), from which the session encryption key is derived. */
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_HOURS: z.coerce.number().min(1).max(168).default(8),
    AUTH_MODE: z.enum(['github', 'dev']).default('github'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    /** GitHub logins allowed to sign in (case-insensitive). Empty means nobody: the console fails closed. */
    GITHUB_ALLOWED_USERS: list,
    DEV_USER: z.string().default('local-operator'),
    /** HMAC secrets accepted on the replication webhook (comma-separated during a rotation). */
    WEBHOOK_SIGNING_SECRET: list.refine(
      (secrets) => secrets.length > 0 && secrets.every((secret) => secret.length >= 16),
      {
        message: 'needs at least one secret of 16 or more characters',
      },
    ),
    /** HMAC secret for the regional workloads' admin API (chaos controls). */
    REGION_ADMIN_SECRET: z.string().min(16),
    WEB_DIST_DIR: z.string().optional(),
    STATE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_500),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, context) => {
    if (!env.SENTRY_CONFIG_JSON && !env.SENTRY_CONFIG_FILE) {
      context.addIssue({ code: 'custom', message: 'SENTRY_CONFIG_JSON or SENTRY_CONFIG_FILE is required' });
    }
    if (env.AUTH_MODE === 'github' && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)) {
      context.addIssue({
        code: 'custom',
        message: 'AUTH_MODE=github needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET',
      });
    }
    if (env.AUTH_MODE === 'dev' && env.NODE_ENV === 'production') {
      // Defence in depth: a misconfigured production deployment must never accept the dev sign-in.
      context.addIssue({ code: 'custom', message: 'AUTH_MODE=dev is refused when NODE_ENV=production' });
    }
  });

export interface ConsoleConfig {
  production: boolean;
  port: number;
  host: string;
  publicUrl: URL;
  sentry: SentryConfig;
  taskQueue: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  auth:
    | { mode: 'github'; clientId: string; clientSecret: string; allowedUsers: string[] }
    | { mode: 'dev'; devUser: string };
  webhookSecrets: string[];
  regionAdminSecret: string;
  webDistDir: string;
  statePollIntervalMs: number;
  logLevel: string;
}

export function loadConsoleConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid console configuration:\n${z.prettifyError(result.error)}`);
  }
  const values = result.data;
  return {
    production: values.NODE_ENV === 'production',
    port: values.PORT,
    host: values.HOST,
    publicUrl: new URL(values.PUBLIC_URL),
    sentry: parseSentryConfig(
      values.SENTRY_CONFIG_JSON ?? readFileSync(values.SENTRY_CONFIG_FILE ?? '', 'utf8'),
    ),
    taskQueue: values.TASK_QUEUE,
    sessionSecret: values.SESSION_SECRET,
    sessionTtlSeconds: Math.round(values.SESSION_TTL_HOURS * 3600),
    auth:
      values.AUTH_MODE === 'github'
        ? {
            mode: 'github',
            clientId: values.GITHUB_CLIENT_ID ?? '',
            clientSecret: values.GITHUB_CLIENT_SECRET ?? '',
            allowedUsers: values.GITHUB_ALLOWED_USERS.map((login) => login.toLowerCase()),
          }
        : { mode: 'dev', devUser: values.DEV_USER },
    webhookSecrets: values.WEBHOOK_SIGNING_SECRET,
    regionAdminSecret: values.REGION_ADMIN_SECRET,
    webDistDir: values.WEB_DIST_DIR ?? new URL('../../web/dist', import.meta.url).pathname,
    statePollIntervalMs: values.STATE_POLL_INTERVAL_MS,
    logLevel: values.LOG_LEVEL,
  };
}
