import { describe, expect, it } from 'vitest';
import { BakErrorCode, JSON_RPC_VERSION, fail, ok, parseJsonRpcLine } from '../../packages/protocol/src/index.js';

describe('rpc helpers', () => {
  it('encodes success and failure messages', () => {
    const success = ok('1', { value: 1 });
    const failure = fail('2', 'Not paired', BakErrorCode.E_NOT_PAIRED);

    expect(success.jsonrpc).toBe(JSON_RPC_VERSION);
    expect(failure.error.data?.bakCode).toBe(BakErrorCode.E_NOT_PAIRED);
  });

  it('parses valid request lines', () => {
    const parsed = parseJsonRpcLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.info', params: {} })
    );

    expect(parsed.method).toBe('session.info');
    expect(parsed.id).toBe(1);
  });
});
