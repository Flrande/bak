import type { ElementMapItem } from '@flrande/bak-protocol';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_DIGIT_PATTERN = /(?:\d[ -]?){13,19}/g;
const OTP_PATTERN = /^\d{4,8}$/;
const SECRET_QUERY_PARAM_PATTERN = /(token|secret|password|passwd|otp|code|session|auth)=/i;
const HIGH_ENTROPY_TOKEN_PATTERN = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`]{16,}$/;

function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function redactText(raw: string): string {
  if (!raw) {
    return '';
  }

  const normalized = normalize(raw);
  if (!normalized) {
    return '';
  }

  if (SECRET_QUERY_PARAM_PATTERN.test(normalized)) {
    return '[REDACTED:query-secret]';
  }

  let output = normalized.replace(EMAIL_PATTERN, '[REDACTED:email]');
  output = output.replace(LONG_DIGIT_PATTERN, '[REDACTED:number]');

  if (OTP_PATTERN.test(output)) {
    return '[REDACTED:otp]';
  }

  if (HIGH_ENTROPY_TOKEN_PATTERN.test(output) && !output.includes(' ')) {
    return '[REDACTED:secret]';
  }

  return output;
}

export function redactElement(item: ElementMapItem): ElementMapItem {
  return {
    ...item,
    name: redactText(item.name),
    text: redactText(item.text),
    selectors: {
      ...item.selectors,
      text: item.selectors.text ? redactText(item.selectors.text) : null,
      aria: item.selectors.aria ? redactText(item.selectors.aria) : null
    }
  };
}

export function redactElements(items: ElementMapItem[]): ElementMapItem[] {
  return items.map((item) => redactElement(item));
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }

  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = redactUnknown(item);
    }
    return output;
  }

  return value;
}


