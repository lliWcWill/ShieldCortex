/**
 * x402 Payment Rail — USDC on Base Sepolia via EIP-3009 TransferWithAuthorization.
 *
 * Uses x402 V2 SDK with plugin-based architecture:
 *   1. Create x402Client
 *   2. Register ExactEvmScheme with composed ClientEvmSigner
 *   3. Wrap fetch with payment capability
 *
 * The wrapped fetch automatically handles 402 → sign → retry flow.
 * This rail exposes that flow via the PaymentRail interface so the
 * tool-gateway can orchestrate trust checks + spending guards around it.
 */

import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, erc20Abi } from 'viem';
import { baseSepolia } from 'viem/chains';

import type {
  PaymentRail,
  PaymentRailId,
  PaymentAmount,
  PaymentChallenge,
  PaymentResult,
} from '../types.js';

/** Base Sepolia USDC contract address (Circle-issued test USDC) */
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

/** CAIP-2 network identifier for Base Sepolia */
const BASE_SEPOLIA_CAIP2 = 'eip155:84532';

/** Testnet facilitator URL */
const FACILITATOR_URL = 'https://www.x402.org/facilitator';

export class X402Rail implements PaymentRail {
  readonly id: PaymentRailId = 'x402';
  readonly name = 'x402 (USDC on Base Sepolia)';

  private accountAddress: `0x${string}` | null = null;
  private client: InstanceType<typeof x402Client> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem version mismatch between our dep and @x402's bundled dep
  private publicClient: any = null;
  private fetchWithPayment: typeof fetch | null = null;
  private initialized = false;

  /**
   * Lazily initialize the x402 client and viem account.
   * Returns false if EVM_PRIVATE_KEY is not set.
   */
  private init(): boolean {
    if (this.initialized) return this.accountAddress !== null;

    this.initialized = true;
    const key = process.env.EVM_PRIVATE_KEY;
    if (!key) return false;

    try {
      const account = privateKeyToAccount(key as `0x${string}`);
      this.accountAddress = account.address;

      const pc = createPublicClient({
        chain: baseSepolia,
        transport: http(),
      });
      this.publicClient = pc;

      // Compose a ClientEvmSigner from local account + publicClient
      // toClientEvmSigner merges signTypedData from account with readContract from publicClient
      const signer = toClientEvmSigner(account, pc as Parameters<typeof toClientEvmSigner>[1]);

      this.client = new x402Client();
      registerExactEvmScheme(this.client, { signer });
      this.fetchWithPayment = wrapFetchWithPayment(fetch, this.client);
      return true;
    } catch (err) {
      console.error('[x402] Failed to initialize:', err);
      this.accountAddress = null;
      this.client = null;
      this.publicClient = null;
      this.fetchWithPayment = null;
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.init()) return false;

    try {
      const blockNumber = await this.publicClient.getBlockNumber();
      return blockNumber > 0n;
    } catch {
      return false;
    }
  }

