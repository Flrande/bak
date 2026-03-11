export interface RedactTextOptions {
  debugRichText?: boolean;
}

export interface NameCandidates {
  tag: string;
  role?: string | null;
  inputType?: string | null;
  ariaLabel?: string | null;
  labelledByText?: string | null;
  labelText?: string | null;
  placeholder?: string | null;
  text?: string | null;
  nameAttr?: string | null;
}

const MAX_SAFE_TEXT_LENGTH = 120;
const MAX_DEBUG_TEXT_LENGTH = 320;
const REDACTION_MARKER = '[REDACTED]';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_DIGIT_PATTERN = /(?:\d[ -]?){13,19}/g;
const OTP_PATTERN = /^\d{4,8}$/;
const SECRET_QUERY_PARAM_PATTERN = /(token|secret|password|passwd|otp|code|session|auth)=/i;
const HIGH_ENTROPY_TOKEN_PATTERN = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`]{16,}$/;
const TRANSPORT_SECRET_KEY_SOURCE =
  '(?:api[_-]?key|authorization|auth|cookie|csrf(?:token)?|nonce|password|passwd|secret|session(?:id)?|token|xsrf(?:token)?)';
const TRANSPORT_SECRET_PAIR_PATTERN = new RegExp(`((?:^|[?&;,\\s])${TRANSPORT_SECRET_KEY_SOURCE}=)[^&\\r\\n"'>]*`, 'gi');
const JSON_SECRET_VALUE_PATTERN = new RegExp(
  `((?:"|')${TRANSPORT_SECRET_KEY_SOURCE}(?:"|')\\s*:\\s*)(?:"[^"]*"|'[^']*'|true|false|null|-?\\d+(?:\\.\\d+)?)`,
  'gi'
);
const ASSIGNMENT_SECRET_VALUE_PATTERN = new RegExp(
  `((?:^|[\\s,{;])${TRANSPORT_SECRET_KEY_SOURCE}\\s*[:=]\\s*)([^,&;}"'\\r\\n]+)`,
  'gi'
);
const AUTHORIZATION_VALUE_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+\b/gi;
const SENSITIVE_ATTRIBUTE_PATTERN = /(?:api[_-]?key|authorization|auth|cookie|csrf|nonce|password|passwd|secret|session|token|xsrf)/i;
const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-csrf-token$/i,
  /^x-xsrf-token$/i,
  /^csrf-token$/i,
  /^x-auth-token$/i,
  /^x-api-key$/i,
  /^api-key$/i
];

const INPUT_TEXT_ENTRY_TYPES = new Set([
  'text',
  'search',
  'email',
  'password',
  'tel',
  'url',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time'
]);

function normalize(raw: string): string {
  const cleaned = [...raw]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('');
  return cleaned.replace(/\s+/g, ' ').trim();
}

function clamp(text: string, options: RedactTextOptions): string {
  const max = options.debugRichText ? MAX_DEBUG_TEXT_LENGTH : MAX_SAFE_TEXT_LENGTH;
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function redactByPattern(text: string): string {
  let output = text;

  if (SECRET_QUERY_PARAM_PATTERN.test(output)) {
    return '[REDACTED:query-secret]';
  }

  output = output.replace(EMAIL_PATTERN, '[REDACTED:email]');
  output = output.replace(LONG_DIGIT_PATTERN, '[REDACTED:number]');

  if (OTP_PATTERN.test(output)) {
    return '[REDACTED:otp]';
  }

  if (HIGH_ENTROPY_TOKEN_PATTERN.test(output) && !/[ =&:]/.test(output) && !output.includes('[REDACTED')) {
    return '[REDACTED:secret]';
  }

  return output;
}

function redactTransportSecrets(text: string): string {
  let output = text;
  output = output.replace(AUTHORIZATION_VALUE_PATTERN, '$1 [REDACTED]');
  output = output.replace(TRANSPORT_SECRET_PAIR_PATTERN, '$1[REDACTED]');
  output = output.replace(JSON_SECRET_VALUE_PATTERN, '$1"[REDACTED]"');
  output = output.replace(ASSIGNMENT_SECRET_VALUE_PATTERN, '$1[REDACTED]');

  if (HIGH_ENTROPY_TOKEN_PATTERN.test(output) && !/[ =&:]/.test(output) && !output.includes('[REDACTED')) {
    return '[REDACTED:secret]';
  }

  return output;
}

function shouldRedactHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(name));
}

