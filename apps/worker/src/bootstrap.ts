/**
 * Makes sure the sentry workflow runs, with the worker's configuration.
 *
 * The sentry is a singleton per service: starting it is idempotent (an existing execution is reused). When the
 * running sentry has an older configuration, it gets the new one through the `reconfigure` Update, which it applies
 * between normal-operations cycles (never during a failover).
 */
import { sentryWorkflowId, type SentryConfig } from '@failover-sentry/contracts';
import { computeConfigVersion } from '@failover-sentry/contracts/config';
import { getSentryStateQuery, reconfigureUpdate } from '@failover-sentry/contracts/temporal';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/common';

export interface EnsureSentryResult {
  workflowId: string;
  configVersion: string;
  reconfigured: boolean;
}

export async function ensureSentry(
  client: Client,
  config: SentryConfig,
  taskQueue: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<EnsureSentryResult> {
  const workflowId = sentryWorkflowId(config.serviceName);
  const configVersion = await computeConfigVersion(config);
  await client.workflow.start('failoverSentryWorkflow', {
    workflowId,
    taskQueue,
    args: [{ config, configVersion }],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
  });

  // A brand-new execution answers queries only after its first workflow task; retry briefly.
  const handle = client.workflow.getHandle(workflowId);
  let runningVersion: string | null = null;
  for (let attempt = 1; runningVersion === null; attempt += 1) {
    try {
      runningVersion = (await handle.query(getSentryStateQuery)).configVersion;
    } catch (error) {
      if (attempt >= 10) {
        throw error;
      }
      await sleep(1_000 * attempt);
    }
  }

  if (runningVersion === configVersion) {
    return { workflowId, configVersion, reconfigured: false };
  }
  // Waits until the sentry is between normal-operations cycles (never mid-failover).
  await handle.executeUpdate(reconfigureUpdate, { args: [{ config, configVersion }] });
  return { workflowId, configVersion, reconfigured: true };
}
