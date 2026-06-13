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
/**
 * Manages a WebSocket-capable Connection with:
 *   - Periodic health checks (getSlot ping)
 *   - Auto-reconnect with exponential backoff when health fails
 *   - Re-subscription of all active subscriptions after reconnect
 */
export declare class WsManager {
    private readonly endpoint;
    private conn;
    private readonly subscriptions;
    private consecutiveFailures;
    private reconnectAttempts;
    private destroyed;
    private readonly commitment;
    private readonly healthCheckIntervalMs;
    private readonly healthFailureThreshold;
    private readonly maxReconnectAttempts;
    private readonly initialReconnectDelayMs;
    private readonly maxReconnectDelayMs;
    private healthTimer;
    private reconnectTimer;
    constructor(endpoint: string, opts?: WsManagerOptions);
    /** The active Connection. Use this to register subscriptions. */
    getConnection(): Connection;
    /**
     * Register a managed subscription.
     * `key` must be unique — re-using a key replaces the previous subscription.
     *
     * @param subscribe   Called on connect/reconnect, returns subscription ID.
     * @param unsubscribe Called when the subscription is explicitly removed.
     * @param onReconnect Optional callback fired after each successful reconnect.
     */
    addSubscription(key: string, subscribe: (conn: Connection) => number, unsubscribe: (conn: Connection, id: number) => Promise<void>, onReconnect?: () => void): void;
    removeSubscription(key: string): Promise<void>;
    /** Stop health checks and release resources. */
    destroy(): void;
    private startHealthCheck;
    private runHealthCheck;
    private scheduleReconnect;
    private doReconnect;
}
//# sourceMappingURL=WsManager.d.ts.map