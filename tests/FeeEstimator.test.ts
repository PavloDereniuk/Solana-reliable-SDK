import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeeEstimator } from '../src/tx/FeeEstimator.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool(opts: {
  endpoint?: string;
  getRecentPrioritizationFees?: () => Promise<{ slot: number; prioritizationFee: number }[]>;
}) {
  const conn = {
    rpcEndpoint: opts.endpoint ?? 'https://api.devnet.solana.com',
    getRecentPrioritizationFees: vi
      .fn()
      .mockImplementation(
        opts.getRecentPrioritizationFees ??
          (() => Promise.resolve([])),
      ),
  };
  return {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('FeeEstimator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns defaultFee when getRecentPrioritizationFees returns empty array', async () => {
    const pool = makePool({ getRecentPrioritizationFees: () => Promise.resolve([]) });
    const estimator = new FeeEstimator(pool as any, { defaultFee: 5_000 });

    const fee = await estimator.estimate();
    expect(fee).toBe(5_000);
  });

  it('returns 50th-percentile fee for level "medium"', async () => {
    const fees = [100, 200, 300, 400, 500].map((f, i) => ({ slot: i, prioritizationFee: f }));
    const pool = makePool({ getRecentPrioritizationFees: () => Promise.resolve(fees) });
    const estimator = new FeeEstimator(pool as any);

    const fee = await estimator.estimate([], 'medium');
    // sorted: [100,200,300,400,500] → idx = floor(5*0.5) = 2 → 300
    expect(fee).toBe(300);
  });

  it('returns 25th-percentile fee for level "low"', async () => {
    const fees = [100, 200, 300, 400].map((f, i) => ({ slot: i, prioritizationFee: f }));
    const pool = makePool({ getRecentPrioritizationFees: () => Promise.resolve(fees) });
    const estimator = new FeeEstimator(pool as any);

    const fee = await estimator.estimate([], 'low');
    // sorted: [100,200,300,400] → idx = floor(4*0.25) = 1 → 200
    expect(fee).toBe(200);
  });

  it('returns 75th-percentile fee for level "high"', async () => {
    const fees = [100, 200, 300, 400].map((f, i) => ({ slot: i, prioritizationFee: f }));
    const pool = makePool({ getRecentPrioritizationFees: () => Promise.resolve(fees) });
    const estimator = new FeeEstimator(pool as any);

    const fee = await estimator.estimate([], 'high');
    // sorted: [100,200,300,400] → idx = floor(4*0.75) = 3 → 400
    expect(fee).toBe(400);
  });

  it('reports success to pool after successful RPC call', async () => {
    const pool = makePool({
      getRecentPrioritizationFees: () =>
        Promise.resolve([{ slot: 1, prioritizationFee: 1_000 }]),
    });
    const estimator = new FeeEstimator(pool as any);

    await estimator.estimate();
    expect(pool.reportSuccess).toHaveBeenCalledWith(pool._conn);
  });

  it('returns defaultFee and reports failure on RPC error', async () => {
    const pool = makePool({
      getRecentPrioritizationFees: () => Promise.reject(new Error('RPC timeout')),
    });
    const estimator = new FeeEstimator(pool as any, { defaultFee: 2_000 });

    const fee = await estimator.estimate();
    expect(fee).toBe(2_000);
    expect(pool.reportFailure).toHaveBeenCalledWith(pool._conn);
  });

  it('uses Helius getPriorityFeeEstimate when endpoint contains "helius"', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ result: { priorityFeeEstimate: 42_000 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool({ endpoint: 'https://mainnet.helius-rpc.com/?api-key=TEST123' });
    const estimator = new FeeEstimator(pool as any);

    const fee = await estimator.estimate(['GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR'], 'high');
    expect(fee).toBe(42_000);
    expect(mockFetch).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('falls back to getRecentPrioritizationFees when Helius returns non-ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool({
      endpoint: 'https://mainnet.helius-rpc.com/?api-key=KEY',
      getRecentPrioritizationFees: () =>
        Promise.resolve([{ slot: 1, prioritizationFee: 999 }]),
    });
    const estimator = new FeeEstimator(pool as any);

    const fee = await estimator.estimate();
    expect(fee).toBe(999);

    vi.unstubAllGlobals();
  });
});
