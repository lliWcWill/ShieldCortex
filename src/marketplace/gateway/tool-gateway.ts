/**
 * Tool Gateway — the chokepoint where ALL external tool calls flow.
 *
 * Orchestrates: trust check → first HTTP call → 402 handling →
 * spending guard (reserve/confirm/release) → payment → retry with proof.
 *
 * Two-phase commit: funds are reserved before payment, then confirmed
 * on success or released on failure. Wallet is never in an inconsistent state.
 */

import { runDefencePipeline } from '../../defence/pipeline.js';
import { PaymentRailRouter } from '../payments/router.js';
import { appendEvent } from '../ledger/event-ledger.js';
import { reserveFunds, confirmHold, releaseHold } from './spending-guard.js';
import type { PaymentChallenge, PaymentRail } from '../payments/types.js';
import type { DefenceSource } from '../../defence/types.js';

export interface ToolCallRequest {
  agentId: string;
  toolId: string;
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  source?: DefenceSource;
}

export interface ToolCallResult {
  success: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  paymentMade: boolean;
  paymentAmount?: number;
  error?: string;
}

export class ToolGateway {
  constructor(
    private readonly router: PaymentRailRouter,
    private readonly trustEnabled = true,
  ) {}

  /**
   * Execute a tool call with full trust + payment orchestration.
   */
  async executeToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    const { agentId, toolId, endpoint } = request;

    // Step 1: Defence pipeline (trust check)
    if (this.trustEnabled && request.source) {
      const defence = runDefencePipeline(
        JSON.stringify(request.body ?? ''),
        `tool-call:${toolId}`,
        request.source,
      );

      if (!defence.allowed) {
        appendEvent({
          eventType: 'tool:blocked',
          source: 'tool-gateway',
          actorId: agentId,
          payload: {
            toolId,
            endpoint,
            reason: `Defence pipeline blocked: ${defence.firewall.reason}`,
          },
        });
        return {
          success: false,
          statusCode: 403,
          headers: {},
          body: null,
          paymentMade: false,
          error: `Blocked by defence pipeline: ${defence.firewall.reason}`,
        };
      }
    }

