import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type MethodStatusMap = Record<string, 'Passed'>;

function readStatusMap(path: string): MethodStatusMap {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MethodStatusMap;
  } catch {
    return {};
  }
}

function writeStatusMap(path: string, statusMap: MethodStatusMap): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(statusMap, null, 2)}\n`, 'utf8');
}

export function markRpcMethodInvoked(method: string): void {
  const statusPath = process.env.BAK_E2E_METHOD_STATUS_PATH;
  if (!statusPath) {
    return;
  }
  const normalized = method.trim();
  if (!normalized) {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const statusMap = readStatusMap(statusPath);
      if (statusMap[normalized] === 'Passed') {
        return;
      }
      statusMap[normalized] = 'Passed';
      writeStatusMap(statusPath, statusMap);
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
    }
  }
}
