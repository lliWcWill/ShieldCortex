/**
 * Shared Marketplace Types — CapabilityToken, enums, common interfaces.
 */

import type { PaymentAmount, PaymentRailId } from './payments/types.js';

/**
 * Capability Token — scoped, time-limited, revocable spending permission.
 * Designed for forward-compatibility with AP2 Mandates.
 */
export interface CapabilityToken {
  /** Unique token ID */
  id: string;
  /** Agent this token was issued to */
  agentId: string;
  /** Who issued this token (user, system, parent agent) */
  issuedBy: string;
  /** ISO timestamp of issuance */
  issuedAt: string;

  // --- Spending limits ---
  /** Maximum amount per single payment */
  maxAmount: PaymentAmount;
  /** Maximum total spending per 24h rolling window */
  dailyCeiling: PaymentAmount;

  // --- Scope ---
  /** Tool IDs this token can pay for. ["*"] = all tools. */
  allowedTools: string[];
  /** Tool categories this token covers */
  allowedCategories: string[];
  /** Payment rails this token can use */
  allowedRails: PaymentRailId[];

  // --- Lifecycle ---
  /** ISO timestamp when token expires */
  expiresAt: string;
  /** Max number of uses, null = unlimited */
  maxUses: number | null;

  // --- Step-up authentication ---
  /** Whether high-value payments require human confirmation */
  requiresStepUp: boolean;
  /** Amount above which step-up is triggered */
  stepUpThreshold: PaymentAmount;
  /** Whether first-time tool usage requires step-up */
  stepUpForNewTools: boolean;

  // --- AP2 Mandate forward-compatibility ---
  /** AP2 mandate type if this token maps to a Mandate */
  mandateType?: 'intent' | 'cart';
  /** Cryptographic signature for AP2 verification */
  mandateSignature?: string;

  // --- Runtime state ---
  /** Whether this token has been revoked */
  revoked: boolean;
  /** ISO timestamp of revocation */
  revokedAt?: string;
  /** Why the token was revoked */
  revokedReason?: string;
  /** How many times this token has been used */
  usesConsumed: number;
  /** Total amount spent through this token */
  totalSpent: PaymentAmount;
  /** Trace IDs of operations that used this token */
  traceIds: string[];
}

/**
 * Kill-switch severity levels — graduated response to anomalies.
 */
export type KillSwitchLevel = 'THROTTLE' | 'SUSPEND' | 'RESTRICT' | 'HALT';

/**
 * Wallet operation result.
 */
export interface WalletOperationResult {
  success: boolean;
  balanceCents: number;
  error?: string;
}
