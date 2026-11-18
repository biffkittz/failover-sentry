/**
 * Shared contracts of the Failover Sentry. This entry point is pure data and constants, safe to import from
 * workflow code (which Temporal bundles into a deterministic sandbox) and from the browser.
 *
 * Other entry points:
 * - `@failover-sentry/contracts/temporal`: signal, query and update definitions.
 * - `@failover-sentry/contracts/config`: configuration schema and helpers (zod).
 * - `@failover-sentry/contracts/signing`: HMAC request signing (WebCrypto).
 */
export * from './domain.js';
export type * from './messages.js';
export type * from './carried.js';
export * from './constants.js';
