import { ComputeBudgetProgram, SendTransactionError, } from '@solana/web3.js';
const PERMANENT_ERROR_MARKERS = [
    'InstructionError',
    'custom program error',
    'AccountNotFound',
    'InvalidAccountData',
    'insufficient funds',
];
export class TransactionSender {
    pool;
    blockhashManager;
    feeEstimator;
    computeUnitsHelper;
    opts;
    retryIntervalMs;
    maxDurationMs;
    skipPreflight;
    constructor(pool, blockhashManager, feeEstimator, computeUnitsHelper, opts = {}) {
        this.pool = pool;
        this.blockhashManager = blockhashManager;
        this.feeEstimator = feeEstimator;
        this.computeUnitsHelper = computeUnitsHelper;
        this.opts = opts;
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
    async send(tx, signers) {
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
            let signature;
            try {
                signature = await conn.sendRawTransaction(tx.serialize(), {
                    skipPreflight: this.skipPreflight,
                    maxRetries: 0,
                });
                this.pool.reportSuccess(conn);
            }
            catch (err) {
                if (this.isPermanentError(err))
                    throw err;
                if (this.is429(err)) {
                    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
                }
                else {
                    this.pool.reportFailure(conn);
                    retryDelayMs = this.retryIntervalMs;
                }
                await this.sleep(retryDelayMs);
                continue;
            }
            // Poll confirmation — throws on InstructionError, returns true when confirmed
            try {
                const confirmed = await this.pollStatus(signature);
                if (confirmed)
                    return { signature };
            }
            catch (err) {
                throw err; // permanent on-chain error — no recovery
            }
            await this.sleep(retryDelayMs);
        }
        throw new Error(`transaction timed out after ${this.maxDurationMs}ms`);
    }
    async prepareBudget(tx) {
        const { computeUnits: cuOpt, priorityFee: feeOpt, priorityLevel = 'medium' } = this.opts;
        const prepend = [];
        if (cuOpt === 'auto') {
            // Simulate before adding budget instructions to get real compute consumption
            const units = await this.computeUnitsHelper.simulate(tx);
            prepend.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
        }
        else if (typeof cuOpt === 'number') {
            prepend.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuOpt }));
        }
        if (feeOpt === 'auto') {
            const writable = this.getWritableAccounts(tx);
            const microLamports = await this.feeEstimator.estimate(writable, priorityLevel);
            prepend.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
        }
        else if (typeof feeOpt === 'number') {
            prepend.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: feeOpt }));
        }
        if (prepend.length > 0) {
            tx.instructions.unshift(...prepend);
        }
    }
    async pollStatus(signature) {
        const conn = this.pool.getConnection();
        try {
            const { value } = await conn.getSignatureStatus(signature, {
                searchTransactionHistory: false,
            });
            this.pool.reportSuccess(conn);
            if (!value)
                return false;
            if (value.err) {
                throw new Error(`transaction failed on-chain: ${JSON.stringify(value.err)}`);
            }
            return value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized';
        }
        catch (err) {
            if (err instanceof Error && err.message.startsWith('transaction failed on-chain'))
                throw err;
            this.pool.reportFailure(conn);
            return false;
        }
    }
    getWritableAccounts(tx) {
        const writable = new Set();
        for (const ix of tx.instructions) {
            for (const meta of ix.keys) {
                if (meta.isWritable)
                    writable.add(meta.pubkey.toBase58());
            }
        }
        return [...writable];
    }
    is429(err) {
        if (!(err instanceof Error))
            return false;
        return err.message.includes('429') || err.message.toLowerCase().includes('too many requests');
    }
    isPermanentError(err) {
        if (err instanceof SendTransactionError) {
            const msg = err.message;
            return PERMANENT_ERROR_MARKERS.some((m) => msg.includes(m));
        }
        return false;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=TransactionSender.js.map