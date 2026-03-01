#!/usr/bin/env node
import { Command } from 'commander';
import { callRpc } from './rpc/client.js';
import { startBakDaemon } from './server.js';
import { runGc } from './gc.js';
import { PairingStore } from './pairing-store.js';
import { TraceStore } from './trace-store.js';
import { readEnvInt } from './utils.js';

const DEFAULT_PORT = readEnvInt('BAK_PORT', 17373);
const DEFAULT_RPC_PORT = readEnvInt('BAK_RPC_WS_PORT', DEFAULT_PORT + 1);

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

const program = new Command();
program.name('bak').description('Browser Agent Kit CLI').version('0.1.0');

program
  .command('serve')
  .description('Start bak daemon with extension bridge + JSON-RPC servers')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .action(async (options) => {
    const port = Number.parseInt(String(options.port), 10);
    const rpcWsPort = Number.parseInt(String(options.rpcWsPort), 10);

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
        `[bak] paired=${status.paired} state=${status.connectionState} extensionConnected=${status.extensionConnected} recording=${status.recording} lastSeen=${status.lastSeenTs ?? 'n/a'}\n`
      );
    }, 15_000);
  });

program
  .command('pair')
  .description('Generate pairing token for extension')
  .action(() => {
    const store = new PairingStore();
    const token = store.createToken();
    printResult({ token });
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

program
  .command('export <traceId>')
  .description('Export trace path for debug package')
  .action((traceId) => {
    const traces = new TraceStore();
    printResult(traces.export(traceId));
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
