export function parseNonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be an integer >= 0`);
  }
  return parsed;
}

export function parsePositiveInt(value: unknown, label: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be an integer > 0`);
  }
  return parsed;
}

export function parseFiniteNumber(
  value: unknown,
  label: string,
  options: {
    min?: number;
  } = {}
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (typeof options.min === 'number' && parsed < options.min) {
    throw new Error(`${label} must be >= ${options.min}`);
  }
  return parsed;
}

function optionKey(prefix: string, key: 'locator' | 'eid' | 'role' | 'name' | 'text' | 'css' | 'index' | 'shadow' | 'frame'): string {
  if (!prefix) {
    return key;
  }
  return `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

export function hasLocatorOptions(options: Record<string, unknown>, prefix = ''): boolean {
  const locatorValue = options[optionKey(prefix, 'locator')];
  if (typeof locatorValue === 'string' && locatorValue.trim().length > 0) {
    return true;
  }
  for (const key of ['eid', 'role', 'name', 'text', 'css', 'shadow', 'index', 'frame'] as const) {
    const value = options[optionKey(prefix, key)];
    if (Array.isArray(value) && value.length > 0) {
      return true;
    }
    if (value !== undefined && value !== null && String(value).trim().length > 0) {
      return true;
    }
  }
  return false;
}

export function locatorFromOptions(
  options: Record<string, unknown>,
  parseJson: (value: string, fallback?: Record<string, unknown>) => Record<string, unknown>,
  prefix = ''
): Record<string, unknown> {
  const locatorKey = optionKey(prefix, 'locator');
  if (typeof options[locatorKey] === 'string' && String(options[locatorKey]).trim()) {
    return parseJson(String(options[locatorKey]));
  }

  const locator: Record<string, unknown> = {};
  for (const key of ['eid', 'role', 'name', 'text', 'css', 'shadow'] as const) {
    const optionValue = options[optionKey(prefix, key)];
    if (typeof optionValue === 'string' && optionValue.trim()) {
      locator[key] = optionValue;
    }
  }
  const frameValue = options[optionKey(prefix, 'frame')];
  if (Array.isArray(frameValue) && frameValue.length > 0) {
    locator.framePath = frameValue.map(String);
  }
  const indexValue = options[optionKey(prefix, 'index')];
  if (indexValue !== undefined) {
    locator.index = parseNonNegativeInt(indexValue, prefix ? `${prefix} index` : 'index');
  }
  if (Object.keys(locator).length === 0) {
    throw new Error(prefix ? `${prefix} locator options are required` : 'locator options are required');
  }
  return locator;
}

export function dragDropLocatorsFromOptions(
  options: Record<string, unknown>,
  parseJson: (value: string, fallback?: Record<string, unknown>) => Record<string, unknown>
): { from: Record<string, unknown>; to: Record<string, unknown> } {
  if (!hasLocatorOptions(options, 'from') || !hasLocatorOptions(options, 'to')) {
    throw new Error('drag-drop requires both source and target locator options');
  }
  return {
    from: locatorFromOptions(options, parseJson, 'from'),
    to: locatorFromOptions(options, parseJson, 'to')
  };
}
