/**
 * Chaos switches for the demo: make this region slow, flaky or down, or change how its database's promotions behave.
 * The console's chaos panel drives them; the sentry has to notice and react.
 */
import type { ChaosSettings, ChaosUpdate } from '@failover-sentry/contracts';
import { chaosUpdateSchema } from '@failover-sentry/contracts/schemas';

const HEALTHY: ChaosSettings = { health: 'healthy', latencyMs: 0, errorRate: 0, replication: 'normal' };

export class ChaosController {
  private settings: ChaosSettings = { ...HEALTHY };
  private powered = true;

  get(): ChaosSettings {
    return { ...this.settings };
  }

  update(update: ChaosUpdate): ChaosSettings {
    const parsed = chaosUpdateSchema.parse(update);
    this.settings = { ...this.settings, ...parsed };
    return this.get();
  }

  reset(): ChaosSettings {
    this.settings = { ...HEALTHY };
    return this.get();
  }

  get poweredOn(): boolean {
    return this.powered;
  }

  setPower(on: boolean): void {
    this.powered = on;
  }

  /** A region that is down or powered off can't serve, write or reach its peers. */
  get isDown(): boolean {
    return !this.powered || this.settings.health === 'down';
  }

  /** Promotions take three times as long while replication is `slow`. */
  get slowFactor(): number {
    return this.settings.replication === 'slow' ? 3 : 1;
  }

  shouldFailRequest(random: () => number = Math.random): boolean {
    return this.settings.errorRate > 0 && random() < this.settings.errorRate;
  }
}
