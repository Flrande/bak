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
export const PROTOCOL_VERSION = 'v2' as const;
export const COMPATIBLE_PROTOCOL_VERSIONS = ['v1', 'v2'] as const;

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

export interface SkillPlanStep {
  kind:
    | 'goto'
    | 'click'
    | 'type'
    | 'wait'
    | 'hover'
    | 'doubleClick'
    | 'rightClick'
    | 'dragDrop'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'upload'
    | 'press'
    | 'hotkey'
    | 'scrollTo'
    | 'scrollIntoView'
    | 'elementScroll'
    | 'keyboardType';
  locator?: Locator;
  targetCandidates?: Locator[];
  text?: string;
  clear?: boolean;
  key?: string;
  keys?: string[];
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
  dx?: number;
  dy?: number;
  delayMs?: number;
  fromLocator?: Locator;
  toLocator?: Locator;
  values?: string[];
  files?: Array<{ name: string; mimeType?: string; contentBase64: string }>;
  url?: string;
  waitFor?: {
    mode: 'selector' | 'text' | 'url';
    value: string;
    timeoutMs?: number;
  };
  requiresConfirmation?: boolean;
}

export interface SkillStats {
  runs: number;
  success: number;
  failure: number;
  healAttempts?: number;
  healSuccess?: number;
  retriesTotal?: number;
  manualInterventions?: number;
  lastRunAt?: string;
}

export interface Skill {
  id: string;
  domain: string;
  intent: string;
  description: string;
  urlPatterns?: string[];
  plan: SkillPlanStep[];
  paramsSchema: {
    required?: string[];
    fields: Record<string, { type: 'string'; description?: string }>;
  };
  preconditions?: {
    urlPattern?: string;
    requiredText?: string[];
  };
  healing: {
    retries: number;
    attempts?: number;
    successes?: number;
  };
  stats: SkillStats;
  stability?: 'stable' | 'beta' | 'experimental';
  meta?: {
    source?: 'manual' | 'auto';
    fingerprint?: string;
    learnCount?: number;
    lastLearnedAt?: string;
  };
  createdAt: string;
}

export interface Episode {
  id: string;
  domain: string;
  startUrl: string;
  intent: string;
  steps: SkillPlanStep[];
  anchors: string[];
  outcome: 'success' | 'failed';
  mode?: 'manual' | 'auto';
  createdAt: string;
}

export interface NeedUserConfirmData {
  reason: string;
  candidates: ElementMapItem[];
  action: 'click' | 'type';
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
  memoryBackend: {
    requestedBackend: 'json' | 'sqlite';
    backend: 'json' | 'sqlite';
    fallbackReason: string | null;
  };
  activeTab: {
    id: number;
    title: string;
    url: string;
  } | null;
  context: {
    frameDepth: number;
    shadowDepth: number;
  };
  recording: boolean;
  autoLearning: boolean;
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

interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

interface UploadFilePayload {
  name: string;
  contentBase64: string;
  mimeType?: string;
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
  'tabs.new': { params: { url?: string }; result: { tabId: number } };
  'tabs.close': { params: { tabId: number }; result: { ok: true } };
  'tabs.getActive': { params: { sessionId?: string }; result: { tab: TabInfo | null } };
  'tabs.get': { params: { tabId: number }; result: { tab: TabInfo } };

  'page.goto': { params: { url: string; tabId?: number }; result: { ok: true } };
  'page.back': { params: { tabId?: number }; result: { ok: true } };
  'page.forward': { params: { tabId?: number }; result: { ok: true } };
  'page.reload': { params: { tabId?: number }; result: { ok: true } };
  'page.snapshot': {
    params: { tabId?: number; includeBase64?: boolean };
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
      mode: 'selector' | 'text' | 'url';
      value: string;
      timeoutMs?: number;
    };
    result: { ok: true };
  };
  'page.title': { params: { tabId?: number }; result: { title: string } };
  'page.url': { params: { tabId?: number }; result: { url: string } };
  'page.text': {
    params: { tabId?: number; maxChunks?: number; chunkSize?: number };
    result: { chunks: PageTextChunk[] };
  };
  'page.dom': {
    params: { tabId?: number };
    result: { summary: PageDomSummary };
  };
  'page.accessibilityTree': {
    params: { tabId?: number; limit?: number };
    result: { nodes: AccessibilityNode[] };
  };
  'page.scrollTo': {
    params: { tabId?: number; x?: number; y?: number; behavior?: 'auto' | 'smooth' };
    result: { ok: true; x: number; y: number };
  };
  'page.viewport': {
    params: { tabId?: number; width?: number; height?: number };
    result: { width: number; height: number; devicePixelRatio: number };
  };
  'page.metrics': {
    params: { tabId?: number };
    result: PageMetrics;
  };

