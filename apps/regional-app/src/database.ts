/**
 * A simulated database node: a primary/replica pair with log positions (LSNs), epoch fencing and promotions.
 *
 * It models the parts of a real geo-replicated database (Azure SQL failover groups, say) that a failover
 * orchestrator has to get right:
 * - Asynchronous replication: a replica trails the primary's log, so a forced promotion can lose transactions.
 * - Planned promotion: the old primary stops writing, the replica catches up, then roles switch (no data loss).
 * - Fencing: every order carries an epoch. A node refuses orders with an epoch lower than the one it holds, and a
 *   primary that discovers a primary with a higher epoch demotes itself. Two primaries can briefly coexist only
 *   while a partition hides them from each other, and only the higher epoch is ever routed to.
 *
 * The class holds state and rules only; the replication agent drives time, network and webhooks.
 */
import type {
  DatabaseRole,
  DatabaseSnapshot,
  DemoteRequest,
  PromoteRequest,
  PromotionMode,
  PromotionSnapshot,
} from '@failover-sentry/contracts';

export interface PeerDatabaseStatus {
  regionId: string;
  role: DatabaseRole;
  epoch: number;
  lsn: number;
}

export type PromoteResult =
  | { kind: 'accepted'; promotion: PromotionSnapshot; idempotent: boolean }
  | { kind: 'completed'; promotion: PromotionSnapshot }
  | { kind: 'stale-epoch'; currentEpoch: number };

export type DemoteResult =
  { kind: 'demoted'; changed: boolean } | { kind: 'stale-epoch'; currentEpoch: number };

export interface DatabaseOptions {
  /** Log positions a primary writes per second (synthetic traffic). */
  writesPerSecond: number;
  /** Log positions a replica applies per replication poll. */
  replicationBatch: number;
  /** A replica that hasn't heard from a primary for this long reports itself as lagging. */
  contactTimeoutMs: number;
}

interface PromotionState extends PromotionSnapshot {
  /** Highest primary LSN known when the promotion started (forced promotions lose what lies beyond it). */
  knownPrimaryLsn: number;
  switchAt: number | null;
  startedAtMs: number;
}

export class SimulatedDatabase {
  private role: DatabaseRole = 'replica';
  private epoch = 0;
  private lsn = 0;
  private appliedLsn = 0;
  private knownPrimaryLsn: number | null = null;
  private lastPrimaryContactAt: number | null = null;
  private lastCaughtUpAt: number | null = null;
  private writeCarry = 0;
  private lastWriteAt: number;
  private promotion: PromotionState | null = null;
  private promotionCounter = 0;

  constructor(
    private readonly regionId: string,
    private readonly options: DatabaseOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.lastWriteAt = now();
  }

  snapshot(): DatabaseSnapshot {
    return {
      role: this.role,
      epoch: this.epoch,
      lsn: this.lsn,
      appliedLsn: this.appliedLsn,
      lagSeconds: this.lagSeconds(),
      promotion: this.promotion ? this.publicPromotion(this.promotion) : null,
    };
  }

  /** What peers see when they poll this node (also used by the sentry's direct checks). */
  peerStatus(): PeerDatabaseStatus {
    return { regionId: this.regionId, role: this.role, epoch: this.epoch, lsn: this.lsn };
  }

  get currentRole(): DatabaseRole {
    return this.role;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get activePromotion(): PromotionState | null {
    return this.promotion &&
      (this.promotion.status === 'catching-up' || this.promotion.status === 'switching')
      ? this.promotion
      : null;
  }

  /** Synthetic write traffic: a primary's log grows with time. */
  writeTick(): void {
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.lastWriteAt) / 1000;
    this.lastWriteAt = now;
    if (this.role !== 'primary') {
      this.writeCarry = 0;
      return;
    }
    this.writeCarry += elapsedSeconds * this.options.writesPerSecond;
    const writes = Math.floor(this.writeCarry);
    this.writeCarry -= writes;
    this.lsn += writes;
    this.appliedLsn = this.lsn;
  }

