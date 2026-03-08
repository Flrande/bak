import { describe, expect, it } from 'vitest';
import { dragDropLocatorsFromOptions, locatorFromOptions, parseFiniteNumber } from '../../packages/cli/src/cli-args.js';

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe('cli argument helpers', () => {
  it('parses distinct drag-drop source and target locators', () => {
    const endpoints = dragDropLocatorsFromOptions(
      {
        fromCss: '#drag-source',
        toCss: '#drop-target'
      },
      parseJson
    );

    expect(endpoints).toEqual({
      from: { css: '#drag-source' },
      to: { css: '#drop-target' }
    });
  });

  it('supports mixing json and prefixed drag-drop locators deterministically', () => {
    const endpoints = dragDropLocatorsFromOptions(
      {
        fromLocator: '{"css":"#drag-source","shadow":"auto"}',
        toText: 'Drop here'
      },
      parseJson
    );

    expect(endpoints.from).toMatchObject({ css: '#drag-source', shadow: 'auto' });
    expect(endpoints.to).toMatchObject({ text: 'Drop here' });
  });

  it('rejects ambiguous drag-drop invocations when either endpoint is missing', () => {
    expect(() =>
      dragDropLocatorsFromOptions(
        {
          fromCss: '#drag-source'
        },
        parseJson
      )
    ).toThrow(/requires both source and target locator options/i);
  });

  it('accepts negative deltas and zero coordinates where valid', () => {
    expect(parseFiniteNumber('-120', 'dy')).toBe(-120);
    expect(parseFiniteNumber('0', 'x', { min: 0 })).toBe(0);
  });

  it('rejects invalid numeric values predictably', () => {
    expect(() => parseFiniteNumber('NaN!', 'dx')).toThrow(/finite number/i);
    expect(() => parseFiniteNumber('-1', 'x', { min: 0 })).toThrow(/must be >= 0/i);
  });

  it('parses standard locator payloads including frame paths and index', () => {
    const locator = locatorFromOptions(
      {
        role: 'button',
        name: 'Save',
        frame: ['#demo-frame'],
        index: '0'
      },
      parseJson
    );

    expect(locator).toEqual({
      role: 'button',
      name: 'Save',
      framePath: ['#demo-frame'],
      index: 0
    });
  });
});
