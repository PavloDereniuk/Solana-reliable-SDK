import { Connection } from '@solana/web3.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { HealthChecker } from './HealthChecker.js';
export class RpcPool {
    endpoints;
    connections;
    breakers;
    healthChecker;
    roundRobinIndex = 0;
    strategy;
    commitment;
    metrics;
    callStartTimes = new WeakMap();
    constructor(endpoints, opts = {}) {
        this.endpoints = endpoints;
        if (endpoints.length === 0)
            throw new Error('RpcPool requires at least one endpoint');
        this.commitment = opts.commitment ?? 'confirmed';
        this.strategy = opts.strategy ?? 'round-robin';
        this.metrics = opts.metrics;
        this.connections = endpoints.map((url) => new Connection(url, this.commitment));
        this.breakers = endpoints.map(() => new CircuitBreaker(opts.circuitBreaker));
        this.healthChecker = new HealthChecker(endpoints, opts.healthCheckInterval ?? 30_000);
        this.healthChecker.start();
    }
    /**
     * Повертає наступний доступний Connection.
     * Пропускає ендпоінти з OPEN circuit breaker або мертві за health check.
     */
    getConnection() {
        const total = this.endpoints.length;
        if (this.strategy === 'round-robin') {
            for (let i = 0; i < total; i++) {
                const idx = (this.roundRobinIndex + i) % total;
                if (this.isAvailable(idx)) {
                    this.roundRobinIndex = (idx + 1) % total;
                    return this.connections[idx];
                }
            }
        }
        if (this.strategy === 'priority') {
            for (let idx = 0; idx < total; idx++) {
                if (this.isAvailable(idx))
                    return this.connections[idx];
            }
        }
        // Всі недоступні — повертаємо перший (краще спробувати, ніж кинути error)
        return this.connections[0];
    }
    /** Call before making an RPC request to start latency tracking. */
    startCall(connection) {
        this.callStartTimes.set(connection, Date.now());
    }
    /** Повідомити пул про успішний запит через конкретний Connection */
    reportSuccess(connection) {
        const idx = this.connections.indexOf(connection);
        if (idx !== -1) {
            this.breakers[idx].recordSuccess();
            const latencyMs = Date.now() - (this.callStartTimes.get(connection) ?? Date.now());
            this.metrics?.recordRpcCall(connection.rpcEndpoint, latencyMs, true);
            this.metrics?.recordCircuitState(connection.rpcEndpoint, this.breakers[idx].getState());
        }
    }
    /** Повідомити пул про помилку на конкретному Connection */
    reportFailure(connection) {
        const idx = this.connections.indexOf(connection);
        if (idx !== -1) {
            this.breakers[idx].recordFailure();
            const latencyMs = Date.now() - (this.callStartTimes.get(connection) ?? Date.now());
            this.metrics?.recordRpcCall(connection.rpcEndpoint, latencyMs, false);
            this.metrics?.recordCircuitState(connection.rpcEndpoint, this.breakers[idx].getState());
        }
    }
    getEndpoints() {
        return [...this.endpoints];
    }
    /** Зупинити health checker (викликати при завершенні програми) */
    destroy() {
        this.healthChecker.stop();
    }
    isAvailable(idx) {
        const health = this.healthChecker.getHealth(this.endpoints[idx]);
        const alive = health?.alive ?? true;
        return alive && this.breakers[idx].isAvailable();
    }
}
//# sourceMappingURL=RpcPool.js.map