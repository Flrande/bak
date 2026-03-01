import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PolicyEngine, detectPolicyTags } from '../../packages/cli/src/policy.js';

describe('policy matcher', () => {
  it('denies file upload by default', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-default-'));
    const engine = new PolicyEngine(dataDir);
    const decision = engine.evaluate({
      action: 'element.click',
      domain: 'example.com',
      path: '/upload',
      locator: { css: 'input[type="file"]' }
    });

    expect(decision.decision).toBe('deny');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires confirm for destructive submit actions by default', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-highrisk-'));
    const engine = new PolicyEngine(dataDir);
    const decision = engine.evaluate({
      action: 'element.click',
      domain: 'example.com',
      path: '/settings',
      locator: { name: 'Delete account and submit' }
    });

    expect(decision.decision).toBe('requireConfirm');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('applies allow rule from policy file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-rule-'));
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'allow-example-upload',
            action: 'element.click',
            domain: 'example.com',
            tag: 'fileUpload',
            decision: 'allow',
            reason: 'trusted upload flow'
          }
        ]
      }),
      'utf8'
    );

    const engine = new PolicyEngine(dataDir);
    const decision = engine.evaluate({
      action: 'element.click',
      domain: 'example.com',
      path: '/upload',
      locator: { css: 'input[type="file"]', name: 'Upload invoice' }
    });

    expect(decision.decision).toBe('allow');
    expect(decision.ruleId).toBe('allow-example-upload');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('detectPolicyTags marks risk categories', () => {
    const tags = detectPolicyTags({
      name: 'Send payment now',
      text: 'Delete old card',
      css: 'button.submit-danger'
    });

    expect(tags).toContain('payment');
    expect(tags).toContain('destructive');
    expect(tags).toContain('submit');
    expect(tags).toContain('highRisk');
  });

  it('prefers deny over allow when both rules match', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-priority-'));
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'allow-upload',
            action: 'element.click',
            domain: 'example.com',
            tag: 'fileUpload',
            decision: 'allow'
          },
          {
            id: 'deny-upload',
            action: 'element.click',
            domain: 'example.com',
            tag: 'fileUpload',
            decision: 'deny'
          }
        ]
      }),
      'utf8'
    );

    const engine = new PolicyEngine(dataDir);
    const decision = engine.evaluate({
      action: 'element.click',
      domain: 'example.com',
      path: '/upload',
      locator: { css: 'input[type="file"]', name: 'Upload file' }
    });

    expect(decision.decision).toBe('deny');
    expect(decision.ruleId).toBe('deny-upload');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('supports wildcard domain and pathPrefix rule matching', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-wildcard-'));
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'confirm-billing',
            action: 'element.click',
            domain: '*.example.com',
            pathPrefix: '/billing',
            decision: 'requireConfirm'
          }
        ]
      }),
      'utf8'
    );

    const engine = new PolicyEngine(dataDir);
    const decision = engine.evaluate({
      action: 'element.click',
      domain: 'portal.example.com',
      path: '/billing/invoices',
      locator: { name: 'Open invoice' }
    });

    expect(decision.decision).toBe('requireConfirm');
    expect(decision.ruleId).toBe('confirm-billing');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns audit summary with matched rules and fallback decision', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-audit-'));
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'confirm-destructive',
            action: 'element.click',
            domain: 'example.com',
            tag: 'destructive',
            decision: 'requireConfirm'
          },
          {
            id: 'deny-destructive',
            action: 'element.click',
            domain: 'example.com',
            tag: 'destructive',
            decision: 'deny'
          }
        ]
      }),
      'utf8'
    );

    const engine = new PolicyEngine(dataDir);
    const evaluation = engine.evaluateWithAudit({
      action: 'element.click',
      domain: 'example.com',
      path: '/settings',
      locator: { name: 'Delete account' }
    });

    expect(evaluation.decision.decision).toBe('deny');
    expect(evaluation.audit.matchedRules.length).toBe(2);
    expect(evaluation.audit.defaultDecision).toBe('requireConfirm');
    expect(evaluation.audit.tags).toContain('destructive');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ignores invalid locatorPattern regex and falls back to default decision', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-policy-invalid-regex-'));
    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'broken-regex-rule',
            action: 'element.click',
            domain: 'example.com',
            locatorPattern: '[',
            decision: 'allow'
          }
        ]
      }),
      'utf8'
    );

    const engine = new PolicyEngine(dataDir);
    const decision = engine.evaluate({
      action: 'element.click',
      domain: 'example.com',
      path: '/upload',
      locator: { css: 'input[type="file"]' }
    });

    expect(decision.source).toBe('default');
    expect(decision.decision).toBe('deny');
    rmSync(dataDir, { recursive: true, force: true });
  });
});
