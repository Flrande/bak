import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STATUS_PATH = resolve(process.cwd(), 'test-results', 'method-status.json');

type MethodStatusMap = Record<string, 'Passed'>;

function readStatusMap(): MethodStatusMap {
  if (!existsSync(STATUS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as MethodStatusMap;
  } catch {
    return {};
  }
}

function writeStatusMap(statusMap: MethodStatusMap): void {
  mkdirSync(dirname(STATUS_PATH), { recursive: true });
  writeFileSync(STATUS_PATH, `${JSON.stringify(statusMap, null, 2)}\n`, 'utf8');
}

export function methodStatusPath(): string {
  return STATUS_PATH;
}

export function markMethodInvoked(method: string): void {
  const normalized = method.trim();
  if (!normalized) {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const statusMap = readStatusMap();
      if (statusMap[normalized] === 'Passed') {
        return;
      }
      statusMap[normalized] = 'Passed';
      writeStatusMap(statusMap);
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
    }
  }
}