  'element.click': { params: { tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.type': {
    params: { tabId?: number; locator: Locator; text: string; clear?: boolean; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.scroll': {
    params: { tabId?: number; locator?: Locator; dx?: number; dy?: number };
    result: { ok: true };
  };
  'element.hover': { params: { tabId?: number; locator: Locator }; result: { ok: true } };
  'element.doubleClick': { params: { tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.rightClick': { params: { tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.dragDrop': {
    params: { tabId?: number; from: Locator; to: Locator; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.select': {
    params: { tabId?: number; locator: Locator; values: string[]; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.check': { params: { tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.uncheck': { params: { tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.scrollIntoView': {
    params: { tabId?: number; locator: Locator; behavior?: 'auto' | 'smooth' };
    result: { ok: true };
  };
  'element.focus': { params: { tabId?: number; locator: Locator }; result: { ok: true } };
  'element.blur': { params: { tabId?: number; locator: Locator }; result: { ok: true } };
  'element.get': {
    params: { tabId?: number; locator: Locator };
    result: {
      element: ElementMapItem;
      value?: string;
      checked?: boolean;
      attributes: Record<string, string>;
    };
  };

  'keyboard.press': { params: { tabId?: number; key: string }; result: { ok: true } };
  'keyboard.type': { params: { tabId?: number; text: string; delayMs?: number }; result: { ok: true } };
  'keyboard.hotkey': { params: { tabId?: number; keys: string[] }; result: { ok: true } };

  'mouse.move': { params: { tabId?: number; x: number; y: number }; result: { ok: true } };
  'mouse.click': { params: { tabId?: number; x: number; y: number; button?: 'left' | 'middle' | 'right' }; result: { ok: true } };
  'mouse.wheel': { params: { tabId?: number; dx?: number; dy?: number }; result: { ok: true } };

  'file.upload': {
    params: { tabId?: number; locator: Locator; files: UploadFilePayload[]; requiresConfirm?: boolean };
    result: { ok: true; fileCount: number };
  };

  'context.enterFrame': {
    params: { tabId?: number; framePath?: string[]; locator?: Locator; reset?: boolean };
    result: { ok: true; frameDepth: number; framePath: string[] };
  };
  'context.exitFrame': {
    params: { tabId?: number; levels?: number; reset?: boolean };
    result: { ok: true; frameDepth: number; framePath: string[] };
  };
  'context.enterShadow': {
    params: { tabId?: number; hostSelectors?: string[]; locator?: Locator; reset?: boolean };
    result: { ok: true; shadowDepth: number; shadowPath: string[] };
  };
  'context.exitShadow': {
    params: { tabId?: number; levels?: number; reset?: boolean };
    result: { ok: true; shadowDepth: number; shadowPath: string[] };
  };
  'context.reset': {
    params: { tabId?: number };
    result: { ok: true; frameDepth: number; shadowDepth: number };
  };

  'network.list': {
    params: {
      tabId?: number;
      limit?: number;
      urlIncludes?: string;
      status?: number;
      method?: string;
    };
    result: { entries: NetworkEntry[] };
  };
  'network.get': {
    params: { tabId?: number; id: string };
    result: { entry: NetworkEntry };
  };
  'network.waitFor': {
    params: {
      tabId?: number;
      urlIncludes?: string;
      status?: number;
      method?: string;
      timeoutMs?: number;
    };
    result: { entry: NetworkEntry };
  };
  'network.clear': {
    params: { tabId?: number };
    result: { ok: true };
  };

  'debug.getConsole': { params: { tabId?: number; limit?: number }; result: { entries: ConsoleEntry[] } };
  'debug.dumpState': {
    params: { tabId?: number; consoleLimit?: number; networkLimit?: number; includeAccessibility?: boolean };
    result: {
      url: string;
      title: string;
      context: {
        framePath: string[];
        shadowPath: string[];
      };
      dom: PageDomSummary;
      text: PageTextChunk[];
      console: ConsoleEntry[];
      network: NetworkEntry[];
      accessibility?: AccessibilityNode[];
    };
  };

  'memory.recordStart': {
    params: { intent: string; sessionId?: string };
    result: { recordingId: string };
  };
  'memory.recordStop': {
    params: { outcome?: 'success' | 'failed'; mode?: 'manual' | 'auto' };
    result: { episodeId: string; skillId?: string };
  };
  'memory.skills.list': {
    params: { domain?: string; intent?: string; limit?: number };
    result: { skills: Skill[] };
  };
  'memory.skills.show': { params: { id: string }; result: { skill: Skill } };
  'memory.skills.retrieve': {
    params: { domain?: string; url?: string; intent: string; anchors?: string[]; minScore?: number; limit?: number };
    result: { skills: Skill[] };
  };
  'memory.skills.run': {
    params: { id: string; params?: Record<string, string>; tabId?: number };
    result: { ok: true; updatedSkill?: Skill; usedSkillId: string; retries: number; healed: boolean };
  };
  'memory.skills.delete': { params: { id: string }; result: { ok: true } };
  'memory.skills.stats': {
    params: { id?: string; domain?: string };
    result: {
      stats: Array<{
        id: string;
        intent: string;
        domain: string;
        runs: number;
        success: number;
        failure: number;
        healAttempts: number;
        healSuccess: number;
      }>;
    };
  };
  'memory.episodes.list': {
    params: { domain?: string; intent?: string; limit?: number };
    result: { episodes: Episode[] };
  };
  'memory.replay.explain': {
    params: { id: string };
    result: {
      skillId: string;
      steps: Array<{ index: number; kind: SkillPlanStep['kind']; locator?: Locator; summary: string }>;
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
