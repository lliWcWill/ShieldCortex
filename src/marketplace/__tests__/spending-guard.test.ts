/**
 * Spending Guard Tests — two-phase commit lifecycle.
 *
 * Tests reserveFunds, confirmHold, releaseHold directly against
 * in-memory SQLite. Covers: lifecycle, double-confirm, double-release,
 * confirm-after-release, hold TTL, active holds reducing balance,
 * daily limits, concurrent holds, edge cases.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { initDatabase, closeDatabase, getDatabase } from '../../database/init.js';

// Dynamic imports so modules pick up the in-memory DB
let reserveFunds: typeof import('../gateway/spending-guard.js').reserveFunds;
let confirmHold: typeof import('../gateway/spending-guard.js').confirmHold;
let releaseHold: typeof import('../gateway/spending-guard.js').releaseHold;
let createWallet: typeof import('../wallet/wallet-manager.js').createWallet;
let getWallet: typeof import('../wallet/wallet-manager.js').getWallet;
let queryEvents: typeof import('../ledger/event-ledger.js').queryEvents;
let verifyChain: typeof import('../ledger/event-ledger.js').verifyChain;
let appendEvent: typeof import('../ledger/event-ledger.js').appendEvent;
let freezeWallet: typeof import('../wallet/wallet-manager.js').freezeWallet;
let unfreezeWallet: typeof import('../wallet/wallet-manager.js').unfreezeWallet;

beforeAll(async () => {
  initDatabase(':memory:');
  const guard = await import('../gateway/spending-guard.js');
  reserveFunds = guard.reserveFunds;
  confirmHold = guard.confirmHold;
  releaseHold = guard.releaseHold;
  const wallet = await import('../wallet/wallet-manager.js');
  createWallet = wallet.createWallet;
  getWallet = wallet.getWallet;
  freezeWallet = wallet.freezeWallet;
  unfreezeWallet = wallet.unfreezeWallet;
  const ledger = await import('../ledger/event-ledger.js');
  queryEvents = ledger.queryEvents;
  verifyChain = ledger.verifyChain;
  appendEvent = ledger.appendEvent;
});

afterAll(() => {
  closeDatabase();
});

describe('SpendingGuard', () => {
  // ─── reserveFunds ───────────────────────────────────────────

  describe('reserveFunds', () => {
    it('rejects zero amount', () => {
      createWallet('sg-zero', { initialBalanceCents: 1000, perCallLimitCents: 100 });
      const result = reserveFunds('sg-zero', 'tool-a', 0);
      expect(result.holdId).toBe(0);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('positive');
    });

    it('rejects negative amount', () => {
      createWallet('sg-neg', { initialBalanceCents: 1000, perCallLimitCents: 100 });
      const result = reserveFunds('sg-neg', 'tool-a', -5);
      expect(result.holdId).toBe(0);
      expect(result.reason).toContain('positive');
    });

    it('rejects when wallet not found', () => {
      const result = reserveFunds('sg-ghost', 'tool-a', 10);
      expect(result.holdId).toBe(0);
      expect(result.reason).toContain('not found');
    });

    it('rejects when wallet is frozen', () => {
      createWallet('sg-frozen', { initialBalanceCents: 1000, perCallLimitCents: 100 });
      freezeWallet('sg-frozen', 'test freeze');
      const result = reserveFunds('sg-frozen', 'tool-a', 10);
      expect(result.holdId).toBe(0);
      expect(result.reason).toContain('frozen');
      unfreezeWallet('sg-frozen');
    });

    it('rejects when amount exceeds per-call limit', () => {
      createWallet('sg-limit', { initialBalanceCents: 1000, perCallLimitCents: 5 });
      const result = reserveFunds('sg-limit', 'tool-a', 10);
      expect(result.holdId).toBe(0);
      expect(result.reason).toContain('per-call limit');
    });

    it('rejects when insufficient balance', () => {
      createWallet('sg-broke', { initialBalanceCents: 5, perCallLimitCents: 100 });
      const result = reserveFunds('sg-broke', 'tool-a', 10);
      expect(result.holdId).toBe(0);
      expect(result.reason).toContain('Insufficient');
    });

    it('succeeds and creates hold event', () => {
      createWallet('sg-ok', {
        initialBalanceCents: 1000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 50,
      });
      const result = reserveFunds('sg-ok', 'tool-a', 10);
      expect(result.holdId).toBeGreaterThan(0);
      expect(result.approved).toBe(true); // 10 <= 50 auto-approve
      expect(result.requiresStepUp).toBe(false);
    });

    it('returns requiresStepUp when above auto-approve threshold', () => {
      createWallet('sg-stepup', {
        initialBalanceCents: 1000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 5,
      });
      const result = reserveFunds('sg-stepup', 'tool-a', 10);
      expect(result.holdId).toBeGreaterThan(0);
      expect(result.approved).toBe(false);
      expect(result.requiresStepUp).toBe(true);
      // Clean up: release the hold
      releaseHold(result.holdId);
    });

    it('reduces available balance by active holds', () => {
      createWallet('sg-holds', {
        initialBalanceCents: 20,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      // First hold: 10 cents — should succeed
      const hold1 = reserveFunds('sg-holds', 'tool-a', 10);
      expect(hold1.holdId).toBeGreaterThan(0);

      // Second hold: 10 cents — should succeed (20 - 10 held = 10 available)
      const hold2 = reserveFunds('sg-holds', 'tool-b', 10);
      expect(hold2.holdId).toBeGreaterThan(0);

      // Third hold: 1 cent — should fail (20 - 20 held = 0 available)
      const hold3 = reserveFunds('sg-holds', 'tool-c', 1);
      expect(hold3.holdId).toBe(0);
      expect(hold3.reason).toContain('Insufficient');

      // Clean up
      releaseHold(hold1.holdId);
      releaseHold(hold2.holdId);
    });

    it('released holds free up balance for new holds', () => {
      createWallet('sg-release-reuse', {
        initialBalanceCents: 10,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold1 = reserveFunds('sg-release-reuse', 'tool-a', 10);
      expect(hold1.holdId).toBeGreaterThan(0);

      // Can't reserve more — all balance held
      const hold2 = reserveFunds('sg-release-reuse', 'tool-b', 5);
      expect(hold2.holdId).toBe(0);

      // Release the first hold
      releaseHold(hold1.holdId);

      // Now we can reserve again
      const hold3 = reserveFunds('sg-release-reuse', 'tool-c', 5);
      expect(hold3.holdId).toBeGreaterThan(0);

      releaseHold(hold3.holdId);
    });

    it('enforces daily limit via confirmed holds', () => {
      createWallet('sg-daily', {
        initialBalanceCents: 10000,
        perCallLimitCents: 100,
        dailyLimitCents: 15,
        autoApproveThresholdCents: 100,
      });

      // Hold + confirm = 10 cents daily spend
      const h1 = reserveFunds('sg-daily', 'tool-a', 10);
      expect(h1.holdId).toBeGreaterThan(0);
      confirmHold(h1.holdId);

      // Next hold for 10 more — exceeds daily limit of 15 (10 + 10 > 15)
      const h2 = reserveFunds('sg-daily', 'tool-b', 10);
      expect(h2.holdId).toBe(0);
      expect(h2.reason).toContain('Daily limit');

      // But 5 cents should still work (10 + 5 = 15 <= 15)
      const h3 = reserveFunds('sg-daily', 'tool-c', 5);
      expect(h3.holdId).toBeGreaterThan(0);
      releaseHold(h3.holdId);
    });

    it('creates payment:hold event with correct payload', () => {
      createWallet('sg-event-check', {
        initialBalanceCents: 1000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 50,
      });

      const result = reserveFunds('sg-event-check', 'my-tool', 25);
      expect(result.holdId).toBeGreaterThan(0);

      // Verify the hold event was logged
      const events = queryEvents('payment:hold');
      const holdEvent = events.find(
        e => e.id === result.holdId && e.actorId === 'sg-event-check',
      );
      expect(holdEvent).toBeDefined();
      const payload = holdEvent!.payload as Record<string, unknown>;
      expect(payload.toolId).toBe('my-tool');
      expect(payload.amountCents).toBe(25);
      expect(payload.autoApproved).toBe(true);

      releaseHold(result.holdId);
    });
  });

  // ─── confirmHold ────────────────────────────────────────────

  describe('confirmHold', () => {
    it('debits wallet and appends hold_confirmed event', () => {
      createWallet('sg-confirm', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-confirm', 'tool-a', 25);
      expect(hold.holdId).toBeGreaterThan(0);

      const result = confirmHold(hold.holdId, { rail: 'x402', proof: 'abc' });
      expect(result.success).toBe(true);

      // Wallet debited
      const wallet = getWallet('sg-confirm');
      expect(wallet!.balanceCents).toBe(75); // 100 - 25

      // hold_confirmed event exists
      const confirmed = queryEvents('payment:hold_confirmed');
      const match = confirmed.find(
        e => (e.payload as Record<string, unknown>).holdId === hold.holdId,
      );
      expect(match).toBeDefined();
      expect((match!.payload as Record<string, unknown>).amountCents).toBe(25);
    });

    it('rejects when hold does not exist', () => {
      const result = confirmHold(999999);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects double-confirm (already confirmed)', () => {
      createWallet('sg-dblconfirm', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-dblconfirm', 'tool-a', 10);
      confirmHold(hold.holdId);

      // Second confirm should fail
      const result = confirmHold(hold.holdId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already resolved');

      // Wallet should only be debited once (100 - 10 = 90, NOT 80)
      const wallet = getWallet('sg-dblconfirm');
      expect(wallet!.balanceCents).toBe(90);
    });

    it('rejects confirm-after-release', () => {
      createWallet('sg-conf-after-rel', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-conf-after-rel', 'tool-a', 10);
      releaseHold(hold.holdId);

      const result = confirmHold(hold.holdId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already resolved');

      // Balance unchanged (no debit occurred)
      const wallet = getWallet('sg-conf-after-rel');
      expect(wallet!.balanceCents).toBe(100);
    });

    it('includes settlement data in confirmed event payload', () => {
      createWallet('sg-settle', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-settle', 'tool-a', 5);
      confirmHold(hold.holdId, {
        rail: 'x402',
        proof: 'proof-123',
        settlementMs: 42,
      });

      const confirmed = queryEvents('payment:hold_confirmed');
      const match = confirmed.find(
        e => (e.payload as Record<string, unknown>).holdId === hold.holdId,
      );
      expect(match).toBeDefined();
      const p = match!.payload as Record<string, unknown>;
      expect(p.rail).toBe('x402');
      expect(p.proof).toBe('proof-123');
      expect(p.settlementMs).toBe(42);
      expect(p.confirmedAt).toBeDefined();
    });

    it('updates totalSpentCents on wallet', () => {
      createWallet('sg-totalspent', {
        initialBalanceCents: 1000,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const w0 = getWallet('sg-totalspent');
      expect(w0!.totalSpentCents).toBe(0);

      const h1 = reserveFunds('sg-totalspent', 'tool-a', 10);
      confirmHold(h1.holdId);
      const w1 = getWallet('sg-totalspent');
      expect(w1!.totalSpentCents).toBe(10);

      const h2 = reserveFunds('sg-totalspent', 'tool-b', 20);
      confirmHold(h2.holdId);
      const w2 = getWallet('sg-totalspent');
      expect(w2!.totalSpentCents).toBe(30);
    });
  });

  // ─── releaseHold ────────────────────────────────────────────

  describe('releaseHold', () => {
    it('appends hold_released event without debiting', () => {
      createWallet('sg-release', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-release', 'tool-a', 25);
      const result = releaseHold(hold.holdId, 'payment failed');
      expect(result.success).toBe(true);

      // Balance unchanged
      const wallet = getWallet('sg-release');
      expect(wallet!.balanceCents).toBe(100);

      // Event logged
      const released = queryEvents('payment:hold_released');
      const match = released.find(
        e => (e.payload as Record<string, unknown>).holdId === hold.holdId,
      );
      expect(match).toBeDefined();
      expect((match!.payload as Record<string, unknown>).releaseReason).toBe('payment failed');
    });

    it('rejects when hold does not exist', () => {
      const result = releaseHold(999998);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects double-release', () => {
      createWallet('sg-dblrelease', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-dblrelease', 'tool-a', 10);
      releaseHold(hold.holdId, 'first release');
      const result = releaseHold(hold.holdId, 'second release');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already resolved');
    });

    it('rejects release-after-confirm', () => {
      createWallet('sg-rel-after-conf', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-rel-after-conf', 'tool-a', 10);
      confirmHold(hold.holdId);
      const result = releaseHold(hold.holdId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already resolved');
    });

    it('uses default release reason when none provided', () => {
      createWallet('sg-default-reason', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-default-reason', 'tool-a', 5);
      releaseHold(hold.holdId);

      const released = queryEvents('payment:hold_released');
      const match = released.find(
        e => (e.payload as Record<string, unknown>).holdId === hold.holdId,
      );
      expect((match!.payload as Record<string, unknown>).releaseReason).toBe('payment failed');
    });
  });

  // ─── Hold TTL ───────────────────────────────────────────────

  describe('hold TTL expiry', () => {
    it('expired holds do not reduce available balance', () => {
      createWallet('sg-ttl', {
        initialBalanceCents: 20,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      // Create a hold event manually with a timestamp 6 minutes ago (beyond 5-min TTL)
      const db = getDatabase();
      const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();

      // Insert an old hold directly into event_log to simulate TTL expiry
      // We need to go through appendEvent for chain integrity, then backdate it
      const holdEvent = appendEvent({
        eventType: 'payment:hold',
        source: 'spending-guard',
        actorId: 'sg-ttl',
        payload: { toolId: 'old-tool', amountCents: 15, autoApproved: true },
      });

      // Backdate the timestamp (test-only — simulates passage of time)
      db.prepare('UPDATE event_log SET timestamp = ? WHERE id = ?').run(
        sixMinAgo,
        holdEvent.id,
      );

      // The expired hold (15 cents) should NOT reduce available balance
      // So we should be able to reserve up to 20 cents
      const result = reserveFunds('sg-ttl', 'tool-a', 20);
      expect(result.holdId).toBeGreaterThan(0);

      releaseHold(result.holdId);
    });

    it('non-expired holds still reduce available balance', () => {
      createWallet('sg-ttl-active', {
        initialBalanceCents: 20,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      // Create a recent hold (within TTL)
      const hold = reserveFunds('sg-ttl-active', 'tool-a', 15);
      expect(hold.holdId).toBeGreaterThan(0);

      // Try to reserve more than available (20 - 15 = 5 available)
      const hold2 = reserveFunds('sg-ttl-active', 'tool-b', 10);
      expect(hold2.holdId).toBe(0);
      expect(hold2.reason).toContain('Insufficient');

      releaseHold(hold.holdId);
    });
  });

  // ─── Multi-agent isolation ──────────────────────────────────

  describe('multi-agent isolation', () => {
    it('holds from one agent do not affect another', () => {
      createWallet('sg-alice', {
        initialBalanceCents: 50,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });
      createWallet('sg-bob', {
        initialBalanceCents: 50,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      // Alice holds 50 cents (all her balance)
      const aliceHold = reserveFunds('sg-alice', 'tool-a', 50);
      expect(aliceHold.holdId).toBeGreaterThan(0);

      // Bob can still reserve his full 50 cents — Alice's hold doesn't affect him
      const bobHold = reserveFunds('sg-bob', 'tool-b', 50);
      expect(bobHold.holdId).toBeGreaterThan(0);

      releaseHold(aliceHold.holdId);
      releaseHold(bobHold.holdId);
    });
  });

  // ─── Hash chain integrity ──────────────────────────────────

  describe('hash chain integrity', () => {
    it('chain remains valid after reserve + confirm', () => {
      createWallet('sg-chain-ok', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-chain-ok', 'tool-a', 10);
      confirmHold(hold.holdId);

      const broken = verifyChain();
      expect(broken).toBeNull();
    });

    it('chain remains valid after reserve + release', () => {
      createWallet('sg-chain-rel', {
        initialBalanceCents: 100,
        perCallLimitCents: 100,
        autoApproveThresholdCents: 100,
      });

      const hold = reserveFunds('sg-chain-rel', 'tool-a', 10);
      releaseHold(hold.holdId, 'test release');

      const broken = verifyChain();
      expect(broken).toBeNull();
    });
  });
});
