import { describe, expect, it } from 'vitest';
import {
  containsRedactionMarker,
  inferSafeName,
  redactElementText,
  redactHeaderMap,
  redactTransportText
} from '../../packages/extension/src/privacy.js';

describe('privacy redaction', () => {
  it('redacts obvious sensitive text patterns', () => {
    expect(redactElementText('alice@example.com')).toBe('[REDACTED:email]');
    expect(redactElementText('123456')).toBe('[REDACTED:otp]');
    expect(redactElementText('4111 1111 1111 1111')).toBe('[REDACTED:number]');
    expect(redactElementText('token=abcd1234')).toBe('[REDACTED:query-secret]');
  });

  it('clamps length more aggressively in safe mode', () => {
    const raw = 'x'.repeat(400);
    expect(redactElementText(raw).length).toBeLessThanOrEqual(120);
    expect(redactElementText(raw, { debugRichText: true }).length).toBeLessThanOrEqual(320);
  });

  it('redacts transport secrets without destroying surrounding structure', () => {
    expect(redactTransportText('authorization=Bearer abc123def456')).toContain('[REDACTED]');
    expect(redactTransportText('{"csrfToken":"abc123","symbol":"QQQ"}')).toContain('"symbol":"QQQ"');
    expect(redactTransportText('token=abc123&limit=20')).toBe('token=[REDACTED]&limit=20');
  });

  it('redacts sensitive headers while preserving safe ones', () => {
    const headers = redactHeaderMap({
      Authorization: 'Bearer abc123def456',
      'Content-Type': 'application/json'
    });

    expect(headers).toEqual({
      Authorization: '[REDACTED:authorization]',
      'Content-Type': 'application/json'
    });
    expect(containsRedactionMarker(headers?.Authorization)).toBe(true);
  });
});

describe('inferSafeName', () => {
  it('does not use textbox text by default', () => {
    const name = inferSafeName({
      tag: 'input',
      role: 'textbox',
      inputType: 'text',
      text: 'Super Secret Typed Value'
    });

    expect(name).toBe('input');
  });

  it('prefers safe metadata for text-entry fields', () => {
    const name = inferSafeName({
      tag: 'input',
      role: 'textbox',
      inputType: 'email',
      placeholder: 'Work email',
      text: 'someone@example.com'
    });

    expect(name).toBe('Work email');
  });

  it('can include text for diagnostics when debug mode is enabled', () => {
    const name = inferSafeName(
      {
        tag: 'div',
        role: 'button',
        text: 'Delete selected records'
      },
      { debugRichText: true }
    );

    expect(name).toBe('Delete selected records');
  });
});
