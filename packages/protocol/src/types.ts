import { z } from 'zod';

export const BakErrorCode = {
  E_NOT_PAIRED: 'E_NOT_PAIRED',
  E_PERMISSION: 'E_PERMISSION',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_NEED_USER_CONFIRM: 'E_NEED_USER_CONFIRM',
  E_TIMEOUT: 'E_TIMEOUT',
  E_INVALID_PARAMS: 'E_INVALID_PARAMS',
  E_INTERNAL: 'E_INTERNAL',
  E_NOT_READY: 'E_NOT_READY',
  E_EXECUTION: 'E_EXECUTION',
  E_NOT_SERIALIZABLE: 'E_NOT_SERIALIZABLE',
  E_BODY_TOO_LARGE: 'E_BODY_TOO_LARGE',
  E_RESPONSE_NOT_CAPTURED: 'E_RESPONSE_NOT_CAPTURED',
  E_CROSS_ORIGIN_BLOCKED: 'E_CROSS_ORIGIN_BLOCKED',
  E_SELECTOR_AMBIGUOUS: 'E_SELECTOR_AMBIGUOUS',
  E_DEBUGGER_NOT_ATTACHED: 'E_DEBUGGER_NOT_ATTACHED'
} as const;

export type BakErrorCodeValue = (typeof BakErrorCode)[keyof typeof BakErrorCode];

export const JSON_RPC_VERSION = '2.0' as const;
export const PROTOCOL_VERSION = 'v5' as const;
export const COMPATIBLE_PROTOCOL_VERSIONS = ['v5'] as const;

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
  xpath: z.string().optional(),
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

export const ElementSelectorsSchema = z.object({
  css: z.string().nullable(),
  xpath: z.string().nullable().optional(),
  text: z.string().nullable(),
  aria: z.string().nullable()
});

export type ElementSelectors = z.infer<typeof ElementSelectorsSchema>;

