import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── web3.js mock ─────────────────────────────────────────────────────────────
vi.mock('@solana/web3.js', async () => {
  const { PublicKey: RealPublicKey } = await vi.importActual<typeof import('@solana/web3.js')>(
    '@solana/web3.js',
  );

  class Keypair {
    publicKey = new RealPublicKey('11111111111111111111111111111111');
    static generate() { return new Keypair(); }
  }

  class Transaction {
    instructions: unknown[] = [];
    recentBlockhash = '';
    feePayer: unknown = null;
    sign = vi.fn();
    serialize = vi.fn().mockReturnValue(Buffer.from('fakeTx'));
  }

  class SendTransactionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SendTransactionError';
    }
  }

  class ComputeBudgetProgram {
    static setComputeUnitLimit = vi.fn().mockReturnValue({ programId: 'budget', keys: [], data: Buffer.alloc(0) });
    static setComputeUnitPrice = vi.fn().mockReturnValue({ programId: 'budget', keys: [], data: Buffer.alloc(0) });
  }

  return { Keypair, Transaction, SendTransactionError, ComputeBudgetProgram, PublicKey: RealPublicKey };
});
// ─────────────────────────────────────────────────────────────────────────────

import { Transaction, Keypair } from '@solana/web3.js';
import { TransactionSender } from '../src/tx/TransactionSender.js';

function makeBlockhashManager(overrides: Partial<{
  get: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  refresh: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  isExpired: (h: number) => Promise<boolean>;
}> = {}) {
  return {
    get: overrides.get ?? vi.fn().mockResolvedValue({ blockhash: 'hash1', lastValidBlockHeight: 1000 }),
    refresh: overrides.refresh ?? vi.fn().mockResolvedValue({ blockhash: 'hash1', lastValidBlockHeight: 1000 }),
    isExpired: overrides.isExpired ?? vi.fn().mockResolvedValue(false),
    invalidate: vi.fn(),
  };
}

function makeFeeEstimator() {
  return { estimate: vi.fn().mockResolvedValue(5_000) };
}

function makeComputeUnits() {
  return { simulate: vi.fn().mockResolvedValue(50_000), buildLimitInstruction: vi.fn() };
}

