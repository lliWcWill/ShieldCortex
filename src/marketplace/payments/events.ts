/**
 * Payment Event Types — rail-agnostic event definitions for the event ledger.
 * The `rail` field is metadata, not signal — governance operates on behavior, not currency.
 */

import type { PaymentRailId, PaymentAmount } from './types.js';

export type PaymentEventType =
  | 'payment:challenge_received'
  | 'payment:policy_approved'
  | 'payment:policy_denied'
  | 'payment:executing'
  | 'payment:confirmed'
  | 'payment:failed'
  | 'payment:disputed'
  | 'payment:refunded';

export interface PaymentEvent {
  type: PaymentEventType;
  timestamp: string;
  agentId: string;
  toolEndpoint: string;
  challengeId: string;
  rail: PaymentRailId;
  amount: PaymentAmount;
  /** Why the event occurred — denial reason, failure message, etc. */
  reason?: string;
  /** Duration in ms (for payment:confirmed / payment:failed) */
  settlementMs?: number;
  /** Payment proof token (for payment:confirmed) */
  proof?: string;
}
