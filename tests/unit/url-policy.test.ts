import { describe, expect, it } from 'vitest';
import { isSupportedAutomationUrl } from '../../packages/extension/src/url-policy.js';

describe('extension url policy', () => {
  it('allows http and https pages', () => {
    expect(isSupportedAutomationUrl('http://127.0.0.1:4173/form.html')).toBe(true);
    expect(isSupportedAutomationUrl('https://example.com/path')).toBe(true);
  });

  it('rejects non-web protocols', () => {
    expect(isSupportedAutomationUrl('chrome://extensions')).toBe(false);
    expect(isSupportedAutomationUrl('chrome-extension://abc/popup.html')).toBe(false);
    expect(isSupportedAutomationUrl('file:///tmp/demo.txt')).toBe(false);
  });

  it('rejects invalid urls', () => {
    expect(isSupportedAutomationUrl('')).toBe(false);
    expect(isSupportedAutomationUrl('not-a-url')).toBe(false);
    expect(isSupportedAutomationUrl(undefined)).toBe(false);
  });
});
