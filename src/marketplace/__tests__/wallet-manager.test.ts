/**
 * Wallet Manager Tests
 *
 * Tests wallet CRUD, debit/credit operations, freeze/unfreeze,
 * daily limit enforcement, and per-tool auto-approve thresholds.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { initDatabase, closeDatabase } from '../../database/init.js';

let createWallet: typeof import('../wallet/wallet-manager.js').createWallet;
let getWallet: typeof import('../wallet/wallet-manager.js').getWallet;
let listWallets: typeof import('../wallet/wallet-manager.js').listWallets;
let debitWallet: typeof import('../wallet/wallet-manager.js').debitWallet;
let creditWallet: typeof import('../wallet/wallet-manager.js').creditWallet;
let freezeWallet: typeof import('../wallet/wallet-manager.js').freezeWallet;
let unfreezeWallet: typeof import('../wallet/wallet-manager.js').unfreezeWallet;
let getAutoApproveThreshold: typeof import('../wallet/wallet-manager.js').getAutoApproveThreshold;
let setToolAutoApproveThreshold: typeof import('../wallet/wallet-manager.js').setToolAutoApproveThreshold;
let shouldAutoApprove: typeof import('../wallet/wallet-manager.js').shouldAutoApprove;

beforeAll(async () => {
  initDatabase(':memory:');
  const mod = await import('../wallet/wallet-manager.js');
  createWallet = mod.createWallet;
  getWallet = mod.getWallet;
  listWallets = mod.listWallets;
  debitWallet = mod.debitWallet;
  creditWallet = mod.creditWallet;
  freezeWallet = mod.freezeWallet;
  unfreezeWallet = mod.unfreezeWallet;
  getAutoApproveThreshold = mod.getAutoApproveThreshold;
  setToolAutoApproveThreshold = mod.setToolAutoApproveThreshold;
  shouldAutoApprove = mod.shouldAutoApprove;
});

afterAll(() => {
  closeDatabase();
});

describe('Wallet Manager', () => {
  describe('createWallet / getWallet', () => {
    it('creates a wallet with defaults', () => {
      const wallet = createWallet('agent-001');
      expect(wallet.agentId).toBe('agent-001');
      expect(wallet.balanceCents).toBe(0);
      expect(wallet.dailyLimitCents).toBe(500);
      expect(wallet.perCallLimitCents).toBe(100);
      expect(wallet.autoApproveThresholdCents).toBe(50);
      expect(wallet.frozen).toBe(false);
      expect(wallet.allowedTools).toEqual(['*']);
      expect(wallet.allowedRails).toEqual(['x402']);
    });

    it('creates a wallet with custom options', () => {
      const wallet = createWallet('agent-002', {
        displayName: 'Test Agent',
        dailyLimitCents: 2000,
        perCallLimitCents: 500,
        initialBalanceCents: 10000,
        allowedTools: ['youtube-search', 'weather'],
        allowedRails: ['x402', 'l402'],
        autoApproveThresholdCents: 200,
      });
      expect(wallet.displayName).toBe('Test Agent');
      expect(wallet.dailyLimitCents).toBe(2000);
      expect(wallet.perCallLimitCents).toBe(500);
      expect(wallet.balanceCents).toBe(10000);
      expect(wallet.allowedTools).toEqual(['youtube-search', 'weather']);
      expect(wallet.allowedRails).toEqual(['x402', 'l402']);
      expect(wallet.autoApproveThresholdCents).toBe(200);
    });

    it('retrieves wallet by agent ID', () => {
      const wallet = getWallet('agent-001');
      expect(wallet).not.toBeNull();
      expect(wallet!.agentId).toBe('agent-001');
    });

    it('returns null for non-existent wallet', () => {
      expect(getWallet('agent-nonexistent')).toBeNull();
    });
  });

  describe('listWallets', () => {
    it('lists all wallets', () => {
      const wallets = listWallets();
      expect(wallets.length).toBeGreaterThanOrEqual(2);
      const ids = wallets.map(w => w.agentId);
      expect(ids).toContain('agent-001');
      expect(ids).toContain('agent-002');
    });
  });

  describe('creditWallet', () => {
    it('adds funds to a wallet', () => {
      const result = creditWallet('agent-001', 5000);
      expect(result.success).toBe(true);
      expect(result.balanceCents).toBe(5000);
    });

    it('rejects zero or negative amounts', () => {
      expect(creditWallet('agent-001', 0).success).toBe(false);
      expect(creditWallet('agent-001', -100).success).toBe(false);
    });

    it('returns error for non-existent wallet', () => {
      const result = creditWallet('agent-ghost', 100);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('debitWallet', () => {
    it('debits from wallet within limits', () => {
      const result = debitWallet('agent-001', 50);
      expect(result.success).toBe(true);
      expect(result.balanceCents).toBe(4950);
    });

    it('rejects zero or negative amounts', () => {
      expect(debitWallet('agent-001', 0).success).toBe(false);
      expect(debitWallet('agent-001', -10).success).toBe(false);
    });

    it('rejects amounts exceeding per-call limit', () => {
      const result = debitWallet('agent-001', 200); // limit is 100
      expect(result.success).toBe(false);
      expect(result.error).toContain('per-call limit');
    });

    it('rejects amounts exceeding balance', () => {
      // agent-001 has 4950 cents, per-call limit 100
      // Create a wallet with high per-call limit but low balance
      createWallet('agent-low-bal', {
        perCallLimitCents: 10000,
        dailyLimitCents: 50000,
        initialBalanceCents: 50,
      });
      const result = debitWallet('agent-low-bal', 100);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');
    });

    it('returns error for non-existent wallet', () => {
      const result = debitWallet('agent-ghost', 10);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('updates totalSpentCents after successful debit', () => {
      debitWallet('agent-001', 25);
      const wallet = getWallet('agent-001');
      expect(wallet!.totalSpentCents).toBeGreaterThanOrEqual(25);
    });
  });

  describe('freeze / unfreeze', () => {
    it('freezes a wallet with a reason', () => {
      const success = freezeWallet('agent-001', 'anomalous spending');
      expect(success).toBe(true);
      const wallet = getWallet('agent-001');
      expect(wallet!.frozen).toBe(true);
      expect(wallet!.frozenReason).toBe('anomalous spending');
    });

    it('rejects debits on a frozen wallet', () => {
      const result = debitWallet('agent-001', 10);
      expect(result.success).toBe(false);
      expect(result.error).toContain('frozen');
    });

    it('unfreezes a wallet', () => {
      const success = unfreezeWallet('agent-001');
      expect(success).toBe(true);
      const wallet = getWallet('agent-001');
      expect(wallet!.frozen).toBe(false);
      expect(wallet!.frozenReason).toBeNull();
    });

    it('allows debits after unfreezing', () => {
      const result = debitWallet('agent-001', 10);
      expect(result.success).toBe(true);
    });

    it('returns false for non-existent wallet freeze', () => {
      expect(freezeWallet('agent-ghost', 'test')).toBe(false);
    });
  });

  describe('auto-approve thresholds', () => {
    it('returns agent-level default when no per-tool override', () => {
      const threshold = getAutoApproveThreshold('agent-002', 'any-tool');
      expect(threshold).toBe(200); // agent-002 has 200 cent threshold
    });

    it('returns global default for non-existent wallet', () => {
      const threshold = getAutoApproveThreshold('agent-ghost', 'any-tool');
      expect(threshold).toBe(50); // code default
    });

    it('sets and retrieves per-tool override', () => {
      setToolAutoApproveThreshold('agent-002', 'expensive-tool', 25);
      const threshold = getAutoApproveThreshold('agent-002', 'expensive-tool');
      expect(threshold).toBe(25);
    });

    it('per-tool override does not affect other tools', () => {
      const threshold = getAutoApproveThreshold('agent-002', 'other-tool');
      expect(threshold).toBe(200); // still agent-level default
    });

    it('updates existing per-tool override (upsert)', () => {
      setToolAutoApproveThreshold('agent-002', 'expensive-tool', 75);
      expect(getAutoApproveThreshold('agent-002', 'expensive-tool')).toBe(75);
    });

    it('shouldAutoApprove returns true below threshold', () => {
      expect(shouldAutoApprove('agent-002', 'other-tool', 100)).toBe(true);
    });

    it('shouldAutoApprove returns false above threshold', () => {
      expect(shouldAutoApprove('agent-002', 'other-tool', 300)).toBe(false);
    });

    it('shouldAutoApprove respects per-tool override', () => {
      // expensive-tool has 75 cent override
      expect(shouldAutoApprove('agent-002', 'expensive-tool', 50)).toBe(true);
      expect(shouldAutoApprove('agent-002', 'expensive-tool', 100)).toBe(false);
    });
  });
});
