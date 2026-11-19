import type {
  AlertRecord,
  ComputeState,
  EdgeRouting,
  FailoverRun,
  RegionHealthSnapshot,
  RegionId,
  SentryMode,
  TimelineEvent,
} from './domain.js';

/**
 * Everything the sentry carries into its next run when it continues-as-new. Region health is carried too: it is
 * only a cache (the monitors re-report within one probe interval), but it keeps the console from blanking out.
 */
export interface SentryCarriedState {
  startedAt: string;
  continuedAsNewCount: number;
  mode: SentryMode;
  epoch: number;
  activeRegionId: RegionId;
  autoFailoverEnabled: boolean;
  autoFailoverSuspendedReason: string | null;
  lastAutomaticFailoverAt: string | null;
  edge: EdgeRouting | null;
  regionHealth: Record<RegionId, RegionHealthSnapshot>;
  regionCompute: Record<RegionId, ComputeState>;
  recentFailovers: FailoverRun[];
  alerts: AlertRecord[];
  timeline: TimelineEvent[];
  /** Webhook event IDs already processed, so a late redelivery after continue-as-new is still ignored. */
  processedEventIds: string[];
  sequence: number;
  /** When the last failover ended (decisions ignore older health). Absent in state carried by older versions. */
  healthValidSince?: string | null;
  /**
   * Automatic failovers refused at their precheck in a row, and when the last one was: they set the back-off before
   * the next attempt. Absent in state carried by older versions.
   */
  automaticRefusals?: number;
  lastAutomaticRefusalAt?: string | null;
}