  parseChallenge(
    statusCode: number,
    headers: Record<string, string>,
    _body: unknown,
  ): PaymentChallenge | null {
    if (statusCode !== 402) return null;

    // V2 uses PAYMENT-REQUIRED header (case-insensitive lookup)
    const paymentRequiredHeader =
      headers['payment-required'] ??
      headers['PAYMENT-REQUIRED'] ??
      headers['Payment-Required'];

    if (!paymentRequiredHeader) return null;

    try {
      const decoded = decodePaymentRequiredHeader(paymentRequiredHeader);

      if (!decoded || !decoded.accepts || decoded.accepts.length === 0) {
        return null;
      }

      const firstAccept = decoded.accepts[0];

      // x402 amounts are in the token's native decimals (USDC = 6 decimals)
      // Convert to USD cents: amount / 10^4 (since 10^6 / 100 = 10^4)
      const amountValue = firstAccept.amount;
      const rawAmount = BigInt(amountValue);
      const usdCents = Number(rawAmount / 10000n);

      return {
        rail: 'x402',
        amount: {
          value: amountValue,
          currency: 'USDC',
          usdCents,
        },
        challengeData: {
          paymentRequired: decoded,
          selectedRequirements: firstAccept,
        },
        expiresAt: new Date(
          Date.now() + (firstAccept.maxTimeoutSeconds ?? 60) * 1000,
        ).toISOString(),
        toolEndpoint: decoded.resource?.url ?? '',
        challengeId: `x402-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
    } catch (err) {
      console.warn('[x402] Failed to decode PAYMENT-REQUIRED header:', err);
      return null;
    }
  }

  async executePayment(challenge: PaymentChallenge): Promise<PaymentResult> {
    if (!this.init()) {
      return {
        success: false,
        proof: '',
        amount: challenge.amount,
        settlementData: {},
        settlementMs: 0,
        error: 'x402 rail not initialized — EVM_PRIVATE_KEY not set',
      };
    }

    const startMs = performance.now();
    const { paymentRequired } = challenge.challengeData as {
      paymentRequired: PaymentRequired;
    };

    try {
      // Check balance before attempting payment (gotcha #5)
      const balance = await this.getBalance();
      if (balance.usdCents < challenge.amount.usdCents) {
        return {
          success: false,
          proof: '',
          amount: challenge.amount,
          settlementData: {},
          settlementMs: Math.round(performance.now() - startMs),
          error: `Insufficient USDC balance: ${balance.usdCents} cents < ${challenge.amount.usdCents} cents required`,
        };
      }

      // createPaymentPayload takes the full PaymentRequired object
      const paymentPayload = await this.client!.createPaymentPayload(
        paymentRequired,
      );

      if (!paymentPayload) {
        return {
          success: false,
          proof: '',
          amount: challenge.amount,
          settlementData: {},
          settlementMs: Math.round(performance.now() - startMs),
          error: 'Failed to create payment payload',
        };
      }

      // Encode as PAYMENT-SIGNATURE header value
      const signatureHeader = encodePaymentSignatureHeader(paymentPayload);

      return {
        success: true,
        proof: signatureHeader,
        amount: challenge.amount,
        settlementData: {
          paymentPayload,
          network: BASE_SEPOLIA_CAIP2,
          facilitator: FACILITATOR_URL,
        },
        settlementMs: Math.round(performance.now() - startMs),
      };
    } catch (err) {
      return {
        success: false,
        proof: '',
        amount: challenge.amount,
        settlementData: {},
        settlementMs: Math.round(performance.now() - startMs),
        error: `Payment execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  buildAuthHeaders(
    proof: string,
    _challenge: PaymentChallenge,
  ): Record<string, string> {
    return {
      'Payment-Signature': proof,
    };
  }

  async verifyPayment(
    proof: string,
    challengeData: unknown,
  ): Promise<boolean> {
    try {
      const response = await fetch(`${FACILITATOR_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload: proof,
          paymentRequirements: challengeData,
        }),
      });
      const result = await response.json() as { isValid?: boolean };
      return result.isValid === true;
    } catch {
      return false;
    }
  }

  async getBalance(): Promise<PaymentAmount> {
    if (!this.init()) {
      return { value: '0', currency: 'USDC', usdCents: 0 };
    }

    try {
      const balance = await this.publicClient.readContract({
        address: BASE_SEPOLIA_USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.accountAddress!],
      });

      const balanceBigInt = balance as bigint;
      const usdCents = Number(balanceBigInt / 10000n);

      return {
        value: balanceBigInt.toString(),
        currency: 'USDC',
        usdCents,
      };
    } catch (err) {
      console.error('[x402] Failed to read USDC balance:', err);
      return { value: '0', currency: 'USDC', usdCents: 0 };
    }
  }

  /** Get the wrapped fetch function for direct use (e.g., E2E tests) */
  getFetchWithPayment(): typeof fetch | null {
    if (!this.init()) return null;
    return this.fetchWithPayment;
  }

  /** Get the account address */
  getAddress(): string | null {
    if (!this.init()) return null;
    return this.accountAddress;
  }
}
