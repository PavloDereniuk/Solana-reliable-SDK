import { Connection, Commitment } from '@solana/web3.js';
import { CircuitBreakerOptions } from './CircuitBreaker.js';
import type { MetricsCollector } from '../metrics/MetricsCollector.js';
export type PoolStrategy = 'round-robin' | 'priority';
export interface RpcPoolOptions {
    commitment?: Commitment;
    strategy?: PoolStrategy;
    healthCheckInterval?: number;
    circuitBreaker?: Partial<CircuitBreakerOptions>;
    /** Optional metrics collector for observability */
    metrics?: MetricsCollector;
}
export declare class RpcPool {
    private readonly endpoints;
    private readonly connections;
    private readonly breakers;
    private readonly healthChecker;
    private roundRobinIndex;
    private readonly strategy;
    private readonly commitment;
    private readonly metrics;
    private readonly callStartTimes;
    constructor(endpoints: string[], opts?: RpcPoolOptions);
    /**
     * Повертає наступний доступний Connection.
     * Пропускає ендпоінти з OPEN circuit breaker або мертві за health check.
     */
    getConnection(): Connection;
    /** Call before making an RPC request to start latency tracking. */
    startCall(connection: Connection): void;
    /** Повідомити пул про успішний запит через конкретний Connection */
    reportSuccess(connection: Connection): void;
    /** Повідомити пул про помилку на конкретному Connection */
    reportFailure(connection: Connection): void;
    getEndpoints(): string[];
    /** Зупинити health checker (викликати при завершенні програми) */
    destroy(): void;
    private isAvailable;
}
//# sourceMappingURL=RpcPool.d.ts.map