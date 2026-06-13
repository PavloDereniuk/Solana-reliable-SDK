import { Connection } from '@solana/web3.js';
/**
 * Manages a WebSocket-capable Connection with:
 *   - Periodic health checks (getSlot ping)
 *   - Auto-reconnect with exponential backoff when health fails
 *   - Re-subscription of all active subscriptions after reconnect
 */
export class WsManager {
    endpoint;
    conn;
    subscriptions = new Map();
    consecutiveFailures = 0;
    reconnectAttempts = 0;
    destroyed = false;
    commitment;
    healthCheckIntervalMs;
    healthFailureThreshold;
    maxReconnectAttempts;
    initialReconnectDelayMs;
    maxReconnectDelayMs;
    healthTimer = null;
    reconnectTimer = null;
    constructor(endpoint, opts = {}) {
        this.endpoint = endpoint;
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
    getConnection() {
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
    addSubscription(key, subscribe, unsubscribe, onReconnect) {
        const id = subscribe(this.conn);
        this.subscriptions.set(key, { id, subscribe, unsubscribe, onReconnect });
    }
    async removeSubscription(key) {
        const sub = this.subscriptions.get(key);
        if (!sub || sub.id === null) {
            this.subscriptions.delete(key);
            return;
        }
        try {
            await sub.unsubscribe(this.conn, sub.id);
        }
        catch {
            // best-effort
        }
        this.subscriptions.delete(key);
    }
    /** Stop health checks and release resources. */
    destroy() {
        this.destroyed = true;
        if (this.healthTimer)
            clearInterval(this.healthTimer);
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.healthTimer = null;
        this.reconnectTimer = null;
    }
    // ── internals ──────────────────────────────────────────────────────────────
    startHealthCheck() {
        this.healthTimer = setInterval(() => {
            void this.runHealthCheck();
        }, this.healthCheckIntervalMs);
    }
    async runHealthCheck() {
        if (this.destroyed)
            return;
        try {
            await this.conn.getSlot(this.commitment);
            this.consecutiveFailures = 0;
            this.reconnectAttempts = 0;
        }
        catch {
            this.consecutiveFailures++;
            if (this.consecutiveFailures >= this.healthFailureThreshold) {
                this.consecutiveFailures = 0;
                this.scheduleReconnect();
            }
        }
    }
    scheduleReconnect() {
        if (this.destroyed)
            return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts)
            return;
        if (this.reconnectTimer)
            return; // already pending
        const delay = Math.min(this.initialReconnectDelayMs * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelayMs);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.doReconnect();
        }, delay);
    }
    async doReconnect() {
        if (this.destroyed)
            return;
        this.conn = new Connection(this.endpoint, this.commitment);
        for (const sub of this.subscriptions.values()) {
            try {
                sub.id = sub.subscribe(this.conn);
                sub.onReconnect?.();
            }
            catch {
                sub.id = null;
            }
        }
    }
}
//# sourceMappingURL=WsManager.js.map