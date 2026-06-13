import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TransactionConfirmer,
  PermanentTransactionError,
  TransactionExpiredError,
} from '../src/confirm/TransactionConfirmer.js';

// ── pool factory ─────────────────────────────────────────────────────────────
function makePool(
  getSignatureStatuses: () => Promise<unknown>,
  getBlockHeight: () => Promise<number> = () => Promise.resolve(100),
) {
  const conn = {
    getSignatureStatuses: vi.fn().mockImplementation(getSignatureStatuses),
    getBlockHeight: vi.fn().mockImplementation(getBlockHeight),
    rpcEndpoint: 'https://api.devnet.solana.com',
  };
  return {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
}

const LAST_VALID = 200; // higher than default mock blockHeight (100)

describe('TransactionConfirmer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('resolves when status is "confirmed"', async () => {
    const pool = makePool(() =>
      Promise.resolve({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });

    await expect(confirmer.confirm('sig_ok', LAST_VALID)).resolves.toBeUndefined();
  });

  it('resolves when status is "finalized"', async () => {
    const pool = makePool(() =>
      Promise.resolve({ value: [{ confirmationStatus: 'finalized', err: null }] }),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });

    await expect(confirmer.confirm('sig_finalized', LAST_VALID)).resolves.toBeUndefined();
  });

  it('waits when status is "processed" but commitment is "confirmed"', async () => {
    let calls = 0;
    const pool = makePool(() => {
      calls++;
      const status = calls < 3 ? 'processed' : 'confirmed';
      return Promise.resolve({ value: [{ confirmationStatus: status, err: null }] });
    });
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 50,
      timeoutMs: 5_000,
      commitment: 'confirmed',
    });

    const p = confirmer.confirm('sig_wait', LAST_VALID);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('throws PermanentTransactionError on InstructionError', async () => {
    const pool = makePool(() =>
      Promise.resolve({
        value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'InvalidAccountData'] } }],
      }),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });

    await expect(confirmer.confirm('sig_fail', LAST_VALID)).rejects.toThrow(
      PermanentTransactionError,
    );
  });

  it('PermanentTransactionError carries onChainErr', async () => {
    const onChainErr = { InstructionError: [1, 'Custom'] };
    const pool = makePool(() =>
      Promise.resolve({ value: [{ confirmationStatus: 'confirmed', err: onChainErr }] }),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });

    const caught = await confirmer.confirm('sig', LAST_VALID).catch((e) => e);
    expect(caught).toBeInstanceOf(PermanentTransactionError);
    expect(caught.onChainErr).toEqual(onChainErr);
  });

  it('throws TransactionExpiredError when blockHeight exceeds lastValidBlockHeight', async () => {
    // Status always null, block height above lastValid
    const pool = makePool(
      () => Promise.resolve({ value: [null] }),
      () => Promise.resolve(LAST_VALID + 1),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });

    const p = confirmer.confirm('sig_expired', LAST_VALID);
    // Attach handler BEFORE advancing time to avoid unhandled rejection warning
    const check = expect(p).rejects.toThrow(TransactionExpiredError);
    await vi.advanceTimersByTimeAsync(100);
    await check;
  });

  it('TransactionExpiredError carries the signature', async () => {
    const pool = makePool(
      () => Promise.resolve({ value: [null] }),
      () => Promise.resolve(LAST_VALID + 100),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });

    const p = confirmer.confirm('sig_abc', LAST_VALID);
    // Attach handler BEFORE advancing time to avoid unhandled rejection warning
    const errPromise = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    const err = await errPromise;
    expect(err).toBeInstanceOf(TransactionExpiredError);
    expect(err.signature).toBe('sig_abc');
  });

  it('retries on transient RPC network error', async () => {
    let calls = 0;
    const pool = makePool(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('network timeout'));
      return Promise.resolve({ value: [{ confirmationStatus: 'confirmed', err: null }] });
    });
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });

    const p = confirmer.confirm('sig_retry', LAST_VALID);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('reports failure to pool on RPC error', async () => {
    let calls = 0;
    const pool = makePool(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('timeout'));
      return Promise.resolve({ value: [{ confirmationStatus: 'confirmed', err: null }] });
    });
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });

    const p = confirmer.confirm('sig', LAST_VALID);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(pool.reportFailure).toHaveBeenCalled();
  });

  it('throws timeout error when timeoutMs exceeded', async () => {
    // Status always null, block height never exceeds lastValid
    const pool = makePool(
      () => Promise.resolve({ value: [null] }),
      () => Promise.resolve(50), // below LAST_VALID
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 50,
      timeoutMs: 200,
    });

    const p = confirmer.confirm('sig_timeout', LAST_VALID);
    // Attach rejection handler before advancing time
    const check = expect(p).rejects.toThrow('confirmation timed out');
    await vi.advanceTimersByTimeAsync(400);
    await check;
  });

  it('resolves immediately with commitment "processed"', async () => {
    const pool = makePool(() =>
      Promise.resolve({ value: [{ confirmationStatus: 'processed', err: null }] }),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      commitment: 'processed',
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });
    await expect(confirmer.confirm('sig_proc', LAST_VALID)).resolves.toBeUndefined();
  });

  it('reports failure and treats as not-expired when getBlockHeight throws in checkExpired', async () => {
    const pool = makePool(
      () => Promise.resolve({ value: [null] }),
      () => Promise.reject(new Error('block height RPC error')),
    );
    const confirmer = new TransactionConfirmer(pool as any, {
      pollIntervalMs: 10,
      timeoutMs: 200,
    });

    const p = confirmer.confirm('sig_noheight', LAST_VALID);
    const check = expect(p).rejects.toThrow('confirmation timed out');
    await vi.advanceTimersByTimeAsync(300);
    await check;
    expect(pool.reportFailure).toHaveBeenCalled();
  });

  it('handles commitment "finalized" — does not resolve on "confirmed"', async () => {
    let calls = 0;
    const pool = makePool(() => {
      calls++;
      const status = calls < 3 ? 'confirmed' : 'finalized';
      return Promise.resolve({ value: [{ confirmationStatus: status, err: null }] });
    });
    const confirmer = new TransactionConfirmer(pool as any, {
      commitment: 'finalized',
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });

    const p = confirmer.confirm('sig_fin', LAST_VALID);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });
});
