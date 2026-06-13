import { Transaction } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import type { RpcPool } from '../rpc/index.js';
export interface ComputeUnitsOptions {
    /** Safety multiplier applied to simulated units. Default 1.1 (10% buffer). */
    buffer?: number;
    /** Fallback limit when simulation fails. Default 200_000. */
    fallback?: number;
}
export declare class ComputeUnits {
    private readonly pool;
    private readonly buffer;
    private readonly fallback;
    constructor(pool: RpcPool, opts?: ComputeUnitsOptions);
    /**
     * Simulate transaction and return a setComputeUnitLimit instruction
     * sized to actual consumption + buffer. Falls back to `fallback` on error.
     */
    buildLimitInstruction(tx: Transaction): Promise<TransactionInstruction>;
    simulate(tx: Transaction): Promise<number>;
}
//# sourceMappingURL=ComputeUnits.d.ts.map