  /**
   * Applies what a poll of a peer that claims to be primary returned. Returns a description of anything notable
   * (self-demotion, reseed) for the log, or null.
   */
  observePrimary(peer: PeerDatabaseStatus, batchFactor = 1): string | null {
    const now = this.now();
    if (peer.role !== 'primary') {
      return null;
    }
    if (this.role === 'primary') {
      if (peer.epoch > this.epoch) {
        // A primary with a higher epoch exists: this node is the stale side of a split brain. Fence itself.
        const previous = this.epoch;
        this.role = 'replica';
        this.epoch = peer.epoch;
        this.knownPrimaryLsn = peer.lsn;
        this.lastPrimaryContactAt = now;
        this.reseedIfAhead(peer.lsn);
        return `self-demoted: ${peer.regionId} is primary at epoch ${peer.epoch} (this node held epoch ${previous})`;
      }
      return null;
    }
    if (peer.epoch < this.epoch) {
      return null; // A stale primary; the sentry will fence it.
    }
    this.epoch = peer.epoch;
    this.lastPrimaryContactAt = now;
    this.knownPrimaryLsn = peer.lsn;
    const reseeded = this.reseedIfAhead(peer.lsn);
    const batch = Math.max(1, Math.round(this.options.replicationBatch * batchFactor));
    this.appliedLsn = Math.min(peer.lsn, this.appliedLsn + batch);
    this.lsn = peer.lsn;
    if (this.appliedLsn >= peer.lsn) {
      this.lastCaughtUpAt = now;
    }
    return reseeded
      ? `reseeded from ${peer.regionId} at lsn ${peer.lsn} (divergent history discarded)`
      : null;
  }

  /** Accepts a promotion order, or refuses it when it carries a stale epoch. */
  promote(request: PromoteRequest, knownPrimaryLsn: number | null): PromoteResult {
    const now = this.now();
    const existing = this.promotion;
    if (existing && existing.failoverId === request.failoverId && existing.epoch === request.epoch) {
      // A retried order (activity retries): answer with the promotion already under way or done.
      return existing.status === 'completed' && request.mode === 'restore'
        ? { kind: 'completed', promotion: this.publicPromotion(existing) }
        : { kind: 'accepted', promotion: this.publicPromotion(existing), idempotent: true };
    }
    if (this.role === 'primary' && request.epoch === this.epoch) {
      // Already primary at this epoch (e.g. the order is a retry after this node's restart).
      const promotion = this.newPromotion(request, now, knownPrimaryLsn);
      promotion.status = 'completed';
      promotion.completedAt = new Date(now).toISOString();
      this.promotion = promotion;
      return { kind: 'completed', promotion: this.publicPromotion(promotion) };
    }
    if (request.epoch <= this.epoch) {
      return { kind: 'stale-epoch', currentEpoch: this.epoch };
    }

    const promotion = this.newPromotion(request, now, knownPrimaryLsn);
    this.promotion = promotion;
    if (request.mode === 'restore') {
      // Re-promoting a node that was primary moments ago: nothing to catch up on.
      this.completePromotion();
      return { kind: 'completed', promotion: this.publicPromotion(promotion) };
    }
    return { kind: 'accepted', promotion: this.publicPromotion(promotion), idempotent: false };
  }

  /** Turns this node into a replica (fencing). Refuses orders with a stale epoch. */
  demote(request: DemoteRequest): DemoteResult {
    if (request.epoch < this.epoch) {
      return { kind: 'stale-epoch', currentEpoch: this.epoch };
    }
    const changed = this.role !== 'replica' || request.epoch !== this.epoch;
    this.role = 'replica';
    this.epoch = request.epoch;
    const active = this.activePromotion;
    if (active && active.epoch <= request.epoch) {
      this.failPromotion(`superseded by a demotion at epoch ${request.epoch} (${request.reason})`);
    }
    return { kind: 'demoted', changed };
  }

  /** Planned promotions: the replica caught up with the (fenced) old primary; start the role switch. */
  beginSwitch(switchDelayMs: number): void {
    const active = this.activePromotion;
    if (active && active.status === 'catching-up') {
      active.status = 'switching';
      active.switchAt = this.now() + switchDelayMs;
    }
  }

  /** Finishes the active promotion: this node becomes primary at the promotion's epoch. */
  completePromotion(): { dataLossTransactions: number } | null {
    const active = this.promotion;
    if (!active || active.status === 'completed' || active.status === 'failed') {
      return null;
    }
    const now = this.now();
    const dataLossTransactions = Math.max(0, active.knownPrimaryLsn - this.appliedLsn);
    this.role = 'primary';
    this.epoch = active.epoch;
    this.lsn = this.appliedLsn;
    this.knownPrimaryLsn = null;
    this.lastWriteAt = now;
    active.status = 'completed';
    active.completedAt = new Date(now).toISOString();
    return { dataLossTransactions };
  }

