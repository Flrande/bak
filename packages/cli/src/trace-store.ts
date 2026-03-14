import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, id, nowIso, resolveDataDir } from './utils.js';

export interface TraceEntry {
  traceId: string;
  ts: string;
  method: string;
  params: unknown;
  result?: unknown;
  error?: unknown;
}

export class TraceStore {
  private readonly traceDir: string;

  constructor(dataDir = resolveDataDir()) {
    this.traceDir = join(dataDir, 'traces');
  }

  newTraceId(): string {
    return id('trace');
  }

  append(traceId: string, payload: Omit<TraceEntry, 'traceId' | 'ts'>): void {
    ensureDir(this.traceDir);
    const line = JSON.stringify({
      traceId,
      ts: nowIso(),
      ...payload
    });
    appendFileSync(join(this.traceDir, `${traceId}.jsonl`), `${line}\n`, 'utf8');
  }

  getTracePath(traceId: string): string {
    return join(this.traceDir, `${traceId}.jsonl`);
  }

  listTraceIds(): string[] {
    if (!existsSync(this.traceDir)) {
      return [];
    }
    return readdirSync(this.traceDir)
      .filter((item) => item.endsWith('.jsonl'))
      .map((item) => item.replace(/\.jsonl$/, ''));
  }

  readTrace(traceId: string): TraceEntry[] {
    const file = this.getTracePath(traceId);
    if (!existsSync(file)) {
      return [];
    }
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEntry);
  }

  export(traceId: string): { tracePath: string } {
    const tracePath = this.getTracePath(traceId);
    return { tracePath };
  }
}
