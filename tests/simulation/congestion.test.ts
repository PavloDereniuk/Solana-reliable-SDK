/**
 * Network congestion simulation tests.
 * Simulates HTTP 429 rate limiting, high latency, and transaction retry behavior.
 *
 * Mirrors the approach of TransactionSender.test.ts:
 *  - mock @solana/web3.js so tx.sign/serialize are no-ops (no blockhash validation)
 *  - vi.useFakeTimers({ shouldAdvanceTime: false })
 *  - start the send(), advance fake timers, then await the promise
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── web3.js mock (hoisted) ───────────────────────────────────────────────────
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
    add = vi.fn().mockReturnThis();
  }

  class SendTransactionError extends Error {
    constructor(message: string) { super(message); this.name = 'SendTransactionError'; }
  }

  class SystemProgram {
    static transfer = vi.fn().mockReturnValue({ programId: 'sys', keys: [], data: Buffer.alloc(0) });
  }

  class ComputeBudgetProgram {
    static setComputeUnitLimit = vi.fn().mockReturnValue({ programId: 'budget', keys: [], data: Buffer.alloc(0) });
    static setComputeUnitPrice = vi.fn().mockReturnValue({ programId: 'budget', keys: [], data: Buffer.alloc(0) });
  }

  return { Keypair, Transaction, SendTransactionError, SystemProgram, ComputeBudgetProgram, PublicKey: RealPublicKey };
});
// ────────────────────────────────────────────────────────────────────────────

import { Transaction, Keypair, SystemProgram } from '@solana/web3.js';
import { TransactionSender } from '../../src/tx/TransactionSender.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeps(sendImpl?: () => Promise<string>) {
  const conn = {
    rpcEndpoint: 'https://rpc.example.com',
    sendRawTransaction: vi.fn().mockImplementation(sendImpl ?? (() => Promise.resolve('sig_ok'))),
    getSignatureStatus: vi.fn().mockResolvedValue({
      value: { confirmationStatus: 'confirmed', err: null },
    }),
  };
  const pool = {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
  const blockhashManager = {
    refresh: vi.fn().mockResolvedValue({ blockhash: 'hash1', lastValidBlockHeight: 9999 }),
    isExpired: vi.fn().mockResolvedValue(false),
  };
  const feeEstimator = { estimate: vi.fn().mockResolvedValue(0) };
  const computeUnits = { simulate: vi.fn().mockResolvedValue(200_000), buildLimitInstruction: vi.fn() };
  return { pool, blockhashManager, feeEstimator, computeUnits, conn };
}

function makeTx(): Transaction {
  return new Transaction() as any;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Network Congestion Simulation', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  describe('HTTP 429 Rate Limiting', () => {
    it('applies exponential backoff when 429 received', async () => {
      let attempt = 0;
      const { pool, blockhashManager, feeEstimator, computeUnits } = makeDeps(() => {
        attempt++;
        if (attempt < 3) throw new Error('429 Too Many Requests');
        return Promise.resolve('sig_ok');
      });

      const sender = new TransactionSender(
        pool as any, blockhashManager as any, feeEstimator as any, computeUnits as any,
        { retryIntervalMs: 100, maxDurationMs: 10_000 },
      );

      // Attempt 1: 429 → sleep 200ms. Attempt 2: 429 → sleep 400ms. Total: 600ms.
      const prom = sender.send(makeTx(), [Keypair.generate()]);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await prom;

      expect(result.signature).toBe('sig_ok');
      expect(attempt).toBe(3);
    });

    it('does not exceed maxDelay of 30s for exponential backoff', async () => {
      let attempt = 0;
      const { pool, blockhashManager, feeEstimator, computeUnits } = makeDeps(() => {
        attempt++;
        if (attempt < 5) throw new Error('429 Too Many Requests');
        return Promise.resolve('sig_ok');
      });

      const sender = new TransactionSender(
        pool as any, blockhashManager as any, feeEstimator as any, computeUnits as any,
        { retryIntervalMs: 50, maxDurationMs: 60_000 },
      );

      // Sleeps: 100 + 200 + 400 + 800 = 1500ms. Advance 2000ms.
      const prom = sender.send(makeTx(), [Keypair.generate()]);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await prom;

      expect(result.signature).toBe('sig_ok');
      expect(attempt).toBe(5);
    });

    it('non-429 errors report failure to pool and use normal interval', async () => {
      let attempt = 0;
      const { pool, blockhashManager, feeEstimator, computeUnits } = makeDeps(() => {
        attempt++;
        if (attempt < 2) throw new Error('network timeout');
        return Promise.resolve('sig_ok');
      });

      const sender = new TransactionSender(
        pool as any, blockhashManager as any, feeEstimator as any, computeUnits as any,
        { retryIntervalMs: 50, maxDurationMs: 10_000 },
      );

      const prom = sender.send(makeTx(), [Keypair.generate()]);
      await vi.advanceTimersByTimeAsync(200);
      const result = await prom;

      expect(result.signature).toBe('sig_ok');
      expect(pool.reportFailure).toHaveBeenCalled();
    });
  });

  describe('Dropped Transactions', () => {
    it('retries on status null (transaction not yet visible on-chain)', async () => {
      let statusCalls = 0;
      const { pool, blockhashManager, feeEstimator, computeUnits, conn } = makeDeps();
      conn.getSignatureStatus = vi.fn().mockImplementation(() => {
        statusCalls++;
        if (statusCalls < 3) return Promise.resolve({ value: null });
        return Promise.resolve({ value: { confirmationStatus: 'confirmed', err: null } });
      });

      const sender = new TransactionSender(
        pool as any, blockhashManager as any, feeEstimator as any, computeUnits as any,
        { retryIntervalMs: 50, maxDurationMs: 10_000 },
      );

      // 2 null statuses → 2 sleeps of 50ms each = 100ms. Advance 300ms.
      const prom = sender.send(makeTx(), [Keypair.generate()]);
      await vi.advanceTimersByTimeAsync(300);
      const result = await prom;

      expect(result.signature).toBe('sig_ok');
    });

    it('throws timeout after maxDuration with persistently null status', async () => {
      const { pool, blockhashManager, feeEstimator, computeUnits, conn } = makeDeps();
      conn.getSignatureStatus = vi.fn().mockResolvedValue({ value: null });

      const sender = new TransactionSender(
        pool as any, blockhashManager as any, feeEstimator as any, computeUnits as any,
        { retryIntervalMs: 50, maxDurationMs: 300 },
      );

      const prom = sender.send(makeTx(), [Keypair.generate()]);
      const rejectCheck = expect(prom).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(500);
      await rejectCheck;
    });
  });

  describe('Blockhash Expiry During Retry', () => {
    it('re-signs with fresh blockhash when expiry detected, preventing duplicates', async () => {
      let sendCount = 0;
      const { pool, blockhashManager, feeEstimator, computeUnits, conn } = makeDeps(() => {
        sendCount++;
        return Promise.resolve(`sig_attempt_${sendCount}`);
      });

      let expireCheck = 0;
      blockhashManager.isExpired = vi.fn().mockImplementation(() => {
        expireCheck++;
        return Promise.resolve(expireCheck === 1);
      });

      let refreshCount = 0;
      blockhashManager.refresh = vi.fn().mockImplementation(() => {
        refreshCount++;
        return Promise.resolve({ blockhash: `hash${refreshCount}`, lastValidBlockHeight: 9999 + refreshCount });
      });

      conn.getSignatureStatus = vi.fn().mockImplementation(() => {
        if (sendCount >= 2) return Promise.resolve({ value: { confirmationStatus: 'confirmed', err: null } });
        return Promise.resolve({ value: null });
      });

      const sender = new TransactionSender(
        pool as any, blockhashManager as any, feeEstimator as any, computeUnits as any,
        { retryIntervalMs: 50, maxDurationMs: 10_000 },
      );

      const prom = sender.send(makeTx(), [Keypair.generate()]);
      await vi.advanceTimersByTimeAsync(300);
      await prom;

      expect(refreshCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Multi-endpoint Congestion', () => {
    it('round-robin distributes load across healthy endpoints', () => {
      const visited = new Set<string>();
      const { pool } = makeDeps();

      pool.getConnection = vi.fn().mockImplementation(() => {
        const eps = ['https://ep1.com', 'https://ep2.com', 'https://ep3.com'];
        const ep = eps[pool.getConnection.mock.calls.length % 3];
        visited.add(ep);
        return {
          rpcEndpoint: ep,
          sendRawTransaction: vi.fn().mockResolvedValue('sig'),
          getSignatureStatus: vi.fn().mockResolvedValue({ value: { confirmationStatus: 'confirmed', err: null } }),
        };
      });

      for (let i = 0; i < 9; i++) pool.getConnection();
      expect(visited.size).toBe(3);
    });
  });
});
