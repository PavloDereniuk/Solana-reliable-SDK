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
export class ReliableRpcV2 {
  private endpoints: string[];
  private strategy: 'round-robin' | 'priority';
  private roundRobinIndex = 0;
  private readonly failureCounts: Map<string, number> = new Map();
  private readonly openCircuits: Set<string> = new Set();
  private readonly circuitOpenedAt: Map<string, number> = new Map();
  private readonly CIRCUIT_THRESHOLD = 3;
  private readonly CIRCUIT_TIMEOUT_MS = 60_000;

  readonly commitment: 'processed' | 'confirmed' | 'finalized';

  constructor(opts: ReliableRpcV2Options) {
    if (opts.endpoints.length === 0) throw new Error('At least one endpoint required');
    this.endpoints = [...opts.endpoints];
    this.strategy = opts.strategy ?? 'round-robin';
    this.commitment = opts.commitment ?? 'confirmed';
    for (const ep of this.endpoints) this.failureCounts.set(ep, 0);
  }

  /** Returns the currently selected endpoint URL. */
  getEndpoint(): string {
    const available = this.endpoints.filter((ep) => this.isAvailable(ep));
    if (available.length === 0) return this.endpoints[0]; // all broken — try first

    if (this.strategy === 'priority') return available[0];

    const ep = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    return ep;
  }

  /** getSlot — fetches current slot from the best available endpoint. */
  async getSlot(): Promise<SlotInfo> {
    return this.withFailover(async (endpoint) => {
      const { createSolanaRpc } = await import('@solana/rpc');
      const rpc = createSolanaRpc(endpoint);
      const t0 = Date.now();
      const slot = await rpc.getSlot({ commitment: this.commitment }).send();
      return { slot, endpoint, latencyMs: Date.now() - t0 };
    });
  }

  /** getLatestBlockhash — fetches blockhash with lastValidBlockHeight. */
  async getLatestBlockhash(): Promise<BlockhashV2> {
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
  async getBalance(address: Address): Promise<bigint> {
    return this.withFailover(async (endpoint) => {
      const { createSolanaRpc } = await import('@solana/rpc');
      const rpc = createSolanaRpc(endpoint);
      const result = await rpc.getBalance(address, { commitment: this.commitment }).send();
      return result.value;
    });
  }

  /** sendTransaction — sends a base64-encoded signed transaction. */
  async sendTransaction(encodedTx: string, opts: { skipPreflight?: boolean } = {}): Promise<string> {
    return this.withFailover(async (endpoint) => {
      const { createSolanaRpc } = await import('@solana/rpc');
      const rpc = createSolanaRpc(endpoint);
      return rpc.sendTransaction(encodedTx as Parameters<typeof rpc.sendTransaction>[0], {
        skipPreflight: opts.skipPreflight ?? false,
        encoding: 'base64',
        maxRetries: 0n,
        preflightCommitment: this.commitment,
      }).send();
    });
  }

  /** getSignatureStatuses — poll for transaction confirmation status. */
  async getSignatureStatuses(signatures: string[]): Promise<Array<{
    slot?: bigint;
    confirmations?: number;
    confirmationStatus?: string;
    err?: unknown;
  } | null>> {
    return this.withFailover(async (endpoint) => {
      const { createSolanaRpc } = await import('@solana/rpc');
      const rpc = createSolanaRpc(endpoint);
      const result = await rpc.getSignatureStatuses(
        signatures as unknown as Parameters<typeof rpc.getSignatureStatuses>[0],
        { searchTransactionHistory: false },
      ).send();
      return result.value as unknown as Array<{
        slot?: bigint;
        confirmations?: number;
        confirmationStatus?: string;
        err?: unknown;
      } | null>;
    });
  }

  /**
   * Expose all endpoints for use with the raw @solana/rpc createSolanaRpc().
   * This lets users create their own typed RPC clients while still benefiting
   * from the pool's endpoint selection logic.
   */
  getAllEndpoints(): string[] {
    return [...this.endpoints];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async withFailover<T>(fn: (endpoint: string) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < this.endpoints.length; attempt++) {
      const endpoint = this.getEndpoint();
      if (tried.has(endpoint)) break;
      tried.add(endpoint);
      try {
        const result = await fn(endpoint);
        this.recordSuccess(endpoint);
        return result;
      } catch (err) {
        this.recordFailure(endpoint);
        if (attempt === this.endpoints.length - 1) throw err;
      }
    }
    throw new Error('All endpoints exhausted');
  }

  private isAvailable(endpoint: string): boolean {
    if (!this.openCircuits.has(endpoint)) return true;
    const openedAt = this.circuitOpenedAt.get(endpoint) ?? 0;
    if (Date.now() - openedAt >= this.CIRCUIT_TIMEOUT_MS) {
      this.openCircuits.delete(endpoint);
      return true;
    }
    return false;
  }

  private recordSuccess(endpoint: string): void {
    this.failureCounts.set(endpoint, 0);
    this.openCircuits.delete(endpoint);
  }

  private recordFailure(endpoint: string): void {
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
export function createReliableRpcV2(opts: ReliableRpcV2Options): ReliableRpcV2 {
  return new ReliableRpcV2(opts);
}
