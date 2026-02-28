import { describe, expect, it } from 'vitest';
import { quantizedBBoxHash } from '../../packages/cli/src/utils.js';

describe('quantizedBBoxHash', () => {
  it('is stable within same quantization bucket', () => {
    const a = quantizedBBoxHash('example.com', '/form', 'button', 'Save', {
      x: 101,
      y: 204,
      width: 89,
      height: 33
    });

    const b = quantizedBBoxHash('example.com', '/form', 'button', 'Save', {
      x: 104,
      y: 203,
      width: 88,
      height: 31
    });

    expect(a).toBe(b);
  });

  it('changes when semantic fields change', () => {
    const a = quantizedBBoxHash('example.com', '/form', 'button', 'Save', {
      x: 100,
      y: 200,
      width: 90,
      height: 30
    });
    const b = quantizedBBoxHash('example.com', '/form', 'link', 'Save', {
      x: 100,
      y: 200,
      width: 90,
      height: 30
    });

    expect(a).not.toBe(b);
  });
});
