import type { NetworkEntry } from '@flrande/bak-protocol';
import { redactHeaderMap, redactTransportText } from './privacy.js';
import { EXTENSION_VERSION } from './version.js';

const DEBUGGER_VERSION = '1.3';
const MAX_ENTRIES = 1000;
const DEFAULT_BODY_BYTES = 8 * 1024;
const DEFAULT_TOTAL_BODY_BYTES = 256 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface DebuggerTarget {
  tabId: number;
}

interface TabCaptureState {
  attached: boolean;
  attachError: string | null;
  entries: NetworkEntry[];
  entriesById: Map<string, NetworkEntry>;
  requestIdToEntryId: Map<string, string>;
  lastTouchedAt: number;
}

const captures = new Map<number, TabCaptureState>();

function getState(tabId: number): TabCaptureState {
  const existing = captures.get(tabId);
  if (existing) {
    return existing;
  }
  const created: TabCaptureState = {
    attached: false,
    attachError: null,
    entries: [],
    entriesById: new Map(),
    requestIdToEntryId: new Map(),
    lastTouchedAt: Date.now()
  };
  captures.set(tabId, created);
  return created;
}

function debuggerTarget(tabId: number): DebuggerTarget {
  return { tabId };
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function truncateUtf8(value: string, limit: number): string {
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= limit) {
    return value;
  }
  return textDecoder.decode(encoded.subarray(0, limit));
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return textDecoder.decode(bytes);
}

function truncateText(value: string | undefined, limit = DEFAULT_BODY_BYTES): { text?: string; truncated: boolean; bytes?: number } {
  if (typeof value !== 'string') {
    return { truncated: false };
  }
  const bytes = utf8ByteLength(value);
  if (bytes <= limit) {
    return { text: value, truncated: false, bytes };
  }
  const truncatedText = truncateUtf8(value, limit);
  return { text: truncatedText, truncated: true, bytes };
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    result[String(key)] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return true;
  }
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('javascript') ||
    normalized.includes('xml') ||
    normalized.includes('html') ||
    normalized.includes('urlencoded') ||
    normalized.includes('graphql')
  );
}

function pushEntry(state: TabCaptureState, entry: NetworkEntry, requestId: string): void {
  state.entries.push(entry);
  state.entriesById.set(entry.id, entry);
  state.requestIdToEntryId.set(requestId, entry.id);
  state.lastTouchedAt = Date.now();
  while (state.entries.length > MAX_ENTRIES) {
    const removed = state.entries.shift();
    if (!removed) {
      break;
    }
    state.entriesById.delete(removed.id);
  }
}

function entryForRequest(tabId: number, requestId: string): NetworkEntry | null {
  const state = captures.get(tabId);
  if (!state) {
    return null;
  }
  const entryId = state.requestIdToEntryId.get(requestId);
  if (!entryId) {
    return null;
  }
  return state.entriesById.get(entryId) ?? null;
}

async function sendDebuggerCommand<T = unknown>(tabId: number, method: string, commandParams?: Record<string, unknown>): Promise<T> {
  return (await chrome.debugger.sendCommand(debuggerTarget(tabId), method, commandParams)) as T;
}

async function getResponseBodyPreview(tabId: number, requestId: string, contentType: string | undefined): Promise<{
  responseBodyPreview?: string;
  responseBodyTruncated?: boolean;
  binary?: boolean;
}> {
  try {
    const response = (await sendDebuggerCommand<{
      body?: string;
      base64Encoded?: boolean;
    }>(tabId, 'Network.getResponseBody', { requestId })) ?? { body: '' };
    const rawBody = typeof response.body === 'string' ? response.body : '';
    const base64Encoded = response.base64Encoded === true;
    const binary = base64Encoded && !isTextualContentType(contentType);
    if (binary) {
      return { binary: true };
    }
    const decoded = base64Encoded ? decodeBase64Utf8(rawBody) : rawBody;
    const preview = truncateText(decoded, DEFAULT_BODY_BYTES);
    return {
      responseBodyPreview: preview.text ? redactTransportText(preview.text) : undefined,
      responseBodyTruncated: preview.truncated
    };
  } catch (error) {
    const entry = entryForRequest(tabId, requestId);
    if (entry) {
      entry.failureReason = error instanceof Error ? error.message : String(error);
    }
    return {};
  }
}

async function handleLoadingFinished(tabId: number, params: Record<string, unknown>): Promise<void> {
  const requestId = String(params.requestId ?? '');
  const entry = entryForRequest(tabId, requestId);
  if (!entry) {
    return;
  }
  entry.durationMs = entry.startedAt ? Math.max(0, Date.now() - entry.startedAt) : entry.durationMs;
  if (typeof params.encodedDataLength === 'number') {
    entry.responseBytes = Math.max(0, Math.round(params.encodedDataLength));
  }
  const body = await getResponseBodyPreview(tabId, requestId, entry.contentType);
  Object.assign(entry, body);
  if ((entry.requestBytes ?? 0) + (entry.responseBytes ?? 0) > DEFAULT_TOTAL_BODY_BYTES) {
    entry.truncated = true;
  }
}