function makePool(
  sendRawTransaction: () => Promise<string>,
  getSignatureStatus?: () => Promise<unknown>,
) {
  const conn = {
    sendRawTransaction: vi.fn().mockImplementation(sendRawTransaction),
    getSignatureStatus: vi.fn().mockImplementation(
      getSignatureStatus ??
      (() => Promise.resolve({ value: { confirmationStatus: 'confirmed', err: null } })),
    ),
    rpcEndpoint: 'https://api.devnet.solana.com',
  };
  return {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
}

describe('TransactionSender', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns signature on first successful send + confirm', async () => {
    const pool = makePool(() => Promise.resolve('sig_ok'));
    const sender = new TransactionSender(
      pool as any,
      makeBlockhashManager() as any,
      makeFeeEstimator() as any,
      makeComputeUnits() as any,
    );

    const result = await sender.send(new Transaction() as any, [new Keypair() as any]);
    expect(result.signature).toBe('sig_ok');
  });

  it('retries send and succeeds on second attempt', async () => {
    let calls = 0;
    const pool = makePool(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('connection reset'));
      return Promise.resolve('sig_retry');
    });

    const sender = new TransactionSender(
      pool as any,
      makeBlockhashManager() as any,
      makeFeeEstimator() as any,
      makeComputeUnits() as any,
      { retryIntervalMs: 10, maxDurationMs: 5_000 },
    );

    const promise = sender.send(new Transaction() as any, [new Keypair() as any]);
    // Let the retry happen
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.signature).toBe('sig_retry');
  });

  it('applies exponential backoff on HTTP 429', async () => {
    let calls = 0;
    const pool = makePool(() => {
      calls++;
      if (calls <= 2) return Promise.reject(new Error('429 Too Many Requests'));
      return Promise.resolve('sig_after_429');
    });

    const sender = new TransactionSender(
      pool as any,
      makeBlockhashManager() as any,
      makeFeeEstimator() as any,
      makeComputeUnits() as any,
      { retryIntervalMs: 100, maxDurationMs: 10_000 },
    );

    // First 429  → sleep 200ms. Second 429 → sleep 400ms. Total = 600ms. Advance 700ms to be safe.
    const sendPromise = sender.send(new Transaction() as any, [new Keypair() as any]);
    await vi.advanceTimersByTimeAsync(700);
    const result = await sendPromise;
    expect(result.signature).toBe('sig_after_429');
    expect(calls).toBe(3);
  });

  it('re-signs when blockhash expires', async () => {
    let expiredChecks = 0;
    const blockhashManager = makeBlockhashManager({
      isExpired: vi.fn().mockImplementation(() => {
        expiredChecks++;
        return Promise.resolve(expiredChecks === 1); // expired on first check
      }),
      refresh: vi.fn()
        .mockResolvedValueOnce({ blockhash: 'hash1', lastValidBlockHeight: 1000 })
        .mockResolvedValueOnce({ blockhash: 'hash2', lastValidBlockHeight: 2000 }),
    });

    const pool = makePool(() => Promise.resolve('sig_resigned'));
    const tx = new Transaction() as any;

    const sender = new TransactionSender(
      pool as any,
      blockhashManager as any,
      makeFeeEstimator() as any,
      makeComputeUnits() as any,
      { retryIntervalMs: 10, maxDurationMs: 5_000 },
    );

    const promise = sender.send(tx, [new Keypair() as any]);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.signature).toBe('sig_resigned');
    expect(blockhashManager.refresh).toHaveBeenCalledTimes(2); // initial + re-sign
    expect(tx.sign).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on permanent on-chain error', async () => {
    const pool = makePool(
      () => Promise.resolve('sig_fail'),
      () => Promise.resolve({ value: { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'InvalidAccountData'] } } }),
    );

    const sender = new TransactionSender(
      pool as any,
      makeBlockhashManager() as any,
      makeFeeEstimator() as any,
      makeComputeUnits() as any,
      { retryIntervalMs: 10, maxDurationMs: 5_000 },
    );

    await expect(
      sender.send(new Transaction() as any, [new Keypair() as any]),
    ).rejects.toThrow('transaction failed on-chain');
  });

  it('adds compute budget instructions when computeUnits + priorityFee are set', async () => {
    const pool = makePool(() => Promise.resolve('sig_budget'));
    const cu = makeComputeUnits();
    const fe = makeFeeEstimator();
    const tx = new Transaction() as any;

    const sender = new TransactionSender(
      pool as any,
      makeBlockhashManager() as any,
      fe as any,
      cu as any,
      { computeUnits: 'auto', priorityFee: 'auto', retryIntervalMs: 10, maxDurationMs: 5_000 },
    );

    const promise = sender.send(tx, [new Keypair() as any]);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(cu.simulate).toHaveBeenCalled();
    expect(fe.estimate).toHaveBeenCalled();
    // Two budget instructions prepended
    expect(tx.instructions).toHaveLength(2);
  });

  it('throws timeout error when maxDuration exceeded', async () => {
    const pool = makePool(() => Promise.reject(new Error('network down')));

    const sender = new TransactionSender(
      pool as any,
      makeBlockhashManager() as any,
      makeFeeEstimator() as any,
      makeComputeUnits() as any,
      { retryIntervalMs: 100, maxDurationMs: 300 },
    );

    const sendPromise = sender.send(new Transaction() as any, [new Keypair() as any]);
    // Attach rejection handler BEFORE advancing time to prevent unhandled rejection warning
    const rejectCheck = expect(sendPromise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(400);
    await rejectCheck;
  });
});
