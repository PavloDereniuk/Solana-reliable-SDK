import { PublicKey } from '@solana/web3.js';
import type { RpcPool } from '../rpc/index.js';

export type PriorityLevel = 'low' | 'medium' | 'high';

export interface FeeEstimatorOptions {
  defaultFee?: number;
}

export class FeeEstimator {
  private readonly defaultFee: number;

  constructor(
    private readonly pool: RpcPool,
    opts: FeeEstimatorOptions = {},
  ) {
    this.defaultFee = opts.defaultFee ?? 1_000;
  }

  /**
   * Estimates priority fee in microLamports.
   * Uses Helius getPriorityFeeEstimate when available, falls back to
   * getRecentPrioritizationFees with percentile selection.
   */
  async estimate(writableAccounts: string[] = [], level: PriorityLevel = 'medium'): Promise<number> {
    const conn = this.pool.getConnection();
    const endpoint = conn.rpcEndpoint;

    if (endpoint.includes('helius')) {
      try {
        const fee = await this.heliusFee(endpoint, writableAccounts, level);
        this.pool.reportSuccess(conn);
        return fee;
      } catch {
        // fall through to standard fallback
      }
    }

    try {
      const pubkeys = writableAccounts
        .slice(0, 128)
        .map((k) => new PublicKey(k));

      const fees = await conn.getRecentPrioritizationFees(
        pubkeys.length ? { lockedWritableAccounts: pubkeys } : undefined,
      );

      this.pool.reportSuccess(conn);

      if (fees.length === 0) return this.defaultFee;

      const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const p = level === 'low' ? 0.25 : level === 'high' ? 0.75 : 0.5;
      return sorted[Math.floor(sorted.length * p)];
    } catch {
      this.pool.reportFailure(conn);
      return this.defaultFee;
    }
  }

  private async heliusFee(
    endpoint: string,
    accountKeys: string[],
    level: PriorityLevel,
  ): Promise<number> {
    const url = new URL(endpoint);
    const apiKey = url.searchParams.get('api-key');
    if (!apiKey) throw new Error('no api-key in Helius endpoint');

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getPriorityFeeEstimate',
        params: [
          {
            accountKeys,
            options: { priorityLevel: level.toUpperCase() },
          },
        ],
      }),
    });

    if (!resp.ok) throw new Error(`Helius ${resp.status}`);

    const data = (await resp.json()) as {
      result?: { priorityFeeEstimate: number };
    };

    const fee = data.result?.priorityFeeEstimate;
    if (fee === undefined) throw new Error('unexpected Helius response shape');
    return fee;
  }
}
