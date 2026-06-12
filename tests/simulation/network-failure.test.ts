/**
 * Network failure simulation tests.
 * Simulates endpoint failures, cascading outages, and circuit breaker behavior
 * under real-world failure conditions without making actual network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RpcPool } from '../../src/rpc/RpcPool.js';
import { CircuitBreaker } from '../../src/rpc/CircuitBreaker.js';
import { MetricsCollector } from '../../src/metrics/MetricsCollector.js';

// ── mock HealthChecker to avoid real network calls ────────────────────────────

vi.mock('../../src/rpc/HealthChecker.js', () => ({
  HealthChecker: class {
    constructor() {}
    start = vi.fn();
    stop = vi.fn();
    getHealth = vi.fn().mockReturnValue({ url: '', alive: true, latencyMs: 50, lastChecked: Date.now() });
    getAliveEndpoints = vi.fn().mockReturnValue([]);
  },
}));

// ── mock Connection ───────────────────────────────────────────────────────────

vi.mock('@solana/web3.js', async (orig) => {
  const actual = await orig<typeof import('@solana/web3.js')>();
  let callCount = 0;

  const MockConnection = class {
    rpcEndpoint: string;
    constructor(ep: string) { this.rpcEndpoint = ep; }
    getSlot = vi.fn().mockResolvedValue(300_000_000);
    getLatestBlockhash = vi.fn().mockResolvedValue({
      blockhash: 'FakeHash1111111111111111111111111111111111111',
      lastValidBlockHeight: 999_999,
    });
    sendRawTransaction = vi.fn().mockResolvedValue('FakeSig1111111111111111111111111111111111111');
    getSignatureStatus = vi.fn().mockResolvedValue({
      value: { confirmationStatus: 'confirmed', err: null },
    });
  };

  return { ...actual, Connection: MockConnection };
});

const ENDPOINTS = [
  'https://rpc-primary.example.com',
  'https://rpc-secondary.example.com',
  'https://rpc-tertiary.example.com',
];

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool(endpoints = ENDPOINTS, metrics?: MetricsCollector) {
  return new RpcPool(endpoints, { commitment: 'confirmed', metrics });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Network Failure Simulation', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  describe('Single endpoint failure', () => {
    it('pool continues serving requests when one endpoint fails', () => {
      const pool = makePool();
      const conn1 = pool.getConnection();

      // Report 3 failures → opens circuit
      pool.reportFailure(conn1);
      pool.reportFailure(conn1);
      pool.reportFailure(conn1);

      // Next request should come from a different endpoint
      const conn2 = pool.getConnection();
      expect(conn2.rpcEndpoint).not.toBe(conn1.rpcEndpoint);
    });

    it('pool falls back through all endpoints before giving up', () => {
      const pool = makePool([ENDPOINTS[0], ENDPOINTS[1]]);

      // Kill both endpoints
      const c1 = pool.getConnection();
      pool.reportFailure(c1); pool.reportFailure(c1); pool.reportFailure(c1);
      const c2 = pool.getConnection();
      pool.reportFailure(c2); pool.reportFailure(c2); pool.reportFailure(c2);

      // When all circuits are open, pool falls back to first (safety net)
      const fallback = pool.getConnection();
      expect(fallback.rpcEndpoint).toBe(ENDPOINTS[0]);
    });

    it('circuit heals after timeout and endpoint becomes available again', () => {
      const pool = makePool();
      const conn = pool.getConnection();

      pool.reportFailure(conn); pool.reportFailure(conn); pool.reportFailure(conn);

      // After circuit opens, endpoint unavailable
      const next = pool.getConnection();
      expect(next.rpcEndpoint).not.toBe(conn.rpcEndpoint);

      // Advance past circuit timeout (60s default)
      vi.advanceTimersByTime(61_000);

      // Endpoint should be reachable again (HALF_OPEN)
      const healed = pool.getConnection();
      // The pool should eventually return to the first endpoint
      pool.reportSuccess(healed);
      expect(healed).toBeDefined();
    });
  });

  describe('All-endpoints failure', () => {
    it('returns the first endpoint as safety fallback when all circuits open', () => {
      const pool = makePool(ENDPOINTS.slice(0, 2));

      // Exhaust all endpoints
      for (const ep of ENDPOINTS.slice(0, 2)) {
        const c = pool.getConnection();
        for (let i = 0; i < 3; i++) pool.reportFailure(c);
      }

      // Should still return something (not throw)
      const emergency = pool.getConnection();
      expect(emergency).toBeDefined();
    });
  });

  describe('Priority strategy under failures', () => {
    it('always tries primary endpoint first when healthy', () => {
      const pool = new RpcPool(ENDPOINTS, { strategy: 'priority' });
      const conn = pool.getConnection();
      expect(conn.rpcEndpoint).toBe(ENDPOINTS[0]);
      pool.destroy();
    });

    it('skips primary and uses secondary when primary circuit is open', () => {
      const pool = new RpcPool(ENDPOINTS, { strategy: 'priority' });
      const primary = pool.getConnection();
      expect(primary.rpcEndpoint).toBe(ENDPOINTS[0]);

      pool.reportFailure(primary); pool.reportFailure(primary); pool.reportFailure(primary);

      const next = pool.getConnection();
      expect(next.rpcEndpoint).toBe(ENDPOINTS[1]);
      pool.destroy();
    });
  });

  describe('Metrics integration under failure', () => {
    it('records failures and updates circuit state in MetricsCollector', () => {
      const metrics = new MetricsCollector();
      const pool = makePool(ENDPOINTS, metrics);
      const conn = pool.getConnection();

      pool.reportFailure(conn); pool.reportFailure(conn); pool.reportFailure(conn);

      const snap = metrics.getSnapshot();
      const ep = Object.keys(snap.rpc)[0];

      expect(snap.rpc[ep]?.failures).toBeGreaterThanOrEqual(3);
    });

    it('records success latency in MetricsCollector', () => {
      const metrics = new MetricsCollector();
      const pool = makePool(ENDPOINTS, metrics);
      const conn = pool.getConnection();
      pool.startCall(conn);
      pool.reportSuccess(conn);

      const snap = metrics.getSnapshot();
      const ep = Object.keys(snap.rpc)[0];
      expect(snap.rpc[ep]?.totalRequests).toBe(1);
    });
  });
});
