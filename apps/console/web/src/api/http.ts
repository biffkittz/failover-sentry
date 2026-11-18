/**
 * The app's only HTTP client. Same-origin requests carry the HTTP-only session cookie automatically; state-changing
 * requests add the CSRF header the server requires. Errors become `ApiError`, with the server's message for people.
 */
import { CSRF_HEADER } from '@failover-sentry/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  /** Cancels the request (stale data, unmounted component). */
  signal?: AbortSignal;
}

export async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers[CSRF_HEADER] = '1';
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, 'network', 'The console server is unreachable. Check your connection.');
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  const body = text ? (safeJson(text) as Record<string, unknown> | null) : null;
  if (!response.ok) {
    const message =
      typeof body?.message === 'string'
        ? body.message
        : `The server answered ${response.status} ${response.statusText}`;
    throw new ApiError(response.status, typeof body?.error === 'string' ? body.error : 'error', message);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const http = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
};
