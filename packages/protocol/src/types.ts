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
  css: z.string().optional()
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
  level: z.enum(['error', 'warn', 'info']),
  message: z.string(),
  ts: z.number(),
  source: z.string().optional()
});

export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export interface SkillPlanStep {
  kind: 'goto' | 'click' | 'type' | 'wait';
  locator?: Locator;
  targetCandidates?: Locator[];
  text?: string;
  url?: string;
  waitFor?: {
    mode: 'selector' | 'text' | 'url';
    value: string;
    timeoutMs?: number;
  };
  requiresConfirmation?: boolean;
}

export interface Skill {
  id: string;
  domain: string;
  intent: string;
  description: string;
  plan: SkillPlanStep[];
  paramsSchema: {
    required?: string[];
    fields: Record<string, { type: 'string'; description?: string }>;
  };
  healing: {
    retries: number;
  };
  stats: {
    runs: number;
    success: number;
    failure: number;
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
  createdAt: string;
}

export interface NeedUserConfirmData {
  reason: string;
  candidates: ElementMapItem[];
  action: 'click' | 'type';
}

export interface MethodMap {
  'session.create': { params: { clientName?: string }; result: { sessionId: string } };
  'session.close': { params: { sessionId: string }; result: { closed: true } };
  'session.info': {
    params: { sessionId?: string };
    result: {
      sessionId: string | null;
      paired: boolean;
      extensionConnected: boolean;
      recording: boolean;
    };
  };
  'tabs.list': {
    params: { sessionId?: string };
    result: { tabs: Array<{ id: number; title: string; url: string; active: boolean }> };
  };
  'tabs.focus': { params: { tabId: number }; result: { ok: true } };
  'tabs.new': { params: { url?: string }; result: { tabId: number } };
  'tabs.close': { params: { tabId: number }; result: { ok: true } };
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
  'element.click': { params: { tabId?: number; locator: Locator }; result: { ok: true } };
  'element.type': {
    params: { tabId?: number; locator: Locator; text: string; clear?: boolean };
    result: { ok: true };
  };
  'element.scroll': {
    params: { tabId?: number; locator?: Locator; dx?: number; dy?: number };
    result: { ok: true };
  };
  'debug.getConsole': { params: { tabId?: number; limit?: number }; result: { entries: ConsoleEntry[] } };
  'memory.recordStart': {
    params: { intent: string; sessionId?: string };
    result: { recordingId: string };
  };
  'memory.recordStop': { params: { outcome?: 'success' | 'failed' }; result: { episodeId: string; skillId?: string } };
  'memory.skills.list': {
    params: { domain?: string; intent?: string };
    result: { skills: Skill[] };
  };
  'memory.skills.show': { params: { id: string }; result: { skill: Skill } };
  'memory.skills.run': {
    params: { id: string; params?: Record<string, string>; tabId?: number };
    result: { ok: true; updatedSkill?: Skill };
  };
  'memory.skills.delete': { params: { id: string }; result: { ok: true } };
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
