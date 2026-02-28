import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomToken, redacted, resolveDataDir } from './utils.js';

interface PairingState {
  token: string;
  createdAt: string;
}

export class PairingStore {
  private readonly path: string;

  constructor(dataDir = resolveDataDir()) {
    this.path = join(dataDir, 'pairing.json');
  }

  getToken(): string | null {
    if (!existsSync(this.path)) {
      return null;
    }
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as PairingState;
    return raw.token;
  }

  createToken(): string {
    const token = randomToken();
    const state: PairingState = {
      token,
      createdAt: new Date().toISOString()
    };
    writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return token;
  }

  requireToken(): string {
    const token = this.getToken();
    if (!token) {
      throw new Error('pair token not found, run `bak pair` first');
    }
    return token;
  }

  describe(): string {
    const token = this.getToken();
    return token ? redacted(token) : 'not-paired';
  }
}
