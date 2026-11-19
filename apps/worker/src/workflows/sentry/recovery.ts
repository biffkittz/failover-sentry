/**
 * Recovering a region (after the sentry fenced it, say): start its compute again, then wait until its monitor
 * reports it HEALTHY as a replica. Runs in the background, outside normal operations, so a failover starting
 * meanwhile doesn't cancel it.
 *
 * Usually the region is a standby. It can also be the primary: a forced failover that fenced the old primary and then
 * failed leaves the stopped region primary, in manual intervention (validateRecoverRegion allows exactly that case).
 */
import type { RegionId, RegionRecovery } from '@failover-sentry/contracts';
import { ApplicationFailure, condition } from '@temporalio/workflow';
import { compute } from '../activities.js';
import { describeFailure } from '../errors.js';
import type { FailoverHost } from './failover.js';

const RECOVERY_TIMEOUT_MS = 10 * 60_000;

export type RecoveryHost = Pick<FailoverHost, 'state' | 'raiseAlert'>;

export async function recoverRegion(
  host: RecoveryHost,
  regionId: RegionId,
  recovery: RegionRecovery,
): Promise<void> {
  const { state } = host;
  const name = state.displayName(regionId);
  try {
    state.regionCompute.set(regionId, 'starting');
    const started = await compute.startRegionCompute({
      regionId,
      reason: `recovery requested by ${recovery.requestedBy}`,
    });
    recovery.phase = 'AWAITING_HEALTH';
    recovery.detail = started.detail;
    const sinceMs = Date.now();
    const healthy = await condition(() => {
      const health = state.regionHealth.get(regionId);
      return Boolean(
        health &&
        Date.parse(health.observedAt) > sinceMs &&
        health.status === 'HEALTHY' &&
        health.lastProbe?.db?.role === 'replica',
      );
    }, RECOVERY_TIMEOUT_MS);
    if (!healthy) {
      throw ApplicationFailure.nonRetryable(`${name} did not report HEALTHY as a replica within 10 minutes`);
    }
    state.regionCompute.set(regionId, 'running');
    recovery.phase = 'DONE';
    // A recovered primary (the fenced old primary of a failover that needed manual intervention) comes back empty,
    // as a replica; reconciliation then promotes it, unless a standby holds newer data.
    const primary = regionId === state.activeRegionId;
    recovery.detail = primary
      ? 'Running again, as a replica until the sentry promotes it'
      : 'Healthy and replicating as a standby';
    host.raiseAlert(
      'REGION_RECOVERED',
      'info',
      `${name} recovered`,
      primary
        ? `${name} is running again. It came back as an empty replica: the sentry promotes it, unless a standby holds newer data, in which case fail over to that standby.`
        : `${name} is back as a healthy standby.`,
      {
        regionId,
      },
    );
  } catch (error) {
    recovery.phase = 'FAILED';
    recovery.detail = describeFailure(error);
    state.regionCompute.set(regionId, 'unknown');
    host.raiseAlert('RECOVERY_FAILED', 'warning', `Recovery of ${name} failed`, recovery.detail, {
      regionId,
    });
  }
}
