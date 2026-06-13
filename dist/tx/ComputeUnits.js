import { ComputeBudgetProgram } from '@solana/web3.js';
export class ComputeUnits {
    pool;
    buffer;
    fallback;
    constructor(pool, opts = {}) {
        this.pool = pool;
        this.buffer = opts.buffer ?? 1.1;
        this.fallback = opts.fallback ?? 200_000;
    }
    /**
     * Simulate transaction and return a setComputeUnitLimit instruction
     * sized to actual consumption + buffer. Falls back to `fallback` on error.
     */
    async buildLimitInstruction(tx) {
        const units = await this.simulate(tx);
        return ComputeBudgetProgram.setComputeUnitLimit({ units });
    }
    async simulate(tx) {
        const conn = this.pool.getConnection();
        try {
            const { value } = await conn.simulateTransaction(tx);
            this.pool.reportSuccess(conn);
            const consumed = value.unitsConsumed;
            if (!consumed || consumed === 0)
                return this.fallback;
            return Math.ceil(consumed * this.buffer);
        }
        catch {
            this.pool.reportFailure(conn);
            return this.fallback;
        }
    }
}
//# sourceMappingURL=ComputeUnits.js.map