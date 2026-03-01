import { describe, expect, it } from 'vitest';
import { unsupportedLocatorHint } from '../../packages/extension/src/limitations.js';

describe('unsupported locator hints', () => {
  it('flags shadow-dom selectors', () => {
    const hint = unsupportedLocatorHint({ css: 'div >>> button' });
    expect(hint).toContain('shadow-dom');
  });

  it('flags iframe selectors', () => {
    const hint = unsupportedLocatorHint({ css: 'iframe#pay-frame button' });
    expect(hint).toContain('iframe');
  });

  it('returns null for regular css selectors', () => {
    expect(unsupportedLocatorHint({ css: '#save-btn' })).toBeNull();
  });
});
