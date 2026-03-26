import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkCloneResult } from '../../packages/protocol/src/types.js';
import {
  buildPaginatedUrl,
  extractPaginatedItems,
  mergeQueryFileIntoUrl,
  resolveRequestBody,
  writeCloneArtifacts
} from '../../packages/cli/src/fetch-tools.js';

const createdDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('fetch tools', () => {
  it('merges query-file JSON values into the request URL', () => {
    const dir = tempDir('bak-query-json-');
    const queryPath = join(dir, 'query.json');
    writeFileSync(queryPath, JSON.stringify({ symbol: 'QQQ', page: 3, filter: ['uoa', 'flow'] }), 'utf8');

    const merged = new URL(mergeQueryFileIntoUrl('https://example.test/api/data?symbol=SPY', queryPath));
    expect(merged.searchParams.get('symbol')).toBe('QQQ');
    expect(merged.searchParams.get('page')).toBe('3');
    expect(merged.searchParams.getAll('filter')).toEqual(['uoa', 'flow']);
  });

  it('loads body text from body-file and rejects conflicting inline body', () => {
    const dir = tempDir('bak-body-file-');
    const bodyPath = join(dir, 'body.txt');
    writeFileSync(bodyPath, '{"hello":"world"}', 'utf8');

    expect(resolveRequestBody(undefined, bodyPath)).toBe('{"hello":"world"}');
    expect(() => resolveRequestBody('inline', bodyPath)).toThrow(/body and body-file/i);
  });

  it('extracts paginated items from heuristics or explicit items-path', () => {
    expect(extractPaginatedItems({ rows: [{ id: 1 }, { id: 2 }] }).items).toHaveLength(2);
    expect(extractPaginatedItems({ data: { items: [{ id: 9 }] } }, 'data.items').items).toEqual([{ id: 9 }]);
  });

  it('rewrites clone commands to use query/body support files', () => {
    const dir = tempDir('bak-clone-artifacts-');
    const clone: NetworkCloneResult = {
      request: {
        id: 'net_1',
        url: 'https://example.test/api/data?symbol=QQQ&page=1',
        method: 'POST',
        kind: 'fetch',
        contentType: 'application/json',
        sameOrigin: true,
        bodyPresent: true,
        bodyTruncated: false
      },
      cloneable: true,
      preferredCommand: {
        tool: 'page.fetch',
        argv: ['page', 'fetch'],
        powershell: "bak 'page' 'fetch'"
      },
      pageFetch: {
        url: 'https://example.test/api/data?symbol=QQQ&page=1',
        method: 'POST',
        headers: {
          Accept: 'application/json'
        },
        body: '{"hello":"world"}',
        contentType: 'application/json',
        auth: 'auto'
      },
      notes: []
    };

    const written = writeCloneArtifacts(clone, dir);
    expect(written.preferredCommand.argv).toContain('--query-file');
    expect(written.preferredCommand.argv).toContain('--body-file');
    const queryFile = written.preferredCommand.supportFiles?.find((file) => file.kind === 'query-file');
    const bodyFile = written.preferredCommand.supportFiles?.find((file) => file.kind === 'body-file');
    expect(queryFile?.path).toBeTruthy();
    expect(bodyFile?.path).toBeTruthy();
    expect(readFileSync(queryFile!.path, 'utf8')).toBe('symbol=QQQ&page=1');
    expect(readFileSync(bodyFile!.path, 'utf8')).toBe('{"hello":"world"}');
  });

  it('builds paginated URLs with page and limit parameters', () => {
    const url = new URL(buildPaginatedUrl('https://example.test/api/rows?symbol=QQQ', 'page', 'limit', 4, 250));
    expect(url.searchParams.get('symbol')).toBe('QQQ');
    expect(url.searchParams.get('page')).toBe('4');
    expect(url.searchParams.get('limit')).toBe('250');
  });
});
