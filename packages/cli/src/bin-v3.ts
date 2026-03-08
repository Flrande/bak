import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { callRpc } from './rpc/client.js';
import { exportDiagnosticZip } from './diagnostic-export.js';
import { runDoctor } from './doctor.js';
import { runGc } from './gc.js';
import { dragDropLocatorsFromOptions, hasLocatorOptions, locatorFromOptions, parseFiniteNumber, parseNonNegativeInt, parsePositiveInt } from './cli-args.js';
import { exportMemory, createMemoryStoreResolved } from './memory/factory.js';
import { PairingStore } from './pairing-store.js';
import { startBakDaemon } from './server.js';
import { readEnvInt, resolveDataDir } from './utils.js';

const DEFAULT_PORT = readEnvInt('BAK_PORT', 17373);
const DEFAULT_RPC_PORT = readEnvInt('BAK_RPC_WS_PORT', DEFAULT_PORT + 1);
const DEFAULT_PAIR_TTL_DAYS = readEnvInt('BAK_PAIR_TTL_DAYS', 30);
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

function printResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseJson(value: string | undefined, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function parseKv(values: string[]): Record<string, string> {
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

function parseRpcPort(options: { rpcWsPort?: string }): number {
  return Number.parseInt(String(options.rpcWsPort ?? DEFAULT_RPC_PORT), 10);
}

function parseTabId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('tab-id must be an integer >= 0');
  }
  return parsed;
}

