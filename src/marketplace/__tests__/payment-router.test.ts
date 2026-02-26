/**
 * PaymentRailRouter Tests
 *
 * Tests rail registration, 402 challenge routing, and availability checks.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaymentRailRouter } from '../payments/router.js';
import type {
  PaymentRail,
  PaymentRailId,
  PaymentAmount,
  PaymentChallenge,
  PaymentResult,
} from '../payments/types.js';

/** Minimal mock rail for testing */
function createMockRail(
  id: PaymentRailId,
  opts?: {
    available?: boolean;
    parsesChallenge?: PaymentChallenge | null;
  },
): PaymentRail {
  return {
    id,
    name: `Mock ${id}`,
    isAvailable: async () => opts?.available ?? true,
    parseChallenge: () => opts?.parsesChallenge ?? null,
    executePayment: async () => ({
      success: true,
      proof: 'mock-proof',
      amount: { value: '100', currency: 'USDC', usdCents: 100 },
      settlementData: {},
      settlementMs: 50,
    }),
    buildAuthHeaders: () => ({ 'X-PAYMENT': 'mock' }),
    verifyPayment: async () => true,
    getBalance: async () => ({ value: '1000', currency: 'USDC', usdCents: 1000 }),
  };
}

const mockChallenge: PaymentChallenge = {
  rail: 'x402',
  amount: { value: '100', currency: 'USDC', usdCents: 100 },
  challengeData: { invoice: 'test' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  toolEndpoint: 'https://tool.example.com/api',
  challengeId: 'ch-001',
};

describe('PaymentRailRouter', () => {
  let router: PaymentRailRouter;

  beforeEach(() => {
    router = new PaymentRailRouter();
  });

  describe('registerRail / unregisterRail', () => {
    it('registers a rail and makes it retrievable', () => {
      const rail = createMockRail('x402');
      router.registerRail(rail);
      expect(router.getRail('x402')).toBe(rail);
      expect(router.getRegisteredRails()).toEqual(['x402']);
    });

    it('replaces a rail with the same ID', () => {
      router.registerRail(createMockRail('x402'));
      const replacement = createMockRail('x402');
      router.registerRail(replacement);
      expect(router.getRail('x402')).toBe(replacement);
      expect(router.getRegisteredRails()).toHaveLength(1);
    });

    it('unregisters a rail', () => {
      router.registerRail(createMockRail('x402'));
      expect(router.unregisterRail('x402')).toBe(true);
      expect(router.getRail('x402')).toBeUndefined();
    });

    it('returns false when unregistering a non-existent rail', () => {
      expect(router.unregisterRail('l402')).toBe(false);
    });

    it('supports multiple rails', () => {
      router.registerRail(createMockRail('x402'));
      router.registerRail(createMockRail('l402'));
      expect(router.getRegisteredRails()).toEqual(['x402', 'l402']);
    });
  });

  describe('getAvailableRails', () => {
    it('returns only available rails', async () => {
      router.registerRail(createMockRail('x402', { available: true }));
      router.registerRail(createMockRail('l402', { available: false }));
      const available = await router.getAvailableRails();
      expect(available).toEqual(['x402']);
    });

    it('returns empty when no rails registered', async () => {
      expect(await router.getAvailableRails()).toEqual([]);
    });
  });

  describe('parseChallenge', () => {
    it('returns null for non-402 status codes', () => {
      router.registerRail(createMockRail('x402', { parsesChallenge: mockChallenge }));
      expect(router.parseChallenge(200, {}, null)).toBeNull();
      expect(router.parseChallenge(401, {}, null)).toBeNull();
      expect(router.parseChallenge(500, {}, null)).toBeNull();
    });

    it('returns null when no rails are registered', () => {
      expect(router.parseChallenge(402, {}, null)).toBeNull();
    });

    it('routes 402 to the first matching rail', () => {
      router.registerRail(createMockRail('x402', { parsesChallenge: mockChallenge }));
      const result = router.parseChallenge(402, {}, null);
      expect(result).toEqual(mockChallenge);
    });

    it('skips rails that return null and tries the next', () => {
      const l402Challenge: PaymentChallenge = {
        ...mockChallenge,
        rail: 'l402',
        challengeId: 'ch-l402',
      };
      router.registerRail(createMockRail('x402', { parsesChallenge: null }));
      router.registerRail(createMockRail('l402', { parsesChallenge: l402Challenge }));
      const result = router.parseChallenge(402, {}, null);
      expect(result).toEqual(l402Challenge);
    });

    it('returns null when no rail can parse the challenge', () => {
      router.registerRail(createMockRail('x402', { parsesChallenge: null }));
      router.registerRail(createMockRail('l402', { parsesChallenge: null }));
      expect(router.parseChallenge(402, {}, null)).toBeNull();
    });
  });
});
