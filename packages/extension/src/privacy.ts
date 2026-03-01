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

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_DIGIT_PATTERN = /(?:\d[ -]?){13,19}/g;
const OTP_PATTERN = /^\d{4,8}$/;
const SECRET_QUERY_PARAM_PATTERN = /(token|secret|password|passwd|otp|code|session|auth)=/i;
const HIGH_ENTROPY_TOKEN_PATTERN = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`]{16,}$/;

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

  if (HIGH_ENTROPY_TOKEN_PATTERN.test(output) && !output.includes(' ')) {
    return '[REDACTED:secret]';
  }

  return output;
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
