/**
 * Payment Rail Router — routes 402 responses to the correct payment rail.
 *
 * x402 returns `X-PAYMENT` header; L402 returns `WWW-Authenticate: L402`.
 * Router tries each registered rail's parseChallenge() — first match wins.
 */

import type { PaymentRail, PaymentRailId, PaymentChallenge } from './types.js';

export class PaymentRailRouter {
  private readonly rails: Map<PaymentRailId, PaymentRail> = new Map();

  /** Register a payment rail implementation */
  registerRail(rail: PaymentRail): void {
    this.rails.set(rail.id, rail);
  }

  /** Unregister a payment rail */
  unregisterRail(id: PaymentRailId): boolean {
    return this.rails.delete(id);
  }

  /** Get a specific rail by ID */
  getRail(id: PaymentRailId): PaymentRail | undefined {
    return this.rails.get(id);
  }

  /** Get all registered rail IDs */
  getRegisteredRails(): PaymentRailId[] {
    return [...this.rails.keys()];
  }

  /** Get all rails that are currently available */
  async getAvailableRails(): Promise<PaymentRailId[]> {
    const available: PaymentRailId[] = [];
    for (const [id, rail] of this.rails) {
      if (await rail.isAvailable()) {
        available.push(id);
      }
    }
    return available;
  }

  /**
   * Attempt to parse a 402 response into a PaymentChallenge.
   * Tries each registered rail in order — first match wins.
   * Returns null if no rail can parse the response.
   */
  parseChallenge(
    statusCode: number,
    headers: Record<string, string>,
    body: unknown,
  ): PaymentChallenge | null {
    if (statusCode !== 402) {
      return null;
    }
    for (const rail of this.rails.values()) {
      const challenge = rail.parseChallenge(statusCode, headers, body);
      if (challenge !== null) {
        return challenge;
      }
    }
    return null;
  }
}
