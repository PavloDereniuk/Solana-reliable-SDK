import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@solana/web3.js';
import { ComputeUnits } from '../src/tx/ComputeUnits.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool(simulateTransaction: () => Promise<unknown>) {
  const conn = {
    rpcEndpoint: 'https://api.devnet.solana.com',
    simulateTransaction: vi.fn().mockImplementation(simulateTransaction),
  };
  return {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
}

const TX = new Transaction();

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ComputeUnits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns consumed units × buffer (default 1.1)', async () => {
    const pool = makePool(() => Promise.resolve({ value: { unitsConsumed: 10_000 } }));
    const cu = new ComputeUnits(pool as any);

    const units = await cu.simulate(TX);
    expect(units).toBe(Math.ceil(10_000 * 1.1));
  });

  it('respects custom buffer option', async () => {
    const pool = makePool(() => Promise.resolve({ value: { unitsConsumed: 20_000 } }));
    const cu = new ComputeUnits(pool as any, { buffer: 1.2 });

    const units = await cu.simulate(TX);
    expect(units).toBe(Math.ceil(20_000 * 1.2));
  });

  it('returns fallback when unitsConsumed is 0', async () => {
    const pool = makePool(() => Promise.resolve({ value: { unitsConsumed: 0 } }));
    const cu = new ComputeUnits(pool as any, { fallback: 150_000 });

    const units = await cu.simulate(TX);
    expect(units).toBe(150_000);
  });

  it('returns fallback when unitsConsumed is undefined', async () => {
    const pool = makePool(() => Promise.resolve({ value: {} }));
    const cu = new ComputeUnits(pool as any, { fallback: 200_000 });

    const units = await cu.simulate(TX);
    expect(units).toBe(200_000);
  });

  it('returns fallback and reports failure on RPC error', async () => {
    const pool = makePool(() => Promise.reject(new Error('simulation failed')));
    const cu = new ComputeUnits(pool as any, { fallback: 180_000 });

    const units = await cu.simulate(TX);
    expect(units).toBe(180_000);
    expect(pool.reportFailure).toHaveBeenCalledWith(pool._conn);
  });

  it('reports success on successful simulation', async () => {
    const pool = makePool(() => Promise.resolve({ value: { unitsConsumed: 5_000 } }));
    const cu = new ComputeUnits(pool as any);

    await cu.simulate(TX);
    expect(pool.reportSuccess).toHaveBeenCalledWith(pool._conn);
  });

  it('buildLimitInstruction returns setComputeUnitLimit instruction', async () => {
    const pool = makePool(() => Promise.resolve({ value: { unitsConsumed: 8_000 } }));
    const cu = new ComputeUnits(pool as any);

    const ix = await cu.buildLimitInstruction(TX);
    // ComputeBudgetProgram instructions go to program 11111111111111111111111111111111
    expect(ix.programId).toBeDefined();
    // data[0] is the discriminator for setComputeUnitLimit (2)
    expect(ix.data[0]).toBe(2);
  });
});
