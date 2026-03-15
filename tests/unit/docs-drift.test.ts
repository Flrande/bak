import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');

const docFiles = [
  'docs/user/cli-guide.md',
  'docs/user/quickstart.md',
  'docs/user/agent-prompts.md'
];

const skillFiles = [
  'skills/bak-browser-control/SKILL.md',
  'skills/bak-browser-control/agents/openai.yaml',
  'skills/bak-browser-control/references/commands.md'
];

function readCombined(paths: string[]): string {
  return paths.map((filePath) => readFileSync(resolve(repoRoot, filePath), 'utf8')).join('\n');
}

describe('docs and skills contract drift', () => {
  it('keeps user docs aligned with verify-first and table-id guidance', () => {
    const docs = readCombined(docFiles);

    expect(docs).toContain('page verify');
    expect(docs).toContain('--max-chunks');
    expect(docs).toContain('--chunk-size');
    expect(docs).toContain('--auth auto');
    expect(docs).toContain('html:1');
    expect(docs).not.toContain('table-1');
  });

  it('keeps the bak-browser-control skill aligned with the same command contract', () => {
    const skills = readCombined(skillFiles);

    expect(skills).toContain('page verify');
    expect(skills).toContain('--max-chunks');
    expect(skills).toContain('--chunk-size');
    expect(skills).toContain('--auth auto');
    expect(skills).toContain('html:1');
    expect(skills).not.toContain('table-1');
  });
});
