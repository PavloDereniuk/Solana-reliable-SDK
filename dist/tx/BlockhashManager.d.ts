import type { RpcPool } from '../rpc/index.js';
export interface BlockhashData {
    blockhash: string;
    lastValidBlockHeight: number;
}
export interface BlockhashManagerOptions {
    cacheTtlMs?: number;
}
export declare class BlockhashManager {
    private readonly pool;
    private cached;
    private readonly cacheTtlMs;
    constructor(pool: RpcPool, opts?: BlockhashManagerOptions);
    get(): Promise<BlockhashData>;
    refresh(): Promise<BlockhashData>;
    /**
     * Returns true when the current block height has passed lastValidBlockHeight.
     * Safe to call frequently — uses a separate pool connection and falls back to
     * false on error (assume not expired, let the send attempt surface real errors).
     */
    isExpired(lastValidBlockHeight: number): Promise<boolean>;
    invalidate(): void;
}
//# sourceMappingURL=BlockhashManager.d.ts.map