function resolveExtensionDistPath(): string | null {
  const candidates = [
    resolve(CURRENT_DIR, '..', '..', 'bak-extension', 'dist'),
    resolve(CURRENT_DIR, '..', '..', '..', 'extension', 'dist'),
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

function readCliVersion(): string {
  try {
    const packageJsonUrl = new URL('../package.json', import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version?: unknown };
    if (typeof packageJson.version === 'string' && packageJson.version.trim().length > 0) {
      return packageJson.version;
    }
  } catch {
    // ignore and fall back
  }
  return '0.0.0';
}

async function invoke(method: string, params: Record<string, unknown>, rpcWsPort: number): Promise<void> {
  printResult(await callRpc(method, params, rpcWsPort));
}

function addRpcPortOption(command: Command): Command {
  return command.option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`);
}

function addTabOption(command: Command): Command {
  return command.option('--tab-id <tabId>', 'tab id');
}

function addLocatorOptions(command: Command): Command {
  return command
    .option('--locator <json>', 'locator JSON payload')
    .option('--eid <eid>', 'locator eid')
    .option('--role <role>', 'locator role')
    .option('--name <name>', 'locator name')
    .option('--text <text>', 'locator text')
    .option('--css <css>', 'locator css selector')
    .option('--index <index>', 'locator index')
    .option('--shadow <mode>', 'shadow mode auto|pierce|none')
    .option('--frame <selector...>', 'frame path selectors');
}

function addPrefixedLocatorOptions(command: Command, prefix: 'from' | 'to', label: string): Command {
  return command
    .option(`--${prefix}-locator <json>`, `${label} locator JSON payload`)
    .option(`--${prefix}-eid <eid>`, `${label} locator eid`)
    .option(`--${prefix}-role <role>`, `${label} locator role`)
    .option(`--${prefix}-name <name>`, `${label} locator name`)
    .option(`--${prefix}-text <text>`, `${label} locator text`)
    .option(`--${prefix}-css <css>`, `${label} locator css selector`)
    .option(`--${prefix}-index <index>`, `${label} locator index`)
    .option(`--${prefix}-shadow <mode>`, `${label} shadow mode auto|pierce|none`)
    .option(`--${prefix}-frame <selector...>`, `${label} frame path selectors`);
}

function uploadFilesFromOptions(options: Record<string, unknown>): Array<{ name: string; contentBase64: string; mimeType?: string }> {
  const fileJson = typeof options.files === 'string' ? parseJson(options.files) : undefined;
  if (fileJson && Array.isArray(fileJson.items)) {
    return fileJson.items as Array<{ name: string; contentBase64: string; mimeType?: string }>;
  }
  const paths = Array.isArray(options.filePath) ? (options.filePath as string[]) : [];
  return paths.map((filePath) => {
    const resolved = resolve(String(filePath));
    return {
      name: resolved.split(/[\\/]/).pop() ?? 'upload.bin',
      contentBase64: readFileSync(resolved).toString('base64')
    };
  });
}

const program = new Command();
program.name('bak').description('Browser Agent Kit CLI').version(readCliVersion());

program
  .command('setup')
  .description('Generate a pairing token and print quickstart instructions')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--ttl-days <days>', 'token ttl in days', `${DEFAULT_PAIR_TTL_DAYS}`)
  .option('--json', 'print setup payload as JSON', false)
  .action((options) => {
    const ttlDays = parsePositiveInt(options.ttlDays, 'ttl-days');
    const port = parsePositiveInt(options.port, 'port');
    const rpcWsPort = parsePositiveInt(options.rpcWsPort, 'rpc-ws-port');
    const store = new PairingStore();
    const created = store.createToken({ ttlDays, reason: 'setup' });
    const payload = {
      token: created.token,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      port,
      rpcWsPort,
      extensionDistPath: resolveExtensionDistPath(),
      serveCommand: `bak serve --port ${port} --rpc-ws-port ${rpcWsPort}`,
      doctorCommand: `bak doctor --port ${port} --rpc-ws-port ${rpcWsPort}`
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
  });

program
  .command('serve')
  .description('Start bak daemon with extension bridge + JSON-RPC servers')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--pair', 'rotate pairing token at startup and print token', false)
  .option('--pair-ttl-days <days>', 'token ttl days used with --pair', `${DEFAULT_PAIR_TTL_DAYS}`)
  .action(async (options) => {
    const port = parsePositiveInt(options.port, 'port');
    const rpcWsPort = parsePositiveInt(options.rpcWsPort, 'rpc-ws-port');
    if (options.pair === true) {
      const ttlDays = parsePositiveInt(options.pairTtlDays, 'pair-ttl-days');
      const store = new PairingStore();
      const created = store.createToken({ ttlDays, reason: 'serve-pair' });
      process.stderr.write(`[bak] pair token: ${created.token}\n`);
      process.stderr.write(`[bak] pair token expires: ${created.expiresAt}\n`);
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
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    setInterval(() => {
      const status = daemon.service.status();
      process.stderr.write(
        `[bak] paired=${status.paired} state=${status.connectionState} extensionConnected=${status.extensionConnected} heartbeatStale=${status.heartbeatStale} capture=${status.captureSessionId ?? 'none'} protocol=${status.protocolVersion} memory=${status.memoryBackend.backend}\n`
      );
    }, 15_000);
  });

const pair = program.command('pair').description('Pairing token operations');
pair
  .command('create')
  .option('--ttl-days <days>', 'token ttl in days', `${DEFAULT_PAIR_TTL_DAYS}`)
  .action((options) => {
    const ttlDays = parsePositiveInt(options.ttlDays, 'ttl-days');
    const store = new PairingStore();
    printResult(store.createToken({ ttlDays, reason: 'manual-rotate' }));
  });
pair.command('revoke').option('--reason <reason>', 'revocation reason', 'manual-revoke').action((options) => printResult(new PairingStore().revokeActive(String(options.reason))));
pair.command('status').action(() => printResult(new PairingStore().status()));

program
  .command('doctor')
  .description('Run local diagnostics for bak runtime')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'rpc websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--data-dir <path>', 'override data dir')
  .action(async (options) => {
    printResult(
      await runDoctor({
        port: parsePositiveInt(options.port, 'port'),
        rpcWsPort: parsePositiveInt(options.rpcWsPort, 'rpc-ws-port'),
        dataDir: options.dataDir ? resolve(String(options.dataDir)) : undefined
      })
    );
  });

addRpcPortOption(
  program
    .command('call')
    .description('Call a JSON-RPC method over websocket')
    .requiredOption('--method <method>', 'method name')
    .option('--params <json>', 'params JSON string', '{}')
).action(async (options) => invoke(String(options.method), parseJson(String(options.params)), parseRpcPort(options)));

const tabs = program.command('tabs').description('Tab operations');
addRpcPortOption(tabs.command('list')).action(async (options) => invoke('tabs.list', {}, parseRpcPort(options)));
addRpcPortOption(tabs.command('new').option('--url <url>', 'initial url')).action(async (options) => invoke('tabs.new', { url: options.url ? String(options.url) : undefined }, parseRpcPort(options)));
addRpcPortOption(tabs.command('focus <tabId>')).action(async (tabId, options) => invoke('tabs.focus', { tabId: parsePositiveInt(tabId, 'tabId') }, parseRpcPort(options)));
addRpcPortOption(tabs.command('close <tabId>')).action(async (tabId, options) => invoke('tabs.close', { tabId: parsePositiveInt(tabId, 'tabId') }, parseRpcPort(options)));
addRpcPortOption(tabs.command('get <tabId>')).action(async (tabId, options) => invoke('tabs.get', { tabId: parsePositiveInt(tabId, 'tabId') }, parseRpcPort(options)));
addRpcPortOption(tabs.command('active')).action(async (options) => invoke('tabs.getActive', {}, parseRpcPort(options)));

const page = program.command('page').description('Page operations');
addRpcPortOption(addTabOption(page.command('goto <url>'))).action(async (url, options) => invoke('page.goto', { url: String(url), tabId: parseTabId(options.tabId) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(page.command('wait').requiredOption('--mode <mode>', 'selector | text | url').requiredOption('--value <value>', 'selector/text/url matcher').option('--timeout-ms <timeoutMs>', 'timeout in milliseconds'))).action(async (options) => invoke('page.wait', { tabId: parseTabId(options.tabId), mode: String(options.mode), value: String(options.value), timeoutMs: parsePositiveInt(options.timeoutMs, 'timeout-ms') }, parseRpcPort(options)));
for (const [name, method] of [['url', 'page.url'], ['title', 'page.title'], ['snapshot', 'page.snapshot'], ['text', 'page.text'], ['dom', 'page.dom'], ['a11y', 'page.accessibilityTree'], ['metrics', 'page.metrics']] as const) {
  const command = addRpcPortOption(addTabOption(page.command(name)));
  if (name === 'snapshot') {
    command.option('--include-base64', 'include imageBase64 in the result', false);
  }
  command.action(async (options) =>
    invoke(
      method,
      {
        tabId: parseTabId(options.tabId),
        includeBase64: options.includeBase64 === true ? true : undefined
      },
      parseRpcPort(options)
    )
  );
}
addRpcPortOption(addTabOption(page.command('viewport').option('--width <width>', 'width').option('--height <height>', 'height'))).action(async (options) => invoke('page.viewport', { tabId: parseTabId(options.tabId), width: parsePositiveInt(options.width, 'width'), height: parsePositiveInt(options.height, 'height') }, parseRpcPort(options)));

const debug = program.command('debug').description('Debug utilities');
addRpcPortOption(addTabOption(debug.command('console').option('--limit <limit>', 'max number of entries', '50'))).action(async (options) => invoke('debug.getConsole', { tabId: parseTabId(options.tabId), limit: parsePositiveInt(options.limit, 'limit') }, parseRpcPort(options)));
addRpcPortOption(
  addTabOption(
    debug
      .command('dump-state')
      .option('--console-limit <limit>', 'console entry limit', '80')
      .option('--network-limit <limit>', 'network entry limit', '80')
      .option('--include-a11y', 'include accessibility nodes', false)
      .option('--include-snapshot', 'attach a fresh viewport snapshot to the dump', false)
      .option('--include-snapshot-base64', 'include snapshot imageBase64 when a snapshot is attached', false)
  )
).action(async (options) =>
  invoke(
    'debug.dumpState',
    {
      tabId: parseTabId(options.tabId),
      consoleLimit: parsePositiveInt(options.consoleLimit, 'console-limit'),
      networkLimit: parsePositiveInt(options.networkLimit, 'network-limit'),
      includeAccessibility: options.includeA11y === true,
      includeSnapshot: options.includeSnapshot === true,
      includeSnapshotBase64: options.includeSnapshotBase64 === true
    },
    parseRpcPort(options)
  )
);

const network = program.command('network').description('Network inspection commands');
addRpcPortOption(addTabOption(network.command('list').option('--limit <limit>', 'result limit', '50').option('--url-includes <text>', 'url substring').option('--status <status>', 'status code').option('--method <method>', 'HTTP method'))).action(async (options) => invoke('network.list', { tabId: parseTabId(options.tabId), limit: parsePositiveInt(options.limit, 'limit'), urlIncludes: options.urlIncludes ? String(options.urlIncludes) : undefined, status: parseNonNegativeInt(options.status, 'status'), method: options.method ? String(options.method) : undefined }, parseRpcPort(options)));
addRpcPortOption(addTabOption(network.command('get <id>'))).action(async (id, options) => invoke('network.get', { tabId: parseTabId(options.tabId), id: String(id) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(network.command('wait').option('--url-includes <text>', 'url substring').option('--status <status>', 'status code').option('--method <method>', 'HTTP method').option('--timeout-ms <timeoutMs>', 'timeout in milliseconds', '5000'))).action(async (options) => invoke('network.waitFor', { tabId: parseTabId(options.tabId), urlIncludes: options.urlIncludes ? String(options.urlIncludes) : undefined, status: parseNonNegativeInt(options.status, 'status'), method: options.method ? String(options.method) : undefined, timeoutMs: parsePositiveInt(options.timeoutMs, 'timeout-ms') }, parseRpcPort(options)));
addRpcPortOption(addTabOption(network.command('clear'))).action(async (options) => invoke('network.clear', { tabId: parseTabId(options.tabId) }, parseRpcPort(options)));

const context = program.command('context').description('Frame and shadow context commands');
addRpcPortOption(addTabOption(context.command('enter-frame').option('--frame-path <selector...>', 'frame path selectors'))).action(async (options) => invoke('context.enterFrame', { tabId: parseTabId(options.tabId), framePath: Array.isArray(options.framePath) ? options.framePath.map(String) : undefined }, parseRpcPort(options)));
addRpcPortOption(addTabOption(context.command('exit-frame').option('--levels <levels>', 'levels to exit'))).action(async (options) => invoke('context.exitFrame', { tabId: parseTabId(options.tabId), levels: parsePositiveInt(options.levels, 'levels') }, parseRpcPort(options)));
addRpcPortOption(addTabOption(context.command('enter-shadow').option('--host-selectors <selector...>', 'shadow host selectors'))).action(async (options) => invoke('context.enterShadow', { tabId: parseTabId(options.tabId), hostSelectors: Array.isArray(options.hostSelectors) ? options.hostSelectors.map(String) : undefined }, parseRpcPort(options)));
addRpcPortOption(addTabOption(context.command('exit-shadow').option('--levels <levels>', 'levels to exit'))).action(async (options) => invoke('context.exitShadow', { tabId: parseTabId(options.tabId), levels: parsePositiveInt(options.levels, 'levels') }, parseRpcPort(options)));
addRpcPortOption(addTabOption(context.command('reset'))).action(async (options) => invoke('context.reset', { tabId: parseTabId(options.tabId) }, parseRpcPort(options)));

const element = program.command('element').description('Element operations');
addRpcPortOption(addTabOption(addLocatorOptions(element.command('get')))).action(async (options) => invoke('element.get', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('click')))).action(async (options) => invoke('element.click', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('type').requiredOption('--value <value>', 'text to type').option('--clear', 'clear before typing', false)))).action(async (options) => invoke('element.type', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson), text: String(options.value), clear: options.clear === true }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('hover')))).action(async (options) => invoke('element.hover', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('double-click')))).action(async (options) => invoke('element.doubleClick', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('right-click')))).action(async (options) => invoke('element.rightClick', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('select').requiredOption('--value <value...>', 'selected values')))).action(async (options) => invoke('element.select', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson), values: (options.value as string[]).map(String) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('check')))).action(async (options) => invoke('element.check', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('uncheck')))).action(async (options) => invoke('element.uncheck', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('scroll').option('--dx <dx>', 'horizontal delta').option('--dy <dy>', 'vertical delta', '320')))).action(async (options) => invoke('element.scroll', { tabId: parseTabId(options.tabId), locator: hasLocatorOptions(options) ? locatorFromOptions(options, parseJson) : undefined, dx: parseFiniteNumber(options.dx, 'dx'), dy: parseFiniteNumber(options.dy, 'dy') }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('scroll-into-view')))).action(async (options) => invoke('element.scrollIntoView', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('focus')))).action(async (options) => invoke('element.focus', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addLocatorOptions(element.command('blur')))).action(async (options) => invoke('element.blur', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(addPrefixedLocatorOptions(addPrefixedLocatorOptions(element.command('drag-drop'), 'from', 'source'), 'to', 'target'))).action(async (options) => {
  const endpoints = dragDropLocatorsFromOptions(options, parseJson);
  return invoke('element.dragDrop', { tabId: parseTabId(options.tabId), from: endpoints.from, to: endpoints.to }, parseRpcPort(options));
});

const keyboard = program.command('keyboard').description('Keyboard commands');
addRpcPortOption(addTabOption(keyboard.command('press <key>'))).action(async (key, options) => invoke('keyboard.press', { tabId: parseTabId(options.tabId), key: String(key) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(keyboard.command('type <text>').option('--delay-ms <delayMs>', 'delay per character'))).action(async (text, options) => invoke('keyboard.type', { tabId: parseTabId(options.tabId), text: String(text), delayMs: parseNonNegativeInt(options.delayMs, 'delay-ms') }, parseRpcPort(options)));
addRpcPortOption(addTabOption(keyboard.command('hotkey <keys...>'))).action(async (keys, options) => invoke('keyboard.hotkey', { tabId: parseTabId(options.tabId), keys: (keys as string[]).map(String) }, parseRpcPort(options)));

const mouse = program.command('mouse').description('Mouse commands');
addRpcPortOption(addTabOption(mouse.command('move').requiredOption('--x <x>', 'x').requiredOption('--y <y>', 'y'))).action(async (options) => invoke('mouse.move', { tabId: parseTabId(options.tabId), x: parseFiniteNumber(options.x, 'x', { min: 0 }), y: parseFiniteNumber(options.y, 'y', { min: 0 }) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(mouse.command('click').requiredOption('--x <x>', 'x').requiredOption('--y <y>', 'y').option('--button <button>', 'left|middle|right', 'left'))).action(async (options) => invoke('mouse.click', { tabId: parseTabId(options.tabId), x: parseFiniteNumber(options.x, 'x', { min: 0 }), y: parseFiniteNumber(options.y, 'y', { min: 0 }), button: String(options.button) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(mouse.command('wheel').option('--dx <dx>', 'horizontal delta').option('--dy <dy>', 'vertical delta', '120'))).action(async (options) => invoke('mouse.wheel', { tabId: parseTabId(options.tabId), dx: parseFiniteNumber(options.dx, 'dx'), dy: parseFiniteNumber(options.dy, 'dy') }, parseRpcPort(options)));

const file = program.command('file').description('File input commands');
addRpcPortOption(addTabOption(addLocatorOptions(file.command('upload').option('--file-path <path...>', 'file path(s)').option('--files <json>', 'file JSON payload')))).action(async (options) => invoke('file.upload', { tabId: parseTabId(options.tabId), locator: locatorFromOptions(options, parseJson), files: uploadFilesFromOptions(options) }, parseRpcPort(options)));

const memory = program.command('memory').description('Agent-centered memory commands');
const capture = memory.command('capture').description('Capture lifecycle');
addRpcPortOption(addTabOption(capture.command('begin').requiredOption('--goal <goal>', 'capture goal').option('--label <label...>', 'labels', []))).action(async (options) => invoke('memory.capture.begin', { goal: String(options.goal), tabId: parseTabId(options.tabId), labels: (options.label as string[]).map(String) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(capture.command('mark').requiredOption('--label <label>', 'mark label').option('--role <role>', 'checkpoint|route|procedure|target-page|note').option('--note <note>', 'note'))).action(async (options) => invoke('memory.capture.mark', { tabId: parseTabId(options.tabId), label: String(options.label), role: options.role ? String(options.role) : undefined, note: options.note ? String(options.note) : undefined }, parseRpcPort(options)));
addRpcPortOption(addTabOption(capture.command('end').option('--outcome <outcome>', 'completed|failed|abandoned', 'completed'))).action(async (options) => invoke('memory.capture.end', { tabId: parseTabId(options.tabId), outcome: String(options.outcome) }, parseRpcPort(options)));

const draft = memory.command('draft').description('Draft memory review');
addRpcPortOption(draft.command('list').option('--capture-session-id <id>', 'capture session id').option('--kind <kind>', 'route|procedure|composite').option('--status <status>', 'draft|discarded|promoted').option('--limit <limit>', 'result limit', '50')).action(async (options) => invoke('memory.drafts.list', { captureSessionId: options.captureSessionId ? String(options.captureSessionId) : undefined, kind: options.kind ? String(options.kind) : undefined, status: options.status ? String(options.status) : undefined, limit: parsePositiveInt(options.limit, 'limit') }, parseRpcPort(options)));
addRpcPortOption(draft.command('show <id>')).action(async (id, options) => invoke('memory.drafts.get', { id: String(id) }, parseRpcPort(options)));
addRpcPortOption(draft.command('promote <id>').option('--title <title>', 'override title').option('--goal <goal>', 'override goal').option('--description <description>', 'override description').option('--tag <tag...>', 'tags', [])).action(async (id, options) => invoke('memory.drafts.promote', { id: String(id), title: options.title ? String(options.title) : undefined, goal: options.goal ? String(options.goal) : undefined, description: options.description ? String(options.description) : undefined, tags: (options.tag as string[]).map(String) }, parseRpcPort(options)));
addRpcPortOption(draft.command('discard <id>').option('--reason <reason>', 'discard reason')).action(async (id, options) => invoke('memory.drafts.discard', { id: String(id), reason: options.reason ? String(options.reason) : undefined }, parseRpcPort(options)));

addRpcPortOption(
  addTabOption(
    memory
      .command('search')
      .requiredOption('--goal <goal>', 'goal text')
      .option('--kind <kind>', 'route|procedure|composite')
      .option('--url <url>', 'explicit page url context')
      .option('--limit <limit>', 'result limit', '10')
  )
).action(async (options) =>
  invoke(
    'memory.memories.search',
    {
      goal: String(options.goal),
      kind: options.kind ? String(options.kind) : undefined,
      tabId: parseTabId(options.tabId),
      url: options.url ? String(options.url) : undefined,
      limit: parsePositiveInt(options.limit, 'limit')
    },
    parseRpcPort(options)
  )
);
  addRpcPortOption(addTabOption(memory.command('explain <id>').option('--revision-id <id>', 'specific revision').option('--url <url>', 'explicit page url context'))).action(async (id, options) => invoke('memory.memories.explain', { id: String(id), revisionId: options.revisionId ? String(options.revisionId) : undefined, tabId: parseTabId(options.tabId), url: options.url ? String(options.url) : undefined }, parseRpcPort(options)));
addRpcPortOption(addTabOption(memory.command('show <id>').option('--include-revisions', 'include revisions', false))).action(async (id, options) => invoke('memory.memories.get', { id: String(id), includeRevisions: options.includeRevisions === true }, parseRpcPort(options)));
addRpcPortOption(memory.command('deprecate <id>').option('--reason <reason>', 'deprecation reason')).action(async (id, options) => invoke('memory.memories.deprecate', { id: String(id), reason: options.reason ? String(options.reason) : undefined }, parseRpcPort(options)));
addRpcPortOption(memory.command('delete <id>')).action(async (id, options) => invoke('memory.memories.delete', { id: String(id) }, parseRpcPort(options)));

const plan = memory.command('plan').description('Execution plan commands');
addRpcPortOption(addTabOption(plan.command('create').option('--memory-id <id>', 'single memory id').option('--revision-id <id>', 'single revision id').option('--route-memory-id <id>', 'route memory id').option('--route-revision-id <id>', 'route revision id').option('--procedure-memory-id <id>', 'procedure memory id').option('--procedure-revision-id <id>', 'procedure revision id').option('--mode <mode>', 'dry-run|assist|auto', 'assist').option('--param <kv...>', 'bound parameters key=value', []))).action(async (options) => invoke('memory.plans.create', { memoryId: options.memoryId ? String(options.memoryId) : undefined, revisionId: options.revisionId ? String(options.revisionId) : undefined, routeMemoryId: options.routeMemoryId ? String(options.routeMemoryId) : undefined, routeRevisionId: options.routeRevisionId ? String(options.routeRevisionId) : undefined, procedureMemoryId: options.procedureMemoryId ? String(options.procedureMemoryId) : undefined, procedureRevisionId: options.procedureRevisionId ? String(options.procedureRevisionId) : undefined, tabId: parseTabId(options.tabId), mode: String(options.mode), parameters: parseKv((options.param as string[]) ?? []) }, parseRpcPort(options)));
addRpcPortOption(plan.command('show <id>')).action(async (id, options) => invoke('memory.plans.get', { id: String(id) }, parseRpcPort(options)));
addRpcPortOption(addTabOption(memory.command('execute <id>').option('--mode <mode>', 'dry-run|assist|auto'))).action(async (id, options) => invoke('memory.plans.execute', { id: String(id), tabId: parseTabId(options.tabId), mode: options.mode ? String(options.mode) : undefined }, parseRpcPort(options)));

const run = memory.command('run').description('Execution run history');
addRpcPortOption(run.command('list').option('--memory-id <id>', 'filter by memory').option('--plan-id <id>', 'filter by plan').option('--status <status>', 'completed|blocked|failed').option('--limit <limit>', 'result limit', '50')).action(async (options) => invoke('memory.runs.list', { memoryId: options.memoryId ? String(options.memoryId) : undefined, planId: options.planId ? String(options.planId) : undefined, status: options.status ? String(options.status) : undefined, limit: parsePositiveInt(options.limit, 'limit') }, parseRpcPort(options)));
addRpcPortOption(run.command('show <id>')).action(async (id, options) => invoke('memory.runs.get', { id: String(id) }, parseRpcPort(options)));

const patch = memory.command('patch').description('Patch suggestion review');
addRpcPortOption(patch.command('list').option('--memory-id <id>', 'filter by memory').option('--status <status>', 'open|applied|rejected').option('--limit <limit>', 'result limit', '50')).action(async (options) => invoke('memory.patches.list', { memoryId: options.memoryId ? String(options.memoryId) : undefined, status: options.status ? String(options.status) : undefined, limit: parsePositiveInt(options.limit, 'limit') }, parseRpcPort(options)));
addRpcPortOption(patch.command('show <id>')).action(async (id, options) => invoke('memory.patches.get', { id: String(id) }, parseRpcPort(options)));
addRpcPortOption(patch.command('apply <id>').option('--note <note>', 'apply note')).action(async (id, options) => invoke('memory.patches.apply', { id: String(id), note: options.note ? String(options.note) : undefined }, parseRpcPort(options)));
addRpcPortOption(patch.command('reject <id>').option('--reason <reason>', 'reject reason')).action(async (id, options) => invoke('memory.patches.reject', { id: String(id), reason: options.reason ? String(options.reason) : undefined }, parseRpcPort(options)));

memory
  .command('export')
  .description('Export the current memory store snapshot')
  .option('--data-dir <path>', 'override data dir')
  .option('--out <path>', 'output path')
  .action((options) => {
    const dataDir = options.dataDir ? resolve(String(options.dataDir)) : resolveDataDir();
    const resolution = createMemoryStoreResolved({ dataDir });
    const payload = exportMemory(resolution.store, resolution.backend);
    const outPath = options.out ? resolve(String(options.out)) : join(dataDir, `memory-export-${Date.now()}.json`);
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    printResult({
      outPath,
      backend: resolution.backend,
      captureSessionCount: payload.captureSessions.length,
      draftCount: payload.drafts.length,
      memoryCount: payload.memories.length,
      revisionCount: payload.revisions.length,
      runCount: payload.runs.length,
      patchCount: payload.patches.length
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
  .option('--data-dir <path>', 'override data dir')
  .option('--out <path>', 'output zip path')
  .action(async (options) => {
    const traceId = options.traceId ? String(options.traceId) : options.trace ? String(options.trace) : undefined;
    const dataDir = options.dataDir ? resolve(String(options.dataDir)) : undefined;
    const doctorReport = await runDoctor({
      dataDir,
      port: parsePositiveInt(options.port, 'port'),
      rpcWsPort: parsePositiveInt(options.rpcWsPort, 'rpc-ws-port')
    });
    printResult(
      exportDiagnosticZip({
        traceId,
        dataDir,
        outPath: options.out ? resolve(String(options.out)) : undefined,
        doctorReport,
        includeSnapshots: options.includeSnapshots === true,
        includeMemory: options.includeMemory === true,
        memoryBackend: 'sqlite'
      })
    );
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
    printResult(
      runGc({
        dataDir: options.dataDir ? String(options.dataDir) : undefined,
        traceDays: parseNonNegativeInt(options.traceDays, 'trace-days'),
        snapshotDays: parseNonNegativeInt(options.snapshotDays, 'snapshot-days'),
        traceKeep: parseNonNegativeInt(options.traceKeep, 'trace-keep'),
        snapshotKeep: parseNonNegativeInt(options.snapshotKeep, 'snapshot-keep'),
        force: Boolean(options.force)
      })
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
