/**
 * Spending Guard — Two-phase spending control for the tool gateway.
 *
 * Problem: If we debit the wallet THEN attempt on-chain payment, a failed
 * payment leaves the wallet with the wrong balance. Solution: reserve first,
 * confirm or release after the on-chain result.
 *
 * Flow:
 *   1. reserveFunds() — validates limits + creates a hold
 *   2. confirmHold() — converts hold to permanent debit (payment succeeded)
 *   3. releaseHold() — cancels the hold (payment failed, balance restored)
 *
 * Holds are tracked in the event_log as 'payment:hold' entries.
 * Available balance = balance_cents - sum(active holds).
 */

import { getDatabase, withImmediateTransaction } from '../../database/init.js';
import { getWallet, shouldAutoApprove, debitWallet } from '../wallet/wallet-manager.js';
import { appendEvent } from '../ledger/event-ledger.js';

export interface HoldResult {
  holdId: number;
  approved: boolean;
  requiresStepUp: boolean;
  reason?: string;
}

/**
 * Get the sum of all active holds for an agent.
 */
function getActiveHoldsCents(agentId: string): number {
  const db = getDatabase();
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(
        CAST(json_extract(payload, '$.amountCents') AS INTEGER)
      ), 0) as total
      FROM event_log
      WHERE event_type = 'payment:hold'
        AND actor_id = @agent_id
    `).get({ agent_id: agentId }) as { total: number } | undefined;
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Reserve funds for an upcoming payment.
 *
 * Validates: wallet existence, frozen state, per-call limit, daily limit,
 * available balance (balance - active holds), and auto-approve threshold.
 *
 * Creates a hold entry in the event_log if all checks pass.
 */
export function reserveFunds(
  agentId: string,
  toolId: string,
  amountCents: number,
): HoldResult {
  if (amountCents <= 0) {
    return { holdId: 0, approved: false, requiresStepUp: false, reason: 'Amount must be positive' };
  }

  const wallet = getWallet(agentId);
  if (!wallet) {
    return { holdId: 0, approved: false, requiresStepUp: false, reason: `Wallet not found: ${agentId}` };
  }

  if (wallet.frozen) {
    return {
      holdId: 0,
      approved: false,
      requiresStepUp: false,
      reason: `Wallet frozen: ${wallet.frozenReason ?? 'no reason given'}`,
    };
  }

  if (amountCents > wallet.perCallLimitCents) {
    return {
      holdId: 0,
      approved: false,
      requiresStepUp: false,
      reason: `Amount ${amountCents} exceeds per-call limit ${wallet.perCallLimitCents}`,
    };
  }

  // Check available balance (balance minus active holds)
  const activeHolds = getActiveHoldsCents(agentId);
  const availableBalance = wallet.balanceCents - activeHolds;

  if (amountCents > availableBalance) {
    return {
      holdId: 0,
      approved: false,
      requiresStepUp: false,
      reason: `Insufficient available balance: ${availableBalance} cents (${wallet.balanceCents} - ${activeHolds} held) < ${amountCents}`,
    };
  }

  // Check daily limit
  const db = getDatabase();
  let dailySpent = 0;
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT COALESCE(SUM(
        CAST(json_extract(payload, '$.amount.usdCents') AS INTEGER)
      ), 0) as total
      FROM event_log
      WHERE event_type = 'payment:confirmed'
        AND actor_id = @agent_id
        AND timestamp >= @cutoff
    `).get({ agent_id: agentId, cutoff }) as { total: number } | undefined;
    dailySpent = row?.total ?? 0;
  } catch {
    // event_log query failed — allow the operation
  }

  if (dailySpent + amountCents > wallet.dailyLimitCents) {
    return {
      holdId: 0,
      approved: false,
      requiresStepUp: false,
      reason: `Daily limit exceeded: spent ${dailySpent} + ${amountCents} > limit ${wallet.dailyLimitCents}`,
    };
  }

  // Check auto-approve threshold
  const autoApproved = shouldAutoApprove(agentId, toolId, amountCents);

  // Create hold entry in event_log
  const holdEvent = appendEvent({
    eventType: 'payment:hold',
    source: 'spending-guard',
    actorId: agentId,
    payload: {
      toolId,
      amountCents,
      autoApproved,
    },
  });

  return {
    holdId: holdEvent.id,
    approved: autoApproved,
    requiresStepUp: !autoApproved,
  };
}

/**
 * Confirm a hold — converts to permanent debit after successful on-chain payment.
 *
 * Updates the hold event_type to 'payment:confirmed' and debits the wallet.
 */
export function confirmHold(
  holdId: number,
  settlementData?: Record<string, unknown>,
): { success: boolean; error?: string } {
  return withImmediateTransaction(() => {
    const db = getDatabase();

    // Find the hold event
    const hold = db.prepare(
      "SELECT * FROM event_log WHERE id = ? AND event_type = 'payment:hold'",
    ).get(holdId) as Record<string, unknown> | undefined;

    if (!hold) {
      return { success: false, error: `Hold not found: ${holdId}` };
    }

    const payload = JSON.parse(hold.payload as string) as {
      toolId: string;
      amountCents: number;
      autoApproved: boolean;
    };
    const agentId = hold.actor_id as string;

    // Debit the wallet
    const debitResult = debitWallet(agentId, payload.amountCents);
    if (!debitResult.success) {
      return { success: false, error: `Debit failed: ${debitResult.error}` };
    }

    // Update the hold to confirmed
    db.prepare(
      "UPDATE event_log SET event_type = 'payment:confirmed', payload = @payload WHERE id = @id",
    ).run({
      id: holdId,
      payload: JSON.stringify({
        ...payload,
        confirmedAt: new Date().toISOString(),
        ...(settlementData ?? {}),
      }),
    });

    return { success: true };
  });
}

/**
 * Release a hold — cancels it when on-chain payment fails.
 * Deletes the hold entry so the balance is restored.
 */
export function releaseHold(
  holdId: number,
  reason?: string,
): { success: boolean; error?: string } {
  return withImmediateTransaction(() => {
    const db = getDatabase();

    const hold = db.prepare(
      "SELECT * FROM event_log WHERE id = ? AND event_type = 'payment:hold'",
    ).get(holdId) as Record<string, unknown> | undefined;

    if (!hold) {
      return { success: false, error: `Hold not found: ${holdId}` };
    }

    const payload = JSON.parse(hold.payload as string) as Record<string, unknown>;

    // Convert to a failed event instead of deleting (preserves audit trail)
    db.prepare(
      "UPDATE event_log SET event_type = 'payment:hold_released', payload = @payload WHERE id = @id",
    ).run({
      id: holdId,
      payload: JSON.stringify({
        ...payload,
        releasedAt: new Date().toISOString(),
        releaseReason: reason ?? 'payment failed',
      }),
    });

    return { success: true };
  });
}
