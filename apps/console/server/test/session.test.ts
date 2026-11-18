import { describe, expect, it } from 'vitest';
import { isSessionValid, safeReturnTo, Sealer } from '../src/session.js';

describe('sealed cookies', () => {
  it('round-trips a value and refuses tampering or another purpose', () => {
    const sessions = new Sealer('secret-with-enough-length-for-tests', 'session');
    const sealed = sessions.seal({ login: 'octocat' });
    expect(sessions.open(sealed)).toEqual({ login: 'octocat' });
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('A') ? 'B' : 'A'}A`;
    expect(sessions.open(tampered)).toBeNull();
    expect(new Sealer('secret-with-enough-length-for-tests', 'oauth-state').open(sealed)).toBeNull();
    expect(new Sealer('another-secret-of-enough-length!!', 'session').open(sealed)).toBeNull();
    expect(sessions.open('garbage')).toBeNull();
    expect(sessions.open(undefined)).toBeNull();
  });

  it('checks expiry', () => {
    expect(isSessionValid({ login: 'a', name: null, avatarUrl: null, iat: 100, exp: 200 }, 150)).toBe(true);
    expect(isSessionValid({ login: 'a', name: null, avatarUrl: null, iat: 100, exp: 200 }, 201)).toBe(false);
    expect(isSessionValid(null)).toBe(false);
  });

  it('allows only same-origin relative return paths', () => {
    expect(safeReturnTo('/failovers/fo-1?tab=steps')).toBe('/failovers/fo-1?tab=steps');
    expect(safeReturnTo('//evil.example.com')).toBe('/');
    expect(safeReturnTo('https://evil.example.com')).toBe('/');
    expect(safeReturnTo('/\\evil')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });
});
