export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface CircuitBreakerOptions {
    /** Кількість consecutive failures до переходу в OPEN */
    threshold: number;
    /** Час в мс, через який OPEN → HALF_OPEN */
    timeout: number;
}
export declare class CircuitBreaker {
    private state;
    private failures;
    private openedAt;
    private readonly opts;
    constructor(opts?: Partial<CircuitBreakerOptions>);
    get currentState(): CircuitState;
    getState(): CircuitState;
    isAvailable(): boolean;
    recordSuccess(): void;
    recordFailure(): void;
}
//# sourceMappingURL=CircuitBreaker.d.ts.map