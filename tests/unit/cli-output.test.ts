import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFetchLikeArtifact } from '../../packages/cli/src/program.js';

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

describe('fetch output artifacts', () => {
  it('writes the unwrapped JSON body for page.fetch envelopes', () => {
    const dir = tempDir('bak-cli-fetch-json-');
    const outPath = join(dir, 'response.json');

    const artifact = writeFetchLikeArtifact(outPath, {
      scope: 'current',
      result: {
        url: 'https://example.test/frame',
        framePath: [],
        value: {
          url: 'https://example.test/api/data',
          status: 200,
          ok: true,
          headers: {
            'content-type': 'application/json'
          },
          contentType: 'application/json',
          json: {
            rows: [
              { symbol: 'QQQ', premium: 125000 }
            ]
          },
          bytes: 128,
          truncated: false
        }
      }
    });

    expect(artifact.format).toBe('json');
    expect(artifact.response?.status).toBe(200);
    expect(artifact.scope).toBe('current');
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual({
      rows: [
        { symbol: 'QQQ', premium: 125000 }
      ]
    });
  });

  it('writes the full raw body text for replay responses', () => {
    const dir = tempDir('bak-cli-fetch-raw-');
    const outPath = join(dir, 'response.txt');
    const bodyText = 'full replay body that should be written verbatim';

    const artifact = writeFetchLikeArtifact(outPath, {
      url: 'https://example.test/api/raw',
      status: 200,
      ok: true,
      headers: {
        'content-type': 'text/plain'
      },
      contentType: 'text/plain',
      bodyText,
      bytes: bodyText.length,
      truncated: false
    });

    expect(artifact.format).toBe('text');
    expect(artifact.response?.contentType).toBe('text/plain');
    expect(readFileSync(outPath, 'utf8')).toBe(bodyText);
  });
});
