import { Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import type { RpcPool } from '../rpc/index.js';

export interface ComputeUnitsOptions {
  /** Safety multiplier applied to simulated units. Default 1.1 (10% buffer). */
  buffer?: number;
  /** Fallback limit when simulation fails. Default 200_000. */
  fallback?: number;
}

export class ComputeUnits {
  private readonly buffer: number;
  private readonly fallback: number;

  constructor(
    private readonly pool: RpcPool,
    opts: ComputeUnitsOptions = {},
  ) {
    this.buffer = opts.buffer ?? 1.1;
    this.fallback = opts.fallback ?? 200_000;
  }

  /**
   * Simulate transaction and return a setComputeUnitLimit instruction
   * sized to actual consumption + buffer. Falls back to `fallback` on error.
   */
  async buildLimitInstruction(tx: Transaction): Promise<TransactionInstruction> {
    const units = await this.simulate(tx);
    return ComputeBudgetProgram.setComputeUnitLimit({ units });
  }

  async simulate(tx: Transaction): Promise<number> {
    const conn = this.pool.getConnection();
    try {
      const { value } = await conn.simulateTransaction(tx);
      this.pool.reportSuccess(conn);

      const consumed = value.unitsConsumed;
      if (!consumed || consumed === 0) return this.fallback;

      return Math.ceil(consumed * this.buffer);
    } catch {
      this.pool.reportFailure(conn);
      return this.fallback;
    }
  }
}
