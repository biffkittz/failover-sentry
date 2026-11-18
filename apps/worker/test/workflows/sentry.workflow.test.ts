/**
 * End-to-end tests of the sentry's workflows against a real Temporal server (the Temporal CLI's development server,
 * from TEMPORAL_CLI_PATH or PATH; the SDK never downloads one) with fake activities.
 *
 * Real time, short policies: each scenario takes a few seconds.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  sentryWorkflowId,
  type FailoverRun,
  type SentryConfig,
  type SentryStateView,
} from '@failover-sentry/contracts';
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
import { WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Runtime, DefaultLogger, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeWorld } from '../helpers/fake-world.js';
import { failoverPolicy, healthPolicy, sentryConfig } from '../helpers/fixtures.js';

let env: TestWorkflowEnvironment;
let workflowCode: string;

function temporalCli(): string {
  if (process.env.TEMPORAL_CLI_PATH) {
    return process.env.TEMPORAL_CLI_PATH;
  }
  try {
    return execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('The Temporal CLI is required for workflow tests: install it or set TEMPORAL_CLI_PATH');
  }
}

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  env = await TestWorkflowEnvironment.createLocal({
    server: { executable: { type: 'existing-path', path: temporalCli() }, startupTimeout: '30s' },
  });
  ({ code: workflowCode } = await bundleWorkflowCode({
    workflowsPath: new URL('../../src/workflows/index.ts', import.meta.url).pathname,
    logger: new DefaultLogger('WARN'),
  }));
});

afterAll(async () => {
  await env?.teardown();
});

interface SentryHarness {
  handle: WorkflowHandle;
  world: FakeWorld;
  state(): Promise<SentryStateView>;
  waitFor(
    description: string,
    predicate: (state: SentryStateView) => boolean,
    timeoutMs?: number,
  ): Promise<SentryStateView>;
  lastFailover(state: SentryStateView): FailoverRun | undefined;
}

async function withSentry(
  world: FakeWorld,
  overrides: Partial<SentryConfig>,
  body: (harness: SentryHarness) => Promise<void>,
  environment: TestWorkflowEnvironment = env,
): Promise<void> {
  const taskQueue = `test-${randomUUID()}`;
  const config = sentryConfig({ serviceName: `svc-${randomUUID().slice(0, 8)}`, ...overrides });
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace ?? 'default',
    taskQueue,
    workflowBundle: { code: workflowCode },
    activities: world.activities(),
  });
  await worker.runUntil(async () => {
    const handle = await environment.client.workflow.start('failoverSentryWorkflow', {
      taskQueue,
      workflowId: sentryWorkflowId(config.serviceName),
      args: [{ config, configVersion: 'test' }],
    });
    world.webhookSink = async (event) => {
      await handle.signal(replicationCompleteSignal, { ...event, receivedAt: new Date().toISOString() });
    };
    const state = () => handle.query(getSentryStateQuery);
    const waitFor: SentryHarness['waitFor'] = async (description, predicate, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      let last: SentryStateView | undefined;
      while (Date.now() < deadline) {
        try {
          last = await state();
          if (predicate(last)) {
            return last;
          }
        } catch {
          // The first workflow task may not have completed yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `Timed out waiting for: ${description}\nLast state: ${JSON.stringify(
          last && {
            mode: last.mode,
            epoch: last.epoch,
            active: last.activeRegionId,
            edge: last.edge,
            current: last.currentFailover?.phase,
            timeline: last.timeline.slice(0, 8).map((event) => event.message),
          },
          null,
          2,
        )}`,
      );
    };
    const lastFailover = (current: SentryStateView) => current.recentFailovers[0];
    try {
      await body({ handle, world, state, waitFor, lastFailover });
    } finally {
      await handle.terminate('test finished').catch(() => undefined);
    }
  });
}

/** Update validators reject with WorkflowUpdateFailedError; the validator's message is its cause. */
async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure as Error & { cause?: Error },
  );
  expect(error, 'the Update should have been rejected').not.toBeNull();
  expect(error?.cause?.message ?? error?.message).toMatch(pattern);
}

