/**
 * L402 Rail Stub Tests
 *
 * Verifies the stub contract: isAvailable() → false, parseChallenge detects
 * but returns null, all other methods throw.
 */

import { describe, it, expect } from '@jest/globals';
import { L402Rail } from '../payments/rails/l402-rail.js';
import type { PaymentChallenge } from '../payments/types.js';

describe('L402Rail (stub)', () => {
  const rail = new L402Rail();

  it('has correct id and name', () => {
    expect(rail.id).toBe('l402');
    expect(rail.name).toContain('Lightning');
  });

  it('isAvailable returns false', async () => {
    expect(await rail.isAvailable()).toBe(false);
  });

  it('parseChallenge returns null even for valid L402 headers', () => {
    const result = rail.parseChallenge(
      402,
      { 'www-authenticate': 'L402 macaroon="abc" invoice="lnbc..."' },
      null,
    );
    expect(result).toBeNull();
  });

  it('parseChallenge returns null for non-L402 headers', () => {
    const result = rail.parseChallenge(402, { 'x-payment': 'something' }, null);
    expect(result).toBeNull();
  });

  const dummyChallenge: PaymentChallenge = {
    rail: 'l402',
    amount: { value: '100', currency: 'BTC', usdCents: 100 },
    challengeData: {},
    expiresAt: new Date().toISOString(),
    toolEndpoint: 'https://example.com',
    challengeId: 'ch-test',
  };

  it('executePayment throws', async () => {
    await expect(rail.executePayment(dummyChallenge)).rejects.toThrow('not yet implemented');
  });

  it('buildAuthHeaders throws', () => {
    expect(() => rail.buildAuthHeaders('proof', dummyChallenge)).toThrow('not yet implemented');
  });

  it('verifyPayment throws', async () => {
    await expect(rail.verifyPayment('proof', {})).rejects.toThrow('not yet implemented');
  });

  it('getBalance throws', async () => {
    await expect(rail.getBalance()).rejects.toThrow('not yet implemented');
  });
});
