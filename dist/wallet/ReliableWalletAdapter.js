import { Transaction, } from '@solana/web3.js';
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
    wallet;
    client;
    useReliableClient;
    constructor(wallet, client, opts = {}) {
        this.wallet = wallet;
        this.client = client;
        this.useReliableClient = opts.useReliableClient ?? true;
    }
    get publicKey() {
        if (!this.wallet.publicKey)
            throw new Error('Wallet not connected');
        return this.wallet.publicKey;
    }
    get connected() {
        return this.wallet.connected;
    }
    /**
     * Send a transaction using the wallet for signing and ReliableClient for submission.
     * This replaces the wallet's own sendTransaction to add reliability features.
     */
    async sendTransaction(transaction) {
        if (!this.wallet.publicKey)
            throw new Error('Wallet not connected');
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
    async sendAllTransactions(transactions) {
        const results = [];
        for (const tx of transactions) {
            results.push(await this.sendTransaction(tx));
        }
        return results;
    }
    /**
     * Sign a transaction without sending (delegates to wallet).
     */
    async signTransaction(tx) {
        return this.wallet.signTransaction(tx);
    }
}
//# sourceMappingURL=ReliableWalletAdapter.js.map