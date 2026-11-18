import { describe, expect, it } from 'vitest';
import {
  canonicalMessage,
  createSignatureHeader,
  parseSignatureHeader,
  timingSafeEqual,
  verifySignatureHeader,
} from '../src/signing.js';

const secret = 'test-secret-with-enough-entropy';
const request = { method: 'POST', path: '/api/webhooks/replication', body: '{"eventId":"e1"}' };

describe('request signing', () => {
  it('binds timestamp, method, path and body into the signed message', () => {
    expect(canonicalMessage(1700000000, 'post', '/x', 'body')).toBe('1700000000.POST./x.body');
  });

  it('accepts a request signed with the shared secret', async () => {
    const header = await createSignatureHeader({ secret, ...request, timestamp: 1_700_000_000 });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    await expect(verifySignatureHeader({ secret, ...request, header, now: 1_700_000_010 })).resolves.toEqual({
      ok: true,
      timestamp: 1_700_000_000,
    });
  });

  it('rejects a tampered body, another path or another method', async () => {
    const header = await createSignatureHeader({ secret, ...request, timestamp: 1_700_000_000 });
    const now = 1_700_000_000;
    for (const tampered of [
      { ...request, body: '{"eventId":"e2"}' },
      { ...request, path: '/internal/db/promote' },
      { ...request, method: 'PUT' },
    ]) {
      const result = await verifySignatureHeader({ secret, ...tampered, header, now });
      expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
    }
  });

  it('rejects requests outside the replay window', async () => {
    const header = await createSignatureHeader({ secret, ...request, timestamp: 1_700_000_000 });
    const result = await verifySignatureHeader({ secret, ...request, header, now: 1_700_000_301 });
    expect(result.ok).toBe(false);
  });

  it('accepts any of several secrets during a rotation', async () => {
    const header = await createSignatureHeader({ secret: 'new-secret', ...request, timestamp: 100 });
    const result = await verifySignatureHeader({
      secret: ['old-secret', 'new-secret'],
      ...request,
      header,
      now: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects missing or malformed headers and missing secrets', async () => {
    expect((await verifySignatureHeader({ secret, ...request, header: undefined })).ok).toBe(false);
    expect((await verifySignatureHeader({ secret, ...request, header: 'garbage' })).ok).toBe(false);
    const header = await createSignatureHeader({ secret, ...request });
    expect((await verifySignatureHeader({ secret: '', ...request, header })).ok).toBe(false);
  });

  it('parses headers and compares strings safely', () => {
    expect(parseSignatureHeader(`t=12,v1=${'a'.repeat(64)}`)).toEqual({
      timestamp: 12,
      signatures: ['a'.repeat(64)],
    });
    expect(parseSignatureHeader('t=12')).toBeNull();
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
