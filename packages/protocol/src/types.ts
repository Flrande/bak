import { z } from 'zod';

export const BakErrorCode = {
  E_NOT_PAIRED: 'E_NOT_PAIRED',
  E_PERMISSION: 'E_PERMISSION',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_NEED_USER_CONFIRM: 'E_NEED_USER_CONFIRM',
  E_TIMEOUT: 'E_TIMEOUT',
  E_INVALID_PARAMS: 'E_INVALID_PARAMS',
  E_INTERNAL: 'E_INTERNAL',
  E_NOT_READY: 'E_NOT_READY'
} as const;

export type BakErrorCodeValue = (typeof BakErrorCode)[keyof typeof BakErrorCode];

export const JSON_RPC_VERSION = '2.0' as const;
export const PROTOCOL_VERSION = 'v4' as const;
export const COMPATIBLE_PROTOCOL_VERSIONS = ['v4'] as const;

export type CompatibleProtocolVersion = (typeof COMPATIBLE_PROTOCOL_VERSIONS)[number];

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id?: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: {
      bakCode?: BakErrorCodeValue;
      [k: string]: unknown;
    };
  };
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;

export const LocatorSchema = z.object({
  eid: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
  framePath: z.array(z.string()).optional(),
  shadow: z.enum(['auto', 'pierce', 'none']).optional(),
  index: z.number().int().min(0).optional()
});

export type Locator = z.infer<typeof LocatorSchema>;

export const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

export type BBox = z.infer<typeof BBoxSchema>;

export const ElementMapItemSchema = z.object({
  eid: z.string(),
  tag: z.string(),
  role: z.string().nullable(),
  name: z.string(),
  text: z.string(),
  bbox: BBoxSchema,
  selectors: z.object({
    css: z.string().nullable(),
    text: z.string().nullable(),
    aria: z.string().nullable()
  }),
  risk: z.enum(['low', 'high'])
});

export type ElementMapItem = z.infer<typeof ElementMapItemSchema>;

export const ConsoleEntrySchema = z.object({
  level: z.enum(['log', 'debug', 'info', 'warn', 'error']),
  message: z.string(),
  ts: z.number(),
  source: z.string().optional()
});

export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  status: number;
  ok: boolean;
  kind: 'fetch' | 'xhr' | 'navigation' | 'resource';
  ts: number;
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
  tabId?: number;
}

export interface PageTextChunk {
  chunkId: string;
  text: string;
  sourceTag: string;
}

export interface PageDomSummary {
  url: string;
  title: string;
  totalElements: number;
  interactiveElements: number;
  headings: number;
  links: number;
  forms: number;
  iframes: number;
  shadowHosts: number;
  tagHistogram: Array<{ tag: string; count: number }>;
}

export interface AccessibilityNode {
  role: string;
  name: string;
  tag: string;
  eid?: string;
}

export interface PageMetrics {
  navigation: {
    durationMs: number;
    domContentLoadedMs: number;
    loadEventMs: number;
  };
  longTasks: {
    count: number;
    totalDurationMs: number;
  };
  resources: {
    count: number;
    transferSize: number;
    encodedBodySize: number;
  };
}

export interface UploadFilePayload {
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'requireConfirm';
  reason: string;
  source: 'rule' | 'default';
  ruleId?: string;
}

export interface PolicyAuditEntry extends PolicyDecision {
  action:
    | 'element.click'
    | 'element.type'
    | 'element.doubleClick'
    | 'element.rightClick'
    | 'element.dragDrop'
    | 'element.select'
    | 'element.check'
    | 'element.uncheck'
    | 'file.upload';
  domain: string;
  path: string;
  locatorSummary: {
    hasEid: boolean;
    hasRole: boolean;
    hasName: boolean;
    hasText: boolean;
    hasCss: boolean;
  };
}

interface SessionInfoResult {
  sessionId: string | null;
  paired: boolean;
  extensionConnected: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected';
  connectionReason: string | null;
  protocolVersion: typeof PROTOCOL_VERSION;
  compatibleProtocolVersions: CompatibleProtocolVersion[];
  extensionVersion: string | null;
  activeTab: {
    id: number;
    title: string;
    url: string;
  } | null;
  context: {
    frameDepth: number;
    shadowDepth: number;
  };
  heartbeatStale: boolean;
  heartbeatAgeMs: number | null;
  staleAfterMs: number;
  lastSeenTs: number | null;
  lastHeartbeatTs: number | null;
  bridgePendingRequests: number;
  bridgeLastError: string | null;
  bridgeTotalRequests: number;
  bridgeTotalFailures: number;
  bridgeTotalTimeouts: number;
  bridgeTotalNotReady: number;
  capabilityCount: number;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId?: number;
  groupId?: number | null;
}

export interface WorkspaceInfo {
  id: string;
  label: string;
  color: string;
  windowId: number | null;
  groupId: number | null;
  tabIds: number[];
  activeTabId: number | null;
  primaryTabId: number | null;
  tabs: TabInfo[];
}

