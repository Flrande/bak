import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { callRpc } from './rpc/client.js';
import { exportDiagnosticZip } from './diagnostic-export.js';
import { runDoctor } from './doctor.js';
import { runGc } from './gc.js';
import {
  dragDropLocatorsFromOptions,
  hasLocatorOptions,
  locatorFromOptions,
  parseFiniteNumber,
  parseNonNegativeInt,
  parseOptionalPositiveInt,
  parsePositiveInt
} from './cli-args.js';
import { PairingStore } from './pairing-store.js';
import { startBakDaemon } from './server.js';
import { readEnvInt } from './utils.js';

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

function parseRpcPort(options: { rpcWsPort?: string }): number {
  const port = parsePositiveInt(options.rpcWsPort ?? DEFAULT_RPC_PORT, 'rpc-ws-port');
  if (port > 65535) {
    throw new Error('rpc-ws-port must be <= 65535');
  }
  return port;
}

function parseTabId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('tab-id must be an integer >= 0');
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('tab-id must be an integer >= 0');
  }
  return parsed;
}

function parseSessionId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const sessionId = String(value).trim();
  if (!sessionId) {
    return undefined;
  }
  return sessionId;
}

function parseScope(value: unknown): 'current' | 'main' | 'all-frames' | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const scope = String(value).trim();
  if (scope === 'current' || scope === 'main' || scope === 'all-frames') {
    return scope;
  }
  throw new Error('scope must be one of: current, main, all-frames');
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(String).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseHeaderEntries(values: unknown): Record<string, string> | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const raw of values.map(String)) {
    const index = raw.indexOf(':');
    if (index <= 0) {
      throw new Error('header must use Name:Value format');
    }
    const name = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (!name) {
      throw new Error('header name is required');
    }
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function writeJsonFile(path: string, value: unknown): { outPath: string; bytes: number } {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const outPath = resolve(path);
  writeFileSync(outPath, content, 'utf8');
  return {
    outPath,
    bytes: Buffer.byteLength(content, 'utf8')
  };
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
  return command.option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`);
}

function addTabOption(command: Command): Command {
  return command.option('--session-id <sessionId>', 'target session id').option('--tab-id <tabId>', 'explicit session tab id to target');
}

function addSessionOption(command: Command): Command {
  return command.option('--session-id <sessionId>', 'target session id');
}

function targetParams(options: { tabId?: unknown; sessionId?: unknown }): { tabId?: number; sessionId?: string } {
  return {
    tabId: parseTabId(options.tabId),
    sessionId: parseSessionId(options.sessionId)
  };
}

function addLocatorOptions(command: Command): Command {
  return command
    .option('--locator <json>', 'full locator JSON payload')
    .option('--eid <eid>', 'element id from a snapshot element map')
    .option('--role <role>', 'accessible role')
    .option('--name <name>', 'accessible name')
    .option('--text <text>', 'visible text match')
    .option('--css <css>', 'CSS selector')
    .option('--xpath <xpath>', 'XPath selector')
    .option('--index <index>', 'zero-based match index')
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
    .option(`--${prefix}-css <css>`, `${label} CSS selector`)
    .option(`--${prefix}-xpath <xpath>`, `${label} XPath selector`)
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

function addStructuredHelp(command: Command, options: { notes?: string[]; examples?: string[] }): Command {
  const sections: string[] = [];

  if (options.notes && options.notes.length > 0) {
    sections.push(`Notes:\n${options.notes.map((line) => `  ${line}`).join('\n')}`);
  }

  if (options.examples && options.examples.length > 0) {
    sections.push(`Examples:\n${options.examples.map((line) => `  ${line}`).join('\n')}`);
  }

  if (sections.length > 0) {
    command.addHelpText('after', `\n${sections.join('\n\n')}\n`);
  }

  return command;
}

export function createProgram(): Command {
const program = new Command();
program
  .name('bak')
  .description('Drive a real Chromium browser for an agent through the paired bak daemon and extension')
  .version(readCliVersion())
  .option('--json-errors', 'print structured JSON errors', false)
  .showHelpAfterError()
  .showSuggestionAfterError();

addStructuredHelp(program, {
  notes: [
    'All commands print machine-friendly JSON.',
    'Use --session-id for session-scoped commands and --tab-id to override a session tab.',
    'Create a session before using session, page, element, context, debug, network, keyboard, mouse, or file commands.',
    'Use bak call when the protocol exposes a method without a dedicated CLI command.'
  ],
  examples: [
    'bak setup',
    'bak serve --port 17373 --rpc-ws-port 17374',
    'bak doctor --port 17373 --rpc-ws-port 17374',
    'bak session ensure --session-id session_123 --rpc-ws-port 17374',
    'bak page title --rpc-ws-port 17374'
  ]
});

addStructuredHelp(
  program
    .command('setup')
    .summary('Create a pairing token and print the first-run commands')
    .description('Create a pairing token and print the first-run commands for the daemon and health check')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--ttl-days <days>', 'pair token lifetime in days', `${DEFAULT_PAIR_TTL_DAYS}`)
  .option('--json', 'print the setup payload as JSON', false),
  {
    notes: [
      'Run this first when pairing a browser profile with the local daemon.',
      'The token from setup is what you paste into the extension popup.'
    ],
    examples: [
      'bak setup',
      'bak setup --json',
      'bak setup --port 17373 --rpc-ws-port 17374 --ttl-days 7'
    ]
  }
)
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

addStructuredHelp(
  program
    .command('serve')
    .summary('Start the local daemon and RPC servers')
    .description('Start the bak daemon with the extension bridge and JSON-RPC servers')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--pair', 'rotate a pairing token at startup and print it', false)
  .option('--pair-ttl-days <days>', 'pair token lifetime used with --pair', `${DEFAULT_PAIR_TTL_DAYS}`),
  {
    notes: [
      'Leave this process running while the extension and agent are using bak.',
      'Use --pair when you want serve to mint a fresh token at startup.'
    ],
    examples: [
      'bak serve --port 17373 --rpc-ws-port 17374',
      'bak serve --pair --pair-ttl-days 7'
    ]
  }
)
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
        `[bak] paired=${status.paired} state=${status.connectionState} extensionConnected=${status.extensionConnected} heartbeatStale=${status.heartbeatStale} protocol=${status.protocolVersion}\n`
      );
    }, 15_000);
  });

const pair = program
  .command('pair')
  .summary('Rotate, inspect, or revoke pairing tokens')
  .description('Rotate, inspect, or revoke pairing tokens outside the guided setup flow');
addStructuredHelp(pair, {
  notes: [
    'Use these commands for token rotation and diagnostics after the initial setup.',
    'bak setup remains the simplest first-run entrypoint.'
  ]
});
addStructuredHelp(
  pair
    .command('create')
    .description('Create a new pairing token')
    .option('--ttl-days <days>', 'pair token lifetime in days', `${DEFAULT_PAIR_TTL_DAYS}`),
  {
    examples: ['bak pair create', 'bak pair create --ttl-days 7']
  }
)
  .action((options) => {
    const ttlDays = parsePositiveInt(options.ttlDays, 'ttl-days');
    const store = new PairingStore();
    printResult(store.createToken({ ttlDays, reason: 'manual-rotate' }));
  });
addStructuredHelp(
  pair.command('revoke').description('Revoke the active pairing token').option('--reason <reason>', 'revocation reason', 'manual-revoke'),
  {
    examples: ['bak pair revoke --reason "rotation"']
  }
).action((options) => printResult(new PairingStore().revokeActive(String(options.reason))));
addStructuredHelp(pair.command('status').description('Show the current pairing token state'), {
  examples: ['bak pair status']
}).action(() => printResult(new PairingStore().status()));

addStructuredHelp(
  program
    .command('doctor')
    .summary('Check daemon, extension, and ports')
    .description('Run local diagnostics for the bak runtime, pairing state, and connectivity')
  .option('--port <port>', 'extension websocket port', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port', `${DEFAULT_RPC_PORT}`)
  .option('--data-dir <path>', 'override the data directory'),
  {
    notes: [
      'Run doctor before browser work and again after any pairing or extension issue.',
      'The result highlights blocking errors separately from advisory warnings.'
    ],
    examples: [
      'bak doctor --port 17373 --rpc-ws-port 17374',
      'bak doctor --data-dir (Join-Path $env:LOCALAPPDATA \'bak\')'
    ]
  }
)
  .action(async (options) => {
    printResult(
      await runDoctor({
        port: parsePositiveInt(options.port, 'port'),
        rpcWsPort: parsePositiveInt(options.rpcWsPort, 'rpc-ws-port'),
        dataDir: options.dataDir ? resolve(String(options.dataDir)) : undefined
      })
    );
  });

addStructuredHelp(
  addRpcPortOption(
    program
      .command('call')
      .summary('Call a protocol method without a dedicated CLI command')
      .description('Call a JSON-RPC method over WebSocket when the protocol has no dedicated bak subcommand')
      .requiredOption('--method <method>', 'protocol method name')
      .option('--params <json>', 'params JSON string', '{}')
  ),
  {
    notes: [
      'Use this for protocol-only methods such as page.reload, page.back, page.forward, or page.scrollTo.',
      'Prefer first-class bak commands when they exist because they are easier to discover and script.'
    ],
    examples: [
      'bak call --method page.reload --params "{}" --rpc-ws-port 17374',
      'bak call --method page.scrollTo --params "{\\"x\\":0,\\"y\\":640}" --rpc-ws-port 17374'
    ]
  }
).action(async (options) => invoke(String(options.method), parseJson(String(options.params)), parseRpcPort(options)));

const session = program
  .command('session')
  .summary('Create and inspect agent sessions')
  .description('Manage multi-agent sessions and their dedicated browser state');
addStructuredHelp(session, {
  notes: ['Each session owns one dedicated browser binding and one default active tab/context state.'],
  examples: [
    'bak session create --client-name agent-a --rpc-ws-port 17374',
    'bak session list --rpc-ws-port 17374',
    'bak session ensure --session-id session_123 --rpc-ws-port 17374',
    'bak session open-tab --session-id session_123 --url "https://example.com" --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(session.command('create').description('Create a new agent session').option('--client-name <name>', 'display label for the agent session')), {
  examples: ['bak session create --client-name agent-a --rpc-ws-port 17374']
}).action(async (options) =>
  invoke(
    'session.create',
    {
      clientName: options.clientName ? String(options.clientName) : undefined
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(session.command('list').description('List active sessions')), {
  examples: ['bak session list --rpc-ws-port 17374']
}).action(async (options) => invoke('session.list', {}, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addSessionOption(session.command('info').description('Show session state and current context'))), {
  examples: ['bak session info --session-id session_123 --rpc-ws-port 17374']
}).action(async (options) => invoke('session.info', { sessionId: parseSessionId(options.sessionId) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addSessionOption(session.command('close').description('Close a session and its browser state'))), {
  examples: ['bak session close --session-id session_123 --rpc-ws-port 17374']
}).action(async (options) => invoke('session.close', { sessionId: parseSessionId(options.sessionId) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addSessionOption(
      session
        .command('ensure')
        .description('Create or repair the dedicated browser window, group, and tracked tabs for a session')
        .option('--url <url>', 'initial or recovery URL')
        .option('--focus', 'focus the session window', false)
    )
  ),
  {
    examples: [
      'bak session ensure --session-id session_123 --rpc-ws-port 17374',
      'bak session ensure --session-id session_123 --url "https://example.com" --focus --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'session.ensure',
    {
      sessionId: parseSessionId(options.sessionId),
      url: options.url ? String(options.url) : undefined,
      focus: options.focus === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addSessionOption(
      session
        .command('open-tab')
        .description('Open a tab inside the dedicated session window and tab group')
        .option('--url <url>', 'initial URL')
        .option('--active', 'activate the tab inside the session window', false)
        .option('--focus', 'focus the session window', false)
    )
  ),
  {
    examples: ['bak session open-tab --session-id session_123 --url "https://example.com" --rpc-ws-port 17374']
  }
).action(async (options) =>
  invoke(
    'session.openTab',
    {
      sessionId: parseSessionId(options.sessionId),
      url: options.url ? String(options.url) : undefined,
      active: options.active === true,
      focus: options.focus === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addSessionOption(session.command('list-tabs').description('List the tabs tracked by a session'))), {
  examples: ['bak session list-tabs --session-id session_123 --rpc-ws-port 17374']
}).action(async (options) => invoke('session.listTabs', { sessionId: parseSessionId(options.sessionId) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addSessionOption(session.command('get-active-tab').description('Show the current tab used by default session browser commands'))), {
  examples: ['bak session get-active-tab --session-id session_123 --rpc-ws-port 17374']
}).action(async (options) => invoke('session.getActiveTab', { sessionId: parseSessionId(options.sessionId) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addSessionOption(
      session
        .command('set-active-tab')
        .description('Set the current tab used by default session browser commands')
        .requiredOption('--tab-id <tabId>', 'session tab id to make current')
    )
  ),
  {
    examples: ['bak session set-active-tab --session-id session_123 --tab-id 123 --rpc-ws-port 17374']
  }
).action(async (options) =>
  invoke(
    'session.setActiveTab',
    {
      sessionId: parseSessionId(options.sessionId),
      tabId: parseTabId(options.tabId)
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addSessionOption(session.command('focus').description('Bring the dedicated session window to the front'))), {
  examples: ['bak session focus --session-id session_123 --rpc-ws-port 17374']
}).action(async (options) => invoke('session.focus', { sessionId: parseSessionId(options.sessionId) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addSessionOption(
      session
        .command('reset')
        .description('Recreate the dedicated session window and grouping state')
        .option('--url <url>', 'initial URL')
        .option('--focus', 'focus the session window', false)
    )
  ),
  {
    examples: [
      'bak session reset --session-id session_123 --rpc-ws-port 17374',
      'bak session reset --session-id session_123 --url "https://example.com" --focus --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'session.reset',
    {
      sessionId: parseSessionId(options.sessionId),
      url: options.url ? String(options.url) : undefined,
      focus: options.focus === true
    },
    parseRpcPort(options)
  )
);

const tabs = program
  .command('tabs')
  .summary('List, open, focus, inspect, and close tabs')
  .description('Inspect and control browser tabs directly');
addStructuredHelp(tabs, {
  notes: [
    'Use tabs commands when you want direct browser tab control outside the session helpers.',
    'Most day-to-day agent work is easier with session ensure and session open-tab.'
  ]
});
addStructuredHelp(addRpcPortOption(tabs.command('list').description('List tabs visible to the connected browser')), {
  examples: ['bak tabs list --rpc-ws-port 17374']
}).action(async (options) => invoke('tabs.list', {}, parseRpcPort(options)));
addRpcPortOption(
  tabs
    .command('new')
    .description('Open a new browser tab')
    .option('--url <url>', 'initial URL')
    .option('--active', 'make the created tab active in its window', false)
    .option('--window-id <windowId>', 'target browser window id')
    .option('--add-to-group', 'group the new tab when creating in a window', false)
).action(async (options) =>
  invoke(
    'tabs.new',
    {
      url: options.url ? String(options.url) : undefined,
      active: options.active === true,
      windowId: parseNonNegativeInt(options.windowId, 'window-id'),
      addToGroup: options.addToGroup === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(tabs.command('focus <tabId>').description('Focus a tab by id')), {
  examples: ['bak tabs focus 123 --rpc-ws-port 17374']
}).action(async (tabId, options) => invoke('tabs.focus', { tabId: parsePositiveInt(tabId, 'tabId') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(tabs.command('close <tabId>').description('Close a tab by id')), {
  examples: ['bak tabs close 123 --rpc-ws-port 17374']
}).action(async (tabId, options) => invoke('tabs.close', { tabId: parsePositiveInt(tabId, 'tabId') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(tabs.command('get <tabId>').description('Show tab metadata by id')), {
  examples: ['bak tabs get 123 --rpc-ws-port 17374']
}).action(async (tabId, options) => invoke('tabs.get', { tabId: parsePositiveInt(tabId, 'tabId') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(tabs.command('active').description('Show the browser active tab')), {
  examples: ['bak tabs active --rpc-ws-port 17374']
}).action(async (options) => invoke('tabs.getActive', {}, parseRpcPort(options)));

const page = program
  .command('page')
  .summary('Navigate, wait, and read the current document')
  .description('Navigate the target tab and read the current document in the active frame or shadow context');
addStructuredHelp(page, {
  notes: [
    'Page reads reflect the active frame or shadow context, not always the top-level tab document.',
    'Use page eval, extract, and fetch when important runtime data lives in script state instead of visible DOM.',
    'Use bak call for protocol-only navigation helpers such as page.back, page.forward, page.reload, and page.scrollTo.'
  ],
  examples: [
    'bak page goto "https://example.com" --rpc-ws-port 17374',
    'bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374',
    'bak page extract --path "market_data.QQQ" --rpc-ws-port 17374',
    'bak page snapshot --include-base64 --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(page.command('goto <url>').description('Navigate the target tab to a URL'))), {
  examples: ['bak page goto "https://example.com" --rpc-ws-port 17374']
}).action(async (url, options) => invoke('page.goto', { url: String(url), ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(page.command('wait').description('Wait for a selector, text, or URL match').requiredOption('--mode <mode>', 'selector|text|url').requiredOption('--value <value>', 'selector, text, or URL matcher').option('--timeout-ms <timeoutMs>', 'timeout in milliseconds'))), {
  notes: [
    'Use selector waits before element actions when the page is still rendering.',
    'Use text waits when the page reaches a stable user-facing state before continuing.'
  ],
  examples: [
    'bak page wait --mode selector --value "#submit" --rpc-ws-port 17374',
    'bak page wait --mode text --value "Saved" --timeout-ms 10000 --rpc-ws-port 17374'
  ]
}).action(async (options) => invoke('page.wait', { ...targetParams(options), mode: String(options.mode), value: String(options.value), timeoutMs: parsePositiveInt(options.timeoutMs, 'timeout-ms') }, parseRpcPort(options)));
for (const [name, method, description] of [
  ['url', 'page.url', 'Show the current document URL'],
  ['title', 'page.title', 'Show the current document title'],
  ['snapshot', 'page.snapshot', 'Capture a viewport snapshot and element map'],
  ['text', 'page.text', 'Extract visible text chunks from the current document'],
  ['dom', 'page.dom', 'Summarize the current DOM structure'],
  ['a11y', 'page.accessibilityTree', 'Read the accessibility tree for the current document'],
  ['metrics', 'page.metrics', 'Show performance and resource metrics']
] as const) {
  const command = addRpcPortOption(addTabOption(page.command(name).description(description)));
  if (name === 'snapshot') {
    command.option('--include-base64', 'include imageBase64 in the result', false);
    addStructuredHelp(command, {
      examples: ['bak page snapshot --include-base64 --rpc-ws-port 17374']
    });
  } else {
    addStructuredHelp(command, {
      examples: [`bak page ${name} --rpc-ws-port 17374`]
    });
  }
  command.action(async (options) =>
    invoke(
      method,
      {
        ...targetParams(options),
        includeBase64: options.includeBase64 === true ? true : undefined
      },
      parseRpcPort(options)
    )
  );
}
addStructuredHelp(addRpcPortOption(addTabOption(page.command('viewport').description('Resize or inspect the page viewport').option('--width <width>', 'width').option('--height <height>', 'height'))), {
  examples: [
    'bak page viewport --rpc-ws-port 17374',
    'bak page viewport --width 1440 --height 900 --rpc-ws-port 17374'
  ]
}).action(async (options) => invoke('page.viewport', { ...targetParams(options), width: parseOptionalPositiveInt(options.width, 'width'), height: parseOptionalPositiveInt(options.height, 'height') }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      page
        .command('eval')
        .description('Evaluate a page-world JavaScript expression and return a structured-clone-safe result')
        .requiredOption('--expr <expr>', 'JavaScript expression evaluated in page world')
        .option('--scope <scope>', 'current|main|all-frames')
        .option('--max-bytes <bytes>', 'max serialized result size in bytes')
    )
  ),
  {
    notes: [
      'Use page eval when the data you need is exposed only through runtime JS state.',
      'Results are limited to structured-clone-safe data and may be truncated by --max-bytes.'
    ],
    examples: [
      'bak page eval --expr "window.table_data?.length" --rpc-ws-port 17374',
      'bak page eval --expr "window.market_data?.QQQ" --scope all-frames --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'page.eval',
    {
      ...targetParams(options),
      expr: String(options.expr),
      scope: parseScope(options.scope),
      maxBytes: parseOptionalPositiveInt(options.maxBytes, 'max-bytes')
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      page
        .command('extract')
        .description('Extract a global variable path from page world without allowing arbitrary function calls')
        .requiredOption('--path <path>', 'globalThis path such as market_data.QQQ.quotes.changePercent')
        .option('--resolver <resolver>', 'auto|globalThis|lexical', 'auto')
        .option('--scope <scope>', 'current|main|all-frames')
        .option('--max-bytes <bytes>', 'max serialized result size in bytes')
    )
  ),
  {
    notes: [
      'Use page extract first when you know the variable path and want the safer read-only option.',
      'auto tries globalThis first, then falls back to lexical page-world bindings when the path is not on window.',
      'Paths support dotted segments plus array indexes.'
    ],
    examples: [
      'bak page extract --path "table_data" --resolver auto --rpc-ws-port 17374',
      'bak page extract --path "market_data.QQQ.quotes.changePercent" --resolver lexical --scope main --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'page.extract',
    {
      ...targetParams(options),
      path: String(options.path),
      resolver: options.resolver ? String(options.resolver) : undefined,
      scope: parseScope(options.scope),
      maxBytes: parseOptionalPositiveInt(options.maxBytes, 'max-bytes')
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      page
        .command('fetch')
        .description('Issue a fetch request from the page context so cookies and page session state are preserved')
        .requiredOption('--url <url>', 'request URL')
        .option('--method <method>', 'HTTP method', 'GET')
        .option('--header <name:value...>', 'header entries in Name:Value form')
        .option('--body <body>', 'request body text')
        .option('--content-type <contentType>', 'content type header value')
        .option('--mode <mode>', 'raw|json', 'raw')
        .option('--timeout-ms <timeoutMs>', 'timeout in milliseconds')
        .option('--scope <scope>', 'current|main|all-frames')
        .option('--max-bytes <bytes>', 'max response body bytes to retain')
        .option('--requires-confirm', 'confirm that this request is safe to send from the page context', false)
    )
  ),
  {
    notes: [
      'page fetch executes inside the page context and can reuse login state, CSRF tokens, and same-origin headers.',
      'Use network replay when you want to start from a previously captured request.'
    ],
    examples: [
      'bak page fetch --url "https://example.com/api/data" --method POST --body "{}" --content-type "application/json" --rpc-ws-port 17374',
      'bak page fetch --url "https://example.com/feed" --mode json --header "Accept: application/json" --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'page.fetch',
    {
      ...targetParams(options),
      url: String(options.url),
      method: options.method ? String(options.method) : undefined,
      headers: parseHeaderEntries(options.header),
      body: options.body ? String(options.body) : undefined,
      contentType: options.contentType ? String(options.contentType) : undefined,
      mode: options.mode ? String(options.mode) : undefined,
      timeoutMs: parseOptionalPositiveInt(options.timeoutMs, 'timeout-ms'),
      scope: parseScope(options.scope),
      maxBytes: parseOptionalPositiveInt(options.maxBytes, 'max-bytes'),
      requiresConfirm: options.requiresConfirm === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      page
        .command('freshness')
        .description('Assess whether the page appears fresh, lagged, stale, or unknown based on DOM, inline data, and network signals')
        .option('--patterns <pattern...>', 'additional timestamp regex patterns to scan')
        .option('--fresh-window-ms <ms>', 'max age in milliseconds considered fresh')
        .option('--stale-window-ms <ms>', 'age threshold in milliseconds considered stale')
    )
  ),
  {
    examples: [
      'bak page freshness --rpc-ws-port 17374',
      'bak page freshness --patterns "20\\\\d{2}-\\\\d{2}-\\\\d{2}" "Today" --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'page.freshness',
    {
      ...targetParams(options),
      patterns: parseStringList(options.patterns),
      freshWindowMs: parseOptionalPositiveInt(options.freshWindowMs, 'fresh-window-ms'),
      staleWindowMs: parseOptionalPositiveInt(options.staleWindowMs, 'stale-window-ms')
    },
    parseRpcPort(options)
  )
);

const debug = program
  .command('debug')
  .summary('Read structured console, network, and snapshot state')
  .description('Collect structured debug output for the current browser context');
addStructuredHelp(debug, {
  notes: [
    'Use debug output to verify what the page looks like before retrying or escalating.',
    'Console and network data are useful agent context but still best-effort rather than full DevTools parity.'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(debug.command('console').description('Read recent structured console entries').option('--limit <limit>', 'max number of entries', '50'))), {
  examples: ['bak debug console --limit 20 --rpc-ws-port 17374']
}).action(async (options) => invoke('debug.getConsole', { ...targetParams(options), limit: parsePositiveInt(options.limit, 'limit') }, parseRpcPort(options)));
addRpcPortOption(
  addTabOption(
    debug
      .command('dump-state')
      .description('Capture a structured debug bundle for the current browser context')
      .option('--console-limit <limit>', 'console entry limit', '80')
      .option('--network-limit <limit>', 'network entry limit', '80')
      .option('--section <section...>', 'subset of sections: dom|visible-text|scripts|globals-preview|network-summary|storage|frames')
      .option('--include-a11y', 'include accessibility nodes', false)
      .option('--include-snapshot', 'attach a fresh viewport snapshot to the dump', false)
      .option('--include-snapshot-base64', 'include snapshot imageBase64 when a snapshot is attached', false)
  )
).action(async (options) =>
  invoke(
    'debug.dumpState',
    {
      ...targetParams(options),
      consoleLimit: parsePositiveInt(options.consoleLimit, 'console-limit'),
      networkLimit: parsePositiveInt(options.networkLimit, 'network-limit'),
      section: parseStringList(options.section),
      includeAccessibility: options.includeA11y === true,
      includeSnapshot: options.includeSnapshot === true,
      includeSnapshotBase64: options.includeSnapshotBase64 === true
    },
    parseRpcPort(options)
  )
);

const network = program
  .command('network')
  .summary('Inspect captured page requests')
  .description('Read recent network activity captured from the current page');
addStructuredHelp(network, {
  notes: [
    'Use network wait when the page needs a specific request to finish before the next action.',
    'Use network search and replay to turn dynamic page loading into a reproducible data workflow.'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(network.command('list').description('List captured network entries').option('--limit <limit>', 'result limit', '50').option('--url-includes <text>', 'URL substring').option('--status <status>', 'status code').option('--method <method>', 'HTTP method'))), {
  examples: ['bak network list --url-includes "/api/" --limit 20 --rpc-ws-port 17374']
}).action(async (options) => invoke('network.list', { ...targetParams(options), limit: parsePositiveInt(options.limit, 'limit'), urlIncludes: options.urlIncludes ? String(options.urlIncludes) : undefined, status: parseNonNegativeInt(options.status, 'status'), method: options.method ? String(options.method) : undefined }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      network
        .command('get <id>')
        .description('Show a single network entry by id')
        .option('--include <section...>', 'sections to include: request response')
        .option('--body-bytes <bytes>', 'max request or response body preview bytes')
    )
  ),
  {
    examples: [
      'bak network get req_123 --rpc-ws-port 17374',
      'bak network get req_123 --include request response --body-bytes 4096 --rpc-ws-port 17374'
    ]
  }
).action(async (id, options) =>
  invoke(
    'network.get',
    {
      ...targetParams(options),
      id: String(id),
      include: parseStringList(options.include),
      bodyBytes: parseOptionalPositiveInt(options.bodyBytes, 'body-bytes')
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addTabOption(network.command('wait').description('Wait for a matching network entry').option('--url-includes <text>', 'URL substring').option('--status <status>', 'status code').option('--method <method>', 'HTTP method').option('--timeout-ms <timeoutMs>', 'timeout in milliseconds', '5000'))), {
  examples: ['bak network wait --url-includes "/api/save" --status 200 --rpc-ws-port 17374']
}).action(async (options) => invoke('network.waitFor', { ...targetParams(options), urlIncludes: options.urlIncludes ? String(options.urlIncludes) : undefined, status: parseNonNegativeInt(options.status, 'status'), method: options.method ? String(options.method) : undefined, timeoutMs: parsePositiveInt(options.timeoutMs, 'timeout-ms') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(network.command('clear').description('Clear captured network history for the target tab'))), {
  examples: ['bak network clear --rpc-ws-port 17374']
}).action(async (options) => invoke('network.clear', { ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      network
        .command('search')
        .description('Search recent network entries by URL, headers, or body preview')
        .requiredOption('--pattern <pattern>', 'search pattern')
        .option('--limit <limit>', 'max number of entries', '50')
    )
  ),
  {
    examples: [
      'bak network search --pattern "get_updated_data_" --rpc-ws-port 17374',
      'bak network search --pattern "table_data" --limit 10 --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'network.search',
    {
      ...targetParams(options),
      pattern: String(options.pattern),
      limit: parsePositiveInt(options.limit, 'limit')
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      network
        .command('replay')
        .description('Replay a captured network request through the current page context')
        .requiredOption('--request-id <id>', 'captured request id')
        .option('--mode <mode>', 'raw|json', 'raw')
        .option('--with-schema <mode>', 'auto')
        .option('--timeout-ms <timeoutMs>', 'timeout in milliseconds')
        .option('--max-bytes <bytes>', 'max response body bytes to retain')
        .option('--requires-confirm', 'confirm that replaying the captured request is safe', false)
    )
  ),
  {
    examples: [
      'bak network replay --request-id req_123 --rpc-ws-port 17374',
      'bak network replay --request-id req_123 --mode json --with-schema auto --max-bytes 8192 --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'network.replay',
    {
      ...targetParams(options),
      id: String(options.requestId),
      mode: options.mode ? String(options.mode) : undefined,
      withSchema: options.withSchema ? String(options.withSchema) : undefined,
      timeoutMs: parseOptionalPositiveInt(options.timeoutMs, 'timeout-ms'),
      maxBytes: parseOptionalPositiveInt(options.maxBytes, 'max-bytes'),
      requiresConfirm: options.requiresConfirm === true
    },
    parseRpcPort(options)
  )
);

const table = program
  .command('table')
  .summary('Inspect structured tables and virtual grids')
  .description('Discover tables and extract rows from HTML tables or grid-like components');
addStructuredHelp(table, {
  notes: [
    'Use table commands when page text is incomplete because the UI renders only the visible rows.',
    'rows --all prefers data-source extraction, then scroll stitching, then visible-only fallback.'
  ],
  examples: [
    'bak table list --rpc-ws-port 17374',
    'bak table rows --table table-1 --all --rpc-ws-port 17374',
    'bak table export --table table-1 --out .\\table.json --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(table.command('list').description('List candidate tables or grid-like regions on the page'))), {
  examples: ['bak table list --rpc-ws-port 17374']
}).action(async (options) => invoke('table.list', { ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(addTabOption(table.command('schema').description('Read the detected schema for a table or grid').requiredOption('--table <table>', 'table id from table list'))),
  {
    examples: ['bak table schema --table table-1 --rpc-ws-port 17374']
  }
).action(async (options) =>
  invoke(
    'table.schema',
    {
      ...targetParams(options),
      table: String(options.table)
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      table
        .command('rows')
        .description('Read rows from a detected table or grid')
        .requiredOption('--table <table>', 'table id from table list')
        .option('--limit <limit>', 'row limit', '100')
        .option('--all', 'attempt to read all rows up to --max-rows', false)
        .option('--max-rows <maxRows>', 'max rows when --all is enabled', '10000')
    )
  ),
  {
    examples: [
      'bak table rows --table table-1 --limit 50 --rpc-ws-port 17374',
      'bak table rows --table table-1 --all --max-rows 10000 --rpc-ws-port 17374'
    ]
  }
).action(async (options) =>
  invoke(
    'table.rows',
    {
      ...targetParams(options),
      table: String(options.table),
      limit: parsePositiveInt(options.limit, 'limit'),
      all: options.all === true,
      maxRows: parsePositiveInt(options.maxRows, 'max-rows')
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      table
        .command('export')
        .description('Export rows from a detected table or grid')
        .requiredOption('--table <table>', 'table id from table list')
        .option('--format <format>', 'export format', 'json')
        .option('--out <path>', 'write the export payload to a file')
    )
  ),
  {
    examples: [
      'bak table export --table table-1 --format json --rpc-ws-port 17374',
      'bak table export --table table-1 --out .\\table.json --rpc-ws-port 17374'
    ]
  }
).action(async (options) => {
  const result = await callRpc(
    'table.export',
    {
      ...targetParams(options),
      table: String(options.table),
      format: options.format ? String(options.format) : undefined
    },
    parseRpcPort(options)
  );
  if (options.out) {
    printResult({
      ok: true,
      format: String(options.format ?? 'json'),
      ...writeJsonFile(String(options.out), result)
    });
    return;
  }
  printResult(result);
});

const inspect = program
  .command('inspect')
  .summary('Run higher-level discovery workflows for dynamic pages')
  .description('Summarize candidate data sources, live update signals, and freshness cues for agent workflows');
addStructuredHelp(inspect, {
  notes: ['Inspect commands are intended as discovery helpers built on top of page, table, network, and freshness primitives.'],
  examples: [
    'bak inspect page-data --rpc-ws-port 17374',
    'bak inspect live-updates --rpc-ws-port 17374',
    'bak inspect freshness --patterns "20\\\\d{2}-\\\\d{2}-\\\\d{2}" --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(inspect.command('page-data').description('Summarize likely inline data variables, tables, and recent requests'))), {
  examples: ['bak inspect page-data --rpc-ws-port 17374']
}).action(async (options) => invoke('inspect.pageData', { ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(inspect.command('live-updates').description('Summarize recent mutations, timers, and network cadence'))), {
  examples: ['bak inspect live-updates --rpc-ws-port 17374']
}).action(async (options) => invoke('inspect.liveUpdates', { ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      inspect
        .command('freshness')
        .description('Summarize freshness with UI, inline, and network timing cues')
        .option('--patterns <pattern...>', 'additional timestamp regex patterns to scan')
    )
  ),
  {
    examples: ['bak inspect freshness --patterns "Today" "yesterday" --rpc-ws-port 17374']
  }
).action(async (options) =>
  invoke(
    'inspect.freshness',
    {
      ...targetParams(options),
      patterns: parseStringList(options.patterns)
    },
    parseRpcPort(options)
  )
);

const capture = program
  .command('capture')
  .summary('Export snapshot archives for offline analysis')
  .description('Capture structured session snapshots or HAR payloads for replay and debugging');
addStructuredHelp(capture, {
  examples: [
    'bak capture snapshot --out .\\session.json --rpc-ws-port 17374',
    'bak capture har --out .\\session.har --rpc-ws-port 17374'
  ]
});
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      capture
        .command('snapshot')
        .description('Capture a structured page snapshot including visible text, freshness, and recent network activity')
        .option('--network-limit <limit>', 'max network entries to include', '20')
        .option('--out <path>', 'write the snapshot payload to a file')
    )
  ),
  {
    examples: [
      'bak capture snapshot --rpc-ws-port 17374',
      'bak capture snapshot --network-limit 50 --out .\\tradytics-session.json --rpc-ws-port 17374'
    ]
  }
).action(async (options) => {
  const result = await callRpc(
    'capture.snapshot',
    {
      ...targetParams(options),
      networkLimit: parsePositiveInt(options.networkLimit, 'network-limit')
    },
    parseRpcPort(options)
  );
  if (options.out) {
    printResult({
      ok: true,
      format: 'json',
      ...writeJsonFile(String(options.out), result)
    });
    return;
  }
  printResult(result);
});
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      capture
        .command('har')
        .description('Capture recent network activity as HAR 1.2 JSON')
        .option('--limit <limit>', 'max network entries to include')
        .option('--out <path>', 'write the HAR payload to a file')
    )
  ),
  {
    examples: [
      'bak capture har --rpc-ws-port 17374',
      'bak capture har --limit 200 --out .\\tradytics.har --rpc-ws-port 17374'
    ]
  }
).action(async (options) => {
  const result = await callRpc(
    'capture.har',
    {
      ...targetParams(options),
      limit: parseOptionalPositiveInt(options.limit, 'limit')
    },
    parseRpcPort(options)
  );
  if (options.out) {
    const harPayload = typeof result === 'object' && result !== null && 'har' in (result as Record<string, unknown>) ? (result as { har: unknown }).har : result;
    printResult({
      ok: true,
      format: 'har',
      ...writeJsonFile(String(options.out), harPayload)
    });
    return;
  }
  printResult(result);
});

const context = program
  .command('context')
  .summary('Enter and reset frame or shadow DOM context')
  .description('Manage the session-scoped frame and shadow context used by page, debug, and element commands');
addStructuredHelp(context, {
  notes: [
    'Context changes affect subsequent page reads, debug dumps, and element actions.',
    'Use context reset when you want to return to the top-level document before continuing.'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(context.command('enter-frame').description('Enter a frame context by selector path').option('--frame-path <selector...>', 'frame path selectors'))), {
  examples: ['bak context enter-frame --frame-path "#demo-frame" --rpc-ws-port 17374']
}).action(async (options) => invoke('context.enterFrame', { ...targetParams(options), framePath: Array.isArray(options.framePath) ? options.framePath.map(String) : undefined }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('exit-frame').description('Exit one or more nested frame levels').option('--levels <levels>', 'levels to exit'))), {
  examples: ['bak context exit-frame --levels 1 --rpc-ws-port 17374']
}).action(async (options) => invoke('context.exitFrame', { ...targetParams(options), levels: parseOptionalPositiveInt(options.levels, 'levels') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('enter-shadow').description('Enter a shadow DOM context by host selector path').option('--host-selectors <selector...>', 'shadow host selectors'))), {
  examples: ['bak context enter-shadow --host-selectors "#shadow-host" --rpc-ws-port 17374']
}).action(async (options) => invoke('context.enterShadow', { ...targetParams(options), hostSelectors: Array.isArray(options.hostSelectors) ? options.hostSelectors.map(String) : undefined }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('exit-shadow').description('Exit one or more shadow DOM levels').option('--levels <levels>', 'levels to exit'))), {
  examples: ['bak context exit-shadow --levels 1 --rpc-ws-port 17374']
}).action(async (options) => invoke('context.exitShadow', { ...targetParams(options), levels: parseOptionalPositiveInt(options.levels, 'levels') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('reset').description('Return to the top-level page context'))), {
  examples: ['bak context reset --rpc-ws-port 17374']
}).action(async (options) => invoke('context.reset', { ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('get').description('Show the current saved context snapshot'))), {
  examples: ['bak context get --session-id session_123 --rpc-ws-port 17374']
}).action(async (options) => invoke('context.get', { ...targetParams(options) }, parseRpcPort(options)));
addStructuredHelp(
  addRpcPortOption(
    addTabOption(
      context
        .command('set')
        .description('Replace the saved context snapshot for a session tab')
        .option('--frame-path <selector...>', 'frame path selectors')
        .option('--host-selectors <selector...>', 'shadow host selectors')
    )
  ),
  {
    examples: ['bak context set --session-id session_123 --frame-path "#demo-frame" --host-selectors "#shadow-host" --rpc-ws-port 17374']
  }
).action(async (options) =>
  invoke(
    'context.set',
    {
      ...targetParams(options),
      framePath: Array.isArray(options.framePath) ? options.framePath.map(String) : undefined,
      shadowPath: Array.isArray(options.hostSelectors) ? options.hostSelectors.map(String) : undefined
    },
    parseRpcPort(options)
  )
);

const element = program
  .command('element')
  .summary('Find, inspect, and interact with DOM elements')
  .description('Inspect and interact with elements using locators that work across page, frame, and shadow contexts');
addStructuredHelp(element, {
  notes: [
    'Pass either --locator JSON or individual locator fields such as --css, --role, --name, or --text.',
    'Element commands run in the active context stack, so enter frames or shadow roots first when needed.',
    'Use page wait before element actions when the target has not rendered yet.'
  ],
  examples: [
    'bak element click --css "#submit" --rpc-ws-port 17374',
    'bak element type --role textbox --name "Email" --value "me@example.com" --clear --rpc-ws-port 17374',
    'bak element drag-drop --from-css "#drag" --to-css "#drop" --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('get').description('Inspect a single element and return its state')))), {
  examples: ['bak element get --css "#submit" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.get', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('click').description('Click an element')))), {
  examples: ['bak element click --css "#submit" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.click', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('type').description('Type text into an element').requiredOption('--value <value>', 'text to type').option('--clear', 'clear before typing', false)))), {
  examples: ['bak element type --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374']
}).action(async (options) => invoke('element.type', { ...targetParams(options), locator: locatorFromOptions(options, parseJson), text: String(options.value), clear: options.clear === true }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('hover').description('Hover an element')))), {
  examples: ['bak element hover --css ".menu-trigger" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.hover', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('double-click').description('Double-click an element')))), {
  examples: ['bak element double-click --css "#row-1" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.doubleClick', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('right-click').description('Open the context menu on an element')))), {
  examples: ['bak element right-click --css "#row-1" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.rightClick', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('select').description('Select one or more values in a form control').requiredOption('--value <value...>', 'selected values')))), {
  examples: ['bak element select --css "#role-select" --value admin --rpc-ws-port 17374']
}).action(async (options) => invoke('element.select', { ...targetParams(options), locator: locatorFromOptions(options, parseJson), values: (options.value as string[]).map(String) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('check').description('Check a checkbox or radio control')))), {
  examples: ['bak element check --css "#agree" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.check', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('uncheck').description('Uncheck a checkbox control')))), {
  examples: ['bak element uncheck --css "#agree" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.uncheck', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('scroll').description('Scroll an element or the page').option('--dx <dx>', 'horizontal delta').option('--dy <dy>', 'vertical delta', '320')))), {
  notes: ['This command accepts negative deltas. Omit locator fields to scroll the page itself.'],
  examples: [
    'bak element scroll --dy 320 --rpc-ws-port 17374',
    'bak element scroll --css "#list" --dy -240 --rpc-ws-port 17374'
  ]
}).action(async (options) => invoke('element.scroll', { ...targetParams(options), locator: hasLocatorOptions(options) ? locatorFromOptions(options, parseJson) : undefined, dx: parseFiniteNumber(options.dx, 'dx'), dy: parseFiniteNumber(options.dy, 'dy') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('scroll-into-view').description('Scroll until an element is in view')))), {
  examples: ['bak element scroll-into-view --css "#submit" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.scrollIntoView', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('focus').description('Focus an element')))), {
  examples: ['bak element focus --css "#note-input" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.focus', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(element.command('blur').description('Blur an element')))), {
  examples: ['bak element blur --css "#note-input" --rpc-ws-port 17374']
}).action(async (options) => invoke('element.blur', { ...targetParams(options), locator: locatorFromOptions(options, parseJson) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(addPrefixedLocatorOptions(addPrefixedLocatorOptions(element.command('drag-drop').description('Drag from one located element to another'), 'from', 'source'), 'to', 'target'))), {
  notes: ['Drag-and-drop requires both a source locator and a target locator.'],
  examples: ['bak element drag-drop --from-css "#drag-source" --to-css "#drop-target" --rpc-ws-port 17374']
}).action(async (options) => {
  const endpoints = dragDropLocatorsFromOptions(options, parseJson);
  return invoke('element.dragDrop', { ...targetParams(options), from: endpoints.from, to: endpoints.to }, parseRpcPort(options));
});

const keyboard = program
  .command('keyboard')
  .summary('Send keyboard input')
  .description('Send single keys, text, or key chords to the current tab');
addStructuredHelp(keyboard, {
  examples: [
    'bak keyboard press Enter --rpc-ws-port 17374',
    'bak keyboard type "hello" --rpc-ws-port 17374',
    'bak keyboard hotkey Control L --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(keyboard.command('press <key>').description('Press a single key'))), {
  examples: ['bak keyboard press Enter --rpc-ws-port 17374']
}).action(async (key, options) => invoke('keyboard.press', { ...targetParams(options), key: String(key) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(keyboard.command('type <text>').description('Type plain text').option('--delay-ms <delayMs>', 'delay per character'))), {
  examples: ['bak keyboard type "notes via keyboard" --delay-ms 25 --rpc-ws-port 17374']
}).action(async (text, options) => invoke('keyboard.type', { ...targetParams(options), text: String(text), delayMs: parseNonNegativeInt(options.delayMs, 'delay-ms') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(keyboard.command('hotkey <keys...>').description('Press a key chord in sequence'))), {
  examples: ['bak keyboard hotkey Control Shift P --rpc-ws-port 17374']
}).action(async (keys, options) => invoke('keyboard.hotkey', { ...targetParams(options), keys: (keys as string[]).map(String) }, parseRpcPort(options)));

const mouse = program
  .command('mouse')
  .summary('Move, click, and wheel-scroll by coordinates')
  .description('Send low-level mouse input using viewport coordinates');
addStructuredHelp(mouse, {
  notes: ['Mouse move and click accept zero coordinates. Mouse wheel accepts negative deltas.'],
  examples: [
    'bak mouse move --x 200 --y 150 --rpc-ws-port 17374',
    'bak mouse click --x 200 --y 150 --button left --rpc-ws-port 17374',
    'bak mouse wheel --dy -240 --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(mouse.command('move').description('Move the mouse pointer').requiredOption('--x <x>', 'x').requiredOption('--y <y>', 'y'))), {
  examples: ['bak mouse move --x 200 --y 150 --rpc-ws-port 17374']
}).action(async (options) => invoke('mouse.move', { ...targetParams(options), x: parseFiniteNumber(options.x, 'x', { min: 0 }), y: parseFiniteNumber(options.y, 'y', { min: 0 }) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(mouse.command('click').description('Click at viewport coordinates').requiredOption('--x <x>', 'x').requiredOption('--y <y>', 'y').option('--button <button>', 'left|middle|right', 'left'))), {
  examples: ['bak mouse click --x 200 --y 150 --button left --rpc-ws-port 17374']
}).action(async (options) => invoke('mouse.click', { ...targetParams(options), x: parseFiniteNumber(options.x, 'x', { min: 0 }), y: parseFiniteNumber(options.y, 'y', { min: 0 }), button: String(options.button) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(mouse.command('wheel').description('Scroll using raw wheel deltas').option('--dx <dx>', 'horizontal delta').option('--dy <dy>', 'vertical delta', '120'))), {
  examples: ['bak mouse wheel --dy -240 --rpc-ws-port 17374']
}).action(async (options) => invoke('mouse.wheel', { ...targetParams(options), dx: parseFiniteNumber(options.dx, 'dx'), dy: parseFiniteNumber(options.dy, 'dy') }, parseRpcPort(options)));

const file = program
  .command('file')
  .summary('Upload files to file inputs')
  .description('Upload local files or inline file payloads to a file input element');
addStructuredHelp(file, {
  notes: ['Use --file-path for local files or --files for inline JSON payloads with base64 content.'],
  examples: [
    'bak file upload --css "#file-input" --file-path .\\report.pdf --rpc-ws-port 17374',
    'bak file upload --css "#file-input" --files "{\\"items\\":[{\\"name\\":\\"notes.txt\\",\\"contentBase64\\":\\"SGVsbG8=\\"}]}" --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(addLocatorOptions(file.command('upload').description('Upload files to an input element').option('--file-path <path...>', 'file path(s)').option('--files <json>', 'file JSON payload')))), {
  examples: ['bak file upload --css "#file-input" --file-path .\\report.pdf --rpc-ws-port 17374']
}).action(async (options) => invoke('file.upload', { ...targetParams(options), locator: locatorFromOptions(options, parseJson), files: uploadFilesFromOptions(options) }, parseRpcPort(options)));

addStructuredHelp(
  program
    .command('export')
    .summary('Export a redacted diagnostic package')
    .description('Export a redacted diagnostic zip package with traces, doctor output, and optional snapshots')
  .option('--trace-id <traceId>', 'include only a single trace and snapshot set')
  .option('--trace <traceId>', 'deprecated alias for --trace-id')
  .option('--port <port>', 'extension websocket port for doctor snapshot', `${DEFAULT_PORT}`)
  .option('--rpc-ws-port <port>', 'JSON-RPC websocket port for doctor snapshot', `${DEFAULT_RPC_PORT}`)
  .option('--include-snapshots', 'include raw snapshot image folders (may contain sensitive visual data)', false)
  .option('--data-dir <path>', 'override the data directory')
  .option('--out <path>', 'output zip path'),
  {
    examples: [
      'bak export --out .\\diag.zip',
      'bak export --trace-id trace_123 --include-snapshots --out .\\diag-with-images.zip'
    ]
  }
)
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
        includeSnapshots: options.includeSnapshots === true
      })
    );
  });

addStructuredHelp(
  program
    .command('gc')
    .summary('Apply retention rules to traces and snapshots')
    .description('Apply retention policy to traces and snapshots')
  .option('--data-dir <path>', 'override BAK_DATA_DIR for this command')
  .option('--trace-days <days>', 'retain traces newer than N days')
  .option('--snapshot-days <days>', 'retain snapshot folders newer than N days')
  .option('--trace-keep <count>', 'always keep at least newest N traces')
  .option('--snapshot-keep <count>', 'always keep at least newest N snapshot folders')
  .option('--force', 'execute deletion (default is dry-run)', false),
  {
    notes: ['Without --force, gc reports what it would delete without mutating anything.'],
    examples: [
      'bak gc',
      'bak gc --trace-days 7 --snapshot-days 7 --force'
    ]
  }
)
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

return program;
}
