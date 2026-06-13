export class PermanentTransactionError extends Error {
    onChainErr;
    constructor(message, onChainErr) {
        super(message);
        this.onChainErr = onChainErr;
        this.name = 'PermanentTransactionError';
    }
}
export class TransactionExpiredError extends Error {
    signature;
    constructor(signature) {
        super(`transaction ${signature} expired: blockhash no longer valid`);
        this.signature = signature;
        this.name = 'TransactionExpiredError';
    }
}
export class TransactionConfirmer {
    pool;
    commitment;
    pollIntervalMs;
    timeoutMs;
    constructor(pool, opts = {}) {
        this.pool = pool;
        this.commitment = opts.commitment ?? 'confirmed';
        this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
        this.timeoutMs = opts.timeoutMs ?? 60_000;
    }
    /**
     * Poll until the transaction reaches the desired commitment level.
     *
     * Throws:
     *   PermanentTransactionError  — InstructionError or other on-chain failure (no retry)
     *   TransactionExpiredError    — blockHeight > lastValidBlockHeight while status still null
     *   Error('confirmation timed out') — wall-clock timeout exceeded
     */
    async confirm(signature, lastValidBlockHeight) {
        const deadline = Date.now() + this.timeoutMs;
        while (Date.now() < deadline) {
            const statusConn = this.pool.getConnection();
            try {
                const { value: statuses } = await statusConn.getSignatureStatuses([signature], {
                    searchTransactionHistory: false,
                });
                this.pool.reportSuccess(statusConn);
                const status = statuses?.[0] ?? null;
                if (status !== null) {
                    if (status.err) {
                        throw new PermanentTransactionError(`transaction failed on-chain: ${JSON.stringify(status.err)}`, status.err);
                    }
                    if (this.meetsCommitment(status.confirmationStatus))
                        return;
                }
                else {
                    // Status not found yet — check if blockhash already expired
                    const expired = await this.checkExpired(lastValidBlockHeight);
                    if (expired)
                        throw new TransactionExpiredError(signature);
                }
            }
            catch (err) {
                if (err instanceof PermanentTransactionError)
                    throw err;
                if (err instanceof TransactionExpiredError)
                    throw err;
                // Network / RPC error → report failure and retry
                this.pool.reportFailure(statusConn);
            }
            await this.sleep(this.pollIntervalMs);
        }
        throw new Error(`confirmation timed out after ${this.timeoutMs}ms for signature ${signature}`);
    }
    async checkExpired(lastValidBlockHeight) {
        const conn = this.pool.getConnection();
        try {
            const height = await conn.getBlockHeight(this.commitment);
            this.pool.reportSuccess(conn);
            return height > lastValidBlockHeight;
        }
        catch {
            this.pool.reportFailure(conn);
            return false; // assume not expired on RPC error
        }
    }
    meetsCommitment(status) {
        if (!status)
            return false;
        switch (this.commitment) {
            case 'processed': return true;
            case 'confirmed': return status === 'confirmed' || status === 'finalized';
            case 'finalized': return status === 'finalized';
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=TransactionConfirmer.js.map