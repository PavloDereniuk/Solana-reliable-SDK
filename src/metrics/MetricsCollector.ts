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

export class MetricsCollector {
  private readonly rpcLatencies = new Map<string, number[]>();
  private readonly rpcFailures = new Map<string, number>();
  private readonly rpcRequests = new Map<string, number>();
  private readonly circuitStates = new Map<string, 'CLOSED' | 'OPEN' | 'HALF_OPEN'>();
  private readonly txSamples: TxSample[] = [];

  /** Keep at most this many latency samples per endpoint to bound memory. */
  private readonly maxSamplesPerEndpoint: number;

  constructor(opts: { maxSamplesPerEndpoint?: number } = {}) {
    this.maxSamplesPerEndpoint = opts.maxSamplesPerEndpoint ?? 500;
  }

  // ── RPC metrics ─────────────────────────────────────────────────────────────

  recordRpcCall(endpoint: string, latencyMs: number, success: boolean): void {
    const key = this.normalizeUrl(endpoint);

    const requests = (this.rpcRequests.get(key) ?? 0) + 1;
    this.rpcRequests.set(key, requests);

    if (!success) {
      this.rpcFailures.set(key, (this.rpcFailures.get(key) ?? 0) + 1);
    }

    const samples = this.rpcLatencies.get(key) ?? [];
    samples.push(latencyMs);
    if (samples.length > this.maxSamplesPerEndpoint) samples.shift();
    this.rpcLatencies.set(key, samples);
  }

  recordCircuitState(endpoint: string, state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
    this.circuitStates.set(this.normalizeUrl(endpoint), state);
  }

  // ── Transaction metrics ──────────────────────────────────────────────────────

