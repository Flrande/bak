import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NetworkCloneResult } from '@flrande/bak-protocol';

const STRUCTURED_ITEM_KEYS = ['data', 'rows', 'results', 'items', 'records', 'entries'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderPowerShellCommand(argv: string[]): string {
  return ['bak', ...argv].map((part) => quotePowerShellArg(part)).join(' ');
}

function parseQueryFileEntries(rawContent: string): Array<[string, string]> {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!isRecord(parsed)) {
      throw new Error('query-file JSON must be an object');
    }
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) {
            continue;
          }
          entries.push([key, String(item)]);
        }
        continue;
      }
      entries.push([key, String(value)]);
    }
    return entries;
  }
  const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
  return [...params.entries()];
}

export function mergeQueryFileIntoUrl(urlText: string, queryFilePath?: string): string {
  if (!queryFilePath) {
    return urlText;
  }
  const raw = readFileSync(resolve(queryFilePath), 'utf8');
  const entries = parseQueryFileEntries(raw);
  const url = new URL(urlText);
  const grouped = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const existing = grouped.get(key) ?? [];
    existing.push(value);
    grouped.set(key, existing);
  }
  for (const [key, values] of grouped.entries()) {
    url.searchParams.delete(key);
    for (const value of values) {
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}

export function resolveRequestBody(body: string | undefined, bodyFilePath?: string): string | undefined {
  if (body && bodyFilePath) {
    throw new Error('body and body-file cannot be used together');
  }
  if (!bodyFilePath) {
    return body;
  }
  return readFileSync(resolve(bodyFilePath), 'utf8');
}

function parseItemsPath(path: string): Array<string | number> {
  const normalized = path.replace(/^globalThis\.?/, '').replace(/^window\.?/, '').trim();
  if (!normalized) {
    throw new Error('items-path is required');
  }
  const segments: Array<string | number> = [];
  let index = 0;
  while (index < normalized.length) {
    if (normalized[index] === '.') {
      index += 1;
      continue;
    }
    if (normalized[index] === '[') {
      const bracket = normalized.slice(index).match(/^\[(\d+)\]/);
      if (!bracket) {
        throw new Error('items-path only supports numeric bracket segments');
      }
      segments.push(Number(bracket[1]));
      index += bracket[0].length;
      continue;
    }
    const identifier = normalized.slice(index).match(/^[A-Za-z_$][\w$]*/);
    if (!identifier) {
      throw new Error(`Unsupported items-path token near: ${normalized.slice(index, index + 16)}`);
    }
    segments.push(identifier[0]);
    index += identifier[0].length;
  }
  return segments;
}

function readPathValue(input: unknown, path: string): unknown {
  let current: unknown = input;
  for (const segment of parseItemsPath(path)) {
    if (current === null || current === undefined || !(segment in Object(current))) {
      throw new Error(`items-path not found: ${path}`);
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

export function extractPaginatedItems(payload: unknown, itemsPath?: string): { items: unknown[]; source: string } {
  if (itemsPath) {
    const resolved = readPathValue(payload, itemsPath);
    if (!Array.isArray(resolved)) {
      throw new Error(`items-path did not resolve to an array: ${itemsPath}`);
    }
    return {
      items: resolved,
      source: itemsPath
    };
  }
  if (Array.isArray(payload)) {
    return {
      items: payload,
      source: '$'
    };
  }
  if (!isRecord(payload)) {
    throw new Error('Could not resolve paginated rows from the response body');
  }
  for (const key of STRUCTURED_ITEM_KEYS) {
    if (Array.isArray(payload[key])) {
      return {
        items: payload[key] as unknown[],
        source: `$.${key}`
      };
    }
  }
  throw new Error('Could not resolve paginated rows from the response body');
}

export function buildPaginatedUrl(
  urlText: string,
  pageParam: string,
  limitParam: string,
  page: number,
  pageSize: number
): string {
  const url = new URL(urlText);
  url.searchParams.set(pageParam, String(page));
  url.searchParams.set(limitParam, String(pageSize));
  return url.toString();
}

export function writeCloneArtifacts(result: NetworkCloneResult, outDir?: string): NetworkCloneResult {
  if (!outDir || !result.pageFetch || result.preferredCommand.tool !== 'page.fetch') {
    return result;
  }
  const resolvedOutDir = resolve(outDir);
  mkdirSync(resolvedOutDir, { recursive: true });
  const supportFiles: NonNullable<NetworkCloneResult['preferredCommand']['supportFiles']> = [];
  const url = new URL(result.pageFetch.url);
  const baseUrl = new URL(result.pageFetch.url);
  baseUrl.search = '';
  const argv = [
    'page',
    'fetch',
    '--url',
    baseUrl.toString(),
    '--method',
    result.pageFetch.method,
    '--auth',
    'auto',
    '--mode',
    result.pageFetch.mode ?? 'raw'
  ];

  if (url.search.length > 1) {
    const queryPath = join(resolvedOutDir, 'query.txt');
    const queryText = url.search.slice(1);
    writeFileSync(queryPath, queryText, 'utf8');
    supportFiles.push({
      kind: 'query-file',
      path: queryPath,
      bytes: Buffer.byteLength(queryText, 'utf8')
    });
    argv.push('--query-file', queryPath);
  }

  if (result.pageFetch.contentType) {
    argv.push('--content-type', result.pageFetch.contentType);
  }

  for (const [name, value] of Object.entries(result.pageFetch.headers ?? {})) {
    argv.push('--header', `${name}: ${value}`);
  }

  if (typeof result.pageFetch.body === 'string') {
    const bodyPath = join(resolvedOutDir, 'body.txt');
    writeFileSync(bodyPath, result.pageFetch.body, 'utf8');
    supportFiles.push({
      kind: 'body-file',
      path: bodyPath,
      bytes: Buffer.byteLength(result.pageFetch.body, 'utf8')
    });
    argv.push('--body-file', bodyPath);
  }

  return {
    ...result,
    preferredCommand: {
      ...result.preferredCommand,
      argv,
      powershell: renderPowerShellCommand(argv),
      supportFiles
    }
  };
}
