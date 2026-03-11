import { describe, expect, it } from 'vitest';
import { resolveRpcTimeoutMs } from '../../packages/cli/src/rpc/client.js';

describe('rpc client timeout resolution', () => {
  it('uses a longer timeout for navigation-oriented session and page methods', () => {
    expect(resolveRpcTimeoutMs('session.openTab', {})).toBe(45_000);
    expect(resolveRpcTimeoutMs('session.ensure', {})).toBe(45_000);
    expect(resolveRpcTimeoutMs('page.goto', {})).toBe(45_000);
  });

  it('keeps the default timeout for ordinary methods', () => {
    expect(resolveRpcTimeoutMs('page.url', {})).toBe(15_000);
    expect(resolveRpcTimeoutMs('session.info', {})).toBe(15_000);
  });

  it('honors larger explicit timeoutMs requests with headroom', () => {
    expect(resolveRpcTimeoutMs('session.openTab', { timeoutMs: 60_000 })).toBe(70_000);
    expect(resolveRpcTimeoutMs('page.url', { timeoutMs: 20_000 })).toBe(30_000);
  });
});
