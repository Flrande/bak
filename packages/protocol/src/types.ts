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
export const PROTOCOL_VERSION = 'v3' as const;
export const COMPATIBLE_PROTOCOL_VERSIONS = ['v3'] as const;

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

export type MemoryKind = 'route' | 'procedure' | 'composite';
export type MemoryExecutionMode = 'dry-run' | 'assist' | 'auto';
export type MemoryStatus = 'active' | 'deprecated' | 'deleted';
export type DraftStatus = 'draft' | 'discarded' | 'promoted';
export type CaptureSessionStatus = 'capturing' | 'ended';
export type CaptureOutcome = 'completed' | 'failed' | 'abandoned';
export type CaptureMarkRole = 'checkpoint' | 'route' | 'procedure' | 'target-page' | 'note';
export type MemoryApplicabilityStatus = 'applicable' | 'partial' | 'inapplicable';
export type MemoryRunStatus = 'completed' | 'blocked' | 'failed';
export type PatchSuggestionStatus = 'open' | 'applied' | 'rejected';
export type MemoryParameterKind = 'text' | 'secret' | 'file' | 'enum' | 'boolean';

export interface UploadFilePayload {
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export interface MemoryParameterDefinition {
  kind: MemoryParameterKind;
  required: boolean;
  description?: string;
  enumValues?: string[];
}

export interface MemoryParameterValueFile {
  kind: 'file';
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export type MemoryParameterValue =
  | string
  | boolean
  | MemoryParameterValueFile
  | Array<string>
  | Array<MemoryParameterValueFile>;

export interface PageFingerprint {
  id: string;
  url: string;
  origin: string;
  path: string;
  title: string;
  headings: string[];
  textSnippets: string[];
  anchorNames: string[];
  dom: {
    totalElements: number;
    interactiveElements: number;
    iframes: number;
    shadowHosts: number;
    tagHistogram: Array<{ tag: string; count: number }>;
  };
  capturedAt: string;
}

export type MemoryStepKind =
  | 'goto'
  | 'wait'
  | 'click'
  | 'type'
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
  | 'keyboardType'
  | 'focus'
  | 'blur'
  | 'enterFrame'
  | 'exitFrame'
  | 'enterShadow'
  | 'exitShadow'
  | 'resetContext';

export interface MemoryStep {
  kind: MemoryStepKind;
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
  files?: UploadFilePayload[];
  url?: string;
  waitFor?: {
    mode: 'selector' | 'text' | 'url';
    value: string;
    timeoutMs?: number;
  };
  framePath?: string[];
  hostSelectors?: string[];
  levels?: number;
  summary?: string;
}

export interface CaptureSession {
  id: string;
  goal: string;
  status: CaptureSessionStatus;
  outcome?: CaptureOutcome;
  tabId?: number;
  startedAt: string;
  endedAt?: string;
  startFingerprintId?: string;
  endFingerprintId?: string;
  labels: string[];
  eventCount: number;
}

export interface CaptureEvent {
  id: string;
  captureSessionId: string;
  at: string;
  kind: MemoryStepKind | 'mark';
  label?: string;
  note?: string;
  role?: CaptureMarkRole;
  step?: MemoryStep;
  pageFingerprintId?: string;
}

export interface DraftMemory {
  id: string;
  captureSessionId: string;
  kind: MemoryKind;
  status: DraftStatus;
  title: string;
  goal: string;
  description: string;
  steps: MemoryStep[];
  parameterSchema: Record<string, MemoryParameterDefinition>;
  tags: string[];
  rationale: string[];
  riskNotes: string[];
  entryFingerprintId?: string;
  targetFingerprintId?: string;
  sourceEventIds: string[];
  createdAt: string;
  discardedAt?: string;
  promotedAt?: string;
}

export interface DurableMemory {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  title: string;
  goal: string;
  description: string;
  tags: string[];
  latestRevisionId: string;
  createdAt: string;
  updatedAt: string;
  deprecatedReason?: string;
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  revision: number;
  kind: MemoryKind;
  title: string;
  goal: string;
  description: string;
  steps: MemoryStep[];
  parameterSchema: Record<string, MemoryParameterDefinition>;
  entryFingerprintId?: string;
  targetFingerprintId?: string;
  tags: string[];
  rationale: string[];
  riskNotes: string[];
  changeSummary: string[];
  createdAt: string;
  createdFromDraftId?: string;
  supersedesRevisionId?: string;
}

export interface MemorySearchCandidate {
  memoryId: string;
  revisionId: string;
  kind: MemoryKind;
  title: string;
  goal: string;
  score: number;
  whyMatched: string[];
  risks: string[];
  warnings: string[];
}

export interface MemoryApplicabilityCheck {
  key: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface MemoryExplanation {
  status: MemoryApplicabilityStatus;
  summary: string;
  whyMatched: string[];
  risks: string[];
  warnings: string[];
  checks: MemoryApplicabilityCheck[];
  currentPageFingerprint?: PageFingerprint;
}

export interface MemoryPlanStep extends MemoryStep {
  index: number;
  sourceMemoryId: string;
  sourceRevisionId: string;
  sourceKind: MemoryKind;
  assistBehavior: 'execute' | 'pause';
}

export interface MemoryPlan {
  id: string;
  kind: MemoryKind;
  mode: MemoryExecutionMode;
  status: 'ready' | 'executed' | 'failed';
  routeRevisionId?: string;
  procedureRevisionId?: string;
  revisionIds: string[];
  parameters: Record<string, MemoryParameterValue>;
  entryFingerprintId?: string;
  targetFingerprintId?: string;
  applicabilityStatus: MemoryApplicabilityStatus;
  applicabilitySummary: string;
  checks: MemoryApplicabilityCheck[];
  steps: MemoryPlanStep[];
  createdAt: string;
  lastRunId?: string;
}

export interface MemoryRunStep {
  index: number;
  kind: MemoryStepKind;
  sourceMemoryId: string;
  sourceRevisionId: string;
  sourceKind: MemoryKind;
  status: 'completed' | 'blocked' | 'failed' | 'dry-run' | 'skipped';
  detail: string;
  patchSuggestionId?: string;
}

export interface MemoryRun {
  id: string;
  planId: string;
  mode: MemoryExecutionMode;
  status: MemoryRunStatus;
  revisionIds: string[];
  startedAt: string;
  endedAt?: string;
  patchSuggestionIds: string[];
  resultSummary: string;
  steps: MemoryRunStep[];
}

export interface PatchSuggestion {
  id: string;
  memoryId: string;
  baseRevisionId: string;
  status: PatchSuggestionStatus;
  title: string;
  summary: string;
  reason: string;
  affectedStepIndexes: number[];
  changeSummary: string[];
  proposedRevision: {
    kind: MemoryKind;
    title: string;
    goal: string;
    description: string;
    steps: MemoryStep[];
    parameterSchema: Record<string, MemoryParameterDefinition>;
    entryFingerprintId?: string;
    targetFingerprintId?: string;
    tags: string[];
    rationale: string[];
    riskNotes: string[];
  };
  createdAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
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
    requestedBackend: 'sqlite';
    backend: 'sqlite';
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
  captureSessionId: string | null;
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
    params: {
      tabId?: number;
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

  'memory.capture.begin': {
    params: { goal: string; tabId?: number; labels?: string[] };
    result: { captureSession: CaptureSession };
  };
  'memory.capture.mark': {
    params: { label: string; note?: string; role?: CaptureMarkRole; tabId?: number };
    result: { event: CaptureEvent };
  };
  'memory.capture.end': {
    params: { outcome?: CaptureOutcome; note?: string; tabId?: number };
    result: { captureSession: CaptureSession; drafts: DraftMemory[] };
  };

  'memory.drafts.list': {
    params: { captureSessionId?: string; kind?: MemoryKind; status?: DraftStatus; limit?: number };
    result: { drafts: DraftMemory[] };
  };
  'memory.drafts.get': { params: { id: string }; result: { draft: DraftMemory } };
  'memory.drafts.promote': {
    params: { id: string; title?: string; goal?: string; description?: string; tags?: string[] };
    result: { memory: DurableMemory; revision: MemoryRevision };
  };
  'memory.drafts.discard': {
    params: { id: string; reason?: string };
    result: { draft: DraftMemory };
  };

  'memory.memories.search': {
    params: { goal: string; kind?: MemoryKind; tabId?: number; url?: string; limit?: number; includeDeprecated?: boolean };
    result: { candidates: MemorySearchCandidate[] };
  };
  'memory.memories.get': {
    params: { id: string; includeRevisions?: boolean };
    result: { memory: DurableMemory; revisions?: MemoryRevision[] };
  };
  'memory.memories.explain': {
    params: { id: string; revisionId?: string; tabId?: number; url?: string; goal?: string };
    result: { memory: DurableMemory; revision: MemoryRevision; explanation: MemoryExplanation };
  };
  'memory.memories.deprecate': {
    params: { id: string; reason?: string };
    result: { memory: DurableMemory };
  };
  'memory.memories.delete': { params: { id: string }; result: { ok: true } };

  'memory.plans.create': {
    params: {
      memoryId?: string;
      revisionId?: string;
      routeMemoryId?: string;
      routeRevisionId?: string;
      procedureMemoryId?: string;
      procedureRevisionId?: string;
      goal?: string;
      tabId?: number;
      mode?: MemoryExecutionMode;
      parameters?: Record<string, MemoryParameterValue>;
    };
    result: { plan: MemoryPlan };
  };
  'memory.plans.get': { params: { id: string }; result: { plan: MemoryPlan } };
  'memory.plans.execute': {
    params: { id: string; mode?: MemoryExecutionMode; tabId?: number };
    result: { run: MemoryRun };
  };

  'memory.runs.list': {
    params: { memoryId?: string; planId?: string; status?: MemoryRunStatus; limit?: number };
    result: { runs: MemoryRun[] };
  };
  'memory.runs.get': { params: { id: string }; result: { run: MemoryRun } };

  'memory.patches.list': {
    params: { memoryId?: string; status?: PatchSuggestionStatus; limit?: number };
    result: { patches: PatchSuggestion[] };
  };
  'memory.patches.get': { params: { id: string }; result: { patch: PatchSuggestion } };
  'memory.patches.apply': {
    params: { id: string; note?: string };
    result: { patch: PatchSuggestion; memory: DurableMemory; revision: MemoryRevision };
  };
  'memory.patches.reject': {
    params: { id: string; reason?: string };
    result: { patch: PatchSuggestion };
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
