import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomToken, readEnvInt, redacted, resolveDataDir, sha1 } from './utils.js';

interface LegacyPairingState {
  token: string;
  createdAt: string;
}

interface PairTokenState {
  token: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  reason?: string;
}

interface RevokedTokenRecord {
  fingerprint: string;
  revokedAt: string;
  expiresAt?: string;
  reason?: string;
}

interface PairingStateV2 {
  version: 2;
  active: PairTokenState | null;
  revoked: RevokedTokenRecord[];
}

const DEFAULT_TTL_DAYS = readEnvInt('BAK_PAIR_TTL_DAYS', 30);

function nowMs(): number {
  return Date.now();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIso(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(state: PairTokenState): boolean {
  return parseIso(state.expiresAt) <= nowMs();
}

export class PairingStore {
  private readonly path: string;

  constructor(dataDir = resolveDataDir()) {
    this.path = join(dataDir, 'pairing.json');
  }

  private loadState(): PairingStateV2 {
    if (!existsSync(this.path)) {
      return {
        version: 2,
        active: null,
        revoked: []
      };
    }

    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as LegacyPairingState | PairingStateV2;
    if ('version' in raw && raw.version === 2) {
      return {
        version: 2,
        active: raw.active ?? null,
        revoked: Array.isArray(raw.revoked) ? raw.revoked : []
      };
    }

    const legacy = raw as LegacyPairingState;
    const createdAt = legacy.createdAt || toIso(nowMs());
    const expiresAt = toIso(parseIso(createdAt) + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
    return {
      version: 2,
      active: legacy.token
        ? {
            token: legacy.token,
            createdAt,
            expiresAt
          }
        : null,
      revoked: []
    };
  }

  private saveState(state: PairingStateV2): void {
    writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private sanitizeTtlDays(ttlDays: number): number {
    if (!Number.isInteger(ttlDays) || ttlDays <= 0) {
      throw new Error('ttlDays must be an integer > 0');
    }
    return ttlDays;
  }

  getToken(): string | null {
    const state = this.loadState();
    if (!state.active) {
      return null;
    }
    if (state.active.revokedAt || isExpired(state.active)) {
      return null;
    }
    return state.active.token;
  }

  getTokenState(): PairTokenState | null {
    const state = this.loadState();
    return state.active;
  }

  validateToken(token: string): { ok: boolean; reason?: string } {
    const state = this.loadState();
    if (!state.active?.token) {
      return { ok: false, reason: 'not-paired' };
    }
    if (token !== state.active.token) {
      return { ok: false, reason: 'token-mismatch' };
    }
    if (state.active.revokedAt) {
      return { ok: false, reason: 'token-revoked' };
    }
    if (isExpired(state.active)) {
      return { ok: false, reason: 'token-expired' };
    }
    return { ok: true };
  }

  createToken(options: { ttlDays?: number; reason?: string } = {}): { token: string; expiresAt: string; createdAt: string } {
    const ttlDays = this.sanitizeTtlDays(options.ttlDays ?? DEFAULT_TTL_DAYS);
    const state = this.loadState();

    if (state.active?.token) {
      state.revoked.unshift({
        fingerprint: sha1(state.active.token),
        revokedAt: toIso(nowMs()),
        expiresAt: state.active.expiresAt,
        reason: options.reason ?? 'rotated'
      });
    }

    const createdAt = toIso(nowMs());
    const expiresAt = toIso(nowMs() + ttlDays * 24 * 60 * 60 * 1000);
    const token = randomToken();
    state.active = {
      token,
      createdAt,
      expiresAt
    };
    state.revoked = state.revoked.slice(0, 20);
    this.saveState(state);
    return { token, createdAt, expiresAt };
  }

  revokeActive(reason = 'manual-revoke'): { revoked: boolean } {
    const state = this.loadState();
    if (!state.active?.token) {
      return { revoked: false };
    }

    state.revoked.unshift({
      fingerprint: sha1(state.active.token),
      revokedAt: toIso(nowMs()),
      expiresAt: state.active.expiresAt,
      reason
    });
    state.active = null;
    state.revoked = state.revoked.slice(0, 20);
    this.saveState(state);
    return { revoked: true };
  }

  status(): {
    paired: boolean;
    createdAt: string | null;
    expiresAt: string | null;
    expired: boolean;
    revoked: boolean;
    tokenPreview: string;
  } {
    const active = this.getTokenState();
    if (!active?.token) {
      return {
        paired: false,
        createdAt: null,
        expiresAt: null,
        expired: false,
        revoked: false,
        tokenPreview: 'not-paired'
      };
    }

    const expired = isExpired(active);
    const revoked = Boolean(active.revokedAt);
    return {
      paired: !expired && !revoked,
      createdAt: active.createdAt,
      expiresAt: active.expiresAt,
      expired,
      revoked,
      tokenPreview: redacted(active.token)
    };
  }

  requireToken(): string {
    const token = this.getToken();
    if (!token) {
      throw new Error('pair token not found, run `bak pair` first');
    }
    return token;
  }

  describe(): string {
    const status = this.status();
    return status.paired ? status.tokenPreview : 'not-paired';
  }
}
