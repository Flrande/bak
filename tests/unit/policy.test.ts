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
});
