export class BlockhashManager {
    pool;
    cached = null;
    cacheTtlMs;
    constructor(pool, opts = {}) {
        this.pool = pool;
        this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    }
    async get() {
        if (this.cached && Date.now() - this.cached.fetchedAt < this.cacheTtlMs) {
            return { blockhash: this.cached.blockhash, lastValidBlockHeight: this.cached.lastValidBlockHeight };
        }
        return this.refresh();
    }
    async refresh() {
        const conn = this.pool.getConnection();
        try {
            const result = await conn.getLatestBlockhash('confirmed');
            this.pool.reportSuccess(conn);
            this.cached = { ...result, fetchedAt: Date.now() };
            return result;
        }
        catch (err) {
            this.pool.reportFailure(conn);
            throw err;
        }
    }
    /**
     * Returns true when the current block height has passed lastValidBlockHeight.
     * Safe to call frequently — uses a separate pool connection and falls back to
     * false on error (assume not expired, let the send attempt surface real errors).
     */
    async isExpired(lastValidBlockHeight) {
        const conn = this.pool.getConnection();
        try {
            const height = await conn.getBlockHeight('confirmed');
            this.pool.reportSuccess(conn);
            return height > lastValidBlockHeight;
        }
        catch {
            this.pool.reportFailure(conn);
            return false;
        }
    }
    invalidate() {
        this.cached = null;
    }
}
//# sourceMappingURL=BlockhashManager.js.map