function upsertRequest(tabId: number, params: Record<string, unknown>): void {
  const state = getState(tabId);
  const requestId = String(params.requestId ?? '');
  if (!requestId) {
    return;
  }
  const request = typeof params.request === 'object' && params.request !== null ? (params.request as Record<string, unknown>) : {};
  const headers = redactHeaderMap(normalizeHeaders(request.headers));
  const truncatedRequest = truncateText(typeof request.postData === 'string' ? request.postData : undefined, DEFAULT_BODY_BYTES);
  const entry: NetworkEntry = {
    id: `net_${tabId}_${requestId}`,
    url: typeof request.url === 'string' ? request.url : '',
    method: typeof request.method === 'string' ? request.method : 'GET',
    status: 0,
    ok: false,
    kind:
      params.type === 'XHR'
        ? 'xhr'
        : params.type === 'Fetch'
          ? 'fetch'
          : params.type === 'Document'
            ? 'navigation'
            : 'resource',
    resourceType: typeof params.type === 'string' ? String(params.type) : undefined,
    ts: Date.now(),
    startedAt: Date.now(),
    durationMs: 0,
    requestBytes: truncatedRequest.bytes,
    requestHeaders: headers,
    requestBodyPreview: truncatedRequest.text ? redactTransportText(truncatedRequest.text) : undefined,
    requestBodyTruncated: truncatedRequest.truncated,
    initiatorUrl:
      typeof params.initiator === 'object' &&
      params.initiator !== null &&
      typeof (params.initiator as Record<string, unknown>).url === 'string'
        ? String((params.initiator as Record<string, unknown>).url)
        : undefined,
    tabId,
    source: 'debugger'
  };
  pushEntry(state, entry, requestId);
}

function updateResponse(tabId: number, params: Record<string, unknown>): void {
  const requestId = String(params.requestId ?? '');
  const entry = entryForRequest(tabId, requestId);
  if (!entry) {
    return;
  }
  const response = typeof params.response === 'object' && params.response !== null ? (params.response as Record<string, unknown>) : {};
  const responseHeaders = redactHeaderMap(normalizeHeaders(response.headers));
  entry.status = typeof response.status === 'number' ? Math.round(response.status) : entry.status;
  entry.ok = entry.status >= 200 && entry.status < 400;
  entry.contentType =
    typeof response.mimeType === 'string'
      ? response.mimeType
      : headerValue(responseHeaders, 'content-type');
  entry.responseHeaders = responseHeaders;
  if (typeof response.encodedDataLength === 'number') {
    entry.responseBytes = Math.max(0, Math.round(response.encodedDataLength));
  }
}

function updateFailure(tabId: number, params: Record<string, unknown>): void {
  const requestId = String(params.requestId ?? '');
  const entry = entryForRequest(tabId, requestId);
  if (!entry) {
    return;
  }
  entry.ok = false;
  entry.failureReason = typeof params.errorText === 'string' ? params.errorText : 'loading failed';
  entry.durationMs = entry.startedAt ? Math.max(0, Date.now() - entry.startedAt) : entry.durationMs;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = typeof source.tabId === 'number' ? source.tabId : undefined;
  if (typeof tabId !== 'number') {
    return;
  }
  const payload = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (method === 'Network.requestWillBeSent') {
    upsertRequest(tabId, payload);
    return;
  }
  if (method === 'Network.responseReceived') {
    updateResponse(tabId, payload);
    return;
  }
  if (method === 'Network.loadingFailed') {
    updateFailure(tabId, payload);
    return;
  }
  if (method === 'Network.loadingFinished') {
    void handleLoadingFinished(tabId, payload);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = typeof source.tabId === 'number' ? source.tabId : undefined;
  if (typeof tabId !== 'number') {
    return;
  }
  const state = getState(tabId);
  state.attached = false;
  state.attachError = reason;
});

