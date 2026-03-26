import type { NetworkEntry } from '@flrande/bak-protocol';

const ROW_CANDIDATE_KEYS = ['data', 'rows', 'results', 'items', 'records', 'entries'] as const;
const SUMMARY_TEXT_LIMIT = 96;

function truncateSummaryText(value: string, limit = SUMMARY_TEXT_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}...`;
}

function safeParseUrl(urlText: string): URL | null {
  try {
    return new URL(urlText);
  } catch {
    try {
      return new URL(urlText, 'http://127.0.0.1');
    } catch {
      return null;
    }
  }
}

function looksLikeFormBody(value: string): boolean {
  return value.includes('=') && (value.includes('&') || !value.trim().startsWith('{'));
}

function summarizeSearchParams(params: URLSearchParams): string | undefined {
  const entries: Array<readonly [string, string]> = [];
  params.forEach((value, key) => {
    entries.push([key, value] as const);
  });
  if (entries.length === 0) {
    return undefined;
  }
  const preview = entries.slice(0, 4).map(([key, value]) => `${key}=${truncateSummaryText(value, 32)}`);
  return entries.length > 4 ? `${preview.join(', ')} ...` : preview.join(', ');
}

function summarizeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `json array(${value.length})`;
  }
  if (!value || typeof value !== 'object') {
    return `json ${truncateSummaryText(String(value), 40)}`;
  }
  const record = value as Record<string, unknown>;
  for (const key of ROW_CANDIDATE_KEYS) {
    if (Array.isArray(record[key])) {
      return `json rows(${record[key].length}) via ${key}`;
    }
  }
  const keys = Object.keys(record).slice(0, 5);
  return keys.length > 0 ? `json keys: ${keys.join(', ')}` : 'json object';
}

export function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

export function summarizeNetworkPayload(
  payload: string | undefined,
  contentType: string | undefined,
  truncated = false
): string | undefined {
  if (typeof payload !== 'string') {
    return undefined;
  }
  const trimmed = payload.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedContentType = contentType?.toLowerCase() ?? '';
  let summary: string | undefined;

  if (normalizedContentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      summary = summarizeJsonValue(JSON.parse(trimmed));
    } catch {
      summary = `json text: ${truncateSummaryText(trimmed)}`;
    }
  } else if (normalizedContentType.includes('x-www-form-urlencoded') || looksLikeFormBody(trimmed)) {
    try {
      const params = new URLSearchParams(trimmed);
      const preview = summarizeSearchParams(params);
      summary = preview ? `form: ${preview}` : 'form body';
    } catch {
      summary = `form text: ${truncateSummaryText(trimmed)}`;
    }
  } else {
    summary = `text: ${truncateSummaryText(trimmed)}`;
  }

  return truncated ? `${summary} (truncated)` : summary;
}

export function buildNetworkEntryDerivedFields(
  entry: Pick<
    NetworkEntry,
    'url' | 'requestHeaders' | 'requestBodyPreview' | 'requestBodyTruncated' | 'contentType' | 'responseBodyPreview' | 'responseBodyTruncated'
  >
): Pick<NetworkEntry, 'hostname' | 'pathname' | 'preview'> {
  const parsedUrl = safeParseUrl(entry.url);
  const preview = {
    query: parsedUrl ? summarizeSearchParams(parsedUrl.searchParams) : undefined,
    request: summarizeNetworkPayload(
      entry.requestBodyPreview,
      headerValue(entry.requestHeaders, 'content-type'),
      entry.requestBodyTruncated === true
    ),
    response: summarizeNetworkPayload(entry.responseBodyPreview, entry.contentType, entry.responseBodyTruncated === true)
  };

  return {
    hostname: parsedUrl?.hostname,
    pathname: parsedUrl?.pathname,
    preview: preview.query || preview.request || preview.response ? preview : undefined
  };
}

export function clampNetworkListLimit(limit: number | undefined, fallback = 50): number {
  return typeof limit === 'number' ? Math.max(1, Math.min(500, Math.floor(limit))) : fallback;
}

export function networkEntryMatchesFilters(
  entry: NetworkEntry,
  filters: {
    urlIncludes?: string;
    status?: number;
    method?: string;
    domain?: string;
    resourceType?: string;
    kind?: NetworkEntry['kind'];
    sinceTs?: number;
  }
): boolean {
  const urlIncludes = typeof filters.urlIncludes === 'string' ? filters.urlIncludes : '';
  const method = typeof filters.method === 'string' ? filters.method.toUpperCase() : '';
  const status = typeof filters.status === 'number' ? filters.status : undefined;
  const domain = typeof filters.domain === 'string' ? filters.domain.trim().toLowerCase() : '';
  const resourceType = typeof filters.resourceType === 'string' ? filters.resourceType.trim().toLowerCase() : '';
  const kind = typeof filters.kind === 'string' ? filters.kind : undefined;
  const sinceTs = typeof filters.sinceTs === 'number' ? filters.sinceTs : undefined;

  if (typeof sinceTs === 'number' && entry.ts < sinceTs) {
    return false;
  }
  if (urlIncludes && !entry.url.includes(urlIncludes)) {
    return false;
  }
  if (method && entry.method.toUpperCase() !== method) {
    return false;
  }
  if (typeof status === 'number' && entry.status !== status) {
    return false;
  }
  if (domain) {
    const hostname = (entry.hostname ?? safeParseUrl(entry.url)?.hostname ?? '').toLowerCase();
    if (!hostname || (!hostname.includes(domain) && hostname !== domain)) {
      return false;
    }
  }
  if (resourceType) {
    if ((entry.resourceType ?? '').toLowerCase() !== resourceType) {
      return false;
    }
  }
  if (kind && entry.kind !== kind) {
    return false;
  }
  return true;
}
