/**
 * Tool Gateway Tests
 *
 * Tests the two-phase commit lifecycle (reserve → confirm/release),
 * 402 retry flow, error propagation, and spending guard integration.
 * Mocks: x402 rail, HTTP fetch, defence pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { initDatabase, closeDatabase } from '../../database/init.js';

// Dynamic imports so modules pick up the in-memory DB
let ToolGateway: typeof import('../gateway/tool-gateway.js').ToolGateway;
let PaymentRailRouter: typeof import('../payments/router.js').PaymentRailRouter;
let createWallet: typeof import('../wallet/wallet-manager.js').createWallet;
let getWallet: typeof import('../wallet/wallet-manager.js').getWallet;
let creditWallet: typeof import('../wallet/wallet-manager.js').creditWallet;
let freezeWallet: typeof import('../wallet/wallet-manager.js').freezeWallet;
let unfreezeWallet: typeof import('../wallet/wallet-manager.js').unfreezeWallet;
let queryEvents: typeof import('../ledger/event-ledger.js').queryEvents;

import type {
  PaymentRail,
  PaymentRailId,
  PaymentChallenge,
  PaymentResult,
  PaymentAmount,
} from '../payments/types.js';

/** Create a mock PaymentRail for testing */
function createMockRail(opts?: {
  available?: boolean;
  parsesChallenge?: PaymentChallenge | null;
  paymentResult?: PaymentResult;
}): PaymentRail {
  const defaultPaymentResult: PaymentResult = {
    success: true,
    proof: 'mock-proof-token',
    amount: { value: '10000', currency: 'USDC', usdCents: 1 },
    settlementData: { tx: '0xabc' },
    settlementMs: 42,
  };

  return {
    id: 'x402' as PaymentRailId,
    name: 'Mock x402',
    isAvailable: async () => opts?.available ?? true,
    parseChallenge: () => opts?.parsesChallenge ?? null,
    executePayment: async () => opts?.paymentResult ?? defaultPaymentResult,
    buildAuthHeaders: (proof: string) => ({ 'Payment-Signature': proof }),
    verifyPayment: async () => true,
    getBalance: async () => ({ value: '1000000', currency: 'USDC', usdCents: 100 }),
  };
}

