/**
 * X402 Rail Tests
 *
 * Tests the x402 payment rail boundary: parseChallenge header decoding,
 * isAvailable env var check, buildAuthHeaders, and executePayment flow.
 * All viem/x402 SDK calls are mocked — no real RPC or chain interaction.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Store original env
const originalEnv = { ...process.env };

describe('X402Rail', () => {
  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  describe('isAvailable', () => {
    it('returns false when EVM_PRIVATE_KEY is not set', async () => {
      delete process.env.EVM_PRIVATE_KEY;
      // Fresh import to reset initialized state
      const { X402Rail } = await import('../payments/rails/x402-rail.js');
      const rail = new X402Rail();
      expect(await rail.isAvailable()).toBe(false);
    });

    it('has correct id and name', async () => {
      const { X402Rail } = await import('../payments/rails/x402-rail.js');
      const rail = new X402Rail();
      expect(rail.id).toBe('x402');
      expect(rail.name).toContain('x402');
      expect(rail.name).toContain('USDC');
    });
  });

  describe('parseChallenge', () => {
    let X402Rail: typeof import('../payments/rails/x402-rail.js').X402Rail;

    beforeEach(async () => {
      const mod = await import('../payments/rails/x402-rail.js');
      X402Rail = mod.X402Rail;
    });

    it('returns null for non-402 status codes', () => {
      const rail = new X402Rail();
      expect(rail.parseChallenge(200, {}, null)).toBeNull();
      expect(rail.parseChallenge(401, {}, null)).toBeNull();
      expect(rail.parseChallenge(500, {}, null)).toBeNull();
    });

    it('returns null when no PAYMENT-REQUIRED header', () => {
      const rail = new X402Rail();
      expect(rail.parseChallenge(402, {}, null)).toBeNull();
      expect(rail.parseChallenge(402, { 'x-other': 'value' }, null)).toBeNull();
    });

    it('decodes a valid V2 PAYMENT-REQUIRED header', () => {
      const rail = new X402Rail();

      // Create a valid PaymentRequired payload and base64 encode it
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://tool.example.com/api', method: 'GET' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount: '10000', // 0.01 USDC (6 decimals)
            payTo: '0x1234567890abcdef1234567890abcdef12345678',
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      };

      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

      const result = rail.parseChallenge(402, { 'payment-required': encoded }, null);

      expect(result).not.toBeNull();
      expect(result!.rail).toBe('x402');
      expect(result!.amount.currency).toBe('USDC');
      expect(result!.amount.value).toBe('10000');
      // 10000 / 10000 = 1 cent
      expect(result!.amount.usdCents).toBe(1);
      expect(result!.toolEndpoint).toBe('https://tool.example.com/api');
      expect(result!.challengeId).toMatch(/^x402-/);
      expect(result!.challengeData).toHaveProperty('paymentRequired');
      expect(result!.challengeData).toHaveProperty('selectedRequirements');
    });

    it('handles case-insensitive header names', () => {
      const rail = new X402Rail();
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://tool.example.com', method: 'GET' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount: '100000', // 0.10 USDC
            payTo: '0xabc',
            maxTimeoutSeconds: 30,
            extra: {},
          },
        ],
      };

      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

      // Test PAYMENT-REQUIRED (uppercase)
      const result = rail.parseChallenge(402, { 'PAYMENT-REQUIRED': encoded }, null);
      expect(result).not.toBeNull();
      expect(result!.amount.usdCents).toBe(10);
    });

    it('returns null for malformed PAYMENT-REQUIRED header', () => {
      const rail = new X402Rail();
      expect(rail.parseChallenge(402, { 'payment-required': 'not-valid-base64!!!' }, null)).toBeNull();
    });

    it('returns null for empty accepts array', () => {
      const rail = new X402Rail();
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://tool.example.com', method: 'GET' },
        accepts: [],
      };
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');
      expect(rail.parseChallenge(402, { 'payment-required': encoded }, null)).toBeNull();
    });
  });

  describe('buildAuthHeaders', () => {
    it('returns Payment-Signature header', async () => {
      const { X402Rail } = await import('../payments/rails/x402-rail.js');
      const rail = new X402Rail();

      const headers = rail.buildAuthHeaders('base64-proof-token', {
        rail: 'x402',
        amount: { value: '10000', currency: 'USDC', usdCents: 1 },
        challengeData: {},
        expiresAt: new Date().toISOString(),
        toolEndpoint: 'https://example.com',
        challengeId: 'ch-test',
      });

      expect(headers).toHaveProperty('Payment-Signature');
      expect(headers['Payment-Signature']).toBe('base64-proof-token');
    });
  });

  describe('executePayment', () => {
    it('returns error when not initialized (no key)', async () => {
      delete process.env.EVM_PRIVATE_KEY;
      const { X402Rail } = await import('../payments/rails/x402-rail.js');
      const rail = new X402Rail();

      const result = await rail.executePayment({
        rail: 'x402',
        amount: { value: '10000', currency: 'USDC', usdCents: 1 },
        challengeData: {},
        expiresAt: new Date().toISOString(),
        toolEndpoint: 'https://example.com',
        challengeId: 'ch-test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });
  });

  describe('getBalance', () => {
    it('returns zero when not initialized', async () => {
      delete process.env.EVM_PRIVATE_KEY;
      const { X402Rail } = await import('../payments/rails/x402-rail.js');
      const rail = new X402Rail();

      const balance = await rail.getBalance();
      expect(balance.value).toBe('0');
      expect(balance.currency).toBe('USDC');
      expect(balance.usdCents).toBe(0);
    });
  });

  describe('getAddress', () => {
    it('returns null when not initialized', async () => {
      delete process.env.EVM_PRIVATE_KEY;
      const { X402Rail } = await import('../payments/rails/x402-rail.js');
      const rail = new X402Rail();

      expect(rail.getAddress()).toBeNull();
    });
  });
});