function redactAttributeValue(name: string, value: string): string {
  if (!value) {
    return value;
  }
  if (name === 'value') {
    return REDACTION_MARKER;
  }
  return redactTransportText(value);
}

export function redactElementText(raw: string | null | undefined, options: RedactTextOptions = {}): string {
  if (!raw) {
    return '';
  }

  const normalized = normalize(raw);
  if (!normalized) {
    return '';
  }

  const redacted = redactByPattern(normalized);
  return clamp(redacted, options);
}

export function containsRedactionMarker(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.includes('[REDACTED');
}

export function redactTransportText(raw: string | null | undefined): string {
  if (!raw) {
    return '';
  }
  return redactTransportSecrets(String(raw));
}

export function redactHeaderMap(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = shouldRedactHeader(name) ? `[REDACTED:${name.toLowerCase()}]` : redactTransportText(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function redactHtmlSnapshot(root: Element | null | undefined): string {
  if (!root || !('cloneNode' in root)) {
    return '';
  }
  const clone = root.cloneNode(true) as Element;
  const elements = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'script' && !element.getAttribute('src')) {
      element.textContent = '[REDACTED:script]';
    }
    if (tagName === 'textarea' && (element.textContent ?? '').trim().length > 0) {
      element.textContent = REDACTION_MARKER;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name;
      const value = attribute.value;
      const shouldRedactValue =
        (name === 'value' && (tagName === 'input' || tagName === 'textarea' || tagName === 'option')) ||
        SENSITIVE_ATTRIBUTE_PATTERN.test(name);
      if (shouldRedactValue) {
        element.setAttribute(name, redactAttributeValue(name, value));
        continue;
      }
      if (name === 'href' || name === 'src' || name === 'action' || name === 'content' || name.startsWith('data-')) {
        const redacted = redactAttributeValue(name, value);
        if (redacted !== value) {
          element.setAttribute(name, redacted);
        }
      }
    }
  }
  return 'outerHTML' in clone ? (clone as HTMLElement).outerHTML : '';
}

function isTextEntryField(candidates: NameCandidates): boolean {
  const tag = candidates.tag.toLowerCase();
  const role = (candidates.role ?? '').toLowerCase();
  const inputType = (candidates.inputType ?? '').toLowerCase();

  if (role === 'textbox') {
    return true;
  }

  if (tag === 'textarea') {
    return true;
  }

  if (tag === 'input') {
    return INPUT_TEXT_ENTRY_TYPES.has(inputType) || inputType === '';
  }

  return false;
}

export function inferSafeName(candidates: NameCandidates, options: RedactTextOptions = {}): string {
  const allowDebugText = Boolean(options.debugRichText);
  const fromAria = redactElementText(candidates.ariaLabel, options);
  const fromLabelledBy = redactElementText(candidates.labelledByText, options);
  const fromLabel = redactElementText(candidates.labelText, options);
  const fromPlaceholder = redactElementText(candidates.placeholder, options);
  const fromNameAttr = redactElementText(candidates.nameAttr, options);
  const fromText = redactElementText(candidates.text, options);

  const ordered = [fromAria, fromLabelledBy, fromLabel, fromPlaceholder];

  if (!isTextEntryField(candidates) || allowDebugText) {
    ordered.push(fromText);
  }

  ordered.push(fromNameAttr);

  for (const value of ordered) {
    if (value) {
      return value;
    }
  }

  return candidates.tag.toLowerCase();
}
