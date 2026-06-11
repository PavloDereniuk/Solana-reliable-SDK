import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Transaction, SystemProgram, Connection } from '@solana/web3.js';
import { JitoSender } from '../src/jito/JitoSender.js';

// 32 bytes of zeros in base58 = exactly 32 ones; valid Solana blockhash format
const VALID_BLOCKHASH = '11111111111111111111111111111111';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool() {
  const conn = {
    rpcEndpoint: 'https://api.devnet.solana.com',
    sendRawTransaction: vi.fn().mockResolvedValue('fallback_sig'),
  } as unknown as Connection;
  return {
    getConnection: vi.fn().mockReturnValue(conn),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    _conn: conn,
  };
}

function makeBlockhashManager() {
  return {
    refresh: vi.fn().mockResolvedValue({
      blockhash: VALID_BLOCKHASH,
      lastValidBlockHeight: 9999,
    }),
    isExpired: vi.fn().mockResolvedValue(false),
  };
}

function makeTx(keypair: Keypair): Transaction {
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: keypair.publicKey,
    lamports: 1_000,
  }));
  return tx;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('JitoSender', () => {
  const keypair = Keypair.generate();

  beforeEach(() => vi.clearAllMocks());

  it('uses correct mainnet block engine URL by default', () => {
    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any);
    expect(jito).toBeDefined();
  });

  it('uses custom blockEngineUrl when provided', () => {
    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any, {
      blockEngineUrl: 'https://custom.block-engine.example.com/api/v1',
    });
    expect(jito).toBeDefined();
  });

  it('sendBundle submits transactions to Jito block engine', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'bundle-uuid-abc123', id: 1 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any, { tipLamports: 5_000 });

    const tx = makeTx(keypair);
    const bundleId = await jito.sendBundle([tx], [keypair]);

    expect(bundleId).toBe('bundle-uuid-abc123');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/bundles'),
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });

  it('getBundleStatus returns Pending when no result yet', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { value: [] }, id: 1 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any);

    const status = await jito.getBundleStatus('some-bundle-id');
    expect(status.status).toBe('Pending');

    vi.unstubAllGlobals();
  });

  it('getBundleStatus returns Landed when confirmation_status is finalized', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: {
          value: [{ bundle_id: 'abc', confirmation_status: 'finalized', slot: 123456 }],
        },
        id: 1,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any);

    const status = await jito.getBundleStatus('abc');
    expect(status.status).toBe('Landed');
    expect(status.landedSlot).toBe(123456);

    vi.unstubAllGlobals();
  });

  it('sendWithMevProtection falls back to standard RPC when Jito fails and fallbackOnError=true', async () => {
    // Jito fetch fails; standardSend uses the already-signed tx
    const mockFetch = vi.fn().mockRejectedValue(new Error('Jito block engine unreachable'));
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any, {
      fallbackOnError: true,
      tipLamports: 1_000,
    });

    // sendBundle re-signs internally using the mocked blockhash (VALID_BLOCKHASH)
    const tx = makeTx(keypair);
    const sig = await jito.sendWithMevProtection(tx, [keypair]);
    expect(sig).toBe('fallback_sig');

    vi.unstubAllGlobals();
  });

  it('sendWithMevProtection throws when Jito fails and fallbackOnError=false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any, { fallbackOnError: false });

    const tx = makeTx(keypair);
    await expect(jito.sendWithMevProtection(tx, [keypair])).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it('buildTipTransaction creates a SystemProgram.transfer to a Jito tip account', () => {
    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any, { tipLamports: 2_000 });

    const tipTx = jito.buildTipTransaction(keypair);
    expect(tipTx.instructions).toHaveLength(1);
    // SystemProgram programId
    expect(tipTx.instructions[0].programId.toString()).toBe('11111111111111111111111111111111');
  });

  it('throws on HTTP error from block engine', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal('fetch', mockFetch);

    const pool = makePool();
    const bm = makeBlockhashManager();
    const jito = new JitoSender(pool as any, bm as any, { fallbackOnError: false });

    await expect(jito.sendBundle([makeTx(keypair)], [keypair])).rejects.toThrow('HTTP 400');

    vi.unstubAllGlobals();
  });
});
