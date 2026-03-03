#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { callRpc } from './rpc/client.js';
import { startBakDaemon } from './server.js';
import { runGc } from './gc.js';
import { runDoctor } from './doctor.js';
import { exportDiagnosticZip } from './diagnostic-export.js';
import { createMemoryStoreResolved, exportMemory, migrateMemoryJsonToSqlite, resolveMemoryBackend } from './memory/factory.js';
import { PairingStore } from './pairing-store.js';
import { readEnvInt, resolveDataDir } from './utils.js';

const DEFAULT_PORT = readEnvInt('BAK_PORT', 17373);
const DEFAULT_RPC_PORT = readEnvInt('BAK_RPC_WS_PORT', DEFAULT_PORT + 1);
const DEFAULT_PAIR_TTL_DAYS = readEnvInt('BAK_PAIR_TTL_DAYS', 30);

function parseParams(values: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const value of values) {
    const [key, ...rest] = value.split('=');
    if (!key || rest.length === 0) {
      continue;
    }
    output[key] = rest.join('=');
  }
  return output;
}

function printResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseNonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be an integer >= 0`);
  }
  return parsed;
}

function parsePositiveInt(value: unknown, label: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be an integer > 0`);
  }
  return parsed;
}

function resolveExtensionDistPath(): string | null {
  const candidates = [
    resolve(__dirname, '..', '..', 'bak-extension', 'dist'),
    resolve(__dirname, '..', '..', '..', 'extension', 'dist'),
    resolve(process.cwd(), 'node_modules', '@flrande', 'bak-extension', 'dist'),
    resolve(process.cwd(), 'packages', 'extension', 'dist')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const program = new Command();
program.name('bak').description('Browser Agent Kit CLI').version('0.1.0');

program
  .command('setup')
  .description('Generate a pairing token and print quickstart instructions')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--ttl-days <days>', 'token ttl in days', `${DEFAULT_PAIR_TTL_DAYS}`)
  .option('--json', 'print setup payload as JSON', false)
  .action((options) => {
    const ttlDays = parsePositiveInt(options.ttlDays, 'ttl-days');
    const port = Number.parseInt(String(options.port), 10);
    const rpcWsPort = Number.parseInt(String(options.rpcWsPort), 10);
    if (!Number.isInteger(port) || port < 1) {
      throw new Error('port must be an integer >= 1');
    }
    if (!Number.isInteger(rpcWsPort) || rpcWsPort < 1) {
      throw new Error('rpc-ws-port must be an integer >= 1');
    }

    const store = new PairingStore();
    const created = store.createToken({ ttlDays, reason: 'setup' });
    const extensionDistPath = resolveExtensionDistPath();
    const payload = {
      token: created.token,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      port,
      rpcWsPort,
      extensionDistPath,
      serveCommand: `npx bak serve --port ${port} --rpc-ws-port ${rpcWsPort}`,
      doctorCommand: `npx bak doctor --port ${port} --rpc-ws-port ${rpcWsPort}`
    };

    if (options.json === true) {
      printResult(payload);
      return;
    }

    process.stdout.write('[bak] setup ready\n');
    process.stdout.write(`token: ${created.token}\n`);
    process.stdout.write(`token expires: ${created.expiresAt}\n`);
    process.stdout.write(`serve: ${payload.serveCommand}\n`);
    process.stdout.write(`doctor: ${payload.doctorCommand}\n`);
    process.stdout.write(`extension dist: ${extensionDistPath ?? 'not found (install @flrande/bak-extension)'}\n`);
  });

program
  .command('serve')
  .description('Start bak daemon with extension bridge + JSON-RPC servers')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--pair', 'rotate pairing token at startup and print token', false)
  .option('--pair-ttl-days <days>', 'token ttl days used with --pair', `${DEFAULT_PAIR_TTL_DAYS}`)
  .action(async (options) => {
    const port = Number.parseInt(String(options.port), 10);
    const rpcWsPort = Number.parseInt(String(options.rpcWsPort), 10);
    if (!Number.isInteger(port) || port < 1) {
      throw new Error('port must be an integer >= 1');
    }
    if (!Number.isInteger(rpcWsPort) || rpcWsPort < 1) {
      throw new Error('rpc-ws-port must be an integer >= 1');
    }

    if (options.pair === true) {
      const ttlDays = parsePositiveInt(options.pairTtlDays, 'pair-ttl-days');
      const store = new PairingStore();
      const created = store.createToken({ ttlDays, reason: 'serve-pair' });
      process.stderr.write(`[bak] pair token: ${created.token}\n`);
      process.stderr.write(`[bak] pair token expires: ${created.expiresAt}\n`);
      const extensionDistPath = resolveExtensionDistPath();
      if (extensionDistPath) {
        process.stderr.write(`[bak] extension dist: ${extensionDistPath}\n`);
      } else {
        process.stderr.write('[bak] extension dist not found; install @flrande/bak-extension or provide local dist path\n');
      }
      process.stderr.write(`[bak] next: open extension popup, paste token, set port ${port}, click save/connect\n`);
    }

    const daemon = await startBakDaemon(port, rpcWsPort);

    process.stderr.write(`bak daemon ready\n`);
    process.stderr.write(`extension bridge: ws://127.0.0.1:${port}/extension\n`);
    process.stderr.write(`rpc websocket: ws://127.0.0.1:${rpcWsPort}/rpc\n`);
    process.stderr.write(`stdio JSON-RPC enabled\n`);

    const shutdown = async (): Promise<void> => {
      await daemon.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });

    setInterval(() => {
      const status = daemon.service.status();
      process.stderr.write(
        `[bak] paired=${status.paired} state=${status.connectionState} extensionConnected=${status.extensionConnected} heartbeatStale=${status.heartbeatStale} recording=${status.recording} lastSeen=${status.lastSeenTs ?? 'n/a'} protocol=${status.protocolVersion} memory=${status.memoryBackend.backend} requestedMemory=${status.memoryBackend.requestedBackend}\n`
      );
    }, 15_000);
  });

const pair = program.command('pair').description('Pairing token operations');
pair
  .option('--ttl-days <days>', 'token ttl in days', `${DEFAULT_PAIR_TTL_DAYS}`)
  .description('Generate and rotate pairing token for extension')
  .action((options) => {
    const ttlDays = parsePositiveInt(options.ttlDays, 'ttl-days');

    const store = new PairingStore();
    const created = store.createToken({ ttlDays, reason: 'manual-rotate' });
    printResult({
      token: created.token,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt
    });
  });

pair
  .command('revoke')
  .description('Revoke current active pairing token')
  .option('--reason <reason>', 'revocation reason', 'manual-revoke')
  .action((options) => {
    const store = new PairingStore();
    const result = store.revokeActive(String(options.reason));
    printResult(result);
  });

pair
  .command('status')
  .description('Show pairing token status')
  .action(() => {
    const store = new PairingStore();
    printResult(store.status());
  });

program
  .command('doctor')
  .description('Run local diagnostics for bak runtime')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--data-dir <path>', 'override data dir')
  .action(async (options) => {
    const result = await runDoctor({
      port: Number.parseInt(String(options.port), 10),
      rpcWsPort: Number.parseInt(String(options.rpcWsPort), 10),
      dataDir: options.dataDir ? resolve(String(options.dataDir)) : undefined
    });
    printResult(result);
  });

program
  .command('call')
  .description('Call a JSON-RPC method over websocket')
  .requiredOption('--method <method>', 'method name')
  .option('--params <json>', 'params JSON string', '{}')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const method = String(options.method);
    const params = JSON.parse(String(options.params)) as Record<string, unknown>;
    const result = await callRpc(method, params, Number.parseInt(String(options.rpcWsPort), 10));
    printResult(result);
  });