export interface MethodMap {
  'session.create': {
    params: { clientName?: string; protocolVersion?: CompatibleProtocolVersion };
    result: { sessionId: string; protocolVersion: typeof PROTOCOL_VERSION; compatibleProtocolVersions: CompatibleProtocolVersion[] };
  };
  'session.close': { params: { sessionId?: string }; result: { closed: true } };
  'session.info': {
    params: { sessionId?: string };
    result: SessionInfoResult;
  };

  'tabs.list': {
    params: { sessionId?: string };
    result: { tabs: TabInfo[] };
  };
  'tabs.focus': { params: { tabId: number }; result: { ok: true } };
  'tabs.new': {
    params: { url?: string; active?: boolean; windowId?: number; workspaceId?: string; addToGroup?: boolean };
    result: { tabId: number; windowId?: number; groupId?: number | null; workspaceId?: string };
  };
  'tabs.close': { params: { tabId: number }; result: { ok: true } };
  'tabs.getActive': { params: { sessionId?: string }; result: { tab: TabInfo | null } };
  'tabs.get': { params: { tabId: number }; result: { tab: TabInfo } };

  'workspace.ensure': {
    params: { workspaceId?: string; url?: string; focus?: boolean };
    result: { workspace: WorkspaceInfo; created: boolean; repaired: boolean; repairActions: string[] };
  };
  'workspace.info': {
    params: { workspaceId?: string };
    result: { workspace: WorkspaceInfo | null };
  };
  'workspace.openTab': {
    params: { workspaceId?: string; url?: string; active?: boolean; focus?: boolean };
    result: { workspace: WorkspaceInfo; tab: TabInfo };
  };
  'workspace.listTabs': {
    params: { workspaceId?: string };
    result: { workspace: WorkspaceInfo; tabs: TabInfo[] };
  };
  'workspace.getActiveTab': {
    params: { workspaceId?: string };
    result: { workspace: WorkspaceInfo; tab: TabInfo | null };
  };
  'workspace.setActiveTab': {
    params: { workspaceId?: string; tabId: number };
    result: { workspace: WorkspaceInfo; tab: TabInfo };
  };
  'workspace.focus': {
    params: { workspaceId?: string };
    result: { ok: true; workspace: WorkspaceInfo };
  };
  'workspace.reset': {
    params: { workspaceId?: string; url?: string; focus?: boolean };
    result: { workspace: WorkspaceInfo; created: boolean; repaired: boolean; repairActions: string[] };
  };
  'workspace.close': {
    params: { workspaceId?: string };
    result: { ok: true };
  };

  'page.goto': { params: { url: string; tabId?: number; workspaceId?: string }; result: { ok: true } };
  'page.back': { params: { tabId?: number; workspaceId?: string }; result: { ok: true } };
  'page.forward': { params: { tabId?: number; workspaceId?: string }; result: { ok: true } };
  'page.reload': { params: { tabId?: number; workspaceId?: string }; result: { ok: true } };
  'page.snapshot': {
    params: { tabId?: number; workspaceId?: string; includeBase64?: boolean };
    result: {
      traceId: string;
      imagePath: string;
      elementsPath: string;
      imageBase64?: string;
      elementCount: number;
    };
  };
  'page.wait': {
    params: {
      tabId?: number;
      workspaceId?: string;
      mode: 'selector' | 'text' | 'url';
      value: string;
      timeoutMs?: number;
    };
    result: { ok: true };
  };
  'page.title': { params: { tabId?: number; workspaceId?: string }; result: { title: string } };
  'page.url': { params: { tabId?: number; workspaceId?: string }; result: { url: string } };
  'page.text': {
    params: { tabId?: number; workspaceId?: string; maxChunks?: number; chunkSize?: number };
    result: { chunks: PageTextChunk[] };
  };
  'page.dom': {
    params: { tabId?: number; workspaceId?: string };
    result: { summary: PageDomSummary };
  };
  'page.accessibilityTree': {
    params: { tabId?: number; workspaceId?: string; limit?: number };
    result: { nodes: AccessibilityNode[] };
  };
  'page.scrollTo': {
    params: { tabId?: number; workspaceId?: string; x?: number; y?: number; behavior?: 'auto' | 'smooth' };
    result: { ok: true; x: number; y: number };
  };
  'page.viewport': {
    params: { tabId?: number; workspaceId?: string; width?: number; height?: number };
    result: { width: number; height: number; devicePixelRatio: number };
  };
  'page.metrics': {
    params: { tabId?: number; workspaceId?: string };
    result: PageMetrics;
  };

