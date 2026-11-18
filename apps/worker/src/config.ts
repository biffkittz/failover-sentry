/**
 * Worker configuration from the environment. The Temporal connection itself (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE,
 * TEMPORAL_API_KEY, TEMPORAL_TLS, ...) is read by @temporalio/envconfig, Temporal's standard loader.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_TASK_QUEUE, type AlertSeverity, type SentryConfig } from '@failover-sentry/contracts';
import { parseSentryConfig } from '@failover-sentry/contracts/config';
import { z } from 'zod';

const secret = z.string().min(16, 'secrets need at least 16 characters');
const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z
  .object({
    SENTRY_CONFIG_JSON: z.string().optional(),
    SENTRY_CONFIG_FILE: z.string().optional(),
    TASK_QUEUE: z.string().min(1).default(DEFAULT_TASK_QUEUE),
    REGION_ADMIN_SECRET: secret,
    EDGE_ADMIN_SECRET: secret,
    /** Where routing writes go; defaults to the protected service's public URL. */
    EDGE_ADMIN_URL: z.url().optional(),
    COMPUTE_PROVIDER: z.enum(['azure', 'simulated']).optional(),
    AZURE_CLIENT_ID: z.string().optional(),
    ALERT_PROVIDER: z.enum(['cloudflare-email', 'log']).default('log'),
    ALERT_MIN_SEVERITY: z.enum(['info', 'warning', 'critical']).default('warning'),
    CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
    CLOUDFLARE_EMAIL_API_TOKEN: z.string().optional(),
    ALERT_EMAIL_FROM: z.email().optional(),
    ALERT_EMAIL_FROM_NAME: z.string().default('Failover Sentry'),
    ALERT_EMAIL_TO: z.string().default(''),
    HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8081),
    BOOTSTRAP_SENTRY: flag.default(true),
    WORKFLOW_BUNDLE_PATH: z.string().optional(),
    LOG_LEVEL: z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  })
  .superRefine((env, context) => {
    if (!env.SENTRY_CONFIG_JSON && !env.SENTRY_CONFIG_FILE) {
      context.addIssue({ code: 'custom', message: 'SENTRY_CONFIG_JSON or SENTRY_CONFIG_FILE is required' });
    }
    if (env.ALERT_PROVIDER === 'cloudflare-email') {
      for (const key of [
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_EMAIL_API_TOKEN',
        'ALERT_EMAIL_FROM',
      ] as const) {
        if (!env[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required for cloudflare-email alerts`,
          });
        }
      }
      if (!env.ALERT_EMAIL_TO.trim()) {
        context.addIssue({
          code: 'custom',
          path: ['ALERT_EMAIL_TO'],
          message: 'ALERT_EMAIL_TO needs at least one address',
        });
      }
    }
  });

export interface WorkerConfig {
  sentry: SentryConfig;
  taskQueue: string;
  regionAdminSecret: string;
  edgeAdminSecret: string;
  edgeAdminUrl: string;
  computeProvider: 'azure' | 'simulated';
  azureClientId: string | undefined;
  alerts:
    | { provider: 'log'; minimumSeverity: AlertSeverity }
    | {
        provider: 'cloudflare-email';
        minimumSeverity: AlertSeverity;
        accountId: string;
        apiToken: string;
        from: string;
        fromName: string;
        to: string[];
      };
  healthPort: number;
  bootstrapSentry: boolean;
  workflowBundlePath: string | undefined;
  logLevel: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(result.error)}`);
  }
  const values = result.data;
  const sentry = parseSentryConfig(
    values.SENTRY_CONFIG_JSON ?? readFileSync(values.SENTRY_CONFIG_FILE ?? '', 'utf8'),
  );
  const computeProvider =
    values.COMPUTE_PROVIDER ??
    (sentry.regions.some((region) => region.provider === 'azure') ? 'azure' : 'simulated');
  const minimumSeverity = values.ALERT_MIN_SEVERITY;
  return {
    sentry,
    taskQueue: values.TASK_QUEUE,
    regionAdminSecret: values.REGION_ADMIN_SECRET,
    edgeAdminSecret: values.EDGE_ADMIN_SECRET,
    edgeAdminUrl: (values.EDGE_ADMIN_URL ?? sentry.edgePublicUrl).replace(/\/+$/, ''),
    computeProvider,
    azureClientId: values.AZURE_CLIENT_ID,
    alerts:
      values.ALERT_PROVIDER === 'cloudflare-email'
        ? {
            provider: 'cloudflare-email',
            minimumSeverity,
            accountId: values.CLOUDFLARE_ACCOUNT_ID ?? '',
            apiToken: values.CLOUDFLARE_EMAIL_API_TOKEN ?? '',
            from: values.ALERT_EMAIL_FROM ?? '',
            fromName: values.ALERT_EMAIL_FROM_NAME,
            to: values.ALERT_EMAIL_TO.split(',')
              .map((address) => address.trim())
              .filter(Boolean),
          }
        : { provider: 'log', minimumSeverity },
    healthPort: values.HEALTH_PORT,
    bootstrapSentry: values.BOOTSTRAP_SENTRY,
    workflowBundlePath: values.WORKFLOW_BUNDLE_PATH,
    logLevel: values.LOG_LEVEL,
  };
}
