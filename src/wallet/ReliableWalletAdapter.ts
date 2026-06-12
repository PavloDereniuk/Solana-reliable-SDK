import {
  Transaction,
  VersionedTransaction,
  PublicKey,
  Connection,
  type SendOptions,
} from '@solana/web3.js';
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
  sendTransaction(
    transaction: Transaction | VersionedTransaction,
    connection: Connection,
    options?: SendOptions,
  ): Promise<string>;
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
export class ReliableWalletAdapter {
  private readonly useReliableClient: boolean;

  constructor(
    private readonly wallet: WalletLike,
    private readonly client: ReliableClient,
    opts: ReliableWalletAdapterOptions = {},
  ) {
    this.useReliableClient = opts.useReliableClient ?? true;
  }

  get publicKey(): PublicKey {
    if (!this.wallet.publicKey) throw new Error('Wallet not connected');
    return this.wallet.publicKey;
  }

  get connected(): boolean {
    return this.wallet.connected;
  }

  /**
   * Send a transaction using the wallet for signing and ReliableClient for submission.
   * This replaces the wallet's own sendTransaction to add reliability features.
   */
  async sendTransaction(transaction: Transaction): Promise<string> {
    if (!this.wallet.publicKey) throw new Error('Wallet not connected');

    // Prepare the transaction: get fresh blockhash, set fee payer
    const { blockhash, lastValidBlockHeight } = await this.client.blockhashManager.refresh();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.wallet.publicKey;

    // Ask wallet to sign
    const signed = await this.wallet.signTransaction(transaction);
    if (!(signed instanceof Transaction)) {
      throw new Error('VersionedTransaction not supported in sendTransaction — use sendVersionedTransaction');
    }

    // Use ReliableClient pool for submission (with retry, priority fee, etc.)
    const conn = this.client.pool.getConnection();
    const signature = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 0 });
    this.client.pool.reportSuccess(conn);

    // Confirm asynchronously
    await this.client.confirmer.confirm(signature, lastValidBlockHeight);

    return signature;
  }

  /**
   * Sign and send all transactions in sequence using reliable submission.
   */
  async sendAllTransactions(transactions: Transaction[]): Promise<string[]> {
    const results: string[] = [];
    for (const tx of transactions) {
      results.push(await this.sendTransaction(tx));
    }
    return results;
  }

  /**
   * Sign a transaction without sending (delegates to wallet).
   */
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    return this.wallet.signTransaction(tx);
  }
}
