/**
 * web3.js v2.0 (modular @solana/* packages) compatibility layer.
 *
 * Wraps our RPC pool and reliability features around the new functional API.
 * The v2.0 API is fully typed — addresses are plain strings, transactions are
 * built with pipe(), and signing/sending are separated concerns.
 */
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
export class ReliableRpcV2 {
    endpoints;
    strategy;
    roundRobinIndex = 0;
    failureCounts = new Map();
    openCircuits = new Set();
    circuitOpenedAt = new Map();
    CIRCUIT_THRESHOLD = 3;
    CIRCUIT_TIMEOUT_MS = 60_000;
    commitment;
    constructor(opts) {
        if (opts.endpoints.length === 0)
            throw new Error('At least one endpoint required');
        this.endpoints = [...opts.endpoints];
        this.strategy = opts.strategy ?? 'round-robin';
        this.commitment = opts.commitment ?? 'confirmed';
        for (const ep of this.endpoints)
            this.failureCounts.set(ep, 0);
    }
    /** Returns the currently selected endpoint URL. */
    getEndpoint() {
        const available = this.endpoints.filter((ep) => this.isAvailable(ep));
        if (available.length === 0)
            return this.endpoints[0]; // all broken — try first
        if (this.strategy === 'priority')
            return available[0];
        const ep = available[this.roundRobinIndex % available.length];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
        return ep;
    }
    /** getSlot — fetches current slot from the best available endpoint. */
    async getSlot() {
        return this.withFailover(async (endpoint) => {
            const { createSolanaRpc } = await import('@solana/rpc');
            const rpc = createSolanaRpc(endpoint);
            const t0 = Date.now();
            const slot = await rpc.getSlot({ commitment: this.commitment }).send();
            return { slot, endpoint, latencyMs: Date.now() - t0 };
        });
    }
    /** getLatestBlockhash — fetches blockhash with lastValidBlockHeight. */
    async getLatestBlockhash() {
        return this.withFailover(async (endpoint) => {
            const { createSolanaRpc } = await import('@solana/rpc');
            const rpc = createSolanaRpc(endpoint);
            const result = await rpc.getLatestBlockhash({ commitment: this.commitment }).send();
            return {
                blockhash: result.value.blockhash,
                lastValidBlockHeight: result.value.lastValidBlockHeight,
                endpoint,
            };
        });
    }
    /** getBalance — returns balance in lamports for the given address. */
    async getBalance(address) {
        return this.withFailover(async (endpoint) => {
            const { createSolanaRpc } = await import('@solana/rpc');
            const rpc = createSolanaRpc(endpoint);
            const result = await rpc.getBalance(address, { commitment: this.commitment }).send();
            return result.value;
        });
    }
    /** sendTransaction — sends a base64-encoded signed transaction. */
    async sendTransaction(encodedTx, opts = {}) {
        return this.withFailover(async (endpoint) => {
            const { createSolanaRpc } = await import('@solana/rpc');
            const rpc = createSolanaRpc(endpoint);
            return rpc.sendTransaction(encodedTx, {
                skipPreflight: opts.skipPreflight ?? false,
                encoding: 'base64',
                maxRetries: 0n,
                preflightCommitment: this.commitment,
            }).send();
        });
    }
    /** getSignatureStatuses — poll for transaction confirmation status. */
    async getSignatureStatuses(signatures) {
        return this.withFailover(async (endpoint) => {
            const { createSolanaRpc } = await import('@solana/rpc');
            const rpc = createSolanaRpc(endpoint);
            const result = await rpc.getSignatureStatuses(signatures, { searchTransactionHistory: false }).send();
            return result.value;
        });
    }
    /**
     * Expose all endpoints for use with the raw @solana/rpc createSolanaRpc().
     * This lets users create their own typed RPC clients while still benefiting
     * from the pool's endpoint selection logic.
     */
    getAllEndpoints() {
        return [...this.endpoints];
    }
    // ── internals ──────────────────────────────────────────────────────────────
    async withFailover(fn) {
        const tried = new Set();
        for (let attempt = 0; attempt < this.endpoints.length; attempt++) {
            const endpoint = this.getEndpoint();
            if (tried.has(endpoint))
                break;
            tried.add(endpoint);
            try {
                const result = await fn(endpoint);
                this.recordSuccess(endpoint);
                return result;
            }
            catch (err) {
                this.recordFailure(endpoint);
                if (attempt === this.endpoints.length - 1)
                    throw err;
            }
        }
        throw new Error('All endpoints exhausted');
    }
    isAvailable(endpoint) {
        if (!this.openCircuits.has(endpoint))
            return true;
        const openedAt = this.circuitOpenedAt.get(endpoint) ?? 0;
        if (Date.now() - openedAt >= this.CIRCUIT_TIMEOUT_MS) {
            this.openCircuits.delete(endpoint);
            return true;
        }
        return false;
    }
    recordSuccess(endpoint) {
        this.failureCounts.set(endpoint, 0);
        this.openCircuits.delete(endpoint);
    }
    recordFailure(endpoint) {
        const count = (this.failureCounts.get(endpoint) ?? 0) + 1;
        this.failureCounts.set(endpoint, count);
        if (count >= this.CIRCUIT_THRESHOLD) {
            this.openCircuits.add(endpoint);
            this.circuitOpenedAt.set(endpoint, Date.now());
            this.failureCounts.set(endpoint, 0);
        }
    }
}
/** Factory function — v2.0 functional style entry point. */
export function createReliableRpcV2(opts) {
    return new ReliableRpcV2(opts);
}
//# sourceMappingURL=ReliableRpcV2.js.map