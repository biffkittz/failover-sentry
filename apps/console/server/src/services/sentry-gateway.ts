/**
 * The console's only door to the sentry: Temporal queries (state), Updates (operator actions) and the
 * replicationComplete signal. Behind an interface so the HTTP layer can be tested without Temporal.
 */
import {
  monitorWorkflowId,
  sentryWorkflowId,
  type AbortFailoverResult,
  type AlertRecord,
  type FailoverAccepted,
  type FailoverMode,
  type MonitorStateView,
  type RecoverRegionAccepted,
  type ReplicationCompleteSignalPayload,
  type ResolveStallResult,
  type SentryConfig,
  type SentryStateView,
  type SetAutoFailoverResult,
  type StallDecision,
} from '@failover-sentry/contracts';
import { computeConfigVersion } from '@failover-sentry/contracts/config';
import {
  abortFailoverUpdate,
  acknowledgeAlertUpdate,
  getMonitorStateQuery,
  getSentryStateQuery,
  recoverRegionUpdate,
  replicationCompleteSignal,
  resolveStallUpdate,
  setAutoFailoverUpdate,
  triggerFailoverUpdate,
} from '@failover-sentry/contracts/temporal';
import {
  isGrpcDeadlineError,
  QueryRejectedError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  type Client,
} from '@temporalio/client';
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
} from '@temporalio/common';

/** An error the HTTP layer turns into a status code and a message for the operator. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface SentryGateway {
  readonly workflowId: string;
  getState(): Promise<SentryStateView | null>;
  getMonitor(regionId: string): Promise<MonitorStateView>;
  ensureRunning(): Promise<void>;
  triggerFailover(input: {
    targetRegionId?: string | undefined;
    mode: FailoverMode;
    reason: string;
    requestedBy: string;
  }): Promise<FailoverAccepted>;
  abortFailover(input: { reason: string; requestedBy: string }): Promise<AbortFailoverResult>;
  resolveStall(input: { decision: StallDecision; requestedBy: string }): Promise<ResolveStallResult>;
  setAutoFailover(input: { enabled: boolean; requestedBy: string }): Promise<SetAutoFailoverResult>;
  acknowledgeAlert(input: { alertId: string; requestedBy: string }): Promise<AlertRecord>;
  recoverRegion(input: { regionId: string; requestedBy: string }): Promise<RecoverRegionAccepted>;
  signalReplicationComplete(payload: ReplicationCompleteSignalPayload): Promise<void>;
  ping(): Promise<void>;
}

const RPC_DEADLINE_MS = 15_000;

export class TemporalSentryGateway implements SentryGateway {
  readonly workflowId: string;

  constructor(
    private readonly client: Client,
    private readonly config: SentryConfig,
    private readonly taskQueue: string,
  ) {
    this.workflowId = sentryWorkflowId(config.serviceName);
  }

  private handle() {
    return this.client.workflow.getHandle(this.workflowId);
  }

  async getState(): Promise<SentryStateView | null> {
    try {
      return await this.withDeadline(() => this.handle().query(getSentryStateQuery));
    } catch (error) {
      // Rejected: the workflow is closed (cancelled, terminated, failed); the client rejects queries to closed ones.
      if (error instanceof WorkflowNotFoundError || error instanceof QueryRejectedError) {
        return null;
      }
      throw translate(error);
    }
  }

  async getMonitor(regionId: string): Promise<MonitorStateView> {
    if (!this.config.regions.some((region) => region.id === regionId)) {
      throw new GatewayError(404, 'unknown_region', `Unknown region "${regionId}"`);
    }
    try {
      return await this.withDeadline(() =>
        this.client.workflow
          .getHandle(monitorWorkflowId(this.workflowId, regionId))
          .query(getMonitorStateQuery),
      );
    } catch (error) {
      if (error instanceof WorkflowNotFoundError || error instanceof QueryRejectedError) {
        throw new GatewayError(
          404,
          'monitor_not_running',
          `The monitor of ${regionId} isn't running right now (a failover may be in progress)`,
        );
      }
      throw translate(error);
    }
  }

  async ensureRunning(): Promise<void> {
    const configVersion = await computeConfigVersion(this.config);
    try {
      await this.withDeadline(() =>
        this.client.workflow.start('failoverSentryWorkflow', {
          workflowId: this.workflowId,
          taskQueue: this.taskQueue,
          args: [{ config: this.config, configVersion }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }),
      );
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        return;
      }
      throw translate(error);
    }
  }

  triggerFailover(input: Parameters<SentryGateway['triggerFailover']>[0]): Promise<FailoverAccepted> {
    return this.update(() => this.handle().executeUpdate(triggerFailoverUpdate, { args: [input] }));
  }

  abortFailover(input: { reason: string; requestedBy: string }): Promise<AbortFailoverResult> {
    return this.update(() => this.handle().executeUpdate(abortFailoverUpdate, { args: [input] }));
  }

  resolveStall(input: { decision: StallDecision; requestedBy: string }): Promise<ResolveStallResult> {
    return this.update(() => this.handle().executeUpdate(resolveStallUpdate, { args: [input] }));
  }

  setAutoFailover(input: { enabled: boolean; requestedBy: string }): Promise<SetAutoFailoverResult> {
    return this.update(() => this.handle().executeUpdate(setAutoFailoverUpdate, { args: [input] }));
  }

  acknowledgeAlert(input: { alertId: string; requestedBy: string }): Promise<AlertRecord> {
    return this.update(() => this.handle().executeUpdate(acknowledgeAlertUpdate, { args: [input] }));
  }

  recoverRegion(input: { regionId: string; requestedBy: string }): Promise<RecoverRegionAccepted> {
    return this.update(() => this.handle().executeUpdate(recoverRegionUpdate, { args: [input] }));
  }

  async signalReplicationComplete(payload: ReplicationCompleteSignalPayload): Promise<void> {
    try {
      await this.withDeadline(() => this.handle().signal(replicationCompleteSignal, payload));
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        throw new GatewayError(404, 'sentry_not_running', 'The sentry is not running');
      }
      throw translate(error);
    }
  }

  async ping(): Promise<void> {
    await this.withDeadline(() => this.client.workflowService.getSystemInfo({}));
  }

  private async update<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.withDeadline(work);
    } catch (error) {
      throw translate(error);
    }
  }

  private withDeadline<T>(work: () => Promise<T>): Promise<T> {
    return this.client.withDeadline(Date.now() + RPC_DEADLINE_MS, work);
  }
}

/** Maps Temporal errors to what an operator should see. */
export function translate(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }
  if (error instanceof WorkflowUpdateFailedError) {
    // An Update validator (or handler) said no: the cause carries the sentry's reason.
    const cause = error.cause as Error | undefined;
    return new GatewayError(409, 'rejected', cause?.message ?? error.message);
  }
  if (error instanceof WorkflowNotFoundError) {
    return new GatewayError(404, 'sentry_not_running', 'The sentry is not running');
  }
  if (error instanceof WorkflowUpdateRPCTimeoutOrCancelledError || isGrpcDeadlineError(error)) {
    return new GatewayError(504, 'timeout', "The sentry didn't answer in time. Is the worker running?");
  }
  return new GatewayError(
    502,
    'temporal_error',
    `Temporal error: ${(error as Error)?.message ?? String(error)}`,
  );
}
