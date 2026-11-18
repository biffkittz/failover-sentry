/** Helpers for the worker's outbound HTTP calls. */

/** A response the activity can't recover from by retrying (bad input, missing permission). */
export class NonRetryableHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'NonRetryableHttpError';
  }
}

/** A response worth retrying (5xx, 408, 429) or a transport failure. */
export class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'RetryableHttpError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Cloudflare answers challenged requests (Bot Fight Mode, WAF) with 403 and `cf-mitigated: challenge`. A server can't
 * solve a challenge, so say so plainly instead of reporting a mysterious 403.
 */
export function describeHttpFailure(response: Response, body: string, context: string): string {
  if (response.headers.get('cf-mitigated') === 'challenge') {
    return `${context}: Cloudflare challenged the request (Bot Fight Mode or a WAF rule); exempt this host or path`;
  }
  const snippet = body.replace(/\s+/g, ' ').slice(0, 200);
  return `${context}: HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`;
}

export async function readJson<T>(response: Response): Promise<{ json: T | null; text: string }> {
  const text = await response.text();
  if (!text) {
    return { json: null, text };
  }
  try {
    return { json: JSON.parse(text) as T, text };
  } catch {
    return { json: null, text };
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'timed out';
    }
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}
