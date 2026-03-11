import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { callRpc } from './rpc/client.js';
import { exportDiagnosticZip } from './diagnostic-export.js';
import { runDoctor } from './doctor.js';
import { runGc } from './gc.js';
import { dragDropLocatorsFromOptions, hasLocatorOptions, locatorFromOptions, parseFiniteNumber, parseNonNegativeInt, parsePositiveInt } from './cli-args.js';
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

function parseWorkspaceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const workspaceId = String(value).trim();
  if (!workspaceId) {
    return undefined;
  }
  return workspaceId;
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
  return command.option('--tab-id <tabId>', 'explicit tab id to target').option('--workspace-id <workspaceId>', 'explicit workspace id to target');
}

function addWorkspaceOption(command: Command): Command {
  return command.option('--workspace-id <workspaceId>', 'explicit workspace id to target');
}

function targetParams(options: { tabId?: unknown; workspaceId?: unknown }): { tabId?: number; workspaceId?: string } {
  return {
    tabId: parseTabId(options.tabId),
    workspaceId: parseWorkspaceId(options.workspaceId)
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
  .showHelpAfterError()
  .showSuggestionAfterError();

addStructuredHelp(program, {
  notes: [
    'All commands print machine-friendly JSON.',
    'Use --tab-id or --workspace-id to override the default target.',
    'Once a workspace exists, browser commands prefer its current tab.',
    'Use bak call when the protocol exposes a method without a dedicated CLI command.'
  ],
  examples: [
    'bak setup',
    'bak serve --port 17373 --rpc-ws-port 17374',
    'bak doctor --port 17373 --rpc-ws-port 17374',
    'bak workspace ensure --rpc-ws-port 17374',
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

const tabs = program
  .command('tabs')
  .summary('List, open, focus, inspect, and close tabs')
  .description('Inspect and control browser tabs directly');
addStructuredHelp(tabs, {
  notes: [
    'Use tabs commands when you want direct browser tab control outside the workspace helpers.',
    'Most day-to-day agent work is easier with workspace ensure and workspace open-tab.'
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
    .option('--workspace-id <workspaceId>', 'target workspace id')
    .option('--add-to-group', 'group the new tab when creating in a window', false)
).action(async (options) =>
  invoke(
    'tabs.new',
    {
      url: options.url ? String(options.url) : undefined,
      active: options.active === true,
      windowId: parseNonNegativeInt(options.windowId, 'window-id'),
      workspaceId: parseWorkspaceId(options.workspaceId),
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

const workspace = program
  .command('workspace')
  .summary('Create, repair, and target the agent workspace')
  .description('Manage the dedicated agent workspace window, tab group, and current workspace tab');
addStructuredHelp(workspace, {
  notes: [
    'workspace ensure creates or repairs the agent-owned browser window and tab group.',
    'Ordinary page and element commands do not create a workspace automatically.',
    'Once a workspace exists, default browser commands prefer its current tab.'
  ],
  examples: [
    'bak workspace ensure --rpc-ws-port 17374',
    'bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374',
    'bak workspace get-active-tab --rpc-ws-port 17374'
  ]
});
addStructuredHelp(addRpcPortOption(addTabOption(workspace.command('ensure').description('Create or repair the workspace window, group, and tracked tabs').option('--url <url>', 'initial or recovery URL').option('--focus', 'focus the workspace window', false))), {
  examples: [
    'bak workspace ensure --rpc-ws-port 17374',
    'bak workspace ensure --url "https://example.com" --focus --rpc-ws-port 17374'
  ]
}).action(async (options) =>
  invoke(
    'workspace.ensure',
    {
      workspaceId: parseWorkspaceId(options.workspaceId),
      url: options.url ? String(options.url) : undefined,
      focus: options.focus === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addTabOption(workspace.command('info').description('Show workspace metadata and tracked ids'))), {
  examples: ['bak workspace info --rpc-ws-port 17374']
}).action(async (options) => invoke('workspace.info', { workspaceId: parseWorkspaceId(options.workspaceId) }, parseRpcPort(options)));
addRpcPortOption(
  addTabOption(
    workspace.command('open-tab').description('Open a tab inside the workspace window and tab group').option('--url <url>', 'initial URL').option('--active', 'activate the tab inside the workspace window', false).option('--focus', 'focus the workspace window', false)
  )
).action(async (options) =>
  invoke(
    'workspace.openTab',
    {
      workspaceId: parseWorkspaceId(options.workspaceId),
      url: options.url ? String(options.url) : undefined,
      active: options.active === true,
      focus: options.focus === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addTabOption(workspace.command('list-tabs').description('List the tabs tracked by the workspace'))), {
  examples: ['bak workspace list-tabs --rpc-ws-port 17374']
}).action(async (options) => invoke('workspace.listTabs', { workspaceId: parseWorkspaceId(options.workspaceId) }, parseRpcPort(options)));
addRpcPortOption(
  addWorkspaceOption(workspace.command('get-active-tab').description('Show the workspace current tab used by default browser commands'))
).action(async (options) => invoke('workspace.getActiveTab', { workspaceId: parseWorkspaceId(options.workspaceId) }, parseRpcPort(options)));
addRpcPortOption(
  addWorkspaceOption(
    workspace
      .command('set-active-tab')
      .description('Set the workspace current tab used by default browser commands')
      .requiredOption('--tab-id <tabId>', 'workspace tab id to make current')
  )
).action(async (options) =>
  invoke(
    'workspace.setActiveTab',
    {
      workspaceId: parseWorkspaceId(options.workspaceId),
      tabId: parseTabId(options.tabId)
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addTabOption(workspace.command('focus').description('Bring the workspace window to the front'))), {
  examples: ['bak workspace focus --rpc-ws-port 17374']
}).action(async (options) => invoke('workspace.focus', { workspaceId: parseWorkspaceId(options.workspaceId) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(workspace.command('reset').description('Recreate the workspace window and grouping state').option('--url <url>', 'initial URL').option('--focus', 'focus the workspace window', false))), {
  examples: [
    'bak workspace reset --rpc-ws-port 17374',
    'bak workspace reset --url "https://example.com" --focus --rpc-ws-port 17374'
  ]
}).action(async (options) =>
  invoke(
    'workspace.reset',
    {
      workspaceId: parseWorkspaceId(options.workspaceId),
      url: options.url ? String(options.url) : undefined,
      focus: options.focus === true
    },
    parseRpcPort(options)
  )
);
addStructuredHelp(addRpcPortOption(addTabOption(workspace.command('close').description('Close the workspace window and tracked tabs'))), {
  examples: ['bak workspace close --rpc-ws-port 17374']
}).action(async (options) => invoke('workspace.close', { workspaceId: parseWorkspaceId(options.workspaceId) }, parseRpcPort(options)));

const page = program
  .command('page')
  .summary('Navigate, wait, and read the current document')
  .description('Navigate the target tab and read the current document in the active frame or shadow context');
addStructuredHelp(page, {
  notes: [
    'Page reads reflect the active frame or shadow context, not always the top-level tab document.',
    'Use bak call for protocol-only navigation helpers such as page.back, page.forward, page.reload, and page.scrollTo.'
  ],
  examples: [
    'bak page goto "https://example.com" --rpc-ws-port 17374',
    'bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374',
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
}).action(async (options) => invoke('page.viewport', { ...targetParams(options), width: parsePositiveInt(options.width, 'width'), height: parsePositiveInt(options.height, 'height') }, parseRpcPort(options)));

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
  notes: ['Use network wait when the page needs a specific request to finish before the next action.']
});
addStructuredHelp(addRpcPortOption(addTabOption(network.command('list').description('List captured network entries').option('--limit <limit>', 'result limit', '50').option('--url-includes <text>', 'URL substring').option('--status <status>', 'status code').option('--method <method>', 'HTTP method'))), {
  examples: ['bak network list --url-includes "/api/" --limit 20 --rpc-ws-port 17374']
}).action(async (options) => invoke('network.list', { ...targetParams(options), limit: parsePositiveInt(options.limit, 'limit'), urlIncludes: options.urlIncludes ? String(options.urlIncludes) : undefined, status: parseNonNegativeInt(options.status, 'status'), method: options.method ? String(options.method) : undefined }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(network.command('get <id>').description('Show a single network entry by id'))), {
  examples: ['bak network get req_123 --rpc-ws-port 17374']
}).action(async (id, options) => invoke('network.get', { ...targetParams(options), id: String(id) }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(network.command('wait').description('Wait for a matching network entry').option('--url-includes <text>', 'URL substring').option('--status <status>', 'status code').option('--method <method>', 'HTTP method').option('--timeout-ms <timeoutMs>', 'timeout in milliseconds', '5000'))), {
  examples: ['bak network wait --url-includes "/api/save" --status 200 --rpc-ws-port 17374']
}).action(async (options) => invoke('network.waitFor', { ...targetParams(options), urlIncludes: options.urlIncludes ? String(options.urlIncludes) : undefined, status: parseNonNegativeInt(options.status, 'status'), method: options.method ? String(options.method) : undefined, timeoutMs: parsePositiveInt(options.timeoutMs, 'timeout-ms') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(network.command('clear').description('Clear captured network history for the target tab'))), {
  examples: ['bak network clear --rpc-ws-port 17374']
}).action(async (options) => invoke('network.clear', { ...targetParams(options) }, parseRpcPort(options)));

const context = program
  .command('context')
  .summary('Enter and reset frame or shadow DOM context')
  .description('Manage the shared frame and shadow context used by page, debug, and element commands');
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
}).action(async (options) => invoke('context.exitFrame', { ...targetParams(options), levels: parsePositiveInt(options.levels, 'levels') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('enter-shadow').description('Enter a shadow DOM context by host selector path').option('--host-selectors <selector...>', 'shadow host selectors'))), {
  examples: ['bak context enter-shadow --host-selectors "#shadow-host" --rpc-ws-port 17374']
}).action(async (options) => invoke('context.enterShadow', { ...targetParams(options), hostSelectors: Array.isArray(options.hostSelectors) ? options.hostSelectors.map(String) : undefined }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('exit-shadow').description('Exit one or more shadow DOM levels').option('--levels <levels>', 'levels to exit'))), {
  examples: ['bak context exit-shadow --levels 1 --rpc-ws-port 17374']
}).action(async (options) => invoke('context.exitShadow', { ...targetParams(options), levels: parsePositiveInt(options.levels, 'levels') }, parseRpcPort(options)));
addStructuredHelp(addRpcPortOption(addTabOption(context.command('reset').description('Return to the top-level page context'))), {
  examples: ['bak context reset --rpc-ws-port 17374']
}).action(async (options) => invoke('context.reset', { ...targetParams(options) }, parseRpcPort(options)));

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
