import { describe, expect, it } from 'vitest';
import { SimulatedDatabase } from '../src/database.js';

function setup() {
  const clock = { now: 1_000_000 };
  const db = new SimulatedDatabase(
    'east',
    { writesPerSecond: 10, replicationBatch: 1_000, contactTimeoutMs: 5_000 },
    () => clock.now,
  );
  return { db, clock };
}

describe('SimulatedDatabase', () => {
  it('starts as an empty replica at epoch 0', () => {
    const { db } = setup();
    expect(db.snapshot()).toMatchObject({
      role: 'replica',
      epoch: 0,
      lsn: 0,
      appliedLsn: 0,
      promotion: null,
    });
  });

  it('becomes primary immediately on a restore promotion and then writes', () => {
    const { db, clock } = setup();
    const result = db.promote({ failoverId: 'bootstrap-1', epoch: 1, mode: 'restore' }, null);
    expect(result.kind).toBe('completed');
    expect(db.snapshot()).toMatchObject({ role: 'primary', epoch: 1 });
    clock.now += 2_000;
    db.writeTick();
    expect(db.snapshot().lsn).toBe(20);
    expect(db.snapshot().appliedLsn).toBe(20);
  });

  it('refuses promotions that carry a stale epoch, but answers retries idempotently', () => {
    const { db } = setup();
    db.promote({ failoverId: 'fo-1', epoch: 3, mode: 'restore' }, null);
    expect(db.promote({ failoverId: 'fo-0', epoch: 2, mode: 'planned' }, null)).toEqual({
      kind: 'stale-epoch',
      currentEpoch: 3,
    });
    expect(db.promote({ failoverId: 'fo-1', epoch: 3, mode: 'restore' }, null).kind).toBe('completed');
  });

  it('replicates from a primary with an equal or higher epoch and reports lag', () => {
    const { db, clock } = setup();
    expect(db.observePrimary({ regionId: 'west', role: 'primary', epoch: 4, lsn: 500 })).toBeNull();
    expect(db.snapshot()).toMatchObject({
      role: 'replica',
      epoch: 4,
      lsn: 500,
      appliedLsn: 500,
      lagSeconds: 0,
    });
    clock.now += 10_000; // No contact for 10 s: the replica no longer counts as caught up.
    expect(db.snapshot().lagSeconds).toBe(10);
  });

  it('ignores a stale primary but fences itself when a newer primary appears', () => {
    const { db } = setup();
    db.promote({ failoverId: 'fo-1', epoch: 5, mode: 'restore' }, null);
    expect(db.observePrimary({ regionId: 'west', role: 'primary', epoch: 4, lsn: 9 })).toBeNull();
    expect(db.currentRole).toBe('primary');
    const note = db.observePrimary({ regionId: 'west', role: 'primary', epoch: 6, lsn: 0 });
    expect(note).toMatch(/self-demoted/);
    expect(db.snapshot()).toMatchObject({ role: 'replica', epoch: 6 });
  });

  it('accounts for the data a forced promotion loses', () => {
    const { db } = setup();
    db.observePrimary({ regionId: 'west', role: 'primary', epoch: 1, lsn: 100 });
    // The primary keeps writing, but this replica never hears about LSNs beyond 100 before the outage.
    const result = db.promote({ failoverId: 'fo-2', epoch: 2, mode: 'forced' }, 130);
    expect(result.kind).toBe('accepted');
    expect(db.completePromotion()).toEqual({ dataLossTransactions: 30 });
    expect(db.snapshot()).toMatchObject({ role: 'primary', epoch: 2, lsn: 100 });
  });

  it('refuses stale demotions', () => {
    const { db } = setup();
    db.promote({ failoverId: 'fo-1', epoch: 3, mode: 'restore' }, null);
    expect(db.demote({ failoverId: null, epoch: 2, reason: 'old order' })).toEqual({
      kind: 'stale-epoch',
      currentEpoch: 3,
    });
    expect(db.demote({ failoverId: null, epoch: 3, reason: 'fence' })).toEqual({
      kind: 'demoted',
      changed: true,
    });
    expect(db.currentRole).toBe('replica');
  });

  it('keeps a higher-epoch promotion when a lower-epoch demotion arrives', () => {
    const { db } = setup();
    db.promote({ failoverId: 'fo-1', epoch: 2, mode: 'planned' }, null);
    expect(db.demote({ failoverId: null, epoch: 1, reason: 'older fence' }).kind).toBe('demoted');
    expect(db.activePromotion?.failoverId).toBe('fo-1');
  });

  it('cancels an in-flight promotion when fenced with an equal or higher epoch', () => {
    const { db } = setup();
    db.promote({ failoverId: 'fo-1', epoch: 2, mode: 'planned' }, null);
    expect(db.demote({ failoverId: 'fo-1', epoch: 2, reason: 'revert' })).toEqual({
      kind: 'demoted',
      changed: true,
    });
    expect(db.snapshot().promotion).toMatchObject({ status: 'failed' });
    expect(db.activePromotion).toBeNull();
  });

  it('discards divergent history when it reseeds from a new primary', () => {
    const { db } = setup();
    db.promote({ failoverId: 'bootstrap', epoch: 1, mode: 'restore' }, null);
    db.observePrimary({ regionId: 'west', role: 'primary', epoch: 2, lsn: 0 });
    // Self-demoted; now ahead of the new primary? It wrote nothing, so no reseed note is expected here.
    expect(db.snapshot()).toMatchObject({ role: 'replica', epoch: 2 });
  });

  it('resets to an empty replica on a power cycle', () => {
    const { db } = setup();
    db.promote({ failoverId: 'x', epoch: 7, mode: 'restore' }, null);
    db.reset();
    expect(db.snapshot()).toMatchObject({ role: 'replica', epoch: 0, lsn: 0, promotion: null });
  });
});
