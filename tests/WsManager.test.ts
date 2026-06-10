import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── minimal Connection mock ───────────────────────────────────────────────────
vi.mock('@solana/web3.js', async () => {
  const { PublicKey } = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');

  class Connection {
    rpcEndpoint: string;
    private getSlotMock: () => Promise<number>;

    constructor(endpoint: string) {
      this.rpcEndpoint = endpoint;
      this.getSlotMock = vi.fn().mockResolvedValue(42);
    }

    getSlot = vi.fn().mockResolvedValue(42);

    onAccountChange = vi.fn().mockReturnValue(1);
    removeAccountChangeListener = vi.fn().mockResolvedValue(undefined);
  }

  return { Connection, PublicKey };
});
// ─────────────────────────────────────────────────────────────────────────────

import { WsManager } from '../src/ws/WsManager.js';
import { Connection } from '@solana/web3.js';

describe('WsManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('creates a Connection on construction', () => {
    const ws = new WsManager('https://api.devnet.solana.com');
    expect(ws.getConnection()).toBeInstanceOf(Connection);
    ws.destroy();
  });

  it('addSubscription calls subscribe and stores the id', () => {
    const ws = new WsManager('https://api.devnet.solana.com');
    const subscribe = vi.fn().mockReturnValue(99);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);

    ws.addSubscription('my-sub', subscribe, unsubscribe);

    expect(subscribe).toHaveBeenCalledWith(ws.getConnection());
    ws.destroy();
  });

  it('removeSubscription calls unsubscribe', async () => {
    const ws = new WsManager('https://api.devnet.solana.com');
    const subscribe = vi.fn().mockReturnValue(7);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);

    ws.addSubscription('sub-a', subscribe, unsubscribe);
    await ws.removeSubscription('sub-a');

    expect(unsubscribe).toHaveBeenCalledWith(ws.getConnection(), 7);
    ws.destroy();
  });

  it('removeSubscription is a no-op for unknown key', async () => {
    const ws = new WsManager('https://api.devnet.solana.com');
    await expect(ws.removeSubscription('nonexistent')).resolves.toBeUndefined();
    ws.destroy();
  });

  it('triggers reconnect after healthFailureThreshold consecutive failures', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 100,
      healthFailureThreshold: 3,
      initialReconnectDelayMs: 50,
    });

    const conn1 = ws.getConnection();
    // Make all health checks fail
    (conn1.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    // 3 health check intervals → 3 failures → schedules reconnect
    await vi.advanceTimersByTimeAsync(300);
    // Wait for reconnect delay (50ms)
    await vi.advanceTimersByTimeAsync(100);

    // After reconnect a new Connection should be created
    const conn2 = ws.getConnection();
    expect(conn2).not.toBe(conn1);

    ws.destroy();
  });

  it('resubscribes all managed subscriptions after reconnect', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 100,
      healthFailureThreshold: 2,
      initialReconnectDelayMs: 10,
    });

    const subscribe = vi.fn().mockReturnValue(5);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const onReconnect = vi.fn();

    ws.addSubscription('slot-sub', subscribe, unsubscribe, onReconnect);
    const conn1 = ws.getConnection();
    subscribe.mockClear();

    // Force health failures
    (conn1.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    await vi.advanceTimersByTimeAsync(200); // 2 failures
    await vi.advanceTimersByTimeAsync(50);  // reconnect fires

    expect(subscribe).toHaveBeenCalledTimes(1); // re-subscribed on new conn
    expect(onReconnect).toHaveBeenCalledTimes(1);

    ws.destroy();
  });

  it('destroy stops health checks — no reconnect after destroy', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 50,
      healthFailureThreshold: 2,
      initialReconnectDelayMs: 10,
    });

    const conn1 = ws.getConnection();
    (conn1.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    ws.destroy();

    // Advance past multiple intervals — no reconnect should happen
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.getConnection()).toBe(conn1); // same connection
  });

  it('resets reconnect counter after successful health check', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 100,
      healthFailureThreshold: 3,
      initialReconnectDelayMs: 50,
    });

    const conn = ws.getConnection();
    let failCount = 0;

    (conn.getSlot as ReturnType<typeof vi.fn>).mockImplementation(() => {
      failCount++;
      if (failCount === 2) return Promise.reject(new Error('timeout'));
      return Promise.resolve(42);
    });

    // 1st interval: success (failCount=1, resolve) → no failure counted
    // 2nd interval: fail   (failCount=2, reject)
    // 3rd interval: success (failCount=3, resolve) → resets counter
    await vi.advanceTimersByTimeAsync(300);

    // No reconnect should have happened (only 1 failure, threshold is 3)
    expect(ws.getConnection()).toBe(conn);
    ws.destroy();
  });
});
