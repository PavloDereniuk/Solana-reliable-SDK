import { Connection, Commitment } from '@solana/web3.js';
import { CircuitBreaker, CircuitBreakerOptions } from './CircuitBreaker.js';
import { HealthChecker } from './HealthChecker.js';

export type PoolStrategy = 'round-robin' | 'priority';

export interface RpcPoolOptions {
  commitment?: Commitment;
  strategy?: PoolStrategy;
  healthCheckInterval?: number;
  circuitBreaker?: Partial<CircuitBreakerOptions>;
}

export class RpcPool {
  private readonly connections: Connection[];
  private readonly breakers: CircuitBreaker[];
  private readonly healthChecker: HealthChecker;
  private roundRobinIndex = 0;
  private readonly strategy: PoolStrategy;
  private readonly commitment: Commitment;

  constructor(
    private readonly endpoints: string[],
    opts: RpcPoolOptions = {},
  ) {
    if (endpoints.length === 0) throw new Error('RpcPool requires at least one endpoint');

    this.commitment = opts.commitment ?? 'confirmed';
    this.strategy = opts.strategy ?? 'round-robin';

    this.connections = endpoints.map((url) => new Connection(url, this.commitment));
    this.breakers = endpoints.map(() => new CircuitBreaker(opts.circuitBreaker));
    this.healthChecker = new HealthChecker(endpoints, opts.healthCheckInterval ?? 30_000);
    this.healthChecker.start();
  }

  /**
   * Повертає наступний доступний Connection.
   * Пропускає ендпоінти з OPEN circuit breaker або мертві за health check.
   */
  getConnection(): Connection {
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
        if (this.isAvailable(idx)) return this.connections[idx];
      }
    }

    // Всі недоступні — повертаємо перший (краще спробувати, ніж кинути error)
    return this.connections[0];
  }

  /** Повідомити пул про успішний запит через конкретний Connection */
  reportSuccess(connection: Connection): void {
    const idx = this.connections.indexOf(connection);
    if (idx !== -1) this.breakers[idx].recordSuccess();
  }

  /** Повідомити пул про помилку на конкретному Connection */
  reportFailure(connection: Connection): void {
    const idx = this.connections.indexOf(connection);
    if (idx !== -1) this.breakers[idx].recordFailure();
  }

  getEndpoints(): string[] {
    return [...this.endpoints];
  }

  /** Зупинити health checker (викликати при завершенні програми) */
  destroy(): void {
    this.healthChecker.stop();
  }

  private isAvailable(idx: number): boolean {
    const health = this.healthChecker.getHealth(this.endpoints[idx]);
    const alive = health?.alive ?? true;
    return alive && this.breakers[idx].isAvailable();
  }
}
