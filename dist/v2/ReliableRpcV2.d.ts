/**
 * web3.js v2.0 (modular @solana/* packages) compatibility layer.
 *
 * Wraps our RPC pool and reliability features around the new functional API.
 * The v2.0 API is fully typed — addresses are plain strings, transactions are
 * built with pipe(), and signing/sending are separated concerns.
 */
import type { Address } from '@solana/addresses';
export interface ReliableRpcV2Options {
    /** Primary endpoint URLs — same semantics as RpcPool */
    endpoints: string[];
    /** Strategy for selecting endpoints. Default 'round-robin'. */
    strategy?: 'round-robin' | 'priority';
    /** Commitment for all requests. Default 'confirmed'. */
    commitment?: 'processed' | 'confirmed' | 'finalized';
}
export interface SlotInfo {
    slot: bigint;
    endpoint: string;
    latencyMs: number;
}
export interface BlockhashV2 {
    blockhash: string;
    lastValidBlockHeight: bigint;
    endpoint: string;
}
/**
 * A reliability wrapper for the @solana/rpc v2.0 API.
 *
 * Provides the same failover, health-check, and circuit-breaker features
 * as RpcPool but exposed through the web3.js v2.0 functional interface.
 *
 * Usage:
 *   import { createReliableRpcV2 } from 'solana-reliable-sdk/v2';
 *   const rpc = createReliableRpcV2({ endpoints: ['https://...'] });
 *   const { blockhash } = await rpc.getLatestBlockhash();
 *   const slot = await rpc.getSlot();
 */
export declare class ReliableRpcV2 {
    private endpoints;
    private strategy;
    private roundRobinIndex;
    private readonly failureCounts;
    private readonly openCircuits;
    private readonly circuitOpenedAt;
    private readonly CIRCUIT_THRESHOLD;
    private readonly CIRCUIT_TIMEOUT_MS;
    readonly commitment: 'processed' | 'confirmed' | 'finalized';
    constructor(opts: ReliableRpcV2Options);
    /** Returns the currently selected endpoint URL. */
    getEndpoint(): string;
    /** getSlot — fetches current slot from the best available endpoint. */
    getSlot(): Promise<SlotInfo>;
    /** getLatestBlockhash — fetches blockhash with lastValidBlockHeight. */
    getLatestBlockhash(): Promise<BlockhashV2>;
    /** getBalance — returns balance in lamports for the given address. */
    getBalance(address: Address): Promise<bigint>;
    /** sendTransaction — sends a base64-encoded signed transaction. */
    sendTransaction(encodedTx: string, opts?: {
        skipPreflight?: boolean;
    }): Promise<string>;
    /** getSignatureStatuses — poll for transaction confirmation status. */
    getSignatureStatuses(signatures: string[]): Promise<Array<{
        slot?: bigint;
        confirmations?: number;
        confirmationStatus?: string;
        err?: unknown;
    } | null>>;
    /**
     * Expose all endpoints for use with the raw @solana/rpc createSolanaRpc().
     * This lets users create their own typed RPC clients while still benefiting
     * from the pool's endpoint selection logic.
     */
    getAllEndpoints(): string[];
    private withFailover;
    private isAvailable;
    private recordSuccess;
    private recordFailure;
}
/** Factory function — v2.0 functional style entry point. */
export declare function createReliableRpcV2(opts: ReliableRpcV2Options): ReliableRpcV2;
//# sourceMappingURL=ReliableRpcV2.d.ts.map