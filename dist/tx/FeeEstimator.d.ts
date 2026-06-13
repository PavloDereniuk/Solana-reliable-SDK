import type { RpcPool } from '../rpc/index.js';
export type PriorityLevel = 'low' | 'medium' | 'high';
export interface FeeEstimatorOptions {
    defaultFee?: number;
}
export declare class FeeEstimator {
    private readonly pool;
    private readonly defaultFee;
    constructor(pool: RpcPool, opts?: FeeEstimatorOptions);
    /**
     * Estimates priority fee in microLamports.
     * Uses Helius getPriorityFeeEstimate when available, falls back to
     * getRecentPrioritizationFees with percentile selection.
     */
    estimate(writableAccounts?: string[], level?: PriorityLevel): Promise<number>;
    private heliusFee;
}
//# sourceMappingURL=FeeEstimator.d.ts.map