    // Step 2: First HTTP call (no payment)
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: request.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...request.headers,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
      });
    } catch (err) {
      return {
        success: false,
        statusCode: 0,
        headers: {},
        body: null,
        paymentMade: false,
        error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Step 3: If not 402, return the response directly
    if (response.status !== 402) {
      const responseHeaders = Object.fromEntries(response.headers.entries());
      let body: unknown;
      const rawText = await response.text();
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
      return {
        success: response.ok,
        statusCode: response.status,
        headers: responseHeaders,
        body,
        paymentMade: false,
      };
    }

    // Step 4: 402 — parse the payment challenge
    const responseHeaders = Object.fromEntries(response.headers.entries());
    let responseBody: unknown;
    const rawResponseText = await response.text();
    try {
      responseBody = JSON.parse(rawResponseText);
    } catch {
      responseBody = rawResponseText || null;
    }

    const challenge = this.router.parseChallenge(402, responseHeaders, responseBody);

    if (!challenge) {
      appendEvent({
        eventType: 'payment:challenge_unparseable',
        source: 'tool-gateway',
        actorId: agentId,
        payload: { toolId, endpoint, headers: responseHeaders },
      });
      return {
        success: false,
        statusCode: 402,
        headers: responseHeaders,
        body: responseBody,
        paymentMade: false,
        error: 'Received 402 but no registered rail could parse the challenge',
      };
    }

    // Log challenge received
    appendEvent({
      eventType: 'payment:challenge_received',
      source: 'tool-gateway',
      actorId: agentId,
      payload: {
        toolId,
        endpoint,
        rail: challenge.rail,
        amount: challenge.amount,
        challengeId: challenge.challengeId,
      },
    });

    // Step 4b: Check challenge expiry before committing funds
    if (new Date(challenge.expiresAt) <= new Date()) {
      appendEvent({
        eventType: 'payment:challenge_expired',
        source: 'tool-gateway',
        actorId: agentId,
        payload: { toolId, endpoint, expiresAt: challenge.expiresAt },
      });
      return {
        success: false,
        statusCode: 402,
        headers: responseHeaders,
        body: responseBody,
        paymentMade: false,
        error: `Payment challenge expired at ${challenge.expiresAt}`,
      };
    }

    // Step 5: Reserve funds (two-phase: reserve before payment)
    const holdResult = reserveFunds(agentId, toolId, challenge.amount.usdCents);

    if (!holdResult.approved && holdResult.requiresStepUp) {
      // Step-up required — for M0.5 demo, deny step-up automatically
      releaseHold(holdResult.holdId, 'step-up required but not implemented');
      appendEvent({
        eventType: 'payment:policy_denied',
        source: 'tool-gateway',
        actorId: agentId,
        payload: {
          toolId,
          amount: challenge.amount,
          reason: 'Step-up authentication required',
        },
      });
      return {
        success: false,
        statusCode: 402,
        headers: responseHeaders,
        body: responseBody,
        paymentMade: false,
        error: 'Payment requires step-up authentication (not yet implemented)',
      };
    }

    if (holdResult.holdId === 0) {
      // Reserve denied (frozen, limit, balance)
      appendEvent({
        eventType: 'payment:policy_denied',
        source: 'tool-gateway',
        actorId: agentId,
        payload: {
          toolId,
          amount: challenge.amount,
          reason: holdResult.reason,
        },
      });
      return {
        success: false,
        statusCode: 402,
        headers: responseHeaders,
        body: responseBody,
        paymentMade: false,
        error: `Payment denied: ${holdResult.reason}`,
      };
    }

    // Step 6: Execute payment via the rail
    const rail = this.router.getRail(challenge.rail);
    if (!rail) {
      releaseHold(holdResult.holdId, 'rail not found');
      return {
        success: false,
        statusCode: 402,
        headers: responseHeaders,
        body: responseBody,
        paymentMade: false,
        error: `Payment rail not found: ${challenge.rail}`,
      };
    }

    appendEvent({
      eventType: 'payment:executing',
      source: 'tool-gateway',
      actorId: agentId,
      payload: {
        toolId,
        rail: challenge.rail,
        holdId: holdResult.holdId,
        amount: challenge.amount,
      },
    });

    const paymentResult = await rail.executePayment(challenge);

    // Step 7: Handle payment result
    if (!paymentResult.success) {
      // Payment failed — release the hold
      releaseHold(holdResult.holdId, paymentResult.error);

      appendEvent({
        eventType: 'payment:failed',
        source: 'tool-gateway',
        actorId: agentId,
        payload: {
          toolId,
          rail: challenge.rail,
          amount: challenge.amount,
          error: paymentResult.error,
          settlementMs: paymentResult.settlementMs,
        },
      });
      return {
        success: false,
        statusCode: 402,
        headers: responseHeaders,
        body: responseBody,
        paymentMade: false,
        error: `Payment failed: ${paymentResult.error}`,
      };
    }

    // Step 8: Payment succeeded — confirm the hold (permanent debit)
    const confirmResult = confirmHold(holdResult.holdId, {
      amount: challenge.amount,
      rail: challenge.rail,
      proof: paymentResult.proof,
      settlementMs: paymentResult.settlementMs,
    });

    if (!confirmResult.success) {
      // Extremely unlikely: payment succeeded but debit failed
      // Log critical error — manual reconciliation needed
      appendEvent({
        eventType: 'payment:reconciliation_needed',
        source: 'tool-gateway',
        actorId: agentId,
        riskScore: 1.0,
        payload: {
          toolId,
          holdId: holdResult.holdId,
          amount: challenge.amount,
          proof: paymentResult.proof,
          error: confirmResult.error,
        },
      });
    }

    // Step 9: Retry the tool call with payment proof headers
    const authHeaders = rail.buildAuthHeaders(paymentResult.proof, challenge);

    let retryResponse: Response;
    try {
      retryResponse = await fetch(endpoint, {
        method: request.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...request.headers,
          ...authHeaders,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
      });
    } catch (err) {
      appendEvent({
        eventType: 'tool:retry_failed',
        source: 'tool-gateway',
        actorId: agentId,
        payload: {
          toolId,
          error: `Retry network error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return {
        success: false,
        statusCode: 0,
        headers: {},
        body: null,
        paymentMade: true,
        paymentAmount: challenge.amount.usdCents,
        error: `Payment succeeded but retry failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const retryHeaders = Object.fromEntries(retryResponse.headers.entries());
    let retryBody: unknown;
    const rawRetryText = await retryResponse.text();
    try {
      retryBody = JSON.parse(rawRetryText);
    } catch {
      retryBody = rawRetryText;
    }

    // Log the completed payment cycle (NOT payment:confirmed — that's the
    // spending-guard's job via confirmHold. Using a distinct type prevents
    // double-counting in daily spend queries.)
    appendEvent({
      eventType: 'payment:cycle_complete',
      source: 'tool-gateway',
      actorId: agentId,
      payload: {
        toolId,
        rail: challenge.rail,
        amount: challenge.amount,
        challengeId: challenge.challengeId,
        settlementMs: paymentResult.settlementMs,
        retryStatus: retryResponse.status,
      },
    });

    return {
      success: retryResponse.ok,
      statusCode: retryResponse.status,
      headers: retryHeaders,
      body: retryBody,
      paymentMade: true,
      paymentAmount: challenge.amount.usdCents,
    };
  }
}
