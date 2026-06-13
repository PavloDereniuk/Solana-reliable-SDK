import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
const JITO_ENDPOINTS = {
    mainnet: 'https://mainnet.block-engine.jito.wtf/api/v1',
    amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1',
    frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1',
    ny: 'https://ny.mainnet.block-engine.jito.wtf/api/v1',
    tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf/api/v1',
};
/** Jito tip accounts (rotate randomly to spread load) */
const TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];
function randomTipAccount() {
    return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
}
export class JitoSender {
    pool;
    blockhashManager;
    blockEngineUrl;
    tipLamports;
    bundleTimeoutMs;
    fallbackOnError;
    constructor(pool, blockhashManager, opts = {}) {
        this.pool = pool;
        this.blockhashManager = blockhashManager;
        const region = opts.region ?? 'mainnet';
        this.blockEngineUrl = opts.blockEngineUrl ?? JITO_ENDPOINTS[region];
        this.tipLamports = opts.tipLamports ?? 1_000;
        this.bundleTimeoutMs = opts.bundleTimeoutMs ?? 60_000;
        this.fallbackOnError = opts.fallbackOnError ?? true;
    }
    /**
     * Send a transaction through Jito for MEV protection.
     * Automatically adds a tip instruction. Falls back to standard RPC if Jito fails.
     */
    async sendWithMevProtection(tx, signers) {
        try {
            const bundleId = await this.sendBundle([tx], signers);
            const status = await this.waitForBundle(bundleId);
            if (status.status === 'Landed' || status.status === 'Finalizing') {
                // Extract signature from the first transaction
                return tx.signatures[0]?.publicKey?.toBase58() ?? bundleId;
            }
            throw new Error(`bundle ${bundleId} status: ${status.status}`);
        }
        catch (err) {
            if (!this.fallbackOnError)
                throw err;
            // Fall back to standard RPC send
            return this.standardSend(tx, signers);
        }
    }
    /**
     * Submit an atomic bundle of up to 5 transactions to Jito.
     * All transactions land in the same slot or none do.
     * Returns bundle UUID.
     */
    async sendBundle(transactions, signerSets) {
        const { blockhash, lastValidBlockHeight } = await this.blockhashManager.refresh();
        // Normalize signers: accept either a flat Keypair[] (all txs same signers)
        // or Keypair[][] (per-tx signers)
        const perTxSigners = Array.isArray(signerSets[0])
            ? signerSets
            : transactions.map(() => signerSets);
        const encodedTxs = [];
        for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i];
            tx.recentBlockhash = blockhash;
            tx.feePayer = perTxSigners[i][0].publicKey;
            tx.sign(...perTxSigners[i]);
            encodedTxs.push(tx.serialize().toString('base64'));
        }
        const resp = await fetch(`${this.blockEngineUrl}/bundles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [encodedTxs],
            }),
        });
        if (!resp.ok) {
            throw new Error(`Jito block engine error: HTTP ${resp.status}`);
        }
        const data = (await resp.json());
        if (data.error)
            throw new Error(`Jito error: ${data.error.message}`);
        if (!data.result)
            throw new Error('Jito: unexpected response shape');
        return data.result;
    }
    /**
     * Poll Jito for bundle landing status.
     * Resolves when Landed/Failed/timeout.
     */
    async getBundleStatus(bundleId) {
        const resp = await fetch(`${this.blockEngineUrl}/bundles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getBundleStatuses',
                params: [[bundleId]],
            }),
        });
        if (!resp.ok)
            throw new Error(`Jito status error: HTTP ${resp.status}`);
        const data = (await resp.json());
        const item = data.result?.value?.[0];
        if (!item)
            return { bundleId, status: 'Pending' };
        const statusMap = {
            processed: 'Finalizing',
            confirmed: 'Finalizing',
            finalized: 'Landed',
        };
        return {
            bundleId,
            status: statusMap[item.confirmation_status] ?? 'Pending',
            landedSlot: item.slot,
        };
    }
    /** Build a tip transaction to the Jito tip account. */
    buildTipTransaction(payer) {
        const tipAccount = new PublicKey(randomTipAccount());
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tipAccount,
            lamports: this.tipLamports,
        }));
        return tx;
    }
    async waitForBundle(bundleId) {
        const deadline = Date.now() + this.bundleTimeoutMs;
        while (Date.now() < deadline) {
            const status = await this.getBundleStatus(bundleId);
            if (status.status === 'Landed' || status.status === 'Finalizing' || status.status === 'Failed' || status.status === 'Invalid') {
                return status;
            }
            await this.sleep(2_000);
        }
        throw new Error(`bundle ${bundleId} did not land within ${this.bundleTimeoutMs}ms`);
    }
    async standardSend(tx, signers) {
        const conn = this.pool.getConnection();
        const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 0 });
        this.pool.reportSuccess(conn);
        return sig;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=JitoSender.js.map