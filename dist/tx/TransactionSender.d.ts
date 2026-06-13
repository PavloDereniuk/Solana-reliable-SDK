import { Transaction, Keypair } from '@solana/web3.js';
import type { RpcPool } from '../rpc/index.js';
import type { BlockhashManager } from './BlockhashManager.js';
import type { FeeEstimator, PriorityLevel } from './FeeEstimator.js';
import type { ComputeUnits } from './ComputeUnits.js';
export interface TransactionSenderOptions {
    retryIntervalMs?: number;
    maxDurationMs?: number;
    skipPreflight?: boolean;
    priorityFee?: 'auto' | number;
    priorityLevel?: PriorityLevel;
    computeUnits?: 'auto' | number;
}
export interface SendResult {
    signature: string;
}
export declare class TransactionSender {
    private readonly pool;
    private readonly blockhashManager;
    private readonly feeEstimator;
    private readonly computeUnitsHelper;
    private readonly opts;
    private readonly retryIntervalMs;
    private readonly maxDurationMs;
    private readonly skipPreflight;
    constructor(pool: RpcPool, blockhashManager: BlockhashManager, feeEstimator: FeeEstimator, computeUnitsHelper: ComputeUnits, opts?: TransactionSenderOptions);
    /**
     * Prepare, sign, and send a transaction with automatic retry.
     *
     * Flow:
     *   1. Add ComputeBudget instructions (if configured)
     *   2. Get fresh blockhash → sign
     *   3. Send + poll every retryIntervalMs
     *   4. Re-sign when blockhash expires (new signature, safe from duplicates)
     *   5. Exponential backoff on HTTP 429
     *   6. Throw immediately on permanent on-chain errors
     */
    send(tx: Transaction, signers: Keypair[]): Promise<SendResult>;
    private prepareBudget;
    private pollStatus;
    private getWritableAccounts;
    private is429;
    private isPermanentError;
    private sleep;
}
//# sourceMappingURL=TransactionSender.d.ts.map