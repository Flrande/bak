import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';

describe('PairingStore token lifecycle', () => {
  it('creates active token with ttl metadata', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-pairing-create-'));
    const store = new PairingStore(dataDir);
    const created = store.createToken({ ttlDays: 5 });

    expect(created.token.length).toBeGreaterThan(20);
    expect(store.getToken()).toBe(created.token);
    expect(store.status().paired).toBe(true);
    expect(store.status().expiresAt).toBeTruthy();

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('revokes active token', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-pairing-revoke-'));
    const store = new PairingStore(dataDir);
    store.createToken({ ttlDays: 5 });

    const revoked = store.revokeActive('test-revoke');
    expect(revoked.revoked).toBe(true);
    expect(store.getToken()).toBeNull();
    expect(store.status().paired).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('treats expired tokens as invalid', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-pairing-expire-'));
    const store = new PairingStore(dataDir);
    const created = store.createToken({ ttlDays: 1 });
    const pairingPath = join(dataDir, 'pairing.json');

    const raw = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      version: number;
      active: { token: string; createdAt: string; expiresAt: string };
      revoked: unknown[];
    };
    raw.active.expiresAt = new Date(Date.now() - 5_000).toISOString();
    writeFileSync(pairingPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const reloaded = new PairingStore(dataDir);
    expect(reloaded.getToken()).toBeNull();
    expect(reloaded.validateToken(created.token).ok).toBe(false);
    expect(reloaded.status().expired).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });
});
