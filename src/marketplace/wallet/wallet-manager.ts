/**
 * Wallet Manager — CRUD + debit/credit operations for agent wallets.
 * All monetary values are INTEGER cents. No floats in the money path.
 */

import { getDatabase, withImmediateTransaction } from '../../database/init.js';
import type { WalletOperationResult } from '../types.js';

export interface AgentWallet {
  id: number;
  agentId: string;
  displayName: string | null;
  dailyLimitCents: number;
  perCallLimitCents: number;
  balanceCents: number;
  totalSpentCents: number;
  allowedTools: string[];
  allowedRails: string[];
  autoApproveThresholdCents: number;
  frozen: boolean;
  frozenReason: string | null;
  createdAt: string;
  lastReplenished: string;
}

/**
 * Create a new agent wallet.
 */
export function createWallet(
  agentId: string,
  options?: {
    displayName?: string;
    dailyLimitCents?: number;
    perCallLimitCents?: number;
    initialBalanceCents?: number;
    allowedTools?: string[];
    allowedRails?: string[];
    autoApproveThresholdCents?: number;
  },
): AgentWallet {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO agent_wallets (
      agent_id, display_name,
      daily_limit_cents, per_call_limit_cents,
      balance_cents, allowed_tools, allowed_rails,
      auto_approve_threshold_cents
    ) VALUES (
      @agent_id, @display_name,
      @daily_limit_cents, @per_call_limit_cents,
      @balance_cents, @allowed_tools, @allowed_rails,
      @auto_approve_threshold_cents
    )
  `).run({
    agent_id: agentId,
    display_name: options?.displayName ?? null,
    daily_limit_cents: options?.dailyLimitCents ?? 500,
    per_call_limit_cents: options?.perCallLimitCents ?? 100,
    balance_cents: options?.initialBalanceCents ?? 0,
    allowed_tools: JSON.stringify(options?.allowedTools ?? ['*']),
    allowed_rails: JSON.stringify(options?.allowedRails ?? ['x402']),
    auto_approve_threshold_cents: options?.autoApproveThresholdCents ?? 50,
  });

  const wallet = getWallet(agentId);
  if (!wallet) {
    throw new Error(`Failed to create wallet for agent: ${agentId}`);
  }
  return wallet;
}

/**
 * Get a wallet by agent ID.
 */
export function getWallet(agentId: string): AgentWallet | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM agent_wallets WHERE agent_id = ?')
    .get(agentId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapRowToWallet(row);
}

/**
 * List all wallets.
 */
export function listWallets(): AgentWallet[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM agent_wallets ORDER BY created_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(mapRowToWallet);
}

/**
 * Debit (spend from) a wallet. Checks: frozen, per-call limit, daily limit, balance.
 * Uses IMMEDIATE transaction for atomicity.
 */
export function debitWallet(
  agentId: string,
  amountCents: number,
): WalletOperationResult {
  if (amountCents <= 0) {
    return { success: false, balanceCents: 0, error: 'Amount must be positive' };
  }

  return withImmediateTransaction(() => {
    const wallet = getWallet(agentId);
    if (!wallet) {
      return { success: false, balanceCents: 0, error: `Wallet not found: ${agentId}` };
    }

    if (wallet.frozen) {
      return {
        success: false,
        balanceCents: wallet.balanceCents,
        error: `Wallet frozen: ${wallet.frozenReason ?? 'no reason given'}`,
      };
    }

    if (amountCents > wallet.perCallLimitCents) {
      return {
        success: false,
        balanceCents: wallet.balanceCents,
        error: `Amount ${amountCents} exceeds per-call limit ${wallet.perCallLimitCents}`,
      };
    }

    // Daily limit: query confirmed payments in the last 24h from event_log
    const db = getDatabase();
    const dailySpent = getDailySpentCents(db, agentId);
    if (dailySpent + amountCents > wallet.dailyLimitCents) {
      return {
        success: false,
        balanceCents: wallet.balanceCents,
        error: `Daily limit exceeded: spent ${dailySpent} + ${amountCents} > limit ${wallet.dailyLimitCents}`,
      };
    }

    if (amountCents > wallet.balanceCents) {
      return {
        success: false,
        balanceCents: wallet.balanceCents,
        error: `Insufficient balance: ${wallet.balanceCents} < ${amountCents}`,
      };
    }

    const result = db.prepare(`
      UPDATE agent_wallets
      SET balance_cents = balance_cents - @amount,
          total_spent_cents = total_spent_cents + @amount
      WHERE agent_id = @agent_id
    `).run({ amount: amountCents, agent_id: agentId });

    if (result.changes !== 1) {
      return {
        success: false,
        balanceCents: wallet.balanceCents,
        error: `Wallet update failed: no rows matched for ${agentId}`,
      };
    }

    return {
      success: true,
      balanceCents: wallet.balanceCents - amountCents,
    };
  });
}


/**
 * Debit a wallet WITHOUT re-checking limits.
 * Used exclusively by confirmHold() where validation already happened in reserveFunds().
 * Skips: frozen check, per-call limit, daily limit (all verified at reserve time).
 * Only checks: wallet exists and has sufficient balance.
 */
export function debitWalletUnchecked(
  agentId: string,
  amountCents: number,
): WalletOperationResult {
  if (amountCents <= 0) {
    return { success: false, balanceCents: 0, error: 'Amount must be positive' };
  }

  const db = getDatabase();
  const wallet = getWallet(agentId);
  if (!wallet) {
    return { success: false, balanceCents: 0, error: `Wallet not found: ${agentId}` };
  }

  if (amountCents > wallet.balanceCents) {
    return {
      success: false,
      balanceCents: wallet.balanceCents,
      error: `Insufficient balance: ${wallet.balanceCents} < ${amountCents}`,
    };
  }

  const result = db.prepare(`
    UPDATE agent_wallets
    SET balance_cents = balance_cents - @amount,
        total_spent_cents = total_spent_cents + @amount
    WHERE agent_id = @agent_id
  `).run({ amount: amountCents, agent_id: agentId });

  if (result.changes !== 1) {
    return {
      success: false,
      balanceCents: wallet.balanceCents,
      error: `Wallet update failed: no rows matched for ${agentId}`,
    };
  }

  return {
    success: true,
    balanceCents: wallet.balanceCents - amountCents,
  };
}

/**
 * Get total cents spent by an agent in the last 24 hours.
 * Queries the event_log for payment:hold_confirmed events (append-only pattern).
 * Falls back to 0 if event_log doesn't exist yet (pre-M0.5).
 */
function getDailySpentCents(
  db: ReturnType<typeof getDatabase>,
  agentId: string,
): number {
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
    return row?.total ?? 0;
  } catch {
    // event_log may not exist yet in early migration stages
    return 0;
  }
}

/**
 * Credit (add to) a wallet.
 */
export function creditWallet(
  agentId: string,
  amountCents: number,
): WalletOperationResult {
  if (amountCents <= 0) {
    return { success: false, balanceCents: 0, error: 'Amount must be positive' };
  }

  return withImmediateTransaction(() => {
    const wallet = getWallet(agentId);
    if (!wallet) {
      return { success: false, balanceCents: 0, error: `Wallet not found: ${agentId}` };
    }

    const db = getDatabase();
    db.prepare(`
      UPDATE agent_wallets
      SET balance_cents = balance_cents + @amount,
          last_replenished = CURRENT_TIMESTAMP
      WHERE agent_id = @agent_id
    `).run({ amount: amountCents, agent_id: agentId });

    return {
      success: true,
      balanceCents: wallet.balanceCents + amountCents,
    };
  });
}

/**
 * Freeze a wallet — prevents all debits.
 */
export function freezeWallet(agentId: string, reason: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE agent_wallets SET frozen = 1, frozen_reason = @reason
    WHERE agent_id = @agent_id
  `).run({ agent_id: agentId, reason });
  return result.changes > 0;
}

