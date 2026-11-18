/**
 * Alert delivery. The sentry records every alert in its state (the console shows them); these adapters also send
 * them somewhere a human will notice.
 *
 * Cloudflare Email Service: `POST accounts/{account}/email/sending/send` with an account token that holds the Email
 * Sending permission alone (Terraform creates it). Sending to the account's verified destination addresses works on
 * every plan.
 */
import type { AlertRecord, AlertSeverity } from '@failover-sentry/contracts';
import {
  describeHttpFailure,
  errorMessage,
  isRetryableStatus,
  NonRetryableHttpError,
  readJson,
  RetryableHttpError,
} from './http.js';

export interface AlertContext {
  serviceName: string;
  consoleUrl: string;
}

export interface Alerter {
  readonly kind: string;
  send(alert: AlertRecord, context: AlertContext): Promise<string>;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function meetsThreshold(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

export function renderAlertEmail(
  alert: AlertRecord,
  context: AlertContext,
): { subject: string; text: string } {
  const link = alert.failoverId
    ? `${context.consoleUrl}/failovers/${encodeURIComponent(alert.failoverId)}`
    : `${context.consoleUrl}/`;
  const subject = `[Failover Sentry · ${context.serviceName}] ${alert.severity.toUpperCase()}: ${alert.title}`;
  const lines = [
    alert.message,
    '',
    `Severity: ${alert.severity}`,
    `Kind: ${alert.kind}`,
    `When: ${alert.at}`,
    ...(alert.failoverId ? [`Failover: ${alert.failoverId}`] : []),
    ...(alert.regionId ? [`Region: ${alert.regionId}`] : []),
    '',
    `Open the console: ${link}`,
    '',
    '— the Failover Sentry (automated message)',
  ];
  return { subject: subject.slice(0, 200), text: lines.join('\n') };
}

export class LogAlerter implements Alerter {
  readonly kind = 'log';

  async send(alert: AlertRecord): Promise<string> {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'ALERT',
        kind: alert.kind,
        severity: alert.severity,
        title: alert.title,
      }),
    );
    return 'logged (no alert channel configured)';
  }
}

export interface CloudflareEmailOptions {
  accountId: string;
  apiToken: string;
  from: string;
  fromName: string;
  to: readonly string[];
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareEmailAlerter implements Alerter {
  readonly kind = 'cloudflare-email';

  constructor(private readonly options: CloudflareEmailOptions) {}

  async send(alert: AlertRecord, context: AlertContext): Promise<string> {
    const { subject, text } = renderAlertEmail(alert, context);
    const endpoint = this.options.endpoint ?? 'https://api.cloudflare.com/client/v4';
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        `${endpoint}/accounts/${encodeURIComponent(this.options.accountId)}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            from: { address: this.options.from, name: this.options.fromName },
            to: this.options.to,
            subject,
            text,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      throw new RetryableHttpError(`Cloudflare's API couldn't be reached: ${errorMessage(error)}`, null);
    }
    const { json, text: body } = await readJson<{ success?: boolean; errors?: Array<{ code?: number }> }>(
      response,
    );
    if (!response.ok || json?.success !== true) {
      // Error bodies can quote the request; keep only the status and error codes.
      const codes = (json?.errors ?? [])
        .map((error) => error.code)
        .filter((code) => typeof code === 'number');
      const message = describeHttpFailure(
        response,
        codes.length ? `codes ${codes.join(',')}` : '',
        'alert email',
      );
      void body;
      throw isRetryableStatus(response.status)
        ? new RetryableHttpError(message, response.status)
        : new NonRetryableHttpError(message, response.status);
    }
    return `emailed ${this.options.to.length} recipient(s)`;
  }
}
