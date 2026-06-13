/**
 * web3.js v2.0 adapter tests.
 * Verifies that ReliableRpcV2 provides failover, circuit breaking, and round-robin
 * using the new @solana/* modular API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReliableRpcV2, createReliableRpcV2 } from '../../src/v2/ReliableRpcV2.js';

// ── mock @solana/rpc ──────────────────────────────────────────────────────────

const mockRpc = {
  getSlot: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue(300_000_000n) }),
  getLatestBlockhash: vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue({
      value: { blockhash: 'FakeHash111', lastValidBlockHeight: 1000n },
    }),
  }),
  getBalance: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({ value: 1_000_000n }) }),
  sendTransaction: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue('FakeSig111') }),
  getSignatureStatuses: vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
  }),
};

vi.mock('@solana/rpc', () => ({
  createSolanaRpc: vi.fn().mockReturnValue(mockRpc),
}));

const ENDPOINTS = ['https://ep1.com', 'https://ep2.com'];

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ReliableRpcV2 (web3.js v2.0 adapter)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('createReliableRpcV2 factory', () => {
    it('creates a ReliableRpcV2 instance', () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      expect(rpc).toBeInstanceOf(ReliableRpcV2);
    });

    it('throws when no endpoints provided', () => {
      expect(() => createReliableRpcV2({ endpoints: [] })).toThrow('At least one endpoint required');
    });
  });

  describe('getSlot', () => {
    it('returns slot info with latency', async () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      const result = await rpc.getSlot();
      expect(result.slot).toBe(300_000_000n);
      expect(result.endpoint).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getLatestBlockhash', () => {
    it('returns blockhash and lastValidBlockHeight', async () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      const result = await rpc.getLatestBlockhash();
      expect(result.blockhash).toBe('FakeHash111');
      expect(result.lastValidBlockHeight).toBe(1000n);
    });
  });

  describe('getBalance', () => {
    it('returns balance as bigint', async () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      const balance = await rpc.getBalance('some-address' as any);
      expect(balance).toBe(1_000_000n);
    });
  });

  describe('sendTransaction', () => {
    it('sends an encoded transaction and returns signature', async () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      const sig = await rpc.sendTransaction('base64EncodedTx==');
      expect(sig).toBe('FakeSig111');
    });
  });

  describe('getSignatureStatuses', () => {
    it('returns status array for given signatures', async () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      const statuses = await rpc.getSignatureStatuses(['sig1']);
      expect(statuses[0]?.confirmationStatus).toBe('confirmed');
    });
  });

  describe('Failover (circuit breaker simulation)', () => {
    it('falls back to next endpoint after CIRCUIT_THRESHOLD failures', async () => {
      const { createSolanaRpc } = await import('@solana/rpc');
      let callCount = 0;

      (createSolanaRpc as any).mockImplementation((ep: string) => {
        if (ep === ENDPOINTS[0]) {
          return {
            ...mockRpc,
            getSlot: vi.fn().mockReturnValue({
              send: vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount <= 3) throw new Error('endpoint down');
                return Promise.resolve(1n);
              }),
            }),
          };
        }
        return mockRpc;
      });

      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });

      // First call fails → circuit opens on ep1 after 3 failures via withFailover
      // withFailover tries each endpoint once per call, so 3 separate calls will break ep1
      for (let i = 0; i < 3; i++) {
        try { await rpc.getSlot(); } catch {}
      }

      // Now ep1 circuit should be open; ep2 should serve requests
      const result = await rpc.getSlot();
      expect(result).toBeDefined();
    });

    it('getAllEndpoints returns the original list', () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      expect(rpc.getAllEndpoints()).toEqual(ENDPOINTS);
    });

    it('throws "All endpoints exhausted" when priority strategy cycles back to already-tried endpoint', async () => {
      const { createSolanaRpc } = await import('@solana/rpc');

      (createSolanaRpc as any).mockImplementation((ep: string) => {
        if (ep.includes('ep1')) {
          return { ...mockRpc, getSlot: vi.fn().mockReturnValue({ send: vi.fn().mockRejectedValue(new Error('ep1 down')) }) };
        }
        return mockRpc;
      });

      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS, strategy: 'priority' });
      await expect(rpc.getSlot()).rejects.toThrow('All endpoints exhausted');
    });

    it('circuit recovers after CIRCUIT_TIMEOUT_MS elapses', async () => {
      vi.useFakeTimers();
      const { createSolanaRpc } = await import('@solana/rpc');

      let failCount = 0;
      (createSolanaRpc as any).mockImplementation(() => ({
        ...mockRpc,
        getSlot: vi.fn().mockReturnValue({
          send: vi.fn().mockImplementation(() => {
            failCount++;
            if (failCount <= 3) return Promise.reject(new Error('down'));
            return Promise.resolve(300_000_000n);
          }),
        }),
      }));

      const rpc = createReliableRpcV2({ endpoints: ['https://ep1.com'] });

      // Open the circuit with 3 failures (single endpoint → each call fails and throws)
      await rpc.getSlot().catch(() => {});
      await rpc.getSlot().catch(() => {});
      await rpc.getSlot().catch(() => {});

      // Advance past CIRCUIT_TIMEOUT_MS = 60 000ms → isAvailable returns true again
      vi.advanceTimersByTime(61_000);

      const result = await rpc.getSlot();
      expect(result.slot).toBe(300_000_000n);

      vi.useRealTimers();
    });
  });

  describe('Commitment level', () => {
    it('default commitment is "confirmed"', () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS });
      expect(rpc.commitment).toBe('confirmed');
    });

    it('accepts custom commitment', () => {
      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS, commitment: 'finalized' });
      expect(rpc.commitment).toBe('finalized');
    });
  });

  describe('Round-robin strategy', () => {
    it('rotates through endpoints on each call', async () => {
      const usedEndpoints: string[] = [];
      const { createSolanaRpc } = await import('@solana/rpc');
      (createSolanaRpc as any).mockImplementation((ep: string) => {
        usedEndpoints.push(ep);
        return mockRpc;
      });

      const rpc = createReliableRpcV2({ endpoints: ENDPOINTS, strategy: 'round-robin' });
      await rpc.getSlot();
      await rpc.getSlot();

      expect(usedEndpoints).toContain(ENDPOINTS[0]);
      expect(usedEndpoints).toContain(ENDPOINTS[1]);
    });
  });
});
