import {
  Transaction,
  Keypair,
  ComputeBudgetProgram,
  SendTransactionError,
  type TransactionInstruction,
} from '@solana/web3.js';
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

const PERMANENT_ERROR_MARKERS = [
  'InstructionError',
  'custom program error',
  'AccountNotFound',
  'InvalidAccountData',
  'insufficient funds',
];

export class TransactionSender {
  private readonly retryIntervalMs: number;
  private readonly maxDurationMs: number;
  private readonly skipPreflight: boolean;

  constructor(
    private readonly pool: RpcPool,
    private readonly blockhashManager: BlockhashManager,
    private readonly feeEstimator: FeeEstimator,
    private readonly computeUnitsHelper: ComputeUnits,
    private readonly opts: TransactionSenderOptions = {},
  ) {
    this.retryIntervalMs = opts.retryIntervalMs ?? 2_000;
    this.maxDurationMs = opts.maxDurationMs ?? 90_000;
    this.skipPreflight = opts.skipPreflight ?? false;
  }

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
  async send(tx: Transaction, signers: Keypair[]): Promise<SendResult> {
    await this.prepareBudget(tx);

    let { blockhash, lastValidBlockHeight } = await this.blockhashManager.refresh();
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);

    const deadline = Date.now() + this.maxDurationMs;
    let retryDelayMs = this.retryIntervalMs;

    while (Date.now() < deadline) {
      // Re-sign only when the blockhash has expired
      const expired = await this.blockhashManager.isExpired(lastValidBlockHeight);
      if (expired) {
        const fresh = await this.blockhashManager.refresh();
        blockhash = fresh.blockhash;
        lastValidBlockHeight = fresh.lastValidBlockHeight;
        tx.recentBlockhash = blockhash;
        tx.sign(...signers);
        retryDelayMs = this.retryIntervalMs; // reset backoff after re-sign
      }

      const conn = this.pool.getConnection();
      let signature: string;

      try {
        signature = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: this.skipPreflight,
          maxRetries: 0,
        });
        this.pool.reportSuccess(conn);
      } catch (err) {
        if (this.isPermanentError(err)) throw err;

        if (this.is429(err)) {
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        } else {
          this.pool.reportFailure(conn);
          retryDelayMs = this.retryIntervalMs;
        }

        await this.sleep(retryDelayMs);
        continue;
      }

      // Poll confirmation — throws on InstructionError, returns true when confirmed
      try {
        const confirmed = await this.pollStatus(signature);
        if (confirmed) return { signature };
      } catch (err) {
        throw err; // permanent on-chain error — no recovery
      }

      await this.sleep(retryDelayMs);
    }

    throw new Error(`transaction timed out after ${this.maxDurationMs}ms`);
  }

  private async prepareBudget(tx: Transaction): Promise<void> {
    const { computeUnits: cuOpt, priorityFee: feeOpt, priorityLevel = 'medium' } = this.opts;
    const prepend: TransactionInstruction[] = [];

    if (cuOpt === 'auto') {
      // Simulate before adding budget instructions to get real compute consumption
      const units = await this.computeUnitsHelper.simulate(tx);
      prepend.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    } else if (typeof cuOpt === 'number') {
      prepend.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuOpt }));
    }

    if (feeOpt === 'auto') {
      const writable = this.getWritableAccounts(tx);
      const microLamports = await this.feeEstimator.estimate(writable, priorityLevel);
      prepend.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    } else if (typeof feeOpt === 'number') {
      prepend.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: feeOpt }));
    }

    if (prepend.length > 0) {
      tx.instructions.unshift(...prepend);
    }
  }

  private async pollStatus(signature: string): Promise<boolean> {
    const conn = this.pool.getConnection();
    try {
      const { value } = await conn.getSignatureStatus(signature, {
        searchTransactionHistory: false,
      });
      this.pool.reportSuccess(conn);

      if (!value) return false;

      if (value.err) {
        throw new Error(`transaction failed on-chain: ${JSON.stringify(value.err)}`);
      }

      return value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized';
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('transaction failed on-chain')) throw err;
      this.pool.reportFailure(conn);
      return false;
    }
  }

  private getWritableAccounts(tx: Transaction): string[] {
    const writable = new Set<string>();
    for (const ix of tx.instructions) {
      for (const meta of ix.keys) {
        if (meta.isWritable) writable.add(meta.pubkey.toBase58());
      }
    }
    return [...writable];
  }

  private is429(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.includes('429') || err.message.toLowerCase().includes('too many requests');
  }

  private isPermanentError(err: unknown): boolean {
    if (err instanceof SendTransactionError) {
      const msg = err.message;
      return PERMANENT_ERROR_MARKERS.some((m) => msg.includes(m));
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