const mockChallenge: PaymentChallenge = {
  rail: 'x402',
  amount: { value: '10000', currency: 'USDC', usdCents: 1 },
  challengeData: { invoice: 'test' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  toolEndpoint: 'https://tool.example.com/api',
  challengeId: 'ch-001',
};

// Mock fetch for gateway tests
let mockFetchResponses: Array<{
  status: number;
  headers: Record<string, string>;
  body: unknown;
}> = [];

let fetchCallCount = 0;
const originalFetch = globalThis.fetch;

function setupMockFetch() {
  fetchCallCount = 0;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const responseConfig = mockFetchResponses[fetchCallCount] ?? mockFetchResponses[0];
    fetchCallCount++;

    const headers = new Headers(responseConfig.headers);

    return {
      ok: responseConfig.status >= 200 && responseConfig.status < 300,
      status: responseConfig.status,
      headers,
      json: async () => responseConfig.body,
      text: async () => JSON.stringify(responseConfig.body),
    } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

beforeAll(async () => {
  initDatabase(':memory:');
  const gatewayMod = await import('../gateway/tool-gateway.js');
  ToolGateway = gatewayMod.ToolGateway;
  const routerMod = await import('../payments/router.js');
  PaymentRailRouter = routerMod.PaymentRailRouter;
  const walletMod = await import('../wallet/wallet-manager.js');
  createWallet = walletMod.createWallet;
  getWallet = walletMod.getWallet;
  creditWallet = walletMod.creditWallet;
  freezeWallet = walletMod.freezeWallet;
  unfreezeWallet = walletMod.unfreezeWallet;
  const ledgerMod = await import('../ledger/event-ledger.js');
  queryEvents = ledgerMod.queryEvents;
});

afterAll(() => {
  restoreFetch();
  closeDatabase();
});

describe('ToolGateway', () => {
  let router: InstanceType<typeof PaymentRailRouter>;
  let gateway: InstanceType<typeof ToolGateway>;

  beforeEach(() => {
    router = new PaymentRailRouter();
    // Disable trust check for unit tests (tested separately in pipeline.test.ts)
    gateway = new ToolGateway(router, false);
    mockFetchResponses = [];
    restoreFetch();
  });

  describe('successful non-payment call', () => {
    it('returns response directly when endpoint returns 200', async () => {
      // Create agent wallet
      createWallet('gw-agent-1', { initialBalanceCents: 5000 });

      setupMockFetch();
      mockFetchResponses = [
        { status: 200, headers: {}, body: { result: 'transcript data' } },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-1',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.paymentMade).toBe(false);
      expect(result.body).toEqual({ result: 'transcript data' });
      expect(fetchCallCount).toBe(1);
    });
  });

  describe('402 → pay → retry → success', () => {
    it('handles full payment flow with two-phase commit', async () => {
      createWallet('gw-agent-2', {
        initialBalanceCents: 5000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 50,
      });

      // Register a mock rail that parses the challenge
      router.registerRail(createMockRail({ parsesChallenge: mockChallenge }));

      // Create a base64-encoded PAYMENT-REQUIRED header for the mock 402
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://tool.example.com/api', method: 'GET' },
        accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '10000', payTo: '0xabc', maxTimeoutSeconds: 60, extra: {}, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }],
      };

      setupMockFetch();
      mockFetchResponses = [
        // First call: 402
        {
          status: 402,
          headers: {
            'payment-required': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
          },
          body: { error: 'Payment Required' },
        },
        // Retry after payment: 200
        {
          status: 200,
          headers: {},
          body: { result: 'paid content' },
        },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-2',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.paymentMade).toBe(true);
      expect(result.paymentAmount).toBe(1); // 1 cent
      expect(result.body).toEqual({ result: 'paid content' });
      expect(fetchCallCount).toBe(2); // initial 402 + retry

      // Verify wallet was debited
      const wallet = getWallet('gw-agent-2');
      expect(wallet!.balanceCents).toBe(4999); // 5000 - 1
    });
  });

  describe('payment failure → hold released', () => {
    it('releases hold when payment execution fails', async () => {
      createWallet('gw-agent-3', {
        initialBalanceCents: 5000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 50,
      });

      const failedPaymentResult: PaymentResult = {
        success: false,
        proof: '',
        amount: { value: '10000', currency: 'USDC', usdCents: 1 },
        settlementData: {},
        settlementMs: 100,
        error: 'Insufficient on-chain USDC',
      };

      router.registerRail(createMockRail({
        parsesChallenge: mockChallenge,
        paymentResult: failedPaymentResult,
      }));

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-3',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(false);
      expect(result.paymentMade).toBe(false);
      expect(result.error).toContain('Payment failed');

      // Wallet balance should be unchanged (hold was released)
      const wallet = getWallet('gw-agent-3');
      expect(wallet!.balanceCents).toBe(5000);
    });
  });

  describe('frozen wallet rejection', () => {
    it('denies payment when wallet is frozen', async () => {
      createWallet('gw-agent-4', { initialBalanceCents: 5000 });
      freezeWallet('gw-agent-4', 'suspicious activity');

      router.registerRail(createMockRail({ parsesChallenge: mockChallenge }));

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-4',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('frozen');
      expect(result.paymentMade).toBe(false);

      // Unfreeze for cleanup
      unfreezeWallet('gw-agent-4');
    });
  });

  describe('per-call limit exceeded', () => {
    it('denies payment when amount exceeds per-call limit', async () => {
      createWallet('gw-agent-5', {
        initialBalanceCents: 5000,
        perCallLimitCents: 0, // zero limit = deny everything
      });

      const expensiveChallenge: PaymentChallenge = {
        ...mockChallenge,
        amount: { value: '10000', currency: 'USDC', usdCents: 1 },
      };

      router.registerRail(createMockRail({ parsesChallenge: expensiveChallenge }));

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-5',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('denied');
      expect(result.paymentMade).toBe(false);
    });
  });

  describe('insufficient balance', () => {
    it('denies payment when wallet has no funds', async () => {
      createWallet('gw-agent-6', {
        initialBalanceCents: 0,
        perCallLimitCents: 100,
      });

      router.registerRail(createMockRail({ parsesChallenge: mockChallenge }));

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-6',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('denied');
      expect(result.paymentMade).toBe(false);
    });
  });

  describe('no rail registered', () => {
    it('returns error when 402 received but no rails registered', async () => {
      createWallet('gw-agent-7', { initialBalanceCents: 5000 });

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
      ];

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-7',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(402);
      expect(result.error).toContain('no registered rail');
    });
  });

  describe('network error', () => {
    it('handles network failure on initial call', async () => {
      createWallet('gw-agent-8', { initialBalanceCents: 5000 });

      // Make fetch throw
      globalThis.fetch = (() => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const result = await gateway.executeToolCall({
        agentId: 'gw-agent-8',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(0);
      expect(result.error).toContain('Network error');
    });
  });

  describe('event logging', () => {
    it('logs payment:challenge_received on 402', async () => {
      createWallet('gw-agent-9', {
        initialBalanceCents: 5000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 50,
      });

      router.registerRail(createMockRail({ parsesChallenge: mockChallenge }));

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
        { status: 200, headers: {}, body: { data: 'ok' } },
      ];

      await gateway.executeToolCall({
        agentId: 'gw-agent-9',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      // Check that challenge_received was logged
      const challenges = queryEvents('payment:challenge_received');
      const agentChallenges = challenges.filter(
        e => (e.payload as Record<string, unknown>).toolId === 'youtube-search'
          && e.actorId === 'gw-agent-9',
      );
      expect(agentChallenges.length).toBeGreaterThanOrEqual(1);
    });

    it('logs payment:confirmed after successful payment', async () => {
      createWallet('gw-agent-10', {
        initialBalanceCents: 5000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 50,
      });

      router.registerRail(createMockRail({ parsesChallenge: mockChallenge }));

      setupMockFetch();
      mockFetchResponses = [
        { status: 402, headers: { 'payment-required': 'dummy' }, body: null },
        { status: 200, headers: {}, body: { data: 'ok' } },
      ];

      await gateway.executeToolCall({
        agentId: 'gw-agent-10',
        toolId: 'youtube-search',
        endpoint: 'https://tool.example.com/api',
      });

      const confirmed = queryEvents('payment:confirmed');
      const agentConfirmed = confirmed.filter(
        e => e.actorId === 'gw-agent-10',
      );
      expect(agentConfirmed.length).toBeGreaterThanOrEqual(1);
    });
  });
});
