import type { Transaction, Keypair, Commitment } from '@solana/web3.js';
import { RpcPool, type RpcPoolOptions } from './rpc/index.js';
import {
  BlockhashManager,
  FeeEstimator,
  ComputeUnits,
  TransactionSender,
  type SendResult,
  type TransactionSenderOptions,
} from './tx/index.js';
import { TransactionConfirmer, type ConfirmOptions } from './confirm/TransactionConfirmer.js';
import { WsManager, type WsManagerOptions } from './ws/WsManager.js';

export interface ReliableClientOptions {
  /** At least one RPC endpoint URL. First one is treated as highest priority. */
  endpoints: string[];
  commitment?: Commitment;
  /**
   * Optional separate WebSocket endpoint.
   * If omitted, WsManager is not created and `client.ws` is undefined.
   */
  wsEndpoint?: string;

  pool?: Partial<RpcPoolOptions>;
  tx?: Partial<TransactionSenderOptions>;
  confirm?: Partial<ConfirmOptions>;
  ws?: Partial<WsManagerOptions>;
}

/**
 * High-level client that wires RpcPool → BlockhashManager → FeeEstimator →
 * ComputeUnits → TransactionSender → TransactionConfirmer into one easy API.
 *
 * Minimal usage:
 *   const client = new ReliableClient({ endpoints: ['https://...'] });
 *   const { signature } = await client.sendAndConfirm(tx, [keypair]);
 */
export class ReliableClient {
  readonly pool: RpcPool;
  readonly blockhashManager: BlockhashManager;
  readonly feeEstimator: FeeEstimator;
  readonly computeUnits: ComputeUnits;
  readonly sender: TransactionSender;
  readonly confirmer: TransactionConfirmer;
  readonly ws: WsManager | undefined;

  constructor(opts: ReliableClientOptions) {
    const { endpoints, commitment = 'confirmed', wsEndpoint } = opts;

    this.pool = new RpcPool(endpoints, {
      commitment,
      ...opts.pool,
    });

    this.blockhashManager = new BlockhashManager(this.pool);
    this.feeEstimator = new FeeEstimator(this.pool);
    this.computeUnits = new ComputeUnits(this.pool);

    this.sender = new TransactionSender(
      this.pool,
      this.blockhashManager,
      this.feeEstimator,
      this.computeUnits,
      opts.tx,
    );

    this.confirmer = new TransactionConfirmer(this.pool, {
      commitment: commitment as 'processed' | 'confirmed' | 'finalized',
      ...opts.confirm,
    });

    if (wsEndpoint) {
      this.ws = new WsManager(wsEndpoint, {
        commitment,
        ...opts.ws,
      });
    }
  }

  /**
   * Send a transaction and wait for confirmation.
   * Retry-loop, blockhash expiry, priority fees, and CU budget
   * are all handled automatically based on constructor options.
   */
  async sendAndConfirm(transaction: Transaction, signers: Keypair[]): Promise<SendResult> {
    return this.sender.send(transaction, signers);
  }

  /** Release RPC health checker and WebSocket resources. */
  destroy(): void {
    this.pool.destroy();
    this.ws?.destroy();
  }
}
