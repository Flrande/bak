import { describe, expect, it } from 'vitest';
import type { ElementMapItem } from '../../packages/protocol/src/index.js';
import { redactElement, redactElements, redactText } from '../../packages/cli/src/privacy.js';

function sampleElement(overrides: Partial<ElementMapItem> = {}): ElementMapItem {
  return {
    eid: 'eid_1',
    tag: 'input',
    role: 'textbox',
    name: 'email',
    text: '',
    bbox: { x: 1, y: 2, width: 3, height: 4 },
    selectors: {
      css: '#email',
      text: 'alice@example.com',
      aria: 'textbox:alice@example.com'
    },
    risk: 'low',
    ...overrides
  };
}

describe('cli snapshot redaction', () => {
  it('redacts high-risk patterns in name/text/selectors', () => {
    const item = sampleElement({
      name: 'token=abc12345',
      text: '4111 1111 1111 1111'
    });

    const redacted = redactElement(item);

    expect(redacted.name).toBe('[REDACTED:query-secret]');
    expect(redacted.text).toBe('[REDACTED:number]');
    expect(redacted.selectors.text).toBe('[REDACTED:email]');
    expect(redacted.selectors.aria).toContain('[REDACTED:email]');
  });

  it('redacts arrays before snapshot persistence', () => {
    const items = redactElements([
      sampleElement({ text: '123456' }),
      sampleElement({ text: 'safe text', selectors: { css: '#a', text: null, aria: null } })
    ]);

    expect(items[0].text).toBe('[REDACTED:otp]');
    expect(items[1].text).toBe('safe text');
  });

  it('redactText handles empty values safely', () => {
    expect(redactText('')).toBe('');
    expect(redactText('   ')).toBe('');
  });
});
