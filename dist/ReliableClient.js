import { RpcPool } from './rpc/index.js';
import { BlockhashManager, FeeEstimator, ComputeUnits, TransactionSender, } from './tx/index.js';
import { TransactionConfirmer } from './confirm/TransactionConfirmer.js';
import { WsManager } from './ws/WsManager.js';
import { JitoSender } from './jito/JitoSender.js';
/**
 * High-level client that wires RpcPool → BlockhashManager → FeeEstimator →
 * ComputeUnits → TransactionSender → TransactionConfirmer into one easy API.
 *
 * Minimal usage:
 *   const client = new ReliableClient({ endpoints: ['https://...'] });
 *   const { signature } = await client.sendAndConfirm(tx, [keypair]);
 */
export class ReliableClient {
    pool;
    blockhashManager;
    feeEstimator;
    computeUnits;
    sender;
    confirmer;
    ws;
    jito;
    metrics;
    constructor(opts) {
        const { endpoints, commitment = 'confirmed', wsEndpoint } = opts;
        this.metrics = opts.metrics;
        this.pool = new RpcPool(endpoints, {
            commitment,
            metrics: this.metrics,
            ...opts.pool,
        });
        this.blockhashManager = new BlockhashManager(this.pool);
        this.feeEstimator = new FeeEstimator(this.pool);
        this.computeUnits = new ComputeUnits(this.pool);
        this.sender = new TransactionSender(this.pool, this.blockhashManager, this.feeEstimator, this.computeUnits, opts.tx);
        this.confirmer = new TransactionConfirmer(this.pool, {
            commitment: commitment,
            ...opts.confirm,
        });
        if (wsEndpoint) {
            this.ws = new WsManager(wsEndpoint, {
                commitment,
                ...opts.ws,
            });
        }
        if (opts.jito) {
            this.jito = new JitoSender(this.pool, this.blockhashManager, opts.jito);
        }
    }
    /**
     * Send a transaction and wait for confirmation.
     * Retry-loop, blockhash expiry, priority fees, and CU budget
     * are all handled automatically based on constructor options.
     *
     * If jito is configured, routes through the Jito block engine for MEV protection.
     */
    async sendAndConfirm(transaction, signers) {
        if (this.jito) {
            const signature = await this.jito.sendWithMevProtection(transaction, signers);
            this.metrics?.recordTransaction({ retries: 0, success: true, durationMs: 0 });
            return { signature };
        }
        return this.sender.send(transaction, signers);
    }
    /** Release RPC health checker and WebSocket resources. */
    destroy() {
        this.pool.destroy();
        this.ws?.destroy();
    }
}
//# sourceMappingURL=ReliableClient.js.map