// @ts-check
/**
 * In-memory stand-in for Workers KV, for local runs and tests. It simulates KV's propagation delay: a read with a
 * cache TTL (how the Worker reads on the data path) sees a write only after `visibilityDelayMs`, while a read
 * without one (the Worker's fencing check) sees it at once, like the location that took the write.
 */
export class LocalKv {
  /**
   * @param {{ visibilityDelayMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.visibilityDelayMs = options.visibilityDelayMs ?? 0;
    this.now = options.now ?? Date.now;
    /** @type {Map<string, { value: string, visibleAt: number, previous: string | null }>} */
    this.entries = new Map();
  }

  /**
   * @param {string} key
   * @param {{ type?: 'text', cacheTtl?: number }} [options]
   * @returns {Promise<string | null>}
   */
  async get(key, options = {}) {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (options.cacheTtl === undefined || this.now() >= entry.visibleAt) {
      return entry.value;
    }
    return entry.previous;
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  async put(key, value) {
    const existing = this.entries.get(key);
    const previous = existing
      ? this.now() >= existing.visibleAt
        ? existing.value
        : existing.previous
      : null;
    this.entries.set(key, { value, visibleAt: this.now() + this.visibilityDelayMs, previous });
  }
}
