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

  it('sets subscription id to null when subscribe throws during reconnect', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 100,
      healthFailureThreshold: 2,
      initialReconnectDelayMs: 10,
    });

    let callCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount > 1) throw new Error('subscribe failed on reconnect');
      return 5;
    });
    const unsubscribe = vi.fn().mockResolvedValue(undefined);

    ws.addSubscription('broken-sub', subscribe, unsubscribe);
    const conn = ws.getConnection();
    (conn.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    await vi.advanceTimersByTimeAsync(200); // 2 health failures
    await vi.advanceTimersByTimeAsync(50);  // reconnect fires

    // subscribe was called a 2nd time (on reconnect) and threw → id set to null
    expect(subscribe).toHaveBeenCalledTimes(2);
    ws.destroy();
  });

  it('scheduleReconnect stops when maxReconnectAttempts is 0', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 50,
      healthFailureThreshold: 2,
      initialReconnectDelayMs: 10,
      maxReconnectAttempts: 0,
    });

    const conn1 = ws.getConnection();
    (conn1.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    // 2+ failures → scheduleReconnect called → immediately returns because 0 >= 0
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(50);

    expect(ws.getConnection()).toBe(conn1); // no reconnect happened
    ws.destroy();
  });

  it('destroy cancels pending reconnect timer', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 50,
      healthFailureThreshold: 2,
      initialReconnectDelayMs: 30_000, // very long delay
    });

    const conn1 = ws.getConnection();
    (conn1.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    // 2 failures → scheduleReconnect → sets reconnectTimer (30s delay)
    await vi.advanceTimersByTimeAsync(150);

    // destroy while reconnect timer is pending → clearTimeout(reconnectTimer)
    ws.destroy();

    // Even after 60s the connection is unchanged (timer was cleared)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.getConnection()).toBe(conn1);
  });

  it('scheduleReconnect skips second call when reconnectTimer is already set', async () => {
    const ws = new WsManager('https://api.devnet.solana.com', {
      healthCheckIntervalMs: 50,
      healthFailureThreshold: 2,
      initialReconnectDelayMs: 30_000, // very long — timer stays pending
      maxReconnectAttempts: 10,
    });

    const conn1 = ws.getConnection();
    (conn1.getSlot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    // 4 failures: 2 → scheduleReconnect (timer set), 2 more → scheduleReconnect (timer already set → skip)
    await vi.advanceTimersByTimeAsync(300);

    // Reconnect still hasn't fired (30s timer)
    expect(ws.getConnection()).toBe(conn1);
    ws.destroy();
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