  failPromotion(error: string): PromotionSnapshot | null {
    const active = this.activePromotion;
    if (!active) {
      return null;
    }
    active.status = 'failed';
    active.error = error;
    active.completedAt = new Date(this.now()).toISOString();
    return this.publicPromotion(active);
  }

  /** Planned promotions need the replica to have applied everything the old primary wrote. */
  isCaughtUpWith(primaryLsn: number): boolean {
    return this.appliedLsn >= primaryLsn;
  }

  /** Catch up with a peer that is no longer primary (the fenced old primary of a planned failover). */
  catchUpWith(peerLsn: number): void {
    const batch = Math.max(1, this.options.replicationBatch);
    this.appliedLsn = Math.min(peerLsn, this.appliedLsn + batch);
    this.lsn = Math.max(this.lsn, peerLsn);
    if (this.appliedLsn >= peerLsn) {
      this.lastCaughtUpAt = this.now();
    }
  }

  /** A power cycle: the in-memory database comes back as an empty replica that has to reseed. */
  reset(): void {
    this.role = 'replica';
    this.epoch = 0;
    this.lsn = 0;
    this.appliedLsn = 0;
    this.knownPrimaryLsn = null;
    this.lastPrimaryContactAt = null;
    this.lastCaughtUpAt = null;
    this.promotion = null;
    this.writeCarry = 0;
    this.lastWriteAt = this.now();
  }

  private newPromotion(request: PromoteRequest, now: number, knownPrimaryLsn: number | null): PromotionState {
    this.promotionCounter += 1;
    return {
      promotionId: `${this.regionId}-p${this.promotionCounter}-e${request.epoch}`,
      failoverId: request.failoverId,
      epoch: request.epoch,
      mode: request.mode,
      status: request.mode === 'forced' ? 'switching' : 'catching-up',
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      completedAt: null,
      error: null,
      knownPrimaryLsn: Math.max(knownPrimaryLsn ?? this.knownPrimaryLsn ?? this.appliedLsn, this.appliedLsn),
      switchAt: null,
    };
  }

  private publicPromotion(promotion: PromotionState): PromotionSnapshot {
    const { promotionId, failoverId, epoch, mode, status, startedAt, completedAt, error } = promotion;
    return { promotionId, failoverId, epoch, mode, status, startedAt, completedAt, error };
  }

  private reseedIfAhead(primaryLsn: number): boolean {
    if (this.appliedLsn > primaryLsn) {
      this.appliedLsn = primaryLsn;
      this.lsn = primaryLsn;
      return true;
    }
    return false;
  }

  private lagSeconds(): number | null {
    if (this.role === 'primary') {
      return null;
    }
    const now = this.now();
    const inContact =
      this.lastPrimaryContactAt !== null && now - this.lastPrimaryContactAt <= this.options.contactTimeoutMs;
    if (inContact && this.knownPrimaryLsn !== null && this.appliedLsn >= this.knownPrimaryLsn) {
      return 0;
    }
    if (this.lastCaughtUpAt === null) {
      return null;
    }
    return Math.round((now - this.lastCaughtUpAt) / 100) / 10;
  }

  /** For the agent: when a forced or planned switch is due. */
  switchDue(): boolean {
    const active = this.activePromotion;
    if (!active || active.status !== 'switching') {
      return false;
    }
    if (active.switchAt === null) {
      return false;
    }
    return this.now() >= active.switchAt;
  }

  /** For the agent: a forced promotion switches roles `delayMs` after the order arrived. */
  scheduleForcedSwitch(delayMs: number): void {
    const active = this.activePromotion;
    if (active && active.status === 'switching' && active.switchAt === null) {
      active.switchAt = active.startedAtMs + delayMs;
    }
  }

  promotionAgeMs(): number | null {
    const active = this.activePromotion;
    return active ? this.now() - active.startedAtMs : null;
  }

  /** The promotion mode in progress, if any. */
  activePromotionMode(): PromotionMode | null {
    return this.activePromotion?.mode ?? null;
  }
}
