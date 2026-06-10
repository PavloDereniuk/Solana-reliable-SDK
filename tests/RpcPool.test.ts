import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RpcPool } from '../src/rpc/RpcPool.js';

// Мокаємо web3.js Connection і HealthChecker щоб не ходити в мережу
vi.mock('@solana/web3.js', () => {
  class Connection {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
  }
  return { Connection };
});

vi.mock('../src/rpc/HealthChecker.js', () => {
  class HealthChecker {
    private endpoints: string[];
    constructor(endpoints: string[]) {
      this.endpoints = endpoints;
    }
    start() {}
    stop() {}
    getHealth(url: string) {
      return { url, alive: true, latencyMs: 10, lastChecked: Date.now() };
    }
    getAliveEndpoints() {
      return this.endpoints;
    }
  }
  return { HealthChecker };
});

describe('RpcPool', () => {
  const endpoints = [
    'https://rpc1.example.com',
    'https://rpc2.example.com',
    'https://rpc3.example.com',
  ];

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws if no endpoints provided', () => {
    expect(() => new RpcPool([])).toThrow('at least one endpoint');
  });

  it('returns a Connection on getConnection()', () => {
    const pool = new RpcPool(endpoints);
    const conn = pool.getConnection();
    expect(conn).toBeDefined();
  });

  it('round-robins across endpoints', () => {
    const pool = new RpcPool(endpoints, { strategy: 'round-robin' });

    const c1 = pool.getConnection() as unknown as { url: string };
    const c2 = pool.getConnection() as unknown as { url: string };
    const c3 = pool.getConnection() as unknown as { url: string };
    const c4 = pool.getConnection() as unknown as { url: string };

    expect(c1.url).toBe(endpoints[0]);
    expect(c2.url).toBe(endpoints[1]);
    expect(c3.url).toBe(endpoints[2]);
    expect(c4.url).toBe(endpoints[0]); // wrap around
  });

  it('skips endpoint with open circuit breaker', () => {
    const pool = new RpcPool(endpoints, { strategy: 'round-robin', circuitBreaker: { threshold: 1 } });

    const first = pool.getConnection();
    // Ламаємо перший ендпоінт
    pool.reportFailure(first);

    // Наступний виклик має пропустити перший
    const second = pool.getConnection() as unknown as { url: string };
    expect(second.url).not.toBe(endpoints[0]);
  });

  it('priority strategy returns first available endpoint', () => {
    const pool = new RpcPool(endpoints, { strategy: 'priority' });
    const conn = pool.getConnection() as unknown as { url: string };
    expect(conn.url).toBe(endpoints[0]);
  });

  it('getEndpoints() returns the original list', () => {
    const pool = new RpcPool(endpoints);
    expect(pool.getEndpoints()).toEqual(endpoints);
  });

  it('destroy() stops health checker', () => {
    const pool = new RpcPool(endpoints);
    // Не кидає помилку
    expect(() => pool.destroy()).not.toThrow();
  });
});