export async function ensureNetworkDebugger(tabId: number): Promise<void> {
  const state = getState(tabId);
  if (state.attached) {
    return;
  }
  try {
    await chrome.debugger.attach(debuggerTarget(tabId), DEBUGGER_VERSION);
  } catch (error) {
    state.attachError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  await sendDebuggerCommand(tabId, 'Network.enable');
  state.attached = true;
  state.attachError = null;
}

export function networkDebuggerStatus(tabId: number): { attached: boolean; attachError: string | null } {
  const state = getState(tabId);
  return {
    attached: state.attached,
    attachError: state.attachError
  };
}

export function clearNetworkEntries(tabId: number): void {
  const state = getState(tabId);
  state.entries = [];
  state.entriesById.clear();
  state.requestIdToEntryId.clear();
  state.lastTouchedAt = Date.now();
}

function entryMatchesFilters(
  entry: NetworkEntry,
  filters: {
    urlIncludes?: string;
    status?: number;
    method?: string;
  }
): boolean {
  const urlIncludes = typeof filters.urlIncludes === 'string' ? filters.urlIncludes : '';
  const method = typeof filters.method === 'string' ? filters.method.toUpperCase() : '';
  const status = typeof filters.status === 'number' ? filters.status : undefined;

  if (urlIncludes && !entry.url.includes(urlIncludes)) {
    return false;
  }
  if (method && entry.method.toUpperCase() !== method) {
    return false;
  }
  if (typeof status === 'number' && entry.status !== status) {
    return false;
  }
  return true;
}

export function listNetworkEntries(
  tabId: number,
  filters: {
    limit?: number;
    urlIncludes?: string;
    status?: number;
    method?: string;
  } = {}
): NetworkEntry[] {
  const state = getState(tabId);
  const limit = typeof filters.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(filters.limit))) : 50;

  return state.entries
    .filter((entry) => entryMatchesFilters(entry, filters))
    .slice(-limit)
    .reverse()
    .map((entry) => ({ ...entry }));
}

export function getNetworkEntry(tabId: number, id: string): NetworkEntry | null {
  const state = getState(tabId);
  const entry = state.entriesById.get(id);
  return entry ? { ...entry } : null;
}

export async function waitForNetworkEntry(
  tabId: number,
  filters: {
    limit?: number;
    urlIncludes?: string;
    status?: number;
    method?: string;
    timeoutMs?: number;
  } = {}
): Promise<NetworkEntry> {
  const timeoutMs = typeof filters.timeoutMs === 'number' ? Math.max(1, Math.floor(filters.timeoutMs)) : 5000;
  const deadline = Date.now() + timeoutMs;
  const state = getState(tabId);
  const seenIds = new Set(state.entries.filter((entry) => entryMatchesFilters(entry, filters)).map((entry) => entry.id));
  while (Date.now() < deadline) {
    const nextState = getState(tabId);
    const matched = nextState.entries.find((entry) => !seenIds.has(entry.id) && entryMatchesFilters(entry, filters));
    if (matched) {
      return { ...matched };
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw {
    code: 'E_TIMEOUT',
    message: 'network.waitFor timeout'
  };
}

export function searchNetworkEntries(tabId: number, pattern: string, limit = 50): NetworkEntry[] {
  const normalized = pattern.toLowerCase();
  return listNetworkEntries(tabId, { limit: Math.max(limit, 1) }).filter((entry) => {
    const headerText = JSON.stringify({
      requestHeaders: entry.requestHeaders,
      responseHeaders: entry.responseHeaders
    }).toLowerCase();
    return (
      entry.url.toLowerCase().includes(normalized) ||
      (entry.requestBodyPreview ?? '').toLowerCase().includes(normalized) ||
      (entry.responseBodyPreview ?? '').toLowerCase().includes(normalized) ||
      headerText.includes(normalized)
    );
  });
}

export function latestNetworkTimestamp(tabId: number): number | null {
  const entries = listNetworkEntries(tabId, { limit: MAX_ENTRIES });
  return entries.length > 0 ? entries[0]!.ts : null;
}

export function recentNetworkSampleIds(tabId: number, limit = 5): string[] {
  return listNetworkEntries(tabId, { limit }).map((entry) => entry.id);
}

export function exportHar(tabId: number, limit = MAX_ENTRIES): Record<string, unknown> {
  const entries = listNetworkEntries(tabId, { limit }).reverse();
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'bak',
        version: EXTENSION_VERSION
      },
      entries: entries.map((entry) => ({
        startedDateTime: new Date(entry.startedAt ?? entry.ts).toISOString(),
        time: entry.durationMs,
        request: {
          method: entry.method,
          url: entry.url,
          headers: Object.entries(entry.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
          postData:
            typeof entry.requestBodyPreview === 'string'
              ? {
                  mimeType: headerValue(entry.requestHeaders, 'content-type') ?? '',
                  text: entry.requestBodyPreview
                }
              : undefined,
          headersSize: -1,
          bodySize: entry.requestBytes ?? -1
        },
        response: {
          status: entry.status,
          statusText: entry.ok ? 'OK' : entry.failureReason ?? '',
          headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
          content: {
            mimeType: entry.contentType ?? '',
            size: entry.responseBytes ?? -1,
            text: entry.binary ? undefined : entry.responseBodyPreview,
            comment: entry.binary ? 'binary body omitted' : undefined
          },
          headersSize: -1,
          bodySize: entry.responseBytes ?? -1
        },
        cache: {},
        timings: {
          send: 0,
          wait: entry.durationMs,
          receive: 0
        },
        _bak: entry
      }))
    }
  };
}

export function dropNetworkCapture(tabId: number): void {
  captures.delete(tabId);
}