export const ElementMapItemSchema = z.object({
  eid: z.string(),
  tag: z.string(),
  role: z.string().nullable(),
  name: z.string(),
  text: z.string(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  bbox: BBoxSchema,
  selectors: ElementSelectorsSchema,
  risk: z.enum(['low', 'high'])
});

export type ElementMapItem = z.infer<typeof ElementMapItemSchema>;

export const SnapshotActionabilitySchema = z.enum(['click', 'type', 'select', 'check', 'unknown']);

export type SnapshotActionability = z.infer<typeof SnapshotActionabilitySchema>;

export const SnapshotRefSchema = z.object({
  ref: z.string(),
  eid: z.string(),
  role: z.string().nullable(),
  name: z.string(),
  text: z.string(),
  risk: z.enum(['low', 'high']),
  bbox: BBoxSchema,
  selectors: ElementSelectorsSchema,
  actionability: SnapshotActionabilitySchema
});

export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;

export const SnapshotSummaryItemSchema = z.object({
  ref: z.string(),
  eid: z.string(),
  label: z.string(),
  role: z.string().nullable(),
  risk: z.enum(['low', 'high']),
  actionability: SnapshotActionabilitySchema
});

export type SnapshotSummaryItem = z.infer<typeof SnapshotSummaryItemSchema>;

export const SnapshotRecommendationSchema = z.object({
  ref: z.string(),
  actionability: SnapshotActionabilitySchema,
  summary: z.string()
});

export type SnapshotRecommendation = z.infer<typeof SnapshotRecommendationSchema>;

export const SnapshotActionSummarySchema = z.object({
  clickable: z.array(SnapshotSummaryItemSchema),
  inputs: z.array(SnapshotSummaryItemSchema),
  highRisk: z.array(SnapshotSummaryItemSchema),
  recommendedNextActions: z.array(SnapshotRecommendationSchema)
});

export type SnapshotActionSummary = z.infer<typeof SnapshotActionSummarySchema>;

export const SnapshotDiffChangeFieldSchema = z.enum(['name', 'text', 'risk', 'bbox', 'actionability']);

export type SnapshotDiffChangeField = z.infer<typeof SnapshotDiffChangeFieldSchema>;

export const SnapshotRefStateSchema = z.object({
  name: z.string(),
  text: z.string(),
  risk: z.enum(['low', 'high']),
  bbox: BBoxSchema,
  actionability: SnapshotActionabilitySchema
});

export type SnapshotRefState = z.infer<typeof SnapshotRefStateSchema>;

export const SnapshotChangedRefSchema = z.object({
  ref: z.string().nullable(),
  previousRef: z.string().nullable(),
  eid: z.string(),
  previousEid: z.string().nullable(),
  label: z.string(),
  changes: z.array(SnapshotDiffChangeFieldSchema),
  before: SnapshotRefStateSchema,
  after: SnapshotRefStateSchema
});

export type SnapshotChangedRef = z.infer<typeof SnapshotChangedRefSchema>;

export const SnapshotFocusChangeSchema = z.object({
  type: z.enum(['entered', 'left', 'moved']),
  ref: z.string().nullable(),
  previousRef: z.string().nullable(),
  eid: z.string(),
  label: z.string(),
  previousRank: z.number().int().nullable(),
  currentRank: z.number().int().nullable()
});

export type SnapshotFocusChange = z.infer<typeof SnapshotFocusChangeSchema>;

export const SnapshotDiffSchema = z.object({
  comparedTo: z.string(),
  addedRefs: z.array(SnapshotRefSchema),
  removedRefs: z.array(SnapshotRefSchema),
  changedRefs: z.array(SnapshotChangedRefSchema),
  focusChanges: z.array(SnapshotFocusChangeSchema),
  summary: z.object({
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    changed: z.number().int().min(0),
    focusChanged: z.number().int().min(0)
  })
});

export type SnapshotDiff = z.infer<typeof SnapshotDiffSchema>;

export interface PersistedPageSnapshot {
  traceId: string;
  imagePath: string;
  elementsPath: string;
  imageBase64?: string;
  elementCount: number;
  refs?: SnapshotRef[];
  annotatedImagePath?: string;
  annotatedImageBase64?: string;
  actionSummary?: SnapshotActionSummary;
  diff?: SnapshotDiff;
}

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
  startedAt?: number;
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
  tabId?: number;
  resourceType?: string;
  contentType?: string;
  initiatorUrl?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBodyPreview?: string;
  responseBodyPreview?: string;
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  binary?: boolean;
  truncated?: boolean;
  failureReason?: string;
  source?: 'debugger' | 'content';
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

export type PageExecutionScope = 'current' | 'main' | 'all-frames';

export interface PageMethodError {
  code: BakErrorCodeValue | string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PageFrameResult<T = unknown> {
  url: string;
  framePath: string[];
  value?: T;
  truncated?: boolean;
  bytes?: number;
  resolver?: 'globalThis' | 'lexical';
  error?: PageMethodError;
}

export interface PageValueResult<T = unknown> {
  scope: PageExecutionScope;
  result?: PageFrameResult<T>;
  results?: Array<PageFrameResult<T>>;
}

export interface PageFetchResponse {
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  contentType?: string;
  bodyText?: string;
  json?: unknown;
  bytes?: number;
  truncated?: boolean;
  table?: TableHandle;
  schema?: TableSchema;
  mappedRows?: Array<Record<string, unknown>>;
  mappingSource?: string;
}

export interface TableHandle {
  id: string;
  name: string;
  kind: 'html' | 'dataTables' | 'ag-grid' | 'tanstack' | 'handsontable' | 'aria-grid' | 'visible-only';
  selector?: string;
  rowCount?: number;
  columnCount?: number;
  intelligence?: TableIntelligence;
}

export interface TableColumn {
  key: string;
  label: string;
}

export interface TableSchema {
  columns: TableColumn[];
}

export type TableExtractionMode = 'dataSource' | 'scroll' | 'visibleOnly';

export type TableCompleteness = 'complete' | 'partial' | 'unknown';

export interface TableIntelligenceSignal {
  code: string;
  detail: string;
}

export interface TableIntelligence {
  virtualized: boolean;
  lazyLoaded: boolean;
  preferredExtractionMode: TableExtractionMode;
  estimatedTotalRows?: number;
  completeness: TableCompleteness;
  signals: TableIntelligenceSignal[];
}

export interface TableExtractionMetadata {
  mode: TableExtractionMode;
  complete: boolean;
  observedRows: number;
  estimatedTotalRows?: number;
  warnings: string[];
}

export type PageExtractResolver = 'auto' | 'globalThis' | 'lexical';

export type FreshnessTimestampCategory = 'data' | 'contract' | 'event' | 'unknown';

export interface DynamicDataSchemaHint {
  kind: 'rows-object' | 'rows-array' | 'object' | 'array' | 'scalar' | 'unknown';
  columns?: string[];
}

export interface InspectPageDataCandidateProbe {
  name: string;
  resolver: 'globalThis' | 'lexical';
  sample: unknown;
  sampleSize: number | null;
  schemaHint: DynamicDataSchemaHint | null;
  lastObservedAt: number | null;
  timestamps: Array<{
    path: string;
    value: string;
    category: FreshnessTimestampCategory;
  }>;
}

export type InspectPageDataSourceType = 'windowGlobal' | 'inlineJson' | 'networkResponse';

export interface InspectPageDataSource {
  sourceId: string;
  type: InspectPageDataSourceType;
  label: string;
  path: string;
  sampleSize: number | null;
  schemaHint: DynamicDataSchemaHint | null;
  lastObservedAt: number | null;
}

export type InspectPageDataSourceMappingConfidence = 'high' | 'medium' | 'low';

export interface InspectPageDataSourceMappingBasis {
  type: 'columnOverlap' | 'sampleValueOverlap' | 'timeProximity' | 'explicitReference';
  detail: string;
}

export interface InspectPageDataSourceMapping {
  tableId: string;
  sourceId: string;
  confidence: InspectPageDataSourceMappingConfidence;
  basis: InspectPageDataSourceMappingBasis[];
  matchedColumns: string[];
}

export interface InspectPageDataRecommendation {
  title: string;
  command: string;
  note: string;
}

export interface InspectPageDataResult {
  suspiciousGlobals: string[];
  tables: TableHandle[];
  visibleTimestamps: string[];
  inlineTimestamps: string[];
  pageDataCandidates: InspectPageDataCandidateProbe[];
  recentNetwork: NetworkEntry[];
  recommendedNextSteps: string[];
  dataSources: InspectPageDataSource[];
  sourceMappings: InspectPageDataSourceMapping[];
  recommendedNextActions: InspectPageDataRecommendation[];
}

export interface InspectNetworkCadenceSummary {
  sampleCount: number;
  classification: 'none' | 'single-request' | 'bursty' | 'polling';
  averageIntervalMs: number | null;
  medianIntervalMs: number | null;
  latestGapMs: number | null;
  endpoints: string[];
}

export interface InspectLiveUpdatesResult {
  lastMutationAt: number | null;
  timers: {
    timeouts: number;
    intervals: number;
  };
  networkCount: number;
  networkCadence: InspectNetworkCadenceSummary;
  recentNetwork: NetworkEntry[];
}

export interface FreshnessEvidenceItem {
  value: string;
  source: 'visible' | 'inline' | 'page-data' | 'network';
  category: FreshnessTimestampCategory;
  context?: string;
  path?: string;
}

export interface PageFreshnessResult {
  pageLoadedAt: number | null;
  lastMutationAt: number | null;
  latestNetworkTimestamp: number | null;
  latestInlineDataTimestamp: number | null;
  latestPageDataTimestamp: number | null;
  latestNetworkDataTimestamp: number | null;
  domVisibleTimestamp: number | null;
  assessment: 'fresh' | 'lagged' | 'stale' | 'unknown';
  evidence: {
    visibleTimestamps: string[];
    inlineTimestamps: string[];
    pageDataTimestamps: string[];
    networkDataTimestamps: string[];
    classifiedTimestamps: FreshnessEvidenceItem[];
    networkSampleIds: string[];
  };
}

export interface InspectFreshnessResult extends PageFreshnessResult {
  lagMs: number | null;
}

export type DebugDumpSection =
  | 'dom'
  | 'visible-text'
  | 'scripts'
  | 'globals-preview'
  | 'network-summary'
  | 'storage'
  | 'frames';

export interface CaptureSnapshotResult {
  url: string;
  title: string;
  html: string;
  visibleText: PageTextChunk[];
  cookies: Array<{ name: string }>;
  storage: {
    localStorageKeys: string[];
    sessionStorageKeys: string[];
  };
  context: SessionContextSnapshot;
  freshness?: PageFreshnessResult;
  network: NetworkEntry[];
  capturedAt: number;
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

export interface RuntimeInfoResult {
  paired: boolean;
  extensionConnected: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected';
  connectionReason: string | null;
  protocolVersion: typeof PROTOCOL_VERSION;
  compatibleProtocolVersions: CompatibleProtocolVersion[];
  runtimeVersion: string;
  extensionVersion: string | null;
  heartbeatStale: boolean;
  heartbeatAgeMs: number | null;
  staleAfterMs: number;
  lastSeenTs: number | null;
  lastHeartbeatTs: number | null;
  bridgeConnectedAtTs: number | null;
  bridgeDisconnectedAtTs: number | null;
  bridgePendingRequests: number;
  bridgeLastError: string | null;
  bridgeTotalRequests: number;
  bridgeTotalFailures: number;
  bridgeTotalTimeouts: number;
  bridgeTotalNotReady: number;
  capabilityCount: number;
  managedRuntime: boolean;
  idleStopArmed: boolean;
  activeSessionCount: number;
  activeSessions: SessionDescriptor[];
}

export interface SessionContextSnapshot {
  tabId: number | null;
  framePath: string[];
  shadowPath: string[];
}

export interface SessionDescriptor {
  sessionId: string;
  clientName?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface SessionSummary extends SessionDescriptor {
  activeTab: TabInfo | null;
  currentContext: SessionContextSnapshot;
}

export interface SessionInfoResult {
  session: SessionDescriptor;
  activeTab: TabInfo | null;
  currentContext: SessionContextSnapshot;
}

export interface SessionResolveResult {
  sessionId: string;
  clientName?: string;
  createdAt: string;
  created: boolean;
}

export interface SessionCloseTabResult {
  closed: true;
  closedTabId: number;
  sessionClosed: boolean;
  browser: SessionBrowserState | null;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId?: number;
  groupId?: number | null;
}

export interface SessionBrowserState {
  windowId: number | null;
  groupId: number | null;
  tabIds: number[];
  activeTabId: number | null;
  primaryTabId: number | null;
  tabs: TabInfo[];
}

export interface MethodMap {
  'runtime.info': {
    params: Record<string, never>;
    result: RuntimeInfoResult;
  };
  'session.create': {
    params: { clientName?: string; protocolVersion?: CompatibleProtocolVersion };
    result: {
      sessionId: string;
      clientName?: string;
      createdAt: string;
      protocolVersion: typeof PROTOCOL_VERSION;
      compatibleProtocolVersions: CompatibleProtocolVersion[];
    };
  };
  'session.list': {
    params: Record<string, never>;
    result: { sessions: SessionSummary[] };
  };
  'session.close': { params: { sessionId: string }; result: { closed: true } };
  'session.resolve': {
    params: { clientName: string };
    result: SessionResolveResult;
  };
  'session.info': {
    params: { sessionId: string };
    result: SessionInfoResult;
  };
  'session.ensure': {
    params: { sessionId: string; url?: string; focus?: boolean };
    result: { browser: SessionBrowserState; created: boolean; repaired: boolean; repairActions: string[] };
  };
  'session.openTab': {
    params: { sessionId: string; url?: string; active?: boolean; focus?: boolean };
    result: { browser: SessionBrowserState; tab: TabInfo };
  };
  'session.listTabs': {
    params: { sessionId: string };
    result: { browser: SessionBrowserState | null; tabs: TabInfo[] };
  };
  'session.getActiveTab': {
    params: { sessionId: string };
    result: { browser: SessionBrowserState | null; tab: TabInfo | null };
  };
  'session.setActiveTab': {
    params: { sessionId: string; tabId: number };
    result: { browser: SessionBrowserState; tab: TabInfo };
  };
  'session.focus': {
    params: { sessionId: string };
    result: { ok: true; browser: SessionBrowserState };
  };
  'session.closeTab': {
    params: { sessionId: string; tabId?: number };
    result: SessionCloseTabResult;
  };
  'session.reset': {
    params: { sessionId: string; url?: string; focus?: boolean };
    result: { browser: SessionBrowserState; created: boolean; repaired: boolean; repairActions: string[] };
  };

  'tabs.list': {
    params: Record<string, never>;
    result: { tabs: TabInfo[] };
  };
  'tabs.focus': { params: { sessionId: string; tabId: number }; result: { ok: true } };
  'tabs.new': {
    params: { sessionId: string; url?: string; active?: boolean; focus?: boolean };
    result: { tabId: number; windowId?: number; groupId?: number | null };
  };
  'tabs.close': { params: { sessionId: string; tabId: number }; result: { ok: true } };
  'tabs.getActive': { params: Record<string, never>; result: { tab: TabInfo | null } };
  'tabs.get': { params: { tabId: number }; result: { tab: TabInfo } };

  'page.goto': { params: { sessionId: string; url: string; tabId?: number }; result: { ok: true } };
  'page.back': { params: { sessionId: string; tabId?: number }; result: { ok: true } };
  'page.forward': { params: { sessionId: string; tabId?: number }; result: { ok: true } };
  'page.reload': { params: { sessionId: string; tabId?: number }; result: { ok: true } };
  'page.snapshot': {
    params: { sessionId: string; tabId?: number; includeBase64?: boolean; annotate?: boolean; diffWith?: string };
    result: PersistedPageSnapshot;
  };
  'page.wait': {
    params: {
      sessionId: string;
      tabId?: number;
      mode: 'selector' | 'text' | 'url';
      value: string;
      timeoutMs?: number;
    };
    result: { ok: true };
  };
  'page.title': { params: { sessionId: string; tabId?: number }; result: { title: string } };
  'page.url': { params: { sessionId: string; tabId?: number }; result: { url: string } };
  'page.text': {
    params: { sessionId: string; tabId?: number; maxChunks?: number; chunkSize?: number };
    result: { chunks: PageTextChunk[] };
  };
  'page.eval': {
    params: { sessionId: string; tabId?: number; expr: string; scope?: PageExecutionScope; maxBytes?: number };
    result: PageValueResult<unknown>;
  };
  'page.extract': {
    params: {
      sessionId: string;
      tabId?: number;
      path: string;
      scope?: PageExecutionScope;
      maxBytes?: number;
      resolver?: PageExtractResolver;
    };
    result: PageValueResult<unknown>;
  };
  'page.fetch': {
    params: {
      sessionId: string;
      tabId?: number;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      contentType?: string;
      mode?: 'raw' | 'json';
      timeoutMs?: number;
      scope?: PageExecutionScope;
      maxBytes?: number;
      requiresConfirm?: boolean;
    };
    result: PageValueResult<PageFetchResponse>;
  };
  'page.dom': {
    params: { sessionId: string; tabId?: number };
    result: { summary: PageDomSummary };
  };
  'page.accessibilityTree': {
    params: { sessionId: string; tabId?: number; limit?: number };
    result: { nodes: AccessibilityNode[] };
  };
  'page.scrollTo': {
    params: { sessionId: string; tabId?: number; x?: number; y?: number; behavior?: 'auto' | 'smooth' };
    result: { ok: true; x: number; y: number };
  };
  'page.viewport': {
    params: { sessionId: string; tabId?: number; width?: number; height?: number };
    result: { width: number; height: number; devicePixelRatio: number };
  };
  'page.metrics': {
    params: { sessionId: string; tabId?: number };
    result: PageMetrics;
  };
  'page.freshness': {
    params: {
      sessionId: string;
      tabId?: number;
      patterns?: string[];
      freshWindowMs?: number;
      staleWindowMs?: number;
    };
    result: PageFreshnessResult;
  };

  'element.click': { params: { sessionId: string; tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.type': {
    params: { sessionId: string; tabId?: number; locator: Locator; text: string; clear?: boolean; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.scroll': {
    params: { sessionId: string; tabId?: number; locator?: Locator; dx?: number; dy?: number };
    result: { ok: true };
  };
  'element.hover': { params: { sessionId: string; tabId?: number; locator: Locator }; result: { ok: true } };
  'element.doubleClick': { params: { sessionId: string; tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.rightClick': { params: { sessionId: string; tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.dragDrop': {
    params: { sessionId: string; tabId?: number; from: Locator; to: Locator; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.select': {
    params: { sessionId: string; tabId?: number; locator: Locator; values: string[]; requiresConfirm?: boolean };
    result: { ok: true };
  };
  'element.check': { params: { sessionId: string; tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.uncheck': { params: { sessionId: string; tabId?: number; locator: Locator; requiresConfirm?: boolean }; result: { ok: true } };
  'element.scrollIntoView': {
    params: { sessionId: string; tabId?: number; locator: Locator; behavior?: 'auto' | 'smooth' };
    result: { ok: true };
  };
  'element.focus': { params: { sessionId: string; tabId?: number; locator: Locator }; result: { ok: true } };
  'element.blur': { params: { sessionId: string; tabId?: number; locator: Locator }; result: { ok: true } };
  'element.get': {
    params: { sessionId: string; tabId?: number; locator: Locator };
    result: {
      element: ElementMapItem;
      matchedCount: number;
      visible: boolean;
      enabled: boolean;
      textPreview: string;
      value?: string;
      checked?: boolean;
      attributes: Record<string, string>;
    };
  };

  'keyboard.press': { params: { sessionId: string; tabId?: number; key: string }; result: { ok: true } };
  'keyboard.type': { params: { sessionId: string; tabId?: number; text: string; delayMs?: number }; result: { ok: true } };
  'keyboard.hotkey': { params: { sessionId: string; tabId?: number; keys: string[] }; result: { ok: true } };

  'mouse.move': { params: { sessionId: string; tabId?: number; x: number; y: number }; result: { ok: true } };
  'mouse.click': { params: { sessionId: string; tabId?: number; x: number; y: number; button?: 'left' | 'middle' | 'right' }; result: { ok: true } };
  'mouse.wheel': { params: { sessionId: string; tabId?: number; dx?: number; dy?: number }; result: { ok: true } };

  'file.upload': {
    params: { sessionId: string; tabId?: number; locator: Locator; files: UploadFilePayload[]; requiresConfirm?: boolean };
    result: { ok: true; fileCount: number };
  };

  'context.get': {
    params: { sessionId: string; tabId?: number };
    result: SessionContextSnapshot;
  };
  'context.set': {
    params: { sessionId: string; tabId?: number; framePath?: string[]; shadowPath?: string[] };
    result: SessionContextSnapshot & { ok: true; frameDepth: number; shadowDepth: number };
  };
  'context.enterFrame': {
    params: { sessionId: string; tabId?: number; framePath?: string[]; locator?: Locator; reset?: boolean };
    result: { ok: true; frameDepth: number; framePath: string[] };
  };
  'context.exitFrame': {
    params: { sessionId: string; tabId?: number; levels?: number; reset?: boolean };
    result: { ok: true; frameDepth: number; framePath: string[] };
  };
  'context.enterShadow': {
    params: { sessionId: string; tabId?: number; hostSelectors?: string[]; locator?: Locator; reset?: boolean };
    result: { ok: true; shadowDepth: number; shadowPath: string[] };
  };
  'context.exitShadow': {
    params: { sessionId: string; tabId?: number; levels?: number; reset?: boolean };
    result: { ok: true; shadowDepth: number; shadowPath: string[] };
  };
  'context.reset': {
    params: { sessionId: string; tabId?: number };
    result: SessionContextSnapshot & { ok: true; frameDepth: number; shadowDepth: number };
  };

  'network.list': {
    params: {
      sessionId: string;
      tabId?: number;
      limit?: number;
      urlIncludes?: string;
      status?: number;
      method?: string;
    };
    result: { entries: NetworkEntry[] };
  };
  'network.get': {
    params: { sessionId: string; tabId?: number; id: string; include?: Array<'request' | 'response'>; bodyBytes?: number };
    result: { entry: NetworkEntry };
  };
  'network.search': {
    params: { sessionId: string; tabId?: number; pattern: string; limit?: number };
    result: { entries: NetworkEntry[] };
  };
  'network.replay': {
    params: {
      sessionId: string;
      tabId?: number;
      id: string;
      mode?: 'raw' | 'json';
      timeoutMs?: number;
      maxBytes?: number;
      withSchema?: 'auto';
      requiresConfirm?: boolean;
    };
    result: PageFetchResponse;
  };
  'network.waitFor': {
    params: {
      sessionId: string;
      tabId?: number;
      urlIncludes?: string;
      status?: number;
      method?: string;
      timeoutMs?: number;
    };
    result: { entry: NetworkEntry };
  };
  'network.clear': {
    params: { sessionId: string; tabId?: number };
    result: { ok: true };
  };

  'debug.getConsole': { params: { sessionId: string; tabId?: number; limit?: number }; result: { entries: ConsoleEntry[] } };
  'debug.dumpState': {
    params: {
      sessionId: string;
      tabId?: number;
      consoleLimit?: number;
      networkLimit?: number;
      includeAccessibility?: boolean;
      includeSnapshot?: boolean;
      includeSnapshotBase64?: boolean;
      annotateSnapshot?: boolean;
      snapshotDiffWith?: string;
      section?: DebugDumpSection[];
    };
    result: {
      url: string;
      title: string;
      context: {
        framePath: string[];
        shadowPath: string[];
      };
      dom?: PageDomSummary;
      text?: PageTextChunk[];
      elements?: ElementMapItem[];
      metrics?: PageMetrics;
      viewport?: { width: number; height: number; devicePixelRatio: number };
      console?: ConsoleEntry[];
      network?: NetworkEntry[];
      accessibility?: AccessibilityNode[];
      scripts?: {
        inlineCount: number;
        suspectedDataVars: string[];
      };
      globalsPreview?: string[];
      storage?: {
        localStorageKeys: string[];
        sessionStorageKeys: string[];
      };
      frames?: Array<{ framePath: string[]; url: string }>;
      networkSummary?: {
        total: number;
        recent: NetworkEntry[];
      };
      snapshot?: PersistedPageSnapshot;
    };
  };
  'table.list': {
    params: { sessionId: string; tabId?: number };
    result: { tables: TableHandle[] };
  };
  'table.schema': {
    params: { sessionId: string; tabId?: number; table: string };
    result: { table: TableHandle; schema: TableSchema };
  };
  'table.rows': {
    params: { sessionId: string; tabId?: number; table: string; limit?: number; all?: boolean; maxRows?: number };
    result: {
      table: TableHandle;
      extractionMode: TableExtractionMode;
      extraction: TableExtractionMetadata;
      rows: Array<Record<string, unknown>>;
    };
  };
  'table.export': {
    params: { sessionId: string; tabId?: number; table: string; format?: 'json'; all?: boolean; maxRows?: number };
    result: {
      table: TableHandle;
      extractionMode: TableExtractionMode;
      extraction: TableExtractionMetadata;
      rows: Array<Record<string, unknown>>;
    };
  };
  'inspect.pageData': {
    params: { sessionId: string; tabId?: number };
    result: InspectPageDataResult;
  };
  'inspect.liveUpdates': {
    params: { sessionId: string; tabId?: number };
    result: InspectLiveUpdatesResult;
  };
  'inspect.freshness': {
    params: { sessionId: string; tabId?: number; patterns?: string[] };
    result: InspectFreshnessResult;
  };
  'capture.snapshot': {
    params: { sessionId: string; tabId?: number; networkLimit?: number };
    result: CaptureSnapshotResult;
  };
  'capture.har': {
    params: { sessionId: string; tabId?: number; limit?: number };
    result: { har: Record<string, unknown> };
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
