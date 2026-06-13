import type { RpcPool } from '../rpc/index.js';

export interface BlockhashData {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface BlockhashManagerOptions {
  cacheTtlMs?: number;
}

interface CachedEntry extends BlockhashData {
  fetchedAt: number;
}

export class BlockhashManager {
  private cached: CachedEntry | null = null;
  private readonly cacheTtlMs: number;
  private inflight: Promise<BlockhashData> | null = null;

  constructor(
    private readonly pool: RpcPool,
    opts: BlockhashManagerOptions = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  }

  async get(): Promise<BlockhashData> {
    if (this.cached && Date.now() - this.cached.fetchedAt < this.cacheTtlMs) {
      return { blockhash: this.cached.blockhash, lastValidBlockHeight: this.cached.lastValidBlockHeight };
    }
    return this.refresh();
  }

  async refresh(): Promise<BlockhashData> {
    if (this.inflight) return this.inflight;

    this.inflight = this.doRefresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Returns true when the current block height has passed lastValidBlockHeight.
   * Safe to call frequently — uses a separate pool connection and falls back to
   * false on error (assume not expired, let the send attempt surface real errors).
   */
  async isExpired(lastValidBlockHeight: number): Promise<boolean> {
    const conn = this.pool.getConnection();
    try {
      const height = await conn.getBlockHeight('confirmed');
      this.pool.reportSuccess(conn);
      return height > lastValidBlockHeight;
    } catch {
      this.pool.reportFailure(conn);
      return false;
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  private async doRefresh(): Promise<BlockhashData> {
    const conn = this.pool.getConnection();
    try {
      const result = await conn.getLatestBlockhash('confirmed');
      this.pool.reportSuccess(conn);
      this.cached = { ...result, fetchedAt: Date.now() };
      return result;
    } catch (err) {
      this.pool.reportFailure(conn);
      throw err;
    }
  }
}