  'element.click': { params: { tabId?: number; workspaceId?: string; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.type': {
    params: { tabId?: number; workspaceId?: string; locator: Locator; text: string; clear?: boolean; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.scroll': {
    params: { tabId?: number; workspaceId?: string; locator?: Locator; dx?: number; dy?: number };
    result: { ok: true };
  };
  'element.hover': { params: { tabId?: number; workspaceId?: string; locator: Locator }; result: { ok: true } };
  'element.doubleClick': { params: { tabId?: number; workspaceId?: string; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.rightClick': { params: { tabId?: number; workspaceId?: string; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.dragDrop': {
    params: { tabId?: number; workspaceId?: string; from: Locator; to: Locator; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.select': {
    params: { tabId?: number; workspaceId?: string; locator: Locator; values: string[]; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.check': { params: { tabId?: number; workspaceId?: string; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.uncheck': { params: { tabId?: number; workspaceId?: string; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.scrollIntoView': {
    params: { tabId?: number; workspaceId?: string; locator: Locator; behavior?: 'auto' | 'smooth' };
    result: { ok: true };
  };
  'element.focus': { params: { tabId?: number; workspaceId?: string; locator: Locator }; result: { ok: true } };
  'element.blur': { params: { tabId?: number; workspaceId?: string; locator: Locator }; result: { ok: true } };
  'element.get': {
    params: { tabId?: number; workspaceId?: string; locator: Locator };
    result: {
      element: ElementMapItem;
      value?: string;
      checked?: boolean;
      attributes: Record<string, string>;
    };
  };

  'keyboard.press': { params: { tabId?: number; workspaceId?: string; key: string }; result: { ok: true } };
  'keyboard.type': { params: { tabId?: number; workspaceId?: string; text: string; delayMs?: number }; result: { ok: true } };
  'keyboard.hotkey': { params: { tabId?: number; workspaceId?: string; keys: string[] }; result: { ok: true } };

  'mouse.move': { params: { tabId?: number; workspaceId?: string; x: number; y: number }; result: { ok: true } };
  'mouse.click': { params: { tabId?: number; workspaceId?: string; x: number; y: number; button?: 'left' | 'middle' | 'right' }; result: { ok: true } };
  'mouse.wheel': { params: { tabId?: number; workspaceId?: string; dx?: number; dy?: number }; result: { ok: true } };

  'file.upload': {
    params: { tabId?: number; workspaceId?: string; locator: Locator; files: UploadFilePayload[]; requiresConfirm?: boolean };
    result: { ok: true; fileCount: number };
  };

  'context.enterFrame': {
    params: { tabId?: number; workspaceId?: string; framePath?: string[]; locator?: Locator; reset?: boolean };
    result: { ok: true; frameDepth: number; framePath: string[] };
  };
  'context.exitFrame': {
    params: { tabId?: number; workspaceId?: string; levels?: number; reset?: boolean };
    result: { ok: true; frameDepth: number; framePath: string[] };
  };
  'context.enterShadow': {
    params: { tabId?: number; workspaceId?: string; hostSelectors?: string[]; locator?: Locator; reset?: boolean };
    result: { ok: true; shadowDepth: number; shadowPath: string[] };
  };
  'context.exitShadow': {
    params: { tabId?: number; workspaceId?: string; levels?: number; reset?: boolean };
    result: { ok: true; shadowDepth: number; shadowPath: string[] };
  };
  'context.reset': {
    params: { tabId?: number; workspaceId?: string };
    result: { ok: true; frameDepth: number; shadowDepth: number };
  };

  'network.list': {
    params: {
      tabId?: number;
      workspaceId?: string;
      limit?: number;
      urlIncludes?: string;
      status?: number;
      method?: string;
    };
    result: { entries: NetworkEntry[] };
  };
  'network.get': {
    params: { tabId?: number; workspaceId?: string; id: string };
    result: { entry: NetworkEntry };
  };
  'network.waitFor': {
    params: {
      tabId?: number;
      workspaceId?: string;
      urlIncludes?: string;
      status?: number;
      method?: string;
      timeoutMs?: number;
    };
    result: { entry: NetworkEntry };
  };
  'network.clear': {
    params: { tabId?: number; workspaceId?: string };
    result: { ok: true };
  };

  'debug.getConsole': { params: { tabId?: number; workspaceId?: string; limit?: number }; result: { entries: ConsoleEntry[] } };
  'debug.dumpState': {
    params: {
      tabId?: number;
      workspaceId?: string;
      consoleLimit?: number;
      networkLimit?: number;
      includeAccessibility?: boolean;
      includeSnapshot?: boolean;
      includeSnapshotBase64?: boolean;
    };
    result: {
      url: string;
      title: string;
      context: {
        framePath: string[];
        shadowPath: string[];
      };
      dom: PageDomSummary;
      text: PageTextChunk[];
      elements: ElementMapItem[];
      metrics: PageMetrics;
      viewport: { width: number; height: number; devicePixelRatio: number };
      console: ConsoleEntry[];
      network: NetworkEntry[];
      accessibility?: AccessibilityNode[];
      snapshot?: {
        traceId: string;
        imagePath: string;
        elementsPath: string;
        imageBase64?: string;
        elementCount: number;
      };
    };
  };
}

export type MethodName = keyof MethodMap;

export type MethodParams<TMethod extends MethodName> = MethodMap[TMethod]['params'];
export type MethodResult<TMethod extends MethodName> = MethodMap[TMethod]['result'];

export const RequestSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional()
});

export const ResponseSuccessSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown()
});

export const ResponseFailureSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.record(z.unknown()).optional()
  })
});

export const AnyResponseSchema = z.union([ResponseSuccessSchema, ResponseFailureSchema]);
