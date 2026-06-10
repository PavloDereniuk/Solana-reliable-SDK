import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlockhashManager } from '../src/tx/BlockhashManager.js';

// Minimal mock that satisfies BlockhashManager's RpcPool usage
function makePool(overrides: {
  getLatestBlockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight?: () => Promise<number>;
} = {}) {
  const conn = {
    getLatestBlockhash: overrides.getLatestBlockhash ?? vi.fn().mockResolvedValue({
      blockhash: 'abc123',
      lastValidBlockHeight: 1000,
    }),
    getBlockHeight: overrides.getBlockHeight ?? vi.fn().mockResolvedValue(900),
  };

  return {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
}

describe('BlockhashManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fetches blockhash on first call', async () => {
    const pool = makePool();
    const mgr = new BlockhashManager(pool as any);

    const result = await mgr.get();
    expect(result.blockhash).toBe('abc123');
    expect(result.lastValidBlockHeight).toBe(1000);
    expect(pool._conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it('returns cached value within TTL', async () => {
    const pool = makePool();
    const mgr = new BlockhashManager(pool as any, { cacheTtlMs: 30_000 });

    await mgr.get();
    await mgr.get();

    expect(pool._conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expires', async () => {
    const pool = makePool();
    const mgr = new BlockhashManager(pool as any, { cacheTtlMs: 5_000 });

    await mgr.get();
    vi.advanceTimersByTime(6_000);
    await mgr.get();

    expect(pool._conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it('invalidate() clears the cache', async () => {
    const pool = makePool();
    const mgr = new BlockhashManager(pool as any);

    await mgr.get();
    mgr.invalidate();
    await mgr.get();

    expect(pool._conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it('isExpired() returns true when block height exceeds lastValidBlockHeight', async () => {
    const pool = makePool({ getBlockHeight: vi.fn().mockResolvedValue(1001) });
    const mgr = new BlockhashManager(pool as any);

    expect(await mgr.isExpired(1000)).toBe(true);
  });

  it('isExpired() returns false when still within range', async () => {
    const pool = makePool({ getBlockHeight: vi.fn().mockResolvedValue(999) });
    const mgr = new BlockhashManager(pool as any);

    expect(await mgr.isExpired(1000)).toBe(false);
  });

  it('isExpired() returns false and reports failure on RPC error', async () => {
    const pool = makePool({
      getBlockHeight: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const mgr = new BlockhashManager(pool as any);

    expect(await mgr.isExpired(1000)).toBe(false);
    expect(pool.reportFailure).toHaveBeenCalled();
  });

  it('refresh() reports failure and throws on RPC error', async () => {
    const pool = makePool({
      getLatestBlockhash: vi.fn().mockRejectedValue(new Error('rpc down')),
    });
    const mgr = new BlockhashManager(pool as any);

    await expect(mgr.refresh()).rejects.toThrow('rpc down');
    expect(pool.reportFailure).toHaveBeenCalled();
  });
});