  recordTransaction(sample: Omit<TxSample, 'timestamp'>): void {
    this.txSamples.push({ ...sample, timestamp: Date.now() });
    if (this.txSamples.length > 1_000) this.txSamples.shift();
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  getSnapshot(): MetricsSnapshot {
    const rpc: MetricsSnapshot['rpc'] = {};

    for (const [endpoint, samples] of this.rpcLatencies) {
      const sorted = [...samples].sort((a, b) => a - b);
      const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

      rpc[endpoint] = {
        totalRequests: this.rpcRequests.get(endpoint) ?? 0,
        failures: this.rpcFailures.get(endpoint) ?? 0,
        avgLatencyMs: Math.round(avg),
        p95LatencyMs: Math.round(p95),
        circuitState: this.circuitStates.get(endpoint) ?? 'CLOSED',
      };
    }

    const txTotal = this.txSamples.length;
    const txSucceeded = this.txSamples.filter((s) => s.success).length;
    const avgRetries = txTotal
      ? this.txSamples.reduce((a, s) => a + s.retries, 0) / txTotal
      : 0;
    const avgDurationMs = txTotal
      ? this.txSamples.reduce((a, s) => a + s.durationMs, 0) / txTotal
      : 0;

    return {
      rpc,
      transactions: {
        total: txTotal,
        succeeded: txSucceeded,
        failed: txTotal - txSucceeded,
        avgRetries: Math.round(avgRetries * 10) / 10,
        avgDurationMs: Math.round(avgDurationMs),
      },
    };
  }

  /**
   * Export metrics in Prometheus text format (for Grafana / alerting).
   * Compatible with OpenTelemetry Prometheus exporter wire format.
   */
  exportPrometheus(): string {
    const snap = this.getSnapshot();
    const lines: string[] = [];

    const ts = Date.now();

    lines.push('# HELP solana_rpc_requests_total Total RPC requests per endpoint');
    lines.push('# TYPE solana_rpc_requests_total counter');
    for (const [ep, m] of Object.entries(snap.rpc)) {
      lines.push(`solana_rpc_requests_total{endpoint="${ep}"} ${m.totalRequests} ${ts}`);
    }

    lines.push('# HELP solana_rpc_failures_total Total RPC failures per endpoint');
    lines.push('# TYPE solana_rpc_failures_total counter');
    for (const [ep, m] of Object.entries(snap.rpc)) {
      lines.push(`solana_rpc_failures_total{endpoint="${ep}"} ${m.failures} ${ts}`);
    }

    lines.push('# HELP solana_rpc_latency_avg_ms Average RPC latency (ms) per endpoint');
    lines.push('# TYPE solana_rpc_latency_avg_ms gauge');
    for (const [ep, m] of Object.entries(snap.rpc)) {
      lines.push(`solana_rpc_latency_avg_ms{endpoint="${ep}"} ${m.avgLatencyMs} ${ts}`);
    }

    lines.push('# HELP solana_rpc_latency_p95_ms P95 RPC latency (ms) per endpoint');
    lines.push('# TYPE solana_rpc_latency_p95_ms gauge');
    for (const [ep, m] of Object.entries(snap.rpc)) {
      lines.push(`solana_rpc_latency_p95_ms{endpoint="${ep}"} ${m.p95LatencyMs} ${ts}`);
    }

    lines.push('# HELP solana_circuit_breaker_state Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)');
    lines.push('# TYPE solana_circuit_breaker_state gauge');
    const stateNum = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
    for (const [ep, m] of Object.entries(snap.rpc)) {
      lines.push(`solana_circuit_breaker_state{endpoint="${ep}"} ${stateNum[m.circuitState]} ${ts}`);
    }

    lines.push('# HELP solana_tx_total Total transactions sent');
    lines.push('# TYPE solana_tx_total counter');
    lines.push(`solana_tx_total ${snap.transactions.total} ${ts}`);
    lines.push(`solana_tx_succeeded_total ${snap.transactions.succeeded} ${ts}`);
    lines.push(`solana_tx_failed_total ${snap.transactions.failed} ${ts}`);

    lines.push('# HELP solana_tx_avg_retries Average retries per transaction');
    lines.push('# TYPE solana_tx_avg_retries gauge');
    lines.push(`solana_tx_avg_retries ${snap.transactions.avgRetries} ${ts}`);

    return lines.join('\n') + '\n';
  }

  /**
   * Export as OTLP-compatible JSON (for OpenTelemetry Collector / Datadog Agent).
   */
  exportOtlpJson(): object {
    const snap = this.getSnapshot();
    const ts = Date.now() * 1_000_000; // nanoseconds

    const resourceMetrics = {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'solana-reliable-sdk' } }],
      },
      scopeMetrics: [
        {
          scope: { name: 'solana-reliable-sdk', version: '0.1.0' },
          metrics: [
            ...Object.entries(snap.rpc).flatMap(([ep, m]) => [
              gauge('solana.rpc.requests', m.totalRequests, { endpoint: ep }, ts),
              gauge('solana.rpc.failures', m.failures, { endpoint: ep }, ts),
              gauge('solana.rpc.latency.avg_ms', m.avgLatencyMs, { endpoint: ep }, ts),
              gauge('solana.rpc.latency.p95_ms', m.p95LatencyMs, { endpoint: ep }, ts),
              gauge('solana.circuit_breaker.state', stateNum(m.circuitState), { endpoint: ep }, ts),
            ]),
            gauge('solana.tx.total', snap.transactions.total, {}, ts),
            gauge('solana.tx.succeeded', snap.transactions.succeeded, {}, ts),
            gauge('solana.tx.failed', snap.transactions.failed, {}, ts),
            gauge('solana.tx.avg_retries', snap.transactions.avgRetries, {}, ts),
          ],
        },
      ],
    };

    return { resourceMetrics: [resourceMetrics] };
  }

  reset(): void {
    this.rpcLatencies.clear();
    this.rpcFailures.clear();
    this.rpcRequests.clear();
    this.circuitStates.clear();
    this.txSamples.length = 0;
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return url;
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function gauge(
  name: string,
  value: number,
  attrs: Record<string, string>,
  timeUnixNano: number,
): object {
  return {
    name,
    gauge: {
      dataPoints: [
        {
          attributes: Object.entries(attrs).map(([k, v]) => ({
            key: k,
            value: { stringValue: v },
          })),
          timeUnixNano,
          asDouble: value,
        },
      ],
    },
  };
}

function stateNum(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): number {
  return state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2;
}