/**
 * Unfreeze a wallet.
 */
export function unfreezeWallet(agentId: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE agent_wallets SET frozen = 0, frozen_reason = NULL
    WHERE agent_id = @agent_id
  `).run({ agent_id: agentId });
  return result.changes > 0;
}

/**
 * Get the effective auto-approve threshold for a specific tool.
 * Checks per-tool override first, falls back to agent-level default.
 */
export function getAutoApproveThreshold(
  agentId: string,
  toolId: string,
): number {
  const db = getDatabase();

  // Check per-tool override first
  const override = db
    .prepare(
      `SELECT threshold_cents FROM tool_auto_approve_overrides
       WHERE agent_id = ? AND tool_id = ?`,
    )
    .get(agentId, toolId) as { threshold_cents: number } | undefined;

  if (override) {
    return override.threshold_cents;
  }

  // Fall back to agent-level default
  const wallet = db
    .prepare('SELECT auto_approve_threshold_cents FROM agent_wallets WHERE agent_id = ?')
    .get(agentId) as { auto_approve_threshold_cents: number } | undefined;

  return wallet?.auto_approve_threshold_cents ?? 50;
}

/**
 * Set a per-tool auto-approve threshold override.
 */
export function setToolAutoApproveThreshold(
  agentId: string,
  toolId: string,
  thresholdCents: number,
): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO tool_auto_approve_overrides (agent_id, tool_id, threshold_cents)
    VALUES (@agent_id, @tool_id, @threshold_cents)
    ON CONFLICT(agent_id, tool_id) DO UPDATE SET threshold_cents = @threshold_cents
  `).run({ agent_id: agentId, tool_id: toolId, threshold_cents: thresholdCents });
}

/**
 * Check if a payment amount should be auto-approved.
 */
export function shouldAutoApprove(
  agentId: string,
  toolId: string,
  amountCents: number,
): boolean {
  const threshold = getAutoApproveThreshold(agentId, toolId);
  return amountCents <= threshold;
}

/** Map a database row to an AgentWallet */
function mapRowToWallet(row: Record<string, unknown>): AgentWallet {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    displayName: row.display_name as string | null,
    dailyLimitCents: row.daily_limit_cents as number,
    perCallLimitCents: row.per_call_limit_cents as number,
    balanceCents: row.balance_cents as number,
    totalSpentCents: row.total_spent_cents as number,
    allowedTools: JSON.parse(row.allowed_tools as string) as string[],
    allowedRails: JSON.parse(row.allowed_rails as string) as string[],
    autoApproveThresholdCents: row.auto_approve_threshold_cents as number,
    frozen: (row.frozen as number) === 1,
    frozenReason: row.frozen_reason as string | null,
    createdAt: row.created_at as string,
    lastReplenished: row.last_replenished as string,
  };
}
