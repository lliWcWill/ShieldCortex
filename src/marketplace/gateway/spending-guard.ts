/**
 * Spending Guard — Two-phase spending control for the tool gateway.
 *
 * Problem: If we debit the wallet THEN attempt on-chain payment, a failed
 * payment leaves the wallet with the wrong balance. Solution: reserve first,
 * confirm or release after the on-chain result.
 *
 * Flow:
 *   1. reserveFunds() — validates limits + creates a hold
 *   2. confirmHold() — appends confirmation event + debits wallet
 *   3. releaseHold() — appends release event (balance restored)
 *
 * APPEND-ONLY: Holds are tracked as 'payment:hold' entries. Confirmations
 * and releases are SEPARATE events that reference the holdId — we never
 * mutate event_log rows, which would break the hash chain.
 *
 * Active holds = payment:hold events with no matching hold_confirmed/hold_released.
 */

import { getDatabase, withImmediateTransaction } from '../../database/init.js';
import { getWallet, shouldAutoApprove, debitWalletUnchecked } from '../wallet/wallet-manager.js';
import { appendEvent } from '../ledger/event-ledger.js';

/** Default hold TTL: 5 minutes. Holds older than this are considered expired. */
const HOLD_TTL_MS = 5 * 60 * 1000;

export interface HoldResult {
  holdId: number;
  approved: boolean;
  requiresStepUp: boolean;
  reason?: string;
}

/**
 * Get the sum of all active (unresolved, non-expired) holds for an agent.
 * A hold is active if no payment:hold_confirmed or payment:hold_released
 * event references it, and it hasn't exceeded the TTL.
 */
function getActiveHoldsCents(agentId: string): number {
  const db = getDatabase();
  try {
    const ttlCutoff = new Date(Date.now() - HOLD_TTL_MS).toISOString();
    const row = db.prepare(`
      SELECT COALESCE(SUM(
        CAST(json_extract(payload, '$.amountCents') AS INTEGER)
      ), 0) as total
      FROM event_log
      WHERE event_type = 'payment:hold'
        AND actor_id = @agent_id
        AND timestamp >= @ttl_cutoff
        AND id NOT IN (
          SELECT CAST(json_extract(payload, '$.holdId') AS INTEGER)
          FROM event_log
          WHERE event_type IN ('payment:hold_confirmed', 'payment:hold_released')
            AND actor_id = @agent_id
        )
    `).get({ agent_id: agentId, ttl_cutoff: ttlCutoff }) as { total: number } | undefined;
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
 *
 * CRITICAL: Entire function runs in withImmediateTransaction to prevent
 * TOCTOU race where concurrent callers both pass the balance check.
 */
export function reserveFunds(
  agentId: string,
  toolId: string,
  amountCents: number,
): HoldResult {
  if (amountCents <= 0) {
    return { holdId: 0, approved: false, requiresStepUp: false, reason: 'Amount must be positive' };
  }

  return withImmediateTransaction(() => {
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

    // Check daily limit (uses payment:hold_confirmed events)
    const db = getDatabase();
    let dailySpent = 0;
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const row = db.prepare(`
        SELECT COALESCE(SUM(
          CAST(json_extract(payload, '$.amountCents') AS INTEGER)
        ), 0) as total
        FROM event_log
        WHERE event_type = 'payment:hold_confirmed'
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
  });
}

/**
 * Confirm a hold — appends a confirmation event and debits the wallet.
 *
 * APPEND-ONLY: Does NOT mutate the original hold row. Instead appends a
 * 'payment:hold_confirmed' event that references the holdId. This preserves
 * hash chain integrity.
 *
 * Uses debitWalletUnchecked to skip redundant limit checks (already
 * validated during reserveFunds).
 */
export function confirmHold(
  holdId: number,
  settlementData?: Record<string, unknown>,
): { success: boolean; error?: string } {
  return withImmediateTransaction(() => {
    const db = getDatabase();

    // Find the hold event (must still be a 'payment:hold')
    const hold = db.prepare(
      "SELECT * FROM event_log WHERE id = ? AND event_type = 'payment:hold'",
    ).get(holdId) as Record<string, unknown> | undefined;

    if (!hold) {
      return { success: false, error: `Hold not found: ${holdId}` };
    }

    // Check if already confirmed or released
    const resolved = db.prepare(`
      SELECT id FROM event_log
      WHERE event_type IN ('payment:hold_confirmed', 'payment:hold_released')
        AND json_extract(payload, '$.holdId') = ?
    `).get(holdId);

    if (resolved) {
      return { success: false, error: `Hold ${holdId} already resolved` };
    }

    const payload = JSON.parse(hold.payload as string) as {
      toolId: string;
      amountCents: number;
      autoApproved: boolean;
    };
    const agentId = hold.actor_id as string;

    // Debit the wallet (unchecked — limits already validated in reserveFunds)
    const debitResult = debitWalletUnchecked(agentId, payload.amountCents);
    if (!debitResult.success) {
      return { success: false, error: `Debit failed: ${debitResult.error}` };
    }

    // Append confirmation event (preserves hash chain)
    appendEvent({
      eventType: 'payment:hold_confirmed',
      source: 'spending-guard',
      actorId: agentId,
      payload: {
        holdId,
        ...payload,
        confirmedAt: new Date().toISOString(),
        ...(settlementData ?? {}),
      },
    });

    return { success: true };
  });
}

/**
 * Release a hold — appends a release event when on-chain payment fails.
 *
 * APPEND-ONLY: Does NOT mutate the original hold row. Appends a
 * 'payment:hold_released' event that references the holdId.
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

    // Check if already confirmed or released
    const resolved = db.prepare(`
      SELECT id FROM event_log
      WHERE event_type IN ('payment:hold_confirmed', 'payment:hold_released')
        AND json_extract(payload, '$.holdId') = ?
    `).get(holdId);

    if (resolved) {
      return { success: false, error: `Hold ${holdId} already resolved` };
    }

    const payload = JSON.parse(hold.payload as string) as Record<string, unknown>;

    // Append release event (preserves hash chain)
    appendEvent({
      eventType: 'payment:hold_released',
      source: 'spending-guard',
      actorId: hold.actor_id as string,
      payload: {
        holdId,
        ...payload,
        releasedAt: new Date().toISOString(),
        releaseReason: reason ?? 'payment failed',
      },
    });

    return { success: true };
  });
}