const tabs = program.command('tabs').description('Tab operations');
tabs
  .command('list')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc('tabs.list', {}, Number.parseInt(String(options.rpcWsPort), 10));
    printResult(result);
  });

tabs
  .command('new')
  .option('--url <url>', 'initial url')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc(
      'tabs.new',
      { url: options.url ? String(options.url) : undefined },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

tabs
  .command('focus <tabId>')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (tabId, options) => {
    const parsedTabId = Number.parseInt(String(tabId), 10);
    if (!Number.isInteger(parsedTabId) || parsedTabId < 0) {
      throw new Error('tabId must be an integer >= 0');
    }
    const result = await callRpc(
      'tabs.focus',
      { tabId: parsedTabId },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

tabs
  .command('close <tabId>')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (tabId, options) => {
    const parsedTabId = Number.parseInt(String(tabId), 10);
    if (!Number.isInteger(parsedTabId) || parsedTabId < 0) {
      throw new Error('tabId must be an integer >= 0');
    }
    const result = await callRpc(
      'tabs.close',
      { tabId: parsedTabId },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

tabs
  .command('get <tabId>')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (tabId, options) => {
    const parsedTabId = Number.parseInt(String(tabId), 10);
    if (!Number.isInteger(parsedTabId) || parsedTabId < 0) {
      throw new Error('tabId must be an integer >= 0');
    }
    const result = await callRpc(
      'tabs.get',
      { tabId: parsedTabId },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

tabs
  .command('active')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc('tabs.getActive', {}, Number.parseInt(String(options.rpcWsPort), 10));
    printResult(result);
  });

const page = program.command('page').description('Page operations');
page
  .command('goto <url>')
  .option('--tab-id <tabId>', 'tab id')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (url, options) => {
    const tabId = options.tabId ? Number.parseInt(String(options.tabId), 10) : undefined;
    if (tabId !== undefined && (!Number.isInteger(tabId) || tabId < 0)) {
      throw new Error('tab-id must be an integer >= 0');
    }
    const result = await callRpc(
      'page.goto',
      { url: String(url), tabId },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

page
  .command('wait')
  .requiredOption('--mode <mode>', 'selector | text | url')
  .requiredOption('--value <value>', 'selector/text/url matcher')
  .option('--tab-id <tabId>', 'tab id')
  .option('--timeout-ms <timeoutMs>', 'timeout in milliseconds')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const tabId = options.tabId ? Number.parseInt(String(options.tabId), 10) : undefined;
    if (tabId !== undefined && (!Number.isInteger(tabId) || tabId < 0)) {
      throw new Error('tab-id must be an integer >= 0');
    }
    const timeoutMs = options.timeoutMs ? Number.parseInt(String(options.timeoutMs), 10) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      throw new Error('timeout-ms must be an integer >= 1');
    }
    const result = await callRpc(
      'page.wait',
      {
        mode: String(options.mode),
        value: String(options.value),
        tabId,
        timeoutMs
      },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

page
  .command('url')
  .option('--tab-id <tabId>', 'tab id')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const tabId = options.tabId ? Number.parseInt(String(options.tabId), 10) : undefined;
    if (tabId !== undefined && (!Number.isInteger(tabId) || tabId < 0)) {
      throw new Error('tab-id must be an integer >= 0');
    }
    const result = await callRpc(
      'page.url',
      { tabId },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

page
  .command('title')
  .option('--tab-id <tabId>', 'tab id')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const tabId = options.tabId ? Number.parseInt(String(options.tabId), 10) : undefined;
    if (tabId !== undefined && (!Number.isInteger(tabId) || tabId < 0)) {
      throw new Error('tab-id must be an integer >= 0');
    }
    const result = await callRpc(
      'page.title',
      { tabId },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

const debug = program.command('debug').description('Debug utilities');
debug
  .command('console')
  .option('--tab-id <tabId>', 'tab id')
  .option('--limit <limit>', 'max number of entries', '50')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const tabId = options.tabId ? Number.parseInt(String(options.tabId), 10) : undefined;
    if (tabId !== undefined && (!Number.isInteger(tabId) || tabId < 0)) {
      throw new Error('tab-id must be an integer >= 0');
    }
    const limit = Number.parseInt(String(options.limit), 10);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('limit must be an integer >= 1');
    }
    const result = await callRpc(
      'debug.getConsole',
      { tabId, limit },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

const record = program.command('record').description('Recording helpers');
record
  .command('start')
  .requiredOption('--intent <intent>', 'recording intent')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc(
      'memory.recordStart',
      { intent: String(options.intent) },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

record
  .command('stop')
  .option('--outcome <outcome>', 'success or failed', 'success')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc(
      'memory.recordStop',
      { outcome: String(options.outcome) },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

const skills = program.command('skills').description('Memory skill operations');
skills
  .command('list')
  .option('--domain <domain>', 'domain filter')
  .option('--intent <intent>', 'intent filter')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc(
      'memory.skills.list',
      { domain: options.domain, intent: options.intent },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

skills
  .command('show <id>')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (id, options) => {
    const result = await callRpc(
      'memory.skills.show',
      { id },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

skills
  .command('retrieve')
  .requiredOption('--intent <intent>', 'intent text')
  .option('--domain <domain>', 'domain filter')
  .option('--anchor <anchor...>', 'anchors for similarity', [])
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const result = await callRpc(
      'memory.skills.retrieve',
      {
        domain: options.domain,
        intent: String(options.intent),
        anchors: (options.anchor as string[]) ?? []
      },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

skills
  .command('run <id>')
  .option('--tab-id <tabId>', 'tab id')
  .option('--param <kv...>', 'skill param key=value, repeatable', [])
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (id, options) => {
    const params = parseParams((options.param as string[]) ?? []);
    const result = await callRpc(
      'memory.skills.run',
      {
        id,
        tabId: options.tabId ? Number.parseInt(String(options.tabId), 10) : undefined,
        params
      },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

skills
  .command('delete <id>')
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (id, options) => {
    const result = await callRpc(
      'memory.skills.delete',
      { id },
      Number.parseInt(String(options.rpcWsPort), 10)
    );
    printResult(result);
  });

const memory = program.command('memory').description('Memory storage utilities');
memory
  .command('migrate')
  .description('Migrate memory.json into memory.sqlite (idempotent)')
  .option('--data-dir <path>', 'override data dir')
  .action((options) => {
    const result = migrateMemoryJsonToSqlite(options.dataDir ? resolve(String(options.dataDir)) : undefined);
    printResult(result);
  });

memory
  .command('export')
  .description('Export memory payload from selected backend')
  .option('--backend <backend>', 'json or sqlite', process.env.BAK_MEMORY_BACKEND ?? 'json')
  .option('--data-dir <path>', 'override data dir')
  .option('--out <path>', 'output path')
  .action((options) => {
    const dataDir = options.dataDir ? resolve(String(options.dataDir)) : resolveDataDir();
    const backend = resolveMemoryBackend(String(options.backend));
    const resolution = createMemoryStoreResolved({ dataDir, backend });
    const payload = exportMemory(resolution.store, resolution.backend);
    const outPath = options.out ? resolve(String(options.out)) : join(dataDir, `memory-export-${Date.now()}.json`);
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    printResult({
      outPath,
      backend: resolution.backend,
      requestedBackend: resolution.requestedBackend,
      fallbackReason: resolution.fallbackReason,
      episodeCount: payload.episodes.length,
      skillCount: payload.skills.length
    });
    });

program
  .command('export')
  .description('Export redacted diagnostic zip package')
  .option('--trace-id <traceId>', 'include only a single trace and snapshot set')
  .option('--trace <traceId>', 'deprecated alias for --trace-id')
  .option('--port <port>', 'extension websocket port for doctor snapshot', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'rpc websocket port for doctor snapshot', `${DEFAULT_RPC_PORT}`)
  .option('--include-snapshots', 'include raw snapshot image folders (may contain sensitive visual data)', false)
  .option('--include-memory', 'include redacted memory export in package', false)
  .option('--memory-backend <backend>', 'memory backend for export (json|sqlite)', process.env.BAK_MEMORY_BACKEND ?? 'json')
  .option('--data-dir <path>', 'override data dir')
  .option('--out <path>', 'output zip path')
  .action(async (options) => {
    const traceId = options.traceId ? String(options.traceId) : options.trace ? String(options.trace) : undefined;
    if (!options.traceId && options.trace) {
      process.stderr.write('[bak] --trace is deprecated; use --trace-id\n');
    }

    const dataDir = options.dataDir ? resolve(String(options.dataDir)) : undefined;
    const doctorReport = await runDoctor({
      dataDir,
      port: Number.parseInt(String(options.port), 10),
      rpcWsPort: Number.parseInt(String(options.rpcWsPort), 10)
    });

    const result = exportDiagnosticZip({
      traceId,
      dataDir,
      outPath: options.out ? resolve(String(options.out)) : undefined,
      doctorReport,
      includeSnapshots: options.includeSnapshots === true,
      includeMemory: options.includeMemory === true,
      memoryBackend: String(options.memoryBackend)
    });
    printResult({
      ...result,
      doctorOk: doctorReport.ok
    });
  });

program
  .command('gc')
  .description('Apply retention policy to traces and snapshots')
  .option('--data-dir <path>', 'override BAK_DATA_DIR for this command')
  .option('--trace-days <days>', 'retain traces newer than N days')
  .option('--snapshot-days <days>', 'retain snapshot folders newer than N days')
  .option('--trace-keep <count>', 'always keep at least newest N traces')
  .option('--snapshot-keep <count>', 'always keep at least newest N snapshot folders')
  .option('--force', 'execute deletion (default is dry-run)', false)
  .action((options) => {
    const result = runGc({
      dataDir: options.dataDir ? String(options.dataDir) : undefined,
      traceDays: parseNonNegativeInt(options.traceDays, 'trace-days'),
      snapshotDays: parseNonNegativeInt(options.snapshotDays, 'snapshot-days'),
      traceKeep: parseNonNegativeInt(options.traceKeep, 'trace-keep'),
      snapshotKeep: parseNonNegativeInt(options.snapshotKeep, 'snapshot-keep'),
      force: Boolean(options.force)
    });
    printResult(result);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
