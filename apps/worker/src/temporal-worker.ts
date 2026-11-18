/** Builds the worker's adapters and the Temporal worker itself (shared by main.ts and the tests). */
import { existsSync } from 'node:fs';
import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import type { RegionConfig } from '@failover-sentry/contracts';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';
import { createActivities, type ActivityDependencies } from './activities/index.js';
import { CloudflareEmailAlerter, LogAlerter } from './adapters/alerts.js';
import { AzureContainerAppsController, SimulatedComputeController } from './adapters/compute.js';
import { EdgeAdminClient } from './adapters/edge-admin.js';
import { RegionAdminClient } from './adapters/region-admin.js';
import type { WorkerConfig } from './config.js';

export function buildActivityDependencies(config: WorkerConfig): ActivityDependencies {
  const regionMap = new Map<string, RegionConfig>(config.sentry.regions.map((region) => [region.id, region]));
  const regions = new RegionAdminClient(regionMap, config.regionAdminSecret);
  const edge = new EdgeAdminClient(config.edgeAdminUrl, config.sentry.edgePublicUrl, config.edgeAdminSecret);
  const computeController =
    config.computeProvider === 'azure'
      ? new AzureContainerAppsController(azureCredential(config.azureClientId))
      : new SimulatedComputeController(regions);
  const alerter =
    config.alerts.provider === 'cloudflare-email'
      ? new CloudflareEmailAlerter({
          accountId: config.alerts.accountId,
          apiToken: config.alerts.apiToken,
          from: config.alerts.from,
          fromName: config.alerts.fromName,
          to: config.alerts.to,
        })
      : new LogAlerter();
  return {
    regions,
    edge,
    compute: computeController,
    alerter,
    minimumAlertSeverity: config.alerts.minimumSeverity,
  };
}

/** In Azure the worker authenticates as its user-assigned managed identity; locally, as whoever ran `az login`. */
function azureCredential(clientId: string | undefined): TokenCredential {
  return clientId ? new ManagedIdentityCredential({ clientId }) : new DefaultAzureCredential();
}

/** The prebundled workflow code (built into the image), or the sources (development and tests). */
export function workflowSource(
  bundlePath: string | undefined,
): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const defaultBundle = new URL('./workflow-bundle.js', import.meta.url).pathname;
  const path = bundlePath ?? (existsSync(defaultBundle) ? defaultBundle : undefined);
  if (path) {
    return { workflowBundle: { codePath: path } };
  }
  return { workflowsPath: new URL('./workflows/index.js', import.meta.url).pathname };
}

export async function createWorker(
  connection: NativeConnection,
  namespace: string,
  config: WorkerConfig,
  dependencies: ActivityDependencies = buildActivityDependencies(config),
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace,
    taskQueue: config.taskQueue,
    activities: createActivities(dependencies),
    ...workflowSource(config.workflowBundlePath),
    maxCachedWorkflows: 100,
    maxConcurrentActivityTaskExecutions: 20,
    maxConcurrentLocalActivityExecutions: 20,
    shutdownGraceTime: '15 seconds',
  });
}
