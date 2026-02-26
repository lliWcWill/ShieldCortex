/**
 * Payment Rail Abstraction — rail-agnostic interfaces for the hybrid payment model.
 * x402 (USDC) implemented first, L402 (Lightning) added later in sprint MX.
 */

export type PaymentRailId = 'x402' | 'l402';

export interface PaymentAmount {
  /** String representation to avoid float precision issues — e.g. "100" for $1.00 (cents) */
  value: string;
  /** Currency code — "USDC", "BTC", "USD" */
  currency: string;
  /** Equivalent in USD cents (integer) for governance comparisons */
  usdCents: number;
}

export interface PaymentChallenge {
  /** Which rail issued the challenge */
  rail: PaymentRailId;
  /** Amount requested */
  amount: PaymentAmount;
  /** Rail-specific challenge data (x402 header payload, L402 macaroon, etc.) */
  challengeData: unknown;
  /** ISO timestamp when challenge expires */
  expiresAt: string;
  /** The tool endpoint that returned 402 */
  toolEndpoint: string;
  /** Unique identifier for this challenge */
  challengeId: string;
}

export interface PaymentResult {
  /** Whether the payment succeeded */
  success: boolean;
  /** Rail-specific proof token */
  proof: string;
  /** Amount paid */
  amount: PaymentAmount;
  /** Rail-specific settlement metadata */
  settlementData: unknown;
  /** Time to settle in milliseconds */
  settlementMs: number;
  /** Error message if payment failed */
  error?: string;
}

export interface PaymentRail {
  readonly id: PaymentRailId;
  readonly name: string;

  /** Check if this rail is configured and available */
  isAvailable(): Promise<boolean>;

  /** Attempt to parse a 402 response into a challenge. Returns null if not this rail's format. */
  parseChallenge(
    statusCode: number,
    headers: Record<string, string>,
    body: unknown,
  ): PaymentChallenge | null;

  /** Execute a payment for the given challenge */
  executePayment(challenge: PaymentChallenge): Promise<PaymentResult>;

  /** Build HTTP headers to attach the payment proof to a retry request */
  buildAuthHeaders(
    proof: string,
    challenge: PaymentChallenge,
  ): Record<string, string>;

  /** Verify a payment proof (server-side) */
  verifyPayment(proof: string, challengeData: unknown): Promise<boolean>;

  /** Get the current balance on this rail */
  getBalance(): Promise<PaymentAmount>;
}
