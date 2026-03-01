import { describe, expect, it } from 'vitest';
import { computeReconnectDelayMs } from '../../packages/extension/src/reconnect.js';

describe('reconnect backoff', () => {
  it('doubles delay with capped exponential growth', () => {
    expect(computeReconnectDelayMs(0)).toBe(1500);
    expect(computeReconnectDelayMs(1)).toBe(3000);
    expect(computeReconnectDelayMs(2)).toBe(6000);
    expect(computeReconnectDelayMs(3)).toBe(12000);
    expect(computeReconnectDelayMs(4)).toBe(15000);
    expect(computeReconnectDelayMs(10)).toBe(15000);
  });

  it('normalizes invalid attempts and options', () => {
    expect(computeReconnectDelayMs(-1)).toBe(1500);
    expect(computeReconnectDelayMs(Number.NaN)).toBe(1500);
    expect(computeReconnectDelayMs(1.9)).toBe(3000);
    expect(computeReconnectDelayMs(0, { baseDelayMs: 50, maxDelayMs: 10 })).toBe(100);
    expect(computeReconnectDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 4000 })).toBe(4000);
  });
});
