/**
 * L402 Lightning Rail — STUB
 *
 * Implements the PaymentRail interface with all methods throwing.
 * This ensures the router and gateway are rail-agnostic from day one.
 * Full implementation planned for sprint MX.
 */

import type {
  PaymentRail,
  PaymentRailId,
  PaymentAmount,
  PaymentChallenge,
  PaymentResult,
} from '../types.js';

const NOT_IMPLEMENTED = 'L402 rail not yet implemented — planned for sprint MX';

export class L402Rail implements PaymentRail {
  readonly id: PaymentRailId = 'l402';
  readonly name = 'Lightning Network (L402)';

  async isAvailable(): Promise<boolean> {
    return false;
  }

  parseChallenge(
    _statusCode: number,
    headers: Record<string, string>,
    _body: unknown,
  ): PaymentChallenge | null {
    // L402 challenges use WWW-Authenticate: L402 header
    const wwwAuth = headers['www-authenticate'] ?? headers['WWW-Authenticate'];
    if (wwwAuth && wwwAuth.startsWith('L402')) {
      // Detected L402 challenge but cannot handle it yet
      console.warn('[l402] L402 challenge detected but rail is not implemented');
      return null;
    }
    return null;
  }

  async executePayment(_challenge: PaymentChallenge): Promise<PaymentResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  buildAuthHeaders(
    _proof: string,
    _challenge: PaymentChallenge,
  ): Record<string, string> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async verifyPayment(
    _proof: string,
    _challengeData: unknown,
  ): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getBalance(): Promise<PaymentAmount> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
