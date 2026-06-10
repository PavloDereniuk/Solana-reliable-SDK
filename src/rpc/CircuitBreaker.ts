export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Кількість consecutive failures до переходу в OPEN */
  threshold: number;
  /** Час в мс, через який OPEN → HALF_OPEN */
  timeout: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  threshold: 3,
  timeout: 60_000,
};

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt: number | null = null;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get currentState(): CircuitState {
    return this.state;
  }

  isAvailable(): boolean {
    if (this.state === 'CLOSED' || this.state === 'HALF_OPEN') {
      return true;
    }

    // OPEN: перевіряємо чи минув timeout
    if (this.openedAt !== null && Date.now() - this.openedAt >= this.opts.timeout) {
      this.state = 'HALF_OPEN';
      return true;
    }

    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failures++;

    if (this.state === 'HALF_OPEN' || this.failures >= this.opts.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.failures = 0;
    }
  }
}
