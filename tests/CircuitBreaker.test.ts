import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from '../src/rpc/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ threshold: 3, timeout: 60_000 });
  });

  it('starts CLOSED and available', () => {
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
  });

  it('stays CLOSED after fewer failures than threshold', () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
  });

  it('transitions to OPEN after threshold failures', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');
    expect(cb.isAvailable()).toBe(false);
  });

  it('transitions OPEN → HALF_OPEN after timeout', () => {
    vi.useFakeTimers();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isAvailable()).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.currentState).toBe('HALF_OPEN');
    vi.useRealTimers();
  });

  it('transitions HALF_OPEN → CLOSED on success', () => {
    vi.useFakeTimers();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(60_001);
    cb.isAvailable(); // HALF_OPEN
    cb.recordSuccess();

    expect(cb.currentState).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
    vi.useRealTimers();
  });

  it('transitions HALF_OPEN → OPEN on failure', () => {
    vi.useFakeTimers();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(60_001);
    cb.isAvailable(); // HALF_OPEN
    cb.recordFailure(); // одна невдача в HALF_OPEN → назад в OPEN

    expect(cb.currentState).toBe('OPEN');
    vi.useRealTimers();
  });

  it('resets failure count on success', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    // лічильник скинувся після success, тому 2 failures не відкривають
    expect(cb.currentState).toBe('CLOSED');
  });
});
