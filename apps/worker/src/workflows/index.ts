/**
 * Workflow entry point: Temporal bundles this module (and only what it imports) into the deterministic workflow
 * sandbox. Activities are never imported here, only reached through proxies.
 */
import type { SentryWorkflowInput } from '@failover-sentry/contracts';
import { Sentry } from './sentry/sentry.js';

export { monitorRegionChild } from './monitor-region.js';

/** The singleton orchestrator for one protected service. Runs until terminated, continuing as new as it goes. */
export async function failoverSentryWorkflow(input: SentryWorkflowInput): Promise<void> {
  await new Sentry(input).run();
}
