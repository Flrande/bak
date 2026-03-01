import { describe, expect, it } from 'vitest';
import { unsupportedLocator, unsupportedLocatorHint } from '../../packages/extension/src/limitations.js';

describe('unsupported locator hints', () => {
  it('flags shadow-dom selectors', () => {
    const issue = unsupportedLocator({ css: 'div >>> button' });
    expect(issue?.reason).toBe('shadow-dom');
    const hint = unsupportedLocatorHint({ css: 'div >>> button' });
    expect(hint).toContain('shadow-dom');
  });

  it('flags iframe selectors', () => {
    const issue = unsupportedLocator({ css: 'iframe#pay-frame button' });
    expect(issue?.reason).toBe('iframe');
    const hint = unsupportedLocatorHint({ css: 'iframe#pay-frame button' });
    expect(hint).toContain('iframe');
  });

  it('returns null for regular css selectors', () => {
    expect(unsupportedLocatorHint({ css: '#save-btn' })).toBeNull();
  });

  it('does not flag frame substring in regular ids', () => {
    expect(unsupportedLocator({ css: '#frame-button' })).toBeNull();
  });
});
