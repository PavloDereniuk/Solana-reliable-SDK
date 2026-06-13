const DEFAULT_OPTIONS = {
    threshold: 3,
    timeout: 60_000,
};
export class CircuitBreaker {
    state = 'CLOSED';
    failures = 0;
    openedAt = null;
    opts;
    constructor(opts = {}) {
        this.opts = { ...DEFAULT_OPTIONS, ...opts };
    }
    get currentState() {
        return this.state;
    }
    getState() {
        return this.state;
    }
    isAvailable() {
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
    recordSuccess() {
        this.failures = 0;
        this.openedAt = null;
        this.state = 'CLOSED';
    }
    recordFailure() {
        this.failures++;
        if (this.state === 'HALF_OPEN' || this.failures >= this.opts.threshold) {
            this.state = 'OPEN';
            this.openedAt = Date.now();
            this.failures = 0;
        }
    }
}
//# sourceMappingURL=CircuitBreaker.js.map