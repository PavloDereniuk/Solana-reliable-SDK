import { Connection, type Commitment } from '@solana/web3.js';

export interface WsManagerOptions {
  commitment?: Commitment;
  /** How often (ms) to ping via getSlot to detect dead connections. Default 15_000. */
  healthCheckIntervalMs?: number;
  /** Consecutive health failures before triggering reconnect. Default 3. */
  healthFailureThreshold?: number;
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

interface Subscription {
  id: number | null;
  subscribe: (conn: Connection) => number;
  unsubscribe: (conn: Connection, id: number) => Promise<void>;
  onReconnect?: () => void;
}

/**
 * Manages a WebSocket-capable Connection with:
 *   - Periodic health checks (getSlot ping)
 *   - Auto-reconnect with exponential backoff when health fails
 *   - Re-subscription of all active subscriptions after reconnect
 */
export class WsManager {
  private conn: Connection;
  private readonly subscriptions = new Map<string, Subscription>();
  private consecutiveFailures = 0;
  private reconnectAttempts = 0;
  private destroyed = false;

  private readonly commitment: Commitment;
  private readonly healthCheckIntervalMs: number;
  private readonly healthFailureThreshold: number;
  private readonly maxReconnectAttempts: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly endpoint: string,
    opts: WsManagerOptions = {},
  ) {
    this.commitment = opts.commitment ?? 'confirmed';
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 15_000;
    this.healthFailureThreshold = opts.healthFailureThreshold ?? 3;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
    this.initialReconnectDelayMs = opts.initialReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 30_000;

    this.conn = new Connection(endpoint, this.commitment);
    this.startHealthCheck();
  }

  /** The active Connection. Use this to register subscriptions. */
  getConnection(): Connection {
    return this.conn;
  }

  /**
   * Register a managed subscription.
   * `key` must be unique — re-using a key replaces the previous subscription.
   *
   * @param subscribe   Called on connect/reconnect, returns subscription ID.
   * @param unsubscribe Called when the subscription is explicitly removed.
   * @param onReconnect Optional callback fired after each successful reconnect.
   */
  addSubscription(
    key: string,
    subscribe: (conn: Connection) => number,
    unsubscribe: (conn: Connection, id: number) => Promise<void>,
    onReconnect?: () => void,
  ): void {
    const id = subscribe(this.conn);
    this.subscriptions.set(key, { id, subscribe, unsubscribe, onReconnect });
  }

  async removeSubscription(key: string): Promise<void> {
    const sub = this.subscriptions.get(key);
    if (!sub || sub.id === null) {
      this.subscriptions.delete(key);
      return;
    }
    try {
      await sub.unsubscribe(this.conn, sub.id);
    } catch {
      // best-effort
    }
    this.subscriptions.delete(key);
  }

  /** Stop health checks and release resources. */
  destroy(): void {
    this.destroyed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.healthTimer = null;
    this.reconnectTimer = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      void this.runHealthCheck();
    }, this.healthCheckIntervalMs);
  }

  private async runHealthCheck(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.conn.getSlot(this.commitment);
      this.consecutiveFailures = 0;
      this.reconnectAttempts = 0;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.healthFailureThreshold) {
        this.consecutiveFailures = 0;
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (this.reconnectTimer) return; // already pending

    const delay = Math.min(
      this.initialReconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doReconnect();
    }, delay);
  }

  private async doReconnect(): Promise<void> {
    if (this.destroyed) return;

    this.conn = new Connection(this.endpoint, this.commitment);

    for (const sub of this.subscriptions.values()) {
      try {
        sub.id = sub.subscribe(this.conn);
        sub.onReconnect?.();
      } catch {
        sub.id = null;
      }
    }
  }
}
