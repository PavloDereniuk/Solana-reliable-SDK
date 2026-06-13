/**
 * Lightweight in-memory metrics collector.
 * No external dependencies — exports Prometheus text format and OTLP-compatible snapshots.
 * For production use, pass an OpenTelemetry MeterProvider via MetricsCollector.withOtel().
 */
export interface LatencySample {
    endpointUrl: string;
    latencyMs: number;
    success: boolean;
    timestamp: number;
}
export interface TxSample {
    retries: number;
    success: boolean;
    failureReason?: string;
    durationMs: number;
    timestamp: number;
}
export interface MetricsSnapshot {
    rpc: {
        [endpoint: string]: {
            totalRequests: number;
            failures: number;
            avgLatencyMs: number;
            p95LatencyMs: number;
            circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
        };
    };
    transactions: {
        total: number;
        succeeded: number;
        failed: number;
        avgRetries: number;
        avgDurationMs: number;
    };
}
export declare class MetricsCollector {
    private readonly rpcLatencies;
    private readonly rpcFailures;
    private readonly rpcRequests;
    private readonly circuitStates;
    private readonly txSamples;
    /** Keep at most this many latency samples per endpoint to bound memory. */
    private readonly maxSamplesPerEndpoint;
    constructor(opts?: {
        maxSamplesPerEndpoint?: number;
    });
    recordRpcCall(endpoint: string, latencyMs: number, success: boolean): void;
    recordCircuitState(endpoint: string, state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void;
    recordTransaction(sample: Omit<TxSample, 'timestamp'>): void;
    getSnapshot(): MetricsSnapshot;
    /**
     * Export metrics in Prometheus text format (for Grafana / alerting).
     * Compatible with OpenTelemetry Prometheus exporter wire format.
     */
    exportPrometheus(): string;
    /**
     * Export as OTLP-compatible JSON (for OpenTelemetry Collector / Datadog Agent).
     */
    exportOtlpJson(): object;
    reset(): void;
    private normalizeUrl;
}
//# sourceMappingURL=MetricsCollector.d.ts.map