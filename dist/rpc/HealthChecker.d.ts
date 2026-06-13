export interface EndpointHealth {
    url: string;
    alive: boolean;
    latencyMs: number;
    lastChecked: number;
}
export declare class HealthChecker {
    private readonly endpoints;
    private health;
    private timer;
    private readonly intervalMs;
    constructor(endpoints: string[], intervalMs?: number);
    start(): void;
    stop(): void;
    getHealth(url: string): EndpointHealth | undefined;
    getAliveEndpoints(): string[];
    private checkAll;
    private checkOne;
}
//# sourceMappingURL=HealthChecker.d.ts.map