const established = (state: SentryStateView) =>
  state.epoch >= 1 && state.edge?.mode === 'active' && state.edge.activeRegionId === 'east';

describe('failoverSentryWorkflow', () => {
  it('establishes a primary and edge routing on first start (reconciliation)', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ waitFor }) => {
      const state = await waitFor('east established', established);
      expect(world.region('east').db).toMatchObject({ role: 'primary', epoch: state.epoch });
      expect(state.regions.map((region) => [region.config.id, region.role])).toEqual([
        ['east', 'PRIMARY'],
        ['west', 'STANDBY'],
      ]);
    });
  });

  it('fails over automatically when the primary goes down, fencing it and waiting for the webhook', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ waitFor, lastFailover }) => {
      await waitFor('east established', established);
      world.region('east').healthy = false;
      const done = await waitFor(
        'automatic failover finished',
        (state) => lastFailover(state)?.outcome !== undefined && lastFailover(state)?.outcome !== null,
      );
      const run = lastFailover(done);
      expect(run).toMatchObject({
        trigger: 'AUTOMATIC',
        mode: 'forced',
        fromRegionId: 'east',
        toRegionId: 'west',
        outcome: 'SUCCEEDED',
      });
      expect(run?.replication?.source).toBe('webhook');
      expect(done.activeRegionId).toBe('west');
      expect(done.edge).toMatchObject({ mode: 'active', activeRegionId: 'west', epoch: run?.epoch });
      expect(world.region('east').computeStopped).toBe(true);
      expect(done.regions.find((region) => region.config.id === 'east')?.compute).toBe('stopped');
      expect(run?.steps.every((step) => ['SUCCEEDED', 'WARNING', 'SKIPPED'].includes(step.status))).toBe(
        true,
      );
      expect(world.alerts.map((alert) => alert.kind)).toEqual(
        expect.arrayContaining(['FAILOVER_STARTED', 'REGION_FENCED']),
      );
    });
  });

  it('runs a manual planned failover requested through the Update, then recovers nothing to recover', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ handle, waitFor, lastFailover }) => {
      await waitFor('east established', established);
      await waitFor(
        'west observed healthy',
        (state) => state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
      );
      const accepted = await handle.executeUpdate(triggerFailoverUpdate, {
        args: [{ mode: 'planned', reason: 'game day drill', requestedBy: 'tester' }],
      });
      expect(accepted).toMatchObject({ fromRegionId: 'east', toRegionId: 'west', mode: 'planned' });
      const done = await waitFor(
        'manual failover finished',
        (state) => lastFailover(state)?.id === accepted.failoverId,
      );
      expect(lastFailover(done)).toMatchObject({
        outcome: 'SUCCEEDED',
        requestedBy: 'tester',
        trigger: 'MANUAL',
      });
      expect(world.region('east').computeStopped).toBe(false);
      expect(world.region('east').db.role).toBe('replica');
      // Once both restarted monitors have reported, the old primary's pre-failover "primary" snapshot must not
      // have been taken for a split brain.
      const endedAt = Date.parse(lastFailover(done)?.endedAt ?? '');
      await waitFor('both regions observed after the failover', (state) =>
        state.regions.every((region) => Date.parse(region.health?.observedAt ?? '') > endedAt),
      );
      expect(world.alerts.map((alert) => alert.kind)).not.toContain('SPLIT_BRAIN_FENCED');
      await expectRejected(
        handle.executeUpdate(recoverRegionUpdate, { args: [{ regionId: 'east', requestedBy: 'tester' }] }),
        /nothing to recover/,
      );
    });
  });

  it('refuses a second failover while the first is still taking over from normal operations', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ handle, waitFor }) => {
      await waitFor('east established', established);
      await waitFor(
        'west observed healthy',
        (state) => state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
      );
      const request = (reason: string) => ({ mode: 'planned' as const, reason, requestedBy: 'tester' });
      // Accepted means the request is pending; the sentry is now stopping its monitors before failing over.
      await handle.startUpdate(triggerFailoverUpdate, {
        args: [request('first request')],
        waitForStage: WorkflowUpdateStage.ACCEPTED,
      });
      // A rejected Update surfaces from its result, not from startUpdate.
      await expectRejected(
        handle
          .startUpdate(triggerFailoverUpdate, {
            args: [request('second request')],
            waitForStage: WorkflowUpdateStage.ACCEPTED,
          })
          .then((update) => update.result()),
        /already in progress/,
      );
      const done = await waitFor('the failover finished', (state) =>
        Boolean(state.recentFailovers[0]?.outcome),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const after = await handle.query(getSentryStateQuery);
      expect(after.recentFailovers).toHaveLength(1);
      expect(done.recentFailovers[0]).toMatchObject({
        fromRegionId: 'east',
        toRegionId: 'west',
        outcome: 'SUCCEEDED',
      });
    });
  });

  it('rejects invalid Updates in their validators', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ handle, waitFor }) => {
      await waitFor('east established', established);
      await expectRejected(
        handle.executeUpdate(triggerFailoverUpdate, {
          args: [{ targetRegionId: 'east', mode: 'forced', reason: 'nope', requestedBy: 'tester' }],
        }),
        /already the primary/,
      );
      await expectRejected(
        handle.executeUpdate(abortFailoverUpdate, {
          args: [{ reason: 'nothing to abort', requestedBy: 'tester' }],
        }),
        /No failover is in progress/,
      );
      await expectRejected(
        handle.executeUpdate(triggerFailoverUpdate, {
          args: [{ mode: 'planned', reason: 'x', requestedBy: 'tester' }],
        }),
        /reason must be/,
      );
    });
  });

  it('alerts when replica sync stalls past the durable timeout, and reverts when the operator aborts', async () => {
    const world = new FakeWorld(['east', 'west']);
    world.region('west').promotionBehaviour = 'stall';
    await withSentry(world, {}, async ({ handle, waitFor, lastFailover }) => {
      await waitFor('east established', established);
      await waitFor(
        'west observed healthy',
        (state) => state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
      );
      const accepted = await handle.executeUpdate(triggerFailoverUpdate, {
        args: [{ mode: 'planned', reason: 'stall drill', requestedBy: 'tester' }],
      });
      await waitFor('stall reported', (state) => state.currentFailover?.phase === 'AWAITING_OPERATOR');
      expect(
        world.alerts.some((alert) => alert.kind === 'REPLICATION_STALLED' && alert.severity === 'critical'),
      ).toBe(true);
      await handle.executeUpdate(resolveStallUpdate, {
        args: [{ decision: 'abort', requestedBy: 'tester' }],
      });
      const done = await waitFor(
        'failover reverted',
        (state) => lastFailover(state)?.id === accepted.failoverId,
      );
      const run = lastFailover(done);
      expect(run?.outcome).toBe('ABORTED');
      expect(run?.compensations.map((compensation) => compensation.status)).not.toContain('FAILED');
      expect(done.activeRegionId).toBe('east');
      expect(world.region('east').db.role).toBe('primary');
      expect(world.region('west').db.role).toBe('replica');
      expect(done.edge).toMatchObject({ mode: 'active', activeRegionId: 'east' });
      expect(done.edge?.epoch).toBeGreaterThan(run?.epoch ?? 0);
    });
  });

  it('resumes waiting after a stall decision, and completes when retried as forced', async () => {
    const world = new FakeWorld(['east', 'west']);
    world.region('west').promotionBehaviour = 'stall';
    await withSentry(world, {}, async ({ handle, waitFor, lastFailover }) => {
      await waitFor('east established', established);
      await waitFor(
        'west observed healthy',
        (state) => state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
      );
      const accepted = await handle.executeUpdate(triggerFailoverUpdate, {
        args: [{ mode: 'planned', reason: 'retry drill', requestedBy: 'tester' }],
      });
      await waitFor('stall reported', (state) => state.currentFailover?.phase === 'AWAITING_OPERATOR');
      world.region('west').promotionBehaviour = 'complete';
      await handle.executeUpdate(resolveStallUpdate, {
        args: [{ decision: 'retry-forced', requestedBy: 'tester' }],
      });
      // The decision is applied (stall cleared), then the sentry waits for the webhook again.
      await waitFor(
        'decision applied',
        (state) =>
          state.currentFailover === null ||
          (state.currentFailover.phase !== 'AWAITING_OPERATOR' && state.currentFailover.stall === null),
      );
      const done = await waitFor(
        'failover finished',
        (state) => lastFailover(state)?.id === accepted.failoverId,
      );
      const run = lastFailover(done);
      expect(run).toMatchObject({ outcome: 'SUCCEEDED', mode: 'forced' });
      expect(run?.epoch).toBe(accepted.epoch + 1);
      expect(done.timeline.some((event) => event.kind === 'STALL_RETRY_FORCED')).toBe(true);
    });
  });

  it('verifies directly when the webhook never arrives, and proceeds with a warning', async () => {
    const world = new FakeWorld(['east', 'west']);
    world.region('west').promotionBehaviour = 'drop-webhook';
    await withSentry(world, {}, async ({ handle, waitFor, lastFailover }) => {
      await waitFor('east established', established);
      await waitFor(
        'west observed healthy',
        (state) => state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
      );
      const accepted = await handle.executeUpdate(triggerFailoverUpdate, {
        args: [{ mode: 'planned', reason: 'lost webhook drill', requestedBy: 'tester' }],
      });
      const done = await waitFor(
        'failover finished',
        (state) => lastFailover(state)?.id === accepted.failoverId,
      );
      const run = lastFailover(done);
      expect(run?.outcome).toBe('SUCCEEDED');
      expect(run?.replication?.source).toBe('direct-check');
      expect(run?.steps.find((step) => step.name === 'AWAIT_REPLICATION')?.status).toBe('WARNING');
      expect(done.alerts.some((alert) => alert.kind === 'REPLICATION_WEBHOOK_MISSING')).toBe(true);
    });
  });

  it('cancels a failover in flight when the operator aborts it, and compensates', async () => {
    const world = new FakeWorld(['east', 'west']);
    world.promotionDelayMs = 60_000; // Keeps the failover waiting for replication.
    await withSentry(
      world,
      { failover: { ...failoverPolicy, replicationTimeoutSeconds: 60 } },
      async ({ handle, waitFor, lastFailover }) => {
        await waitFor('east established', established);
        await waitFor(
          'west observed healthy',
          (state) =>
            state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
        );
        const accepted = await handle.executeUpdate(triggerFailoverUpdate, {
          args: [{ mode: 'planned', reason: 'abort drill', requestedBy: 'tester' }],
        });
        await waitFor(
          'waiting for replication',
          (state) => state.currentFailover?.phase === 'AWAIT_REPLICATION',
        );
        const result = await handle.executeUpdate(abortFailoverUpdate, {
          args: [{ reason: 'changed my mind', requestedBy: 'tester' }],
        });
        expect(result).toEqual({ failoverId: accepted.failoverId, abortedDuringPhase: 'AWAIT_REPLICATION' });
        const done = await waitFor('aborted', (state) => lastFailover(state)?.id === accepted.failoverId);
        const run = lastFailover(done);
        expect(run?.outcome).toBe('ABORTED');
        expect(run?.steps.find((step) => step.name === 'AWAIT_REPLICATION')?.status).toBe('CANCELLED');
        expect(done.activeRegionId).toBe('east');
        expect(world.region('east').db.role).toBe('primary');
        expect(done.mode).toBe('NORMAL');
      },
    );
  });

  it('reverts when the new primary misbehaves during stabilization', async () => {
    const world = new FakeWorld(['east', 'west']);
    const policy = { ...failoverPolicy, stabilizationSeconds: 30 };
    await withSentry(world, { failover: policy }, async ({ handle, waitFor, lastFailover }) => {
      await waitFor('east established', established);
      await waitFor(
        'west observed healthy',
        (state) => state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
      );
      const accepted = await handle.executeUpdate(triggerFailoverUpdate, {
        args: [{ mode: 'planned', reason: 'anomaly drill', requestedBy: 'tester' }],
      });
      await waitFor('stabilizing', (state) => state.currentFailover?.phase === 'STABILIZATION');
      world.edgeFails = true;
      const done = await waitFor('reverted', (state) => lastFailover(state)?.id === accepted.failoverId);
      world.edgeFails = false;
      const run = lastFailover(done);
      expect(run?.outcome).toBe('REVERTED');
      expect(run?.error).toContain('Anomaly while stabilizing');
      expect(done.activeRegionId).toBe('east');
      expect(done.edge).toMatchObject({ mode: 'active', activeRegionId: 'east' });
      expect(
        done.alerts.some((alert) => alert.kind === 'FAILOVER_REVERTED' && alert.severity === 'critical'),
      ).toBe(true);
    });
  });

  it('ignores duplicate and stale webhooks', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ handle, waitFor }) => {
      await waitFor('east established', established);
      const event = {
        eventId: 'evt-stale',
        type: 'replication.promotion.completed' as const,
        failoverId: 'fo-nope',
        epoch: 1,
        regionId: 'west',
        lsn: 1,
        dataLossTransactions: 0,
        occurredAt: new Date().toISOString(),
        error: null,
        receivedAt: new Date().toISOString(),
      };
      await handle.signal(replicationCompleteSignal, event);
      await handle.signal(replicationCompleteSignal, event);
      const state = await waitFor('webhook ignored', (current) =>
        current.timeline.some((entry) => entry.kind === 'WEBHOOK_IGNORED'),
      );
      expect(state.timeline.filter((entry) => entry.kind === 'WEBHOOK_IGNORED')).toHaveLength(1);
    });
  });

  it('fences a stale primary (split brain) and lets operators acknowledge the alert', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, {}, async ({ handle, waitFor }) => {
      const before = await waitFor('east established', established);
      world.region('west').db = {
        ...world.region('west').db,
        role: 'primary',
        epoch: before.epoch - 1 >= 0 ? before.epoch - 1 : 0,
      };
      const state = await waitFor('split brain fenced', (current) =>
        current.alerts.some((alert) => alert.kind === 'SPLIT_BRAIN_FENCED'),
      );
      expect(world.region('west').db.role).toBe('replica');
      const alert = state.alerts.find((candidate) => candidate.kind === 'SPLIT_BRAIN_FENCED');
      const acknowledged = await handle.executeUpdate(acknowledgeAlertUpdate, {
        args: [{ alertId: alert?.id ?? '', requestedBy: 'tester' }],
      });
      expect(acknowledged.acknowledgedBy).toBe('tester');
    });
  });

  it('suspends automatic failover on request and reports a missing target', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(world, { health: { ...healthPolicy } }, async ({ handle, waitFor }) => {
      await waitFor('east established', established);
      await handle.executeUpdate(setAutoFailoverUpdate, {
        args: [{ enabled: false, requestedBy: 'tester' }],
      });
      world.region('east').healthy = false;
      await waitFor(
        'east unhealthy',
        (state) =>
          state.regions.find((region) => region.config.id === 'east')?.health?.status === 'UNHEALTHY',
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await handle.query(getSentryStateQuery)).recentFailovers).toHaveLength(0);
      world.region('west').healthy = false;
      await waitFor(
        'west unhealthy',
        (state) =>
          state.regions.find((region) => region.config.id === 'west')?.health?.status === 'UNHEALTHY',
      );
      await handle.executeUpdate(setAutoFailoverUpdate, { args: [{ enabled: true, requestedBy: 'tester' }] });
      const state = await waitFor('no target alert', (current) =>
        current.alerts.some((alert) => alert.kind === 'NO_FAILOVER_TARGET'),
      );
      expect(state.recentFailovers).toHaveLength(0);
    });
  });
});

/** Polls until the check passes (or fails the test after the timeout). */
async function waitUntil(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

/** The promise's value, or null when it takes longer than the timeout (for asserting that something doesn't hang). */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

describe('failoverSentryWorkflow continuing as new', () => {
  const historyLimit = 150;
  let shortHistoryEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    // A server that suggests continue-as-new after a short history, so a test reaches it in seconds.
    shortHistoryEnv = await TestWorkflowEnvironment.createLocal({
      server: {
        executable: { type: 'existing-path', path: temporalCli() },
        startupTimeout: '30s',
        extraArgs: ['--dynamic-config-value', `limit.historyCount.suggestContinueAsNew=${historyLimit}`],
      },
    });
  });

  afterAll(async () => {
    await shortHistoryEnv?.teardown();
  });

  it('fails over once its monitors have continued as new', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(
      world,
      {},
      async ({ handle, waitFor, lastFailover }) => {
        await waitFor('east established', established);
        // A child's cancellation targets the run its parent started; this checks the sentry still stops a monitor
        // whose chain has moved on (or it would wait for that monitor forever, and never fail over).
        const monitor = shortHistoryEnv.client.workflow.getHandle(`${handle.workflowId}/monitor/east`);
        await waitUntil('the east monitor continued as new', async () => {
          const view = await monitor.query(getMonitorStateQuery).catch(() => null);
          return (view?.continuedAsNewCount ?? 0) >= 1;
        });
        await waitFor(
          'west observed healthy',
          (state) =>
            state.regions.find((region) => region.config.id === 'west')?.health?.status === 'HEALTHY',
        );
        const accepted = await withTimeout(
          handle.executeUpdate(triggerFailoverUpdate, {
            args: [{ mode: 'planned', reason: 'after monitors continued as new', requestedBy: 'tester' }],
          }),
          20_000,
        );
        expect(accepted, 'the failover must start').toMatchObject({
          fromRegionId: 'east',
          toRegionId: 'west',
        });
        const done = await waitFor(
          'failover finished',
          (state) => lastFailover(state)?.id === accepted?.failoverId,
        );
        expect(lastFailover(done)?.outcome).toBe('SUCCEEDED');
      },
      shortHistoryEnv,
    );
  }, 120_000);

  it('serves a failover requested while it waits to continue as new, instead of deadlocking', async () => {
    const world = new FakeWorld(['east', 'west']);
    await withSentry(
      world,
      {},
      async ({ handle, waitFor }) => {
        await waitFor('east established', established);
        // An alert whose delivery hangs keeps continue-as-new waiting for its background tasks.
        let releaseAlerts: () => void = () => undefined;
        world.alertGate = new Promise<void>((resolve) => {
          releaseAlerts = resolve;
        });
        try {
          world.region('west').healthy = false;
          await waitFor(
            'west unhealthy',
            (state) =>
              state.regions.find((region) => region.config.id === 'west')?.health?.status === 'UNHEALTHY',
          );
          world.region('east').healthy = false;
          const blocked = await waitFor('a no-target alert in flight', (state) =>
            state.alerts.some((alert) => alert.kind === 'NO_FAILOVER_TARGET'),
          );
          const attempts = (state: SentryStateView) =>
            state.timeline.filter((event) => event.kind === 'CONTINUING_AS_NEW').length;
          await waitFor(
            'waiting to continue as new (the alert delivery holds it)',
            (state) => state.runId === blocked.runId && attempts(state) > attempts(blocked),
            60_000,
          );

          const accepted = await withTimeout(
            handle.executeUpdate(triggerFailoverUpdate, {
              args: [
                {
                  mode: 'forced',
                  targetRegionId: 'west',
                  reason: 'during continue-as-new',
                  requestedBy: 'tester',
                },
              ],
            }),
            20_000,
          );
          expect(accepted, 'the failover Update must not hang').toMatchObject({ toRegionId: 'west' });
          const state = await handle.query(getSentryStateQuery);
          expect(state.timeline.some((event) => event.kind === 'CONTINUE_AS_NEW_DEFERRED')).toBe(true);
        } finally {
          releaseAlerts();
        }
      },
      shortHistoryEnv,
    );
  }, 120_000);
});
