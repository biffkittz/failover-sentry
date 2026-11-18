/**
 * Region compute control: the sentry stops a misbehaving old primary to fence it (STONITH: "shoot the other node in
 * the head"), starts it again when an operator recovers the region, and tags regions with their DR role.
 *
 * - Azure: real Azure Resource Manager calls on the region's Container App (stop/start actions, tags).
 * - Simulated: the regional workload's signed power switch (local runs and tests).
 */
import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import { ResourceManagementClient } from '@azure/arm-resources';
import type { TokenCredential } from '@azure/identity';
import type { ComputeState, RegionConfig } from '@failover-sentry/contracts';
import { NonRetryableHttpError } from './http.js';
import type { RegionAdminClient } from './region-admin.js';

export interface ComputeController {
  readonly kind: 'azure' | 'simulated';
  stop(region: RegionConfig): Promise<string>;
  start(region: RegionConfig): Promise<string>;
  state(region: RegionConfig): Promise<ComputeState>;
  /** Merges tags into the region's compute resource. Returns false when the provider has no tags. */
  tag(region: RegionConfig, tags: Record<string, string>): Promise<boolean>;
}

interface ParsedResourceId {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

export function parseContainerAppId(resourceId: string): ParsedResourceId {
  const match =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/containerApps\/([^/]+)$/i.exec(
      resourceId,
    );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new NonRetryableHttpError(`"${resourceId}" is not a Container App resource ID`, 400);
  }
  return { subscriptionId: match[1], resourceGroup: match[2], name: match[3] };
}

export class AzureContainerAppsController implements ComputeController {
  readonly kind = 'azure' as const;
  private readonly appClients = new Map<string, ContainerAppsAPIClient>();
  private readonly resourceClients = new Map<string, ResourceManagementClient>();

  constructor(private readonly credential: TokenCredential) {}

  async stop(region: RegionConfig): Promise<string> {
    const { subscriptionId, resourceGroup, name } = this.resource(region);
    // The poller resolves when Azure Resource Manager reports the long-running stop operation finished.
    await this.apps(subscriptionId).containerApps.stop(resourceGroup, name);
    return `Container App ${name} stopped`;
  }

  async start(region: RegionConfig): Promise<string> {
    const { subscriptionId, resourceGroup, name } = this.resource(region);
    await this.apps(subscriptionId).containerApps.start(resourceGroup, name);
    return `Container App ${name} started`;
  }

  async state(region: RegionConfig): Promise<ComputeState> {
    const { subscriptionId, resourceGroup, name } = this.resource(region);
    const app = await this.apps(subscriptionId).containerApps.get(resourceGroup, name);
    const status = String((app as { runningStatus?: unknown }).runningStatus ?? '').toLowerCase();
    if (status === 'stopped' || status === 'suspended') {
      return 'stopped';
    }
    if (status === 'running' || status === 'ready') {
      return 'running';
    }
    return status === 'progressing' ? 'starting' : 'unknown';
  }

  async tag(region: RegionConfig, tags: Record<string, string>): Promise<boolean> {
    const resourceId = region.azureResourceId;
    if (!resourceId) {
      return false;
    }
    const { subscriptionId } = parseContainerAppId(resourceId);
    // Merge, so the tags Terraform manages stay as they are (Terraform ignores these keys, see infra).
    await this.resources(subscriptionId).tagsOperations.updateAtScope(resourceId, {
      operation: 'Merge',
      properties: { tags },
    });
    return true;
  }

  private resource(region: RegionConfig): ParsedResourceId {
    if (!region.azureResourceId) {
      throw new NonRetryableHttpError(`Region ${region.id} has no azureResourceId to act on`, 400);
    }
    return parseContainerAppId(region.azureResourceId);
  }

  private apps(subscriptionId: string): ContainerAppsAPIClient {
    let client = this.appClients.get(subscriptionId);
    if (!client) {
      client = new ContainerAppsAPIClient(this.credential, subscriptionId);
      this.appClients.set(subscriptionId, client);
    }
    return client;
  }

  private resources(subscriptionId: string): ResourceManagementClient {
    let client = this.resourceClients.get(subscriptionId);
    if (!client) {
      client = new ResourceManagementClient(this.credential, subscriptionId);
      this.resourceClients.set(subscriptionId, client);
    }
    return client;
  }
}

export class SimulatedComputeController implements ComputeController {
  readonly kind = 'simulated' as const;

  constructor(private readonly regions: RegionAdminClient) {}

  async stop(region: RegionConfig): Promise<string> {
    await this.regions.setPower(region.id, 'off');
    return `${region.id} powered off (simulated)`;
  }

  async start(region: RegionConfig): Promise<string> {
    await this.regions.setPower(region.id, 'on');
    return `${region.id} powered on (simulated fresh boot)`;
  }

  async state(): Promise<ComputeState> {
    return 'unknown';
  }

  async tag(): Promise<boolean> {
    return false;
  }
}
