import type { Transaction, Keypair, Commitment } from '@solana/web3.js';
import { RpcPool, type RpcPoolOptions } from './rpc/index.js';
import { BlockhashManager, FeeEstimator, ComputeUnits, TransactionSender, type SendResult, type TransactionSenderOptions } from './tx/index.js';
import { TransactionConfirmer, type ConfirmOptions } from './confirm/TransactionConfirmer.js';
import { WsManager, type WsManagerOptions } from './ws/WsManager.js';
import { MetricsCollector } from './metrics/MetricsCollector.js';
import { JitoSender, type JitoSenderOptions } from './jito/JitoSender.js';
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
    /** Enable Jito/MEV bundle routing. */
    jito?: JitoSenderOptions;
    /** Pass a MetricsCollector to collect RPC + transaction metrics. */
    metrics?: MetricsCollector;
}
/**
 * High-level client that wires RpcPool → BlockhashManager → FeeEstimator →
 * ComputeUnits → TransactionSender → TransactionConfirmer into one easy API.
 *
 * Minimal usage:
 *   const client = new ReliableClient({ endpoints: ['https://...'] });
 *   const { signature } = await client.sendAndConfirm(tx, [keypair]);
 */
export declare class ReliableClient {
    readonly pool: RpcPool;
    readonly blockhashManager: BlockhashManager;
    readonly feeEstimator: FeeEstimator;
    readonly computeUnits: ComputeUnits;
    readonly sender: TransactionSender;
    readonly confirmer: TransactionConfirmer;
    readonly ws: WsManager | undefined;
    readonly jito: JitoSender | undefined;
    readonly metrics: MetricsCollector | undefined;
    constructor(opts: ReliableClientOptions);
    /**
     * Send a transaction and wait for confirmation.
     * Retry-loop, blockhash expiry, priority fees, and CU budget
     * are all handled automatically based on constructor options.
     *
     * If jito is configured, routes through the Jito block engine for MEV protection.
     */
    sendAndConfirm(transaction: Transaction, signers: Keypair[]): Promise<SendResult>;
    /** Release RPC health checker and WebSocket resources. */
    destroy(): void;
}
//# sourceMappingURL=ReliableClient.d.ts.map