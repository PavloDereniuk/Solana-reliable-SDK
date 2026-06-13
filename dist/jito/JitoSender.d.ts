import { Transaction, Keypair } from '@solana/web3.js';
import type { RpcPool } from '../rpc/index.js';
import type { BlockhashManager } from '../tx/BlockhashManager.js';
export type JitoRegion = 'mainnet' | 'amsterdam' | 'frankfurt' | 'ny' | 'tokyo';
export interface JitoSenderOptions {
    region?: JitoRegion;
    /** Custom block engine URL (overrides region) */
    blockEngineUrl?: string;
    /** Tip in lamports sent to Jito tip account. Default 1000. */
    tipLamports?: number;
    /** Timeout waiting for bundle landing (ms). Default 60_000. */
    bundleTimeoutMs?: number;
    /** Fallback to standard RPC send if Jito fails. Default true. */
    fallbackOnError?: boolean;
}
export interface BundleStatus {
    bundleId: string;
    status: 'Invalid' | 'Pending' | 'Failed' | 'Landed' | 'Finalizing';
    landedSlot?: number;
}
export declare class JitoSender {
    private readonly pool;
    private readonly blockhashManager;
    private readonly blockEngineUrl;
    private readonly tipLamports;
    private readonly bundleTimeoutMs;
    private readonly fallbackOnError;
    constructor(pool: RpcPool, blockhashManager: BlockhashManager, opts?: JitoSenderOptions);
    /**
     * Send a transaction through Jito for MEV protection.
     * Automatically adds a tip instruction. Falls back to standard RPC if Jito fails.
     */
    sendWithMevProtection(tx: Transaction, signers: Keypair[]): Promise<string>;
    /**
     * Submit an atomic bundle of up to 5 transactions to Jito.
     * All transactions land in the same slot or none do.
     * Returns bundle UUID.
     */
    sendBundle(transactions: Transaction[], signerSets: Keypair[] | Keypair[][]): Promise<string>;
    /**
     * Poll Jito for bundle landing status.
     * Resolves when Landed/Failed/timeout.
     */
    getBundleStatus(bundleId: string): Promise<BundleStatus>;
    /** Build a tip transaction to the Jito tip account. */
    buildTipTransaction(payer: Keypair): Transaction;
    private waitForBundle;
    private standardSend;
    private sleep;
}
//# sourceMappingURL=JitoSender.d.ts.map