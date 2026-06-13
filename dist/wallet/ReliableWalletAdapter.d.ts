import { Transaction, VersionedTransaction, PublicKey, Connection, type SendOptions } from '@solana/web3.js';
import type { ReliableClient } from '../ReliableClient.js';
/**
 * Minimal interface matching @solana/wallet-adapter-base SignerWalletAdapter.
 * Compatible with Phantom, Solflare, Backpack, and any wallet-adapter v0.15+.
 */
export interface WalletLike {
    publicKey: PublicKey | null;
    connected: boolean;
    signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
    signAllTransactions?<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
    sendTransaction(transaction: Transaction | VersionedTransaction, connection: Connection, options?: SendOptions): Promise<string>;
}
export interface ReliableWalletAdapterOptions {
    /** If true, use ReliableClient for sending; otherwise fall back to wallet's native sendTransaction. */
    useReliableClient?: boolean;
    /** Max duration for sendAndConfirm (ms). Default 90_000. */
    maxDurationMs?: number;
}
/**
 * Wraps any wallet-adapter-compatible wallet and adds:
 * - Automatic RPC failover (via ReliableClient pool)
 * - Priority fee estimation
 * - Compute unit simulation
 * - Retry on dropped transactions
 *
 * Usage:
 *   const adapter = new ReliableWalletAdapter(phantomWallet, client);
 *   const signature = await adapter.sendTransaction(tx);
 */
export declare class ReliableWalletAdapter {
    private readonly wallet;
    private readonly client;
    private readonly useReliableClient;
    constructor(wallet: WalletLike, client: ReliableClient, opts?: ReliableWalletAdapterOptions);
    get publicKey(): PublicKey;
    get connected(): boolean;
    /**
     * Send a transaction using the wallet for signing and ReliableClient for submission.
     * This replaces the wallet's own sendTransaction to add reliability features.
     */
    sendTransaction(transaction: Transaction): Promise<string>;
    /**
     * Sign and send all transactions in sequence using reliable submission.
     */
    sendAllTransactions(transactions: Transaction[]): Promise<string[]>;
    /**
     * Sign a transaction without sending (delegates to wallet).
     */
    signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}
//# sourceMappingURL=ReliableWalletAdapter.d.ts.map