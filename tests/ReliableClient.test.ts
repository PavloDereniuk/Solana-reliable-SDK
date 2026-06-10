import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';

// ── module mocks ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before any variable declarations, so we must
// not reference top-level test vars inside them. Each class provides its own
// vi.fn() methods; tests access them via client.sender.send etc.

vi.mock('../src/rpc/index.js', () => ({
  RpcPool: class {
    destroy = vi.fn();
    getConnection = vi.fn();
    reportSuccess = vi.fn();
    reportFailure = vi.fn();
    getEndpoints = vi.fn().mockReturnValue(['https://api.devnet.solana.com']);
  },
}));

vi.mock('../src/tx/index.js', () => ({
  BlockhashManager: class {
    refresh = vi.fn().mockResolvedValue({ blockhash: 'hash', lastValidBlockHeight: 1000 });
    isExpired = vi.fn().mockResolvedValue(false);
  },
  FeeEstimator: class {
    estimate = vi.fn().mockResolvedValue(1_000);
  },
  ComputeUnits: class {
    simulate = vi.fn().mockResolvedValue(5_000);
    buildLimitInstruction = vi.fn();
  },
  TransactionSender: class {
    send = vi.fn().mockResolvedValue({ signature: 'sig_abc' });
  },
}));

vi.mock('../src/confirm/TransactionConfirmer.js', () => ({
  TransactionConfirmer: class {
    confirm = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../src/ws/WsManager.js', () => ({
  WsManager: class {
    destroy = vi.fn();
    addSubscription = vi.fn();
    removeSubscription = vi.fn();
  },
}));

// Import AFTER mocks are registered
const { ReliableClient } = await import('../src/ReliableClient.js');

// ── helpers ───────────────────────────────────────────────────────────────────

const ENDPOINT = 'https://api.devnet.solana.com';

function makeClient(wsEndpoint?: string) {
  return new ReliableClient({ endpoints: [ENDPOINT], wsEndpoint });
}

function makeTx(keypair: Keypair): Transaction {
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: keypair.publicKey, lamports: 1_000 }));
  return tx;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ReliableClient', () => {
  const keypair = Keypair.generate();
  beforeEach(() => vi.clearAllMocks());

  it('ws is undefined without wsEndpoint', () => {
    expect(makeClient().ws).toBeUndefined();
  });

  it('ws is defined with wsEndpoint', () => {
    expect(makeClient('wss://api.devnet.solana.com').ws).toBeDefined();
  });

  it('exposes all subsystems as public fields', () => {
    const c = makeClient();
    expect(c.pool).toBeDefined();
    expect(c.blockhashManager).toBeDefined();
    expect(c.feeEstimator).toBeDefined();
    expect(c.computeUnits).toBeDefined();
    expect(c.sender).toBeDefined();
    expect(c.confirmer).toBeDefined();
  });

  it('sendAndConfirm delegates to sender.send() and returns the signature', async () => {
    const c = makeClient();
    const tx = makeTx(keypair);
    const result = await c.sendAndConfirm(tx, [keypair]);
    expect(c.sender.send).toHaveBeenCalledWith(tx, [keypair]);
    expect(result.signature).toBe('sig_abc');
  });

  it('destroy() calls pool.destroy()', () => {
    const c = makeClient();
    c.destroy();
    expect(c.pool.destroy).toHaveBeenCalled();
  });

  it('destroy() calls ws.destroy() when wsEndpoint is set', () => {
    const c = makeClient('wss://api.devnet.solana.com');
    c.destroy();
    expect(c.ws!.destroy).toHaveBeenCalled();
  });

  it('destroy() does not throw when ws is undefined', () => {
    expect(() => makeClient().destroy()).not.toThrow();
  });
});
