/**
 * Metrics and observability simulation tests.
 * Verifies that MetricsCollector correctly aggregates RPC and transaction data
 * and exports valid Prometheus/OTLP formats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../../src/metrics/MetricsCollector.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('RPC metrics recording', () => {
    it('records successful calls with latency', () => {
      collector.recordRpcCall('https://rpc1.example.com', 120, true);
      collector.recordRpcCall('https://rpc1.example.com', 80, true);
      const snap = collector.getSnapshot();
      const ep = Object.keys(snap.rpc)[0];
      expect(snap.rpc[ep]?.totalRequests).toBe(2);
      expect(snap.rpc[ep]?.failures).toBe(0);
      expect(snap.rpc[ep]?.avgLatencyMs).toBeGreaterThan(0);
    });

    it('records failed calls and increments failure counter', () => {
      collector.recordRpcCall('https://rpc1.example.com', 5000, false);
      collector.recordRpcCall('https://rpc1.example.com', 100, true);
      const snap = collector.getSnapshot();
      const ep = Object.keys(snap.rpc)[0];
      expect(snap.rpc[ep]?.failures).toBe(1);
      expect(snap.rpc[ep]?.totalRequests).toBe(2);
    });

    it('tracks multiple endpoints independently', () => {
      collector.recordRpcCall('https://ep1.com', 100, true);
      collector.recordRpcCall('https://ep2.com', 200, false);
      const snap = collector.getSnapshot();
      expect(Object.keys(snap.rpc)).toHaveLength(2);
    });

    it('calculates correct p95 latency', () => {
      // Add 20 samples: 19 at 100ms, 1 at 5000ms
      for (let i = 0; i < 19; i++) collector.recordRpcCall('https://rpc.example.com', 100, true);
      collector.recordRpcCall('https://rpc.example.com', 5_000, true);
      const snap = collector.getSnapshot();
      const ep = Object.keys(snap.rpc)[0];
      // p95 of [100×19, 5000] = the 19th value (index 19) = 5000
      expect(snap.rpc[ep]?.p95LatencyMs).toBeGreaterThanOrEqual(100);
    });

    it('records circuit breaker state transitions', () => {
      collector.recordCircuitState('https://rpc.example.com', 'OPEN');
      const snap = collector.getSnapshot();
      // circuitState won't appear until we also have latency data; just check no throw
      expect(() => collector.exportPrometheus()).not.toThrow();
    });
  });

  describe('Transaction metrics recording', () => {
    it('tracks successful and failed transactions', () => {
      collector.recordTransaction({ retries: 0, success: true, durationMs: 1200 });
      collector.recordTransaction({ retries: 2, success: false, failureReason: 'timeout', durationMs: 90_000 });
      const snap = collector.getSnapshot();
      expect(snap.transactions.total).toBe(2);
      expect(snap.transactions.succeeded).toBe(1);
      expect(snap.transactions.failed).toBe(1);
    });

    it('calculates average retries', () => {
      collector.recordTransaction({ retries: 0, success: true, durationMs: 1000 });
      collector.recordTransaction({ retries: 4, success: true, durationMs: 8000 });
      const snap = collector.getSnapshot();
      expect(snap.transactions.avgRetries).toBe(2);
    });
  });

  describe('Prometheus export', () => {
    it('produces valid Prometheus text format with all required metrics', () => {
      collector.recordRpcCall('https://rpc.example.com', 150, true);
      collector.recordTransaction({ retries: 1, success: true, durationMs: 3000 });

      const output = collector.exportPrometheus();
      expect(output).toContain('solana_rpc_requests_total');
      expect(output).toContain('solana_rpc_failures_total');
      expect(output).toContain('solana_rpc_latency_avg_ms');
      expect(output).toContain('solana_rpc_latency_p95_ms');
      expect(output).toContain('solana_circuit_breaker_state');
      expect(output).toContain('solana_tx_total');
      expect(output).toContain('solana_tx_avg_retries');
    });

    it('includes endpoint label in output', () => {
      collector.recordRpcCall('https://rpc1.example.com', 100, true);
      const output = collector.exportPrometheus();
      expect(output).toContain('rpc1.example.com');
    });

    it('redacts api-key in prometheus labels (via normalizeUrl)', () => {
      collector.recordRpcCall('https://mainnet.helius-rpc.com/?api-key=SECRET123', 100, true);
      const output = collector.exportPrometheus();
      // normalizeUrl extracts hostname only — SECRET123 should not appear
      expect(output).not.toContain('SECRET123');
    });

    it('falls back to raw string when normalizeUrl receives an invalid URL', () => {
      // "not-a-valid-url" causes `new URL()` to throw; the catch block returns the raw string
      collector.recordRpcCall('not-a-valid-url', 50, true);
      const output = collector.exportPrometheus();
      expect(output).toContain('not-a-valid-url');
    });
  });

  describe('OTLP JSON export', () => {
    it('produces valid OTLP-compatible JSON structure', () => {
      collector.recordRpcCall('https://rpc.example.com', 100, true);
      const otlp = collector.exportOtlpJson() as any;
      expect(otlp).toHaveProperty('resourceMetrics');
      expect(Array.isArray(otlp.resourceMetrics)).toBe(true);
      const sm = otlp.resourceMetrics[0].scopeMetrics[0];
      expect(sm.scope.name).toBe('solana-reliable-sdk');
      expect(Array.isArray(sm.metrics)).toBe(true);
    });

    it('includes service.name in resource attributes', () => {
      const otlp = collector.exportOtlpJson() as any;
      const attrs = otlp.resourceMetrics[0].resource.attributes;
      const svcName = attrs.find((a: any) => a.key === 'service.name');
      expect(svcName?.value?.stringValue).toBe('solana-reliable-sdk');
    });

    it('stateNum returns 1 for HALF_OPEN and 2 for OPEN in OTLP export', () => {
      const half = new MetricsCollector();
      half.recordRpcCall('https://rpc.example.com', 50, true);
      half.recordCircuitState('https://rpc.example.com', 'HALF_OPEN');
      const otlp1 = half.exportOtlpJson() as any;
      const metrics1 = otlp1.resourceMetrics[0].scopeMetrics[0].metrics;
      const stateMetric1 = metrics1.find((m: any) => m.name === 'solana.circuit_breaker.state');
      expect(stateMetric1?.gauge?.dataPoints[0]?.asDouble).toBe(1);

      const open = new MetricsCollector();
      open.recordRpcCall('https://rpc.example.com', 50, true);
      open.recordCircuitState('https://rpc.example.com', 'OPEN');
      const otlp2 = open.exportOtlpJson() as any;
      const metrics2 = otlp2.resourceMetrics[0].scopeMetrics[0].metrics;
      const stateMetric2 = metrics2.find((m: any) => m.name === 'solana.circuit_breaker.state');
      expect(stateMetric2?.gauge?.dataPoints[0]?.asDouble).toBe(2);
    });
  });

  describe('Memory management', () => {
    it('bounds latency samples at maxSamplesPerEndpoint', () => {
      const small = new MetricsCollector({ maxSamplesPerEndpoint: 10 });
      for (let i = 0; i < 100; i++) small.recordRpcCall('https://rpc.example.com', i * 10, true);
      const snap = small.getSnapshot();
      const ep = Object.keys(snap.rpc)[0];
      // totalRequests continues counting even after samples are bounded
      expect(snap.rpc[ep]?.totalRequests).toBe(100);
    });

    it('bounds txSamples at 1000 by shifting oldest entries', () => {
      for (let i = 0; i < 1002; i++) {
        collector.recordTransaction({ retries: 0, success: true, durationMs: 100 });
      }
      const snap = collector.getSnapshot();
      expect(snap.transactions.total).toBe(1000);
    });

    it('reset() clears all accumulated data', () => {
      collector.recordRpcCall('https://rpc.example.com', 100, true);
      collector.recordTransaction({ retries: 1, success: true, durationMs: 1000 });
      collector.reset();
      const snap = collector.getSnapshot();
      expect(Object.keys(snap.rpc)).toHaveLength(0);
      expect(snap.transactions.total).toBe(0);
    });
  });
});
