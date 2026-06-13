import type { RpcPool } from '../rpc/index.js';
export type ConfirmationStatus = 'processed' | 'confirmed' | 'finalized';
export interface ConfirmOptions {
    commitment?: ConfirmationStatus;
    pollIntervalMs?: number;
    timeoutMs?: number;
}
export declare class PermanentTransactionError extends Error {
    readonly onChainErr: unknown;
    constructor(message: string, onChainErr: unknown);
}
export declare class TransactionExpiredError extends Error {
    readonly signature: string;
    constructor(signature: string);
}
export declare class TransactionConfirmer {
    private readonly pool;
    private readonly commitment;
    private readonly pollIntervalMs;
    private readonly timeoutMs;
    constructor(pool: RpcPool, opts?: ConfirmOptions);
    /**
     * Poll until the transaction reaches the desired commitment level.
     *
     * Throws:
     *   PermanentTransactionError  — InstructionError or other on-chain failure (no retry)
     *   TransactionExpiredError    — blockHeight > lastValidBlockHeight while status still null
     *   Error('confirmation timed out') — wall-clock timeout exceeded
     */
    confirm(signature: string, lastValidBlockHeight: number): Promise<void>;
    private checkExpired;
    private meetsCommitment;
    private sleep;
}
//# sourceMappingURL=TransactionConfirmer.d.ts.map