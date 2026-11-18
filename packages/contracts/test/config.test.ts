import { describe, expect, it } from 'vitest';
import { computeConfigVersion, parseSentryConfig, stableStringify } from '../src/config.js';

const minimal = {
  serviceName: 'storefront',
  edgePublicUrl: 'https://dr.example.com/',
  consoleUrl: 'https://sentry.example.com',
  initialPrimaryRegionId: 'east',
  regions: [
    { id: 'east', displayName: 'East', provider: 'local', baseUrl: 'http://east:8080/' },
    { id: 'west', displayName: 'West', provider: 'local', baseUrl: 'http://west:8080' },
  ],
};

describe('sentry configuration', () => {
  it('fills in policy defaults and trims trailing slashes', () => {
    const config = parseSentryConfig(minimal);
    expect(config.edgePublicUrl).toBe('https://dr.example.com');
    expect(config.regions[0]?.baseUrl).toBe('http://east:8080');
    expect(config.health.probeIntervalSeconds).toBe(30);
    expect(config.failover.autoFailoverEnabled).toBe(true);
    expect(config.failover.replicationTimeoutSeconds).toBe(120);
  });

  it('accepts JSON text', () => {
    expect(parseSentryConfig(JSON.stringify(minimal)).serviceName).toBe('storefront');
  });

  it('rejects a primary that is not a region, duplicate ids and Azure regions without a resource ID', () => {
    expect(() => parseSentryConfig({ ...minimal, initialPrimaryRegionId: 'north' })).toThrow(
      /initialPrimaryRegionId/,
    );
    expect(() =>
      parseSentryConfig({ ...minimal, regions: [minimal.regions[0], { ...minimal.regions[0] }] }),
    ).toThrow(/duplicate region ids: east/);
    expect(() =>
      parseSentryConfig({
        ...minimal,
        regions: [{ ...minimal.regions[0], provider: 'azure' }, minimal.regions[1]],
      }),
    ).toThrow(/azureResourceId/);
  });

  it('rejects a single region and invalid JSON', () => {
    expect(() => parseSentryConfig({ ...minimal, regions: [minimal.regions[0]] })).toThrow(
      /at least two regions/,
    );
    expect(() => parseSentryConfig('{not json')).toThrow(/not valid JSON/);
  });

  it('fingerprints configurations independently of key order', async () => {
    const a = parseSentryConfig(minimal);
    const b = parseSentryConfig(JSON.parse(stableStringify(minimal)) as unknown);
    expect(await computeConfigVersion(a)).toBe(await computeConfigVersion(b));
    expect(await computeConfigVersion(a)).toMatch(/^[0-9a-f]{16}$/);
    const changed = parseSentryConfig({ ...minimal, serviceName: 'other' });
    expect(await computeConfigVersion(changed)).not.toBe(await computeConfigVersion(a));
  });
});
