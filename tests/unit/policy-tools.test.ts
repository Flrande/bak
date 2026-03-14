import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluatePolicyPreview,
  loadPolicyStatus,
  readPolicyAudit,
  recommendPolicyRules
} from '../../packages/cli/src/policy-tools.js';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeTraceEntries(
  dataDir: string,
  traceId: string,
  entries: Array<{ ts: string; params: Record<string, unknown> }>
): void {
  const tracesDir = join(dataDir, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  writeFileSync(
    join(tracesDir, `${traceId}.jsonl`),
    entries
      .map((entry) =>
        JSON.stringify({
          traceId,
          ts: entry.ts,
          method: 'policy.decision',
          params: entry.params
        })
      )
      .join('\n')
      .concat('\n'),
    'utf8'
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('policy tools', () => {
  it('reports stable status when the policy file is missing', () => {
    const dataDir = makeTempDir('bak-policy-tools-status-missing-');

    const status = loadPolicyStatus(dataDir);

    expect(status).toMatchObject({
      exists: false,
      ruleCount: 0,
      defaults: {
        fileUpload: 'deny',
        payment: 'requireConfirm',
        destructive: 'requireConfirm',
        submit: 'requireConfirm',
        highRisk: 'requireConfirm',
        otherwise: 'allow'
      }
    });
    expect(status.actions).toContain('element.click');
    expect(status.tags).toContain('fileUpload');
  });

  it('reports stable status when valid and invalid rules are mixed together', () => {
    const dataDir = makeTempDir('bak-policy-tools-status-mixed-');
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          null,
          {
            id: 'broken-rule',
            action: 'not-a-real-action',
            decision: 'not-a-real-decision'
          },
          {
            id: 'confirm-upload',
            action: 'file.upload',
            decision: 'requireConfirm',
            tag: 'fileUpload'
          }
        ]
      }),
      'utf8'
    );

    const status = loadPolicyStatus(dataDir);

    expect(status.exists).toBe(true);
    expect(status.ruleCount).toBe(2);
  });

  it('evaluates preview decisions with resolved context and audit details', () => {
    const dataDir = makeTempDir('bak-policy-tools-preview-');
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'allow-upload',
            action: 'file.upload',
            domain: 'example.com',
            pathPrefix: '/upload',
            tag: 'fileUpload',
            decision: 'allow',
            reason: 'trusted upload path'
          }
        ]
      }),
      'utf8'
    );

    const result = evaluatePolicyPreview(dataDir, {
      action: 'file.upload',
      domain: 'example.com',
      path: '/upload',
      locator: { css: 'input[type="file"]', name: 'Upload invoice' },
      contextSource: 'explicit'
    });

    expect(result.resolvedContext).toMatchObject({
      action: 'file.upload',
      domain: 'example.com',
      path: '/upload',
      contextSource: 'explicit'
    });
    expect(result.decision).toMatchObject({
      decision: 'allow',
      ruleId: 'allow-upload',
      source: 'rule'
    });
    expect(result.audit.defaultDecision).toBe('deny');
    expect(result.audit.tags).toContain('fileUpload');
  });

  it('reads policy audit entries and summarizes them', () => {
    const dataDir = makeTempDir('bak-policy-tools-audit-');
    writeTraceEntries(dataDir, 'trace-alpha', [
      {
        ts: '2026-03-14T10:00:00.000Z',
        params: {
          action: 'element.click',
          decision: 'deny',
          reason: 'test deny',
          source: 'rule',
          ruleId: 'deny-cancel',
          domain: '127.0.0.1',
          path: '/form.html',
          tags: ['destructive'],
          matchedRuleCount: 1,
          defaultDecision: 'requireConfirm'
        }
      }
    ]);
    writeTraceEntries(dataDir, 'trace-beta', [
      {
        ts: '2026-03-14T11:00:00.000Z',
        params: {
          action: 'file.upload',
          decision: 'allow',
          reason: 'trusted upload',
          source: 'rule',
          ruleId: 'allow-upload',
          domain: '127.0.0.1',
          path: '/upload.html',
          tags: ['fileUpload'],
          matchedRuleCount: 1,
          defaultDecision: 'deny'
        }
      }
    ]);

    const audit = readPolicyAudit(dataDir, { limit: 50 });

    expect(audit.summary).toEqual({
      total: 2,
      byDecision: {
        allow: 1,
        deny: 1
      },
      byAction: {
        'element.click': 1,
        'file.upload': 1
      },
      bySource: {
        rule: 2
      }
    });
    expect(audit.entries[0]).toMatchObject({
      traceId: 'trace-beta',
      action: 'file.upload',
      decision: 'allow'
    });
  });

  it('does not create a traces directory when audit reads an empty data dir', () => {
    const dataDir = makeTempDir('bak-policy-tools-audit-empty-');

    const audit = readPolicyAudit(dataDir, { limit: 10 });

    expect(audit).toEqual({
      summary: {
        total: 0,
        byDecision: {},
        byAction: {},
        bySource: {}
      },
      entries: []
    });
    expect(existsSync(join(dataDir, 'traces'))).toBe(false);
  });

  it('recommends conservative rules only from repeated default deny and requireConfirm decisions', () => {
    const dataDir = makeTempDir('bak-policy-tools-recommend-');
    writeTraceEntries(dataDir, 'trace-one', [
      {
        ts: '2026-03-14T09:00:00.000Z',
        params: {
          action: 'element.click',
          decision: 'deny',
          reason: 'file upload is denied by default policy',
          source: 'default',
          ruleId: null,
          domain: '127.0.0.1',
          path: '/upload.html',
          tags: ['fileUpload', 'highRisk'],
          matchedRuleCount: 0,
          defaultDecision: 'deny'
        }
      }
    ]);
    writeTraceEntries(dataDir, 'trace-two', [
      {
        ts: '2026-03-14T10:00:00.000Z',
        params: {
          action: 'element.click',
          decision: 'deny',
          reason: 'file upload is denied by default policy',
          source: 'default',
          ruleId: null,
          domain: '127.0.0.1',
          path: '/upload.html',
          tags: ['fileUpload'],
          matchedRuleCount: 0,
          defaultDecision: 'deny'
        }
      },
      {
        ts: '2026-03-14T10:30:00.000Z',
        params: {
          action: 'element.click',
          decision: 'allow',
          reason: 'no blocking policy matched',
          source: 'default',
          ruleId: null,
          domain: '127.0.0.1',
          path: '/other.html',
          tags: [],
          matchedRuleCount: 0,
          defaultDecision: 'allow'
        }
      },
      {
        ts: '2026-03-14T10:45:00.000Z',
        params: {
          action: 'element.click',
          decision: 'deny',
          reason: 'explicit deny rule',
          source: 'rule',
          ruleId: 'manual-deny',
          domain: '127.0.0.1',
          path: '/upload.html',
          tags: ['fileUpload'],
          matchedRuleCount: 1,
          defaultDecision: 'deny'
        }
      }
    ]);

    const result = recommendPolicyRules(dataDir, { minOccurrences: 2 });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      rule: {
        id: 'trace-deny-element-click-127-0-0-1-upload-html-fileupload',
        action: 'element.click',
        decision: 'deny',
        domain: '127.0.0.1',
        pathPrefix: '/upload.html',
        tag: 'fileUpload'
      },
      basis: {
        occurrenceCount: 2,
        decision: 'deny',
        action: 'element.click',
        domain: '127.0.0.1',
        path: '/upload.html',
        tag: 'fileUpload',
        traceIds: ['trace-two', 'trace-one']
      }
    });
    expect(result.suggestions[0].rule.reason).toContain('trace-derived suggestion');
    expect(result.suggestions[0].examples).toHaveLength(2);
  });
});
