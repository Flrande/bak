import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BakErrorCode, type ElementMapItem, type Locator, type MemoryRevision } from '../../packages/protocol/src/index.js';
import { BakService } from '../../packages/cli/src/service.js';
import { BridgeError } from '../../packages/cli/src/drivers/extension-bridge.js';
import type { BrowserDriver, DriverConnectionStatus, SnapshotResult } from '../../packages/cli/src/drivers/browser-driver.js';
import { createMemoryStore } from '../../packages/cli/src/memory/factory.js';
import type { MemoryStoreBackend } from '../../packages/cli/src/memory/store.js';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';
import { TraceStore } from '../../packages/cli/src/trace-store.js';

interface DriverRecorder {
  rawRequests: Array<{ method: string; params?: Record<string, unknown> }>;
  pageGotos: Array<{ url: string; tabId?: number }>;
  clicks: Array<{ locator: Locator; tabId?: number; requiresConfirm?: boolean }>;
  types: Array<{ locator: Locator; text: string; clear?: boolean; tabId?: number; requiresConfirm?: boolean }>;
  elementScrolls: Array<{ locator?: Locator; dx: number; dy: number; tabId?: number }>;
  snapshots: Array<{ tabId?: number; includeBase64?: boolean }>;
}

type ContextViewKey = 'top' | 'frame' | 'shadow' | 'frameShadow';

interface DriverView {
  url?: string;
  title?: string;
  textChunks?: string[];
  domSummary?: { totalElements: number; interactiveElements: number; iframes: number; shadowHosts: number; tagHistogram: Array<{ tag: string; count: number }> };
}

interface DriverOptions {
  activeUrl?: string;
  activeTitle?: string;
  activeTabId?: number;
  workspaceExists?: boolean;
  workspaceTabId?: number;
  workspaceActiveTabId?: number;
  workspaceTabIds?: number[];
  workspaceWindowId?: number;
  workspaceGroupId?: number;
  textChunks?: string[];
  domSummary?: { totalElements: number; interactiveElements: number; iframes: number; shadowHosts: number; tagHistogram: Array<{ tag: string; count: number }> };
  snapshotElements?: ElementMapItem[];
  failClick?: (locator: Locator) => boolean;
  views?: Partial<Record<ContextViewKey, DriverView>>;
  elementDetails?: Record<string, { element: ElementMapItem; value?: string; checked?: boolean; attributes?: Record<string, string> }>;
}

function createConnectionStatus(): DriverConnectionStatus {
  const now = Date.now();
  return {
    state: 'connected',
    reason: null,
    extensionVersion: '0.2.3',
    lastSeenTs: now,
    lastRequestTs: now,
    lastResponseTs: now,
    lastHeartbeatTs: now,
    lastError: null,
    connectedAtTs: now,
    disconnectedAtTs: null,
    pendingRequests: 0,
    totalRequests: 0,
    totalFailures: 0,
    totalTimeouts: 0,
    totalNotReady: 0
  };
}

function createDriver(recorder: DriverRecorder, options: DriverOptions = {}): BrowserDriver {
  let activeUrl = options.activeUrl ?? 'https://portal.local/spa';
  let activeTitle = options.activeTitle ?? 'Automation Console';
  const activeTabId = options.activeTabId ?? 1;
  const workspaceTabId = options.workspaceTabId ?? activeTabId;
  let workspaceExists = options.workspaceExists !== false;
  let workspaceTabIds = [...(options.workspaceTabIds ?? [workspaceTabId])];
  let workspaceActiveTabId = options.workspaceActiveTabId ?? workspaceTabId;
  const workspaceWindowId = options.workspaceWindowId ?? 50;
  const workspaceGroupId = options.workspaceGroupId ?? 70;
  const textChunks = options.textChunks ?? ['Automation Console', 'Queue task'];
  const domSummary = options.domSummary ?? {
    totalElements: 24,
    interactiveElements: 7,
    iframes: 0,
    shadowHosts: 0,
    tagHistogram: [{ tag: 'button', count: 3 }, { tag: 'input', count: 2 }]
  };
  const snapshotElements = options.snapshotElements ?? [
    {
      eid: 'eid_queue_btn',
      tag: 'button',
      role: 'button',
      name: 'Queue task',
      text: 'Queue task',
      bbox: { x: 10, y: 20, width: 100, height: 30 },
      selectors: { css: '#queue-btn', text: 'Queue task', aria: 'button:Queue task' },
      risk: 'low'
    }
  ];
  let frameDepth = 0;
  let shadowDepth = 0;

  const currentViewKey = (): ContextViewKey => {
    if (frameDepth > 0 && shadowDepth > 0) {
      return 'frameShadow';
    }
    if (frameDepth > 0) {
      return 'frame';
    }
    if (shadowDepth > 0) {
      return 'shadow';
    }
    return 'top';
  };

  const currentView = (): DriverView => {
    const view = options.views?.[currentViewKey()] ?? {};
    return {
      url: view.url ?? activeUrl,
      title: view.title ?? activeTitle,
      textChunks: view.textChunks ?? textChunks,
      domSummary: view.domSummary ?? domSummary
    };
  };

  const ensureWorkspaceState = (): void => {
    workspaceExists = true;
    if (workspaceTabIds.length === 0) {
      workspaceTabIds = [workspaceTabId];
    }
    if (!workspaceTabIds.includes(workspaceActiveTabId)) {
      workspaceTabIds = [...workspaceTabIds, workspaceActiveTabId];
    }
  };

  const workspaceTabs = () =>
    workspaceTabIds.map((id) => ({
      id,
      title: activeTitle,
      url: activeUrl,
      active: id === workspaceActiveTabId,
      windowId: workspaceWindowId,
      groupId: workspaceGroupId
    }));

  const workspacePayload = () => ({
    id: 'default',
    label: 'bak agent',
    color: 'blue' as const,
    windowId: workspaceWindowId,
    groupId: workspaceGroupId,
    tabIds: [...workspaceTabIds],
    activeTabId: workspaceActiveTabId,
    primaryTabId: workspaceTabIds[0] ?? workspaceActiveTabId,
    tabs: workspaceTabs()
  });

  return {
    isConnected: () => true,
    connectionStatus: () => createConnectionStatus(),
    sessionPing: async () => ({ ok: true, ts: Date.now() }),
    tabsList: async () => ({ tabs: [{ id: activeTabId, title: activeTitle, url: activeUrl, active: true, windowId: 1, groupId: null }] }),
    tabsFocus: async () => ({ ok: true }),
    tabsGetActive: async () => ({ tab: { id: activeTabId, title: activeTitle, url: activeUrl, active: true, windowId: 1, groupId: null } }),
    tabsGet: async (tabId: number) => ({ tab: { id: tabId, title: activeTitle, url: activeUrl, active: tabId === activeTabId, windowId: 1, groupId: null } }),
    tabsNew: async (request = {}) => ({ tabId: request.workspaceId ? workspaceTabId : activeTabId, windowId: request.workspaceId ? workspaceWindowId : 1, groupId: request.workspaceId ? workspaceGroupId : null, workspaceId: request.workspaceId }),
    tabsClose: async () => ({ ok: true }),
    pageGoto: async (url: string, tabId?: number) => {
      recorder.pageGotos.push({ url, tabId });
      activeUrl = url;
      activeTitle = url.includes('billing') ? 'Billing Settings' : 'Automation Console';
      return { ok: true };
    },
    pageBack: async () => ({ ok: true }),
    pageForward: async () => ({ ok: true }),
    pageReload: async () => ({ ok: true }),
    pageWait: async () => ({ ok: true }),
    pageSnapshot: async (tabId, includeBase64): Promise<SnapshotResult> => {
      recorder.snapshots.push({ tabId, includeBase64 });
      return {
        imageBase64: 'base64-image',
        elements: snapshotElements,
        tabId: 1,
        url: activeUrl
      };
    },
    elementClick: async (locator: Locator, tabId?: number, requiresConfirm?: boolean) => {
      recorder.clicks.push({ locator, tabId, requiresConfirm });
      if (options.failClick?.(locator)) {
        throw new BridgeError('E_NOT_FOUND', 'target not found');
      }
      return { ok: true };
    },
    elementType: async (locator: Locator, text: string, clear?: boolean, tabId?: number, requiresConfirm?: boolean) => {
      recorder.types.push({ locator, text, clear, tabId, requiresConfirm });
      return { ok: true };
    },
    elementScroll: async (locator, dx, dy, tabId) => {
      recorder.elementScrolls.push({ locator, dx, dy, tabId });
      return { ok: true };
    },
    debugGetConsole: async () => ({ entries: [{ level: 'info', message: 'console ok', ts: Date.now() }] }),
    userSelectCandidate: async () => ({ selectedEid: snapshotElements[0]?.eid ?? 'eid_fallback' }),
    workspaceEnsure: async () => ({
      ...(ensureWorkspaceState(), {}),
      workspace: workspacePayload(),
      created: false,
      repaired: false,
      repairActions: []
    }),
    workspaceInfo: async () => ({
      workspace: workspaceExists ? workspacePayload() : null
    }),
    workspaceOpenTab: async () => ({
      ...(ensureWorkspaceState(), {}),
      workspace: workspacePayload(),
      tab: workspaceTabs().find((tab) => tab.id === workspaceActiveTabId) ?? workspaceTabs()[0]!
    }),
    workspaceListTabs: async () => ({
      ...(ensureWorkspaceState(), {}),
      workspace: workspacePayload(),
      tabs: workspaceTabs()
    }),
    workspaceGetActiveTab: async () => ({
      ...(ensureWorkspaceState(), {}),
      workspace: workspacePayload(),
      tab: workspaceTabs().find((tab) => tab.id === workspaceActiveTabId) ?? null
    }),
    workspaceSetActiveTab: async ({ tabId }) => ({
      ...(ensureWorkspaceState(), workspaceActiveTabId = tabId, workspaceTabIds = workspaceTabIds.includes(tabId) ? workspaceTabIds : [...workspaceTabIds, tabId], {}),
      workspace: workspacePayload(),
      tab: workspaceTabs().find((tab) => tab.id === tabId)!
    }),
    workspaceFocus: async () => ({ ...(ensureWorkspaceState(), {}), ok: true, workspace: workspacePayload() }),
    workspaceReset: async () => ({ ...(ensureWorkspaceState(), {}), workspace: workspacePayload(), created: false, repaired: true, repairActions: ['reset'] }),
    workspaceClose: async () => {
      workspaceExists = false;
      return { ok: true };
    },
    rawRequest: async (method, params) => {
      recorder.rawRequests.push({ method, params });
      const view = currentView();
      switch (method) {
        case 'workspace.getActiveTab':
          ensureWorkspaceState();
          return {
            workspace: workspacePayload(),
            tab: workspaceTabs().find((tab) => tab.id === workspaceActiveTabId) ?? null
          };
        case 'page.url':
          return { url: view.url ?? activeUrl };
        case 'page.title':
          return { title: view.title ?? activeTitle };
        case 'page.text':
          return { chunks: (view.textChunks ?? textChunks).map((text, index) => ({ chunkId: `chunk_${index + 1}`, text, sourceTag: 'main' })) };
        case 'page.dom':
          return { summary: { url: view.url ?? activeUrl, title: view.title ?? activeTitle, ...(view.domSummary ?? domSummary) } };
        case 'page.metrics':
          return {
            navigation: { durationMs: 100, domContentLoadedMs: 40, loadEventMs: 65 },
            longTasks: { count: 0, totalDurationMs: 0 },
            resources: { count: 2, transferSize: 1280, encodedBodySize: 1024 }
          };
        case 'page.viewport':
          return { width: 1440, height: 900, devicePixelRatio: 1 };
        case 'element.get': {
          const locator = params?.locator as Locator | undefined;
          const detail = locator?.css ? options.elementDetails?.[locator.css] : undefined;
          const element = detail?.element ?? snapshotElements[0];
          return {
            element,
            value: detail?.value,
            checked: detail?.checked,
            attributes: detail?.attributes ?? {}
          };
        }
        case 'network.list':
          return { entries: [] };
        case 'context.enterFrame':
          frameDepth = 1;
          return { ok: true, frameDepth: 1, framePath: ['#demo-frame'] };
        case 'context.exitFrame':
          frameDepth = 0;
          return { ok: true, frameDepth: 0, framePath: [] };
        case 'context.enterShadow':
          shadowDepth += 1;
          return {
            ok: true,
            shadowDepth,
            shadowPath: shadowDepth > 1 ? ['#shadow-host', '#inner-shadow-host'] : ['#shadow-host']
          };
        case 'context.exitShadow':
          shadowDepth = Math.max(0, shadowDepth - 1);
          return { ok: true, shadowDepth, shadowPath: shadowDepth > 0 ? ['#shadow-host'] : [] };
        case 'context.reset':
          frameDepth = 0;
          shadowDepth = 0;
          return { ok: true, frameDepth: 0, shadowDepth: 0 };
        default:
          return { ok: true };
      }
    }
  };
}

function createRevisionFixture(
  store: MemoryStoreBackend,
  input: {
    kind: 'route' | 'procedure' | 'composite';
    title: string;
    goal: string;
    description?: string;
    steps: MemoryRevision['steps'];
    entryUrl?: string;
    targetUrl?: string;
  }
): { memoryId: string; revisionId: string } {
  const entryFingerprint = input.entryUrl
    ? store.createPageFingerprint({
        url: input.entryUrl,
        origin: new URL(input.entryUrl).origin,
        path: new URL(input.entryUrl).pathname,
        title: input.title,
        headings: [],
        textSnippets: [],
        anchorNames: [],
        dom: { totalElements: 5, interactiveElements: 2, iframes: 0, shadowHosts: 0, tagHistogram: [] },
        capturedAt: '2026-03-08T00:00:00.000Z'
      })
    : undefined;
  const targetFingerprint = input.targetUrl
    ? store.createPageFingerprint({
        url: input.targetUrl,
        origin: new URL(input.targetUrl).origin,
        path: new URL(input.targetUrl).pathname,
        title: input.title,
        headings: [],
        textSnippets: [],
        anchorNames: [],
        dom: { totalElements: 5, interactiveElements: 2, iframes: 0, shadowHosts: 0, tagHistogram: [] },
        capturedAt: '2026-03-08T00:00:00.000Z'
      })
    : undefined;

  const memory = store.createMemory({
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    description: input.description ?? input.goal,
    tags: [input.kind]
  });
  const revision = store.createRevision({
    memoryId: memory.id,
    kind: input.kind,
    title: memory.title,
    goal: memory.goal,
    description: memory.description,
    steps: input.steps,
    parameterSchema: {},
    entryFingerprintId: entryFingerprint?.id,
    targetFingerprintId: targetFingerprint?.id,
    tags: memory.tags,
    rationale: [],
    riskNotes: [],
    changeSummary: ['Initial revision']
  });
  return { memoryId: memory.id, revisionId: revision.id };
}

async function withService<T>(
  fn: (ctx: { service: BakService; store: MemoryStoreBackend; traceStore: TraceStore; recorder: DriverRecorder }) => Promise<T> | T,
  options: DriverOptions = {}
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bak-memory-service-'));
  const previousDataDir = process.env.BAK_DATA_DIR;
  process.env.BAK_DATA_DIR = dataDir;

  const pairingStore = new PairingStore(dataDir);
  pairingStore.createToken();
  const traceStore = new TraceStore(dataDir);
  const store = createMemoryStore({ dataDir });
  const recorder: DriverRecorder = { rawRequests: [], pageGotos: [], clicks: [], types: [], elementScrolls: [], snapshots: [] };
  const service = new BakService(createDriver(recorder, options), pairingStore, traceStore, store);

  try {
    return await fn({ service, store, traceStore, recorder });
  } finally {
    store.close?.();
    if (previousDataDir === undefined) {
      delete process.env.BAK_DATA_DIR;
    } else {
      process.env.BAK_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('memory service v3', () => {
  it('does not create durable memories unless the agent explicitly captures and promotes', async () => {
    await withService(async ({ service, store }) => {
      await service.invoke('page.goto', { url: 'https://portal.local/spa' });
      await service.invoke('element.type', { locator: { css: '#task-input' }, text: 'Implicit', clear: true });

      expect(store.listCaptureSessions().length).toBe(0);
      expect(store.listDraftMemories().length).toBe(0);
      expect(store.listMemories().length).toBe(0);
    });
  });

  it('supports explicit capture -> draft -> promote without hidden execution during search', async () => {
    await withService(async ({ service, store, recorder }) => {
      const start = await service.invoke('memory.capture.begin', { goal: 'queue automation task', labels: ['spa'] });
      await service.invoke('page.goto', { url: 'https://portal.local/spa' });
      await service.invoke('memory.capture.mark', { label: 'nav complete', role: 'procedure' });
      await service.invoke('element.type', { locator: { css: '#task-input', name: 'Task title' }, text: 'Nightly backup', clear: true });
      await service.invoke('element.click', { locator: { css: '#queue-btn', text: 'Queue task' } });
      const ended = await service.invoke('memory.capture.end', { outcome: 'completed' });

      expect(start.captureSession.id).toBeTruthy();
      expect(store.listMemories().length).toBe(0);
      expect(ended.drafts.length).toBeGreaterThanOrEqual(2);

      const routeDraft = ended.drafts.find((draft) => draft.kind === 'route');
      const procedureDraft = ended.drafts.find((draft) => draft.kind === 'procedure');
      expect(routeDraft).toBeTruthy();
      expect(procedureDraft).toBeTruthy();

      const promotedRoute = routeDraft ? await service.invoke('memory.drafts.promote', { id: routeDraft.id }) : null;
      const promotedProcedure = procedureDraft ? await service.invoke('memory.drafts.promote', { id: procedureDraft.id }) : null;
      expect(promotedRoute?.memory.kind).toBe('route');
      expect(promotedProcedure?.memory.kind).toBe('procedure');

      const beforeSearchClickCount = recorder.clicks.length;
      const search = await service.invoke('memory.memories.search', { goal: 'queue automation task' });
      expect(search.candidates.length).toBeGreaterThan(0);
      expect(recorder.clicks.length).toBe(beforeSearchClickCount);
      expect(store.listMemories().length).toBe(2);
    });
  });

  it('resolves omitted browser targets to the workspace tab instead of the active human tab', async () => {
    await withService(
      async ({ service, recorder }) => {
        await service.invoke('page.goto', { url: 'https://portal.local/spa' });
        await service.invoke('element.click', { locator: { css: '#queue-btn' } });
        await service.invoke('page.snapshot', { includeBase64: false });

        expect(recorder.pageGotos[0]?.tabId).toBe(42);
        expect(recorder.clicks[0]?.tabId).toBe(42);
        expect(recorder.snapshots[0]?.tabId).toBe(42);
      },
      {
        activeTabId: 1,
        workspaceTabId: 42
      }
    );
  });

  it('falls back to the active browser tab when no workspace exists', async () => {
    await withService(
      async ({ service, recorder }) => {
        await service.invoke('page.title', {});
        await service.invoke('page.goto', { url: 'https://portal.local/spa' });

        expect(recorder.rawRequests).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: 'page.title', params: expect.objectContaining({ tabId: 1 }) })])
        );
        expect(recorder.pageGotos[0]?.tabId).toBe(1);
      },
      {
        activeTabId: 1,
        workspaceTabId: 42,
        workspaceExists: false
      }
    );
  });

  it('keeps explicit tab ids ahead of workspace defaults', async () => {
    await withService(
      async ({ service, recorder }) => {
        await service.invoke('page.goto', { url: 'https://portal.local/spa', tabId: 7 });
        await service.invoke('element.click', { locator: { css: '#queue-btn' }, tabId: 7 });

        expect(recorder.pageGotos[0]?.tabId).toBe(7);
        expect(recorder.clicks[0]?.tabId).toBe(7);
      },
      {
        activeTabId: 1,
        workspaceTabId: 42
      }
    );
  });

  it('switches the workspace current tab and uses it for later default commands', async () => {
    await withService(
      async ({ service, recorder }) => {
        const activeBefore = await service.invoke('workspace.getActiveTab', {});
        expect(activeBefore.tab?.id).toBe(42);

        const switched = await service.invoke('workspace.setActiveTab', { tabId: 77 });
        expect(switched.tab.id).toBe(77);

        await service.invoke('page.goto', { url: 'https://portal.local/spa' });
        await service.invoke('element.click', { locator: { css: '#queue-btn' } });

        expect(recorder.pageGotos[0]?.tabId).toBe(77);
        expect(recorder.clicks[0]?.tabId).toBe(77);
      },
      {
        activeTabId: 1,
        workspaceTabId: 42,
        workspaceTabIds: [42, 77],
        workspaceActiveTabId: 42
      }
    );
  });

  it('aligns capture, explain, plan, and execute flows to the workspace tab when no tab id is provided', async () => {
    await withService(
      async ({ service, store, recorder }) => {
        const started = await service.invoke('memory.capture.begin', { goal: 'queue task in workspace' });
        expect(started.captureSession.tabId).toBe(42);

        await service.invoke('memory.capture.mark', { label: 'queue task', role: 'procedure' });
        await service.invoke('element.type', { locator: { css: '#task-input' }, text: 'Nightly', clear: true });
        await service.invoke('memory.capture.end', { outcome: 'completed' });

        const { memoryId } = createRevisionFixture(store, {
          kind: 'route',
          title: 'Route to automation console',
          goal: 'open automation console',
          steps: [{ kind: 'goto', url: 'https://portal.local/spa.html' }],
          entryUrl: 'https://portal.local/',
          targetUrl: 'https://portal.local/spa.html'
        });

        await service.invoke('memory.memories.explain', { id: memoryId });
        const plan = await service.invoke('memory.plans.create', { memoryId, mode: 'auto' });
        await service.invoke('memory.plans.execute', { id: plan.plan.id, mode: 'auto' });

        expect(recorder.rawRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ method: 'page.url', params: expect.objectContaining({ tabId: 42 }) }),
            expect.objectContaining({ method: 'page.dom', params: expect.objectContaining({ tabId: 42 }) }),
            expect.objectContaining({ method: 'page.text', params: expect.objectContaining({ tabId: 42 }) })
          ])
        );
        expect(recorder.pageGotos.at(-1)?.tabId).toBe(42);
      },
      {
        activeTabId: 1,
        workspaceTabId: 42,
        activeUrl: 'https://portal.local/',
        activeTitle: 'Home'
      }
    );
  });

  it('prefers a route memory over a procedure memory when searching from the remembered route entry page', async () => {
    await withService(
      async ({ service, store }) => {
        const route = createRevisionFixture(store, {
          kind: 'route',
          title: 'Route to automation console',
          goal: 'open automation console',
          steps: [
            { kind: 'click', locator: { css: '#goto-spa', text: 'SPA async page (route + delayed queue)' } },
            { kind: 'wait', waitFor: { mode: 'selector', value: '#tab-automation', timeoutMs: 5000 } },
            { kind: 'click', locator: { css: '#tab-automation', text: 'Automation' } }
          ],
          entryUrl: 'https://portal.local/',
          targetUrl: 'https://portal.local/spa.html'
        });
        createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Queue task in automation console',
          goal: 'open automation console',
          steps: [{ kind: 'type', locator: { css: '#task-input' }, text: 'Nightly backup', clear: true }],
          entryUrl: 'https://portal.local/spa.html',
          targetUrl: 'https://portal.local/spa.html'
        });

        const search = await service.invoke('memory.memories.search', {
          goal: 'open automation console'
        });

        expect(search.candidates[0]?.memoryId).toBe(route.memoryId);
        expect(search.candidates[0]?.kind).toBe('route');
        expect(search.candidates[0]?.whyMatched).toContain('current page resembles the route entry');
      },
      {
        activeUrl: 'https://portal.local/',
        activeTitle: 'Home',
        textChunks: ['Browser Agent Kit Test Site', 'SPA async page']
      }
    );
  });

  it('captures live locator candidates for procedure steps so later patching can match by more than raw css', async () => {
    await withService(
      async ({ service }) => {
        await service.invoke('memory.capture.begin', { goal: 'run drift action' });
        await service.invoke('memory.capture.mark', { label: 'run drift action', role: 'procedure' });
        await service.invoke('element.click', { locator: { css: '#action-primary' } });
        const ended = await service.invoke('memory.capture.end', { outcome: 'completed' });

        const stepCarrierDraft = ended.drafts.find((draft) => draft.steps.some((step) => step.kind === 'click'));
        expect(stepCarrierDraft).toBeTruthy();
        expect(stepCarrierDraft?.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'click',
              locator: expect.objectContaining({ css: '#action-primary' }),
              targetCandidates: expect.arrayContaining([
                expect.objectContaining({
                  css: '#action-primary',
                  role: 'button',
                  name: 'Run Action',
                  text: 'Run Action'
                })
              ])
            })
          ])
        );
      },
      {
        snapshotElements: [
          {
            eid: 'eid_action_primary',
            tag: 'button',
            role: 'button',
            name: 'Run Action',
            text: 'Run Action',
            bbox: { x: 20, y: 40, width: 120, height: 32 },
            selectors: { css: '#action-primary', text: 'Run Action', aria: 'button:Run Action' },
            risk: 'low'
          }
        ],
        elementDetails: {
          '#action-primary': {
            element: {
              eid: 'eid_action_primary',
              tag: 'button',
              role: 'button',
              name: 'Run Action',
              text: 'Run Action',
              bbox: { x: 20, y: 40, width: 120, height: 32 },
              selectors: { css: '#action-primary', text: 'Run Action', aria: 'button:Run Action' },
              risk: 'low'
            },
            attributes: { id: 'action-primary' }
          }
        }
      }
    );
  });

  it('enforces a single active capture session at a time', async () => {
    await withService(async ({ service, store }) => {
      const started = await service.invoke('memory.capture.begin', { goal: 'first capture' });

      await expect(service.invoke('memory.capture.begin', { goal: 'second capture' })).rejects.toMatchObject({
        bakCode: BakErrorCode.E_INVALID_PARAMS,
        details: {
          captureSessionId: started.captureSession.id
        }
      });

      expect(store.listCaptureSessions().filter((session) => session.status === 'capturing')).toHaveLength(1);
      await service.invoke('memory.capture.end', { outcome: 'abandoned' });
      expect(store.listCaptureSessions().filter((session) => session.status === 'capturing')).toHaveLength(0);
    });
  });

  it('captures fingerprints with metadata aligned to the active context document', async () => {
    const cases: Array<{
      label: string;
      beforeCapture: (service: BakService) => Promise<void>;
      expected: { url: string; title: string; snippet: string };
    }> = [
      {
        label: 'top-level',
        beforeCapture: async () => {},
        expected: {
          url: 'https://portal.local/spa',
          title: 'Automation Console',
          snippet: 'Top Console'
        }
      },
      {
        label: 'frame',
        beforeCapture: async (service) => {
          await service.invoke('context.enterFrame', { framePath: ['#demo-frame'] });
        },
        expected: {
          url: 'https://portal.local/iframe-child',
          title: 'Iframe Child',
          snippet: 'Iframe Child'
        }
      },
      {
        label: 'shadow',
        beforeCapture: async (service) => {
          await service.invoke('context.enterShadow', { hostSelectors: ['#shadow-host'] });
        },
        expected: {
          url: 'https://portal.local/shadow',
          title: 'Shadow Playground',
          snippet: 'Shadow Action'
        }
      },
      {
        label: 'frame+shadow',
        beforeCapture: async (service) => {
          await service.invoke('context.enterFrame', { framePath: ['#demo-frame'] });
          await service.invoke('context.enterShadow', { hostSelectors: ['#frame-shadow-host'] });
        },
        expected: {
          url: 'https://portal.local/iframe-child',
          title: 'Iframe Child',
          snippet: 'Frame Shadow Action'
        }
      }
    ];

    for (const testCase of cases) {
      await withService(
        async ({ service, store }) => {
          await testCase.beforeCapture(service);
          const started = await service.invoke('memory.capture.begin', { goal: `capture ${testCase.label}` });
          const session = store.getCaptureSession(started.captureSession.id);
          const fingerprint = session?.startFingerprintId ? store.getPageFingerprint(session.startFingerprintId) : null;

          expect(fingerprint?.url).toBe(testCase.expected.url);
          expect(fingerprint?.title).toBe(testCase.expected.title);
          expect(fingerprint?.path).toBe(new URL(testCase.expected.url).pathname);
          expect(fingerprint?.textSnippets.some((snippet) => snippet.includes(testCase.expected.snippet))).toBe(true);

          await service.invoke('memory.capture.end', { outcome: 'abandoned' });
        },
        {
          activeUrl: 'https://portal.local/spa',
          activeTitle: 'Automation Console',
          textChunks: ['Top Console', 'Queue task'],
          views: {
            frame: {
              url: 'https://portal.local/iframe-child',
              title: 'Iframe Child',
              textChunks: ['Iframe Child', 'Frame Action']
            },
            shadow: {
              url: 'https://portal.local/shadow',
              title: 'Shadow Playground',
              textChunks: ['Shadow Action', 'Shadow Input']
            },
            frameShadow: {
              url: 'https://portal.local/iframe-child',
              title: 'Iframe Child',
              textChunks: ['Frame Shadow Action', 'Frame Shadow Input']
            }
          }
        }
      );
    }
  });

  it('explains applicability and rejects clearly inapplicable procedure plans', async () => {
    await withService(
      async ({ service, store }) => {
        const { memoryId } = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Update billing name',
          goal: 'update billing name',
          steps: [{ kind: 'type', locator: { css: '#billing-name' }, text: '{{name}}' }],
          targetUrl: 'https://billing.local/settings'
        });

        const explain = await service.invoke('memory.memories.explain', { id: memoryId });
        expect(explain.explanation.checks.length).toBeGreaterThan(0);
        expect(explain.explanation.whyMatched[0]).toContain('procedure memory');

        await expect(service.invoke('memory.plans.create', { memoryId, parameters: { name: 'Alice' } })).rejects.toMatchObject({
          bakCode: BakErrorCode.E_NOT_FOUND
        });
      },
      {
        activeUrl: 'https://portal.local/spa',
        activeTitle: 'Automation Console',
        textChunks: ['Automation Console', 'Queue task']
      }
    );
  });

  it('executes assist mode conservatively by pausing before procedure mutations', async () => {
    await withService(
      async ({ service, store, recorder }) => {
        const { memoryId } = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Fill automation task',
          goal: 'fill automation task',
          steps: [{ kind: 'type', locator: { css: '#task-input' }, text: '{{task_name}}', clear: true }],
          targetUrl: 'https://portal.local/spa'
        });

        const created = await service.invoke('memory.plans.create', {
          memoryId,
          mode: 'assist',
          parameters: { task_name: 'Assist only' }
        });
        const executed = await service.invoke('memory.plans.execute', { id: created.plan.id, mode: 'assist' });

        expect(executed.run.status).toBe('blocked');
        expect(executed.run.steps[0]?.status).toBe('blocked');
        expect(recorder.types).toEqual([]);
      },
      {
        activeUrl: 'https://portal.local/spa',
        activeTitle: 'Automation Console'
      }
    );
  });

  it('executes route memories in assist mode without blocking route navigation steps', async () => {
    await withService(
      async ({ service, store, recorder }) => {
        const route = createRevisionFixture(store, {
          kind: 'route',
          title: 'Route to automation console',
          goal: 'open automation console',
          steps: [
            { kind: 'goto', url: 'https://portal.local/spa.html' },
            { kind: 'wait', waitFor: { mode: 'selector', value: '#tab-automation', timeoutMs: 5000 } },
            { kind: 'click', locator: { css: '#tab-automation', text: 'Automation' } }
          ],
          entryUrl: 'https://portal.local/',
          targetUrl: 'https://portal.local/spa.html'
        });

        const plan = await service.invoke('memory.plans.create', {
          memoryId: route.memoryId,
          mode: 'assist'
        });
        const run = await service.invoke('memory.plans.execute', {
          id: plan.plan.id,
          mode: 'assist'
        });
        const url = await service.invoke('page.url', {});

        expect(plan.plan.kind).toBe('route');
        expect(plan.plan.steps.every((step) => step.sourceKind === 'route')).toBe(true);
        expect(run.run.status).toBe('completed');
        expect(run.run.steps.every((step) => step.status === 'completed')).toBe(true);
        expect(recorder.clicks).toHaveLength(1);
        expect(url.url).toContain('/spa.html');
      },
      {
        activeUrl: 'https://portal.local/',
        activeTitle: 'Home',
        textChunks: ['Browser Agent Kit Test Site', 'SPA async page']
      }
    );
  });

  it('creates explicit patch suggestions on drift instead of silently mutating memory', async () => {
    await withService(
      async ({ service, store, recorder }) => {
        const { memoryId } = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Queue task',
          goal: 'queue task',
          steps: [
            {
              kind: 'click',
              locator: { css: '#old-queue-btn', text: 'Queue task' },
              targetCandidates: [{ text: 'Queue task' }, { css: '#old-queue-btn' }]
            }
          ],
          targetUrl: 'https://portal.local/spa'
        });
        const beforeRevisionIds = store.listRevisions(memoryId).map((revision) => revision.id);

        const plan = await service.invoke('memory.plans.create', { memoryId, mode: 'auto' });
        const run = await service.invoke('memory.plans.execute', { id: plan.plan.id, mode: 'auto' });
        expect(run.run.status).toBe('failed');
        expect(run.run.patchSuggestionIds.length).toBe(1);

        const patches = await service.invoke('memory.patches.list', { memoryId });
        expect(patches.patches).toHaveLength(1);
        expect(patches.patches[0]?.status).toBe('open');
        expect(store.listRevisions(memoryId).map((revision) => revision.id)).toEqual(beforeRevisionIds);

        const applied = await service.invoke('memory.patches.apply', { id: patches.patches[0]!.id, note: 'accept healed locator' });
        expect(applied.patch.status).toBe('applied');
        expect(store.listRevisions(memoryId).length).toBe(beforeRevisionIds.length + 1);
        expect(recorder.clicks.length).toBe(1);

        await expect(service.invoke('memory.patches.reject', { id: patches.patches[0]!.id, reason: 'too late' })).rejects.toMatchObject({
          bakCode: BakErrorCode.E_INVALID_PARAMS
        });
      },
      {
        activeUrl: 'https://portal.local/spa',
        activeTitle: 'Automation Console',
        snapshotElements: [
          {
            eid: 'eid_queue_btn',
            tag: 'button',
            role: 'button',
            name: 'Queue task',
            text: 'Queue task',
            bbox: { x: 1, y: 1, width: 10, height: 10 },
            selectors: { css: '#queue-btn', text: 'Queue task', aria: 'button:Queue task' },
            risk: 'low'
          }
        ],
        failClick: (locator) => locator.css === '#old-queue-btn'
      }
    );
  });

  it('allows rejecting an open patch once and blocks later apply attempts', async () => {
    await withService(
      async ({ service, store }) => {
        const { memoryId } = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Queue task',
          goal: 'queue task',
          steps: [
            {
              kind: 'click',
              locator: { css: '#old-queue-btn', text: 'Queue task' },
              targetCandidates: [{ text: 'Queue task' }, { css: '#old-queue-btn' }]
            }
          ],
          targetUrl: 'https://portal.local/spa'
        });

        const plan = await service.invoke('memory.plans.create', { memoryId, mode: 'auto' });
        const run = await service.invoke('memory.plans.execute', { id: plan.plan.id, mode: 'auto' });
        expect(run.run.patchSuggestionIds).toHaveLength(1);

        const patchId = run.run.patchSuggestionIds[0]!;
        const rejected = await service.invoke('memory.patches.reject', { id: patchId, reason: 'not safe enough' });
        expect(rejected.patch.status).toBe('rejected');

        await expect(service.invoke('memory.patches.apply', { id: patchId, note: 'retry apply' })).rejects.toMatchObject({
          bakCode: BakErrorCode.E_INVALID_PARAMS
        });
      },
      {
        activeUrl: 'https://portal.local/spa',
        activeTitle: 'Automation Console',
        snapshotElements: [
          {
            eid: 'eid_queue_btn',
            tag: 'button',
            role: 'button',
            name: 'Queue task',
            text: 'Queue task',
            bbox: { x: 1, y: 1, width: 10, height: 10 },
            selectors: { css: '#queue-btn', text: 'Queue task', aria: 'button:Queue task' },
            risk: 'low'
          }
        ],
        failClick: (locator) => locator.css === '#old-queue-btn'
      }
    );
  });

  it('supports distinct route and procedure memories composed into a composite plan', async () => {
    await withService(
      async ({ service, store }) => {
        const route = createRevisionFixture(store, {
          kind: 'route',
          title: 'Open automation console',
          goal: 'open automation console',
          steps: [
            { kind: 'goto', url: 'https://portal.local/spa' },
            { kind: 'click', locator: { css: '#tab-automation', text: 'Automation' } }
          ],
          entryUrl: 'https://portal.local/home',
          targetUrl: 'https://portal.local/spa'
        });
        const procedure = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Queue task from console',
          goal: 'queue task from console',
          steps: [{ kind: 'type', locator: { css: '#task-input' }, text: '{{task_name}}', clear: true }],
          targetUrl: 'https://portal.local/spa'
        });

        const plan = await service.invoke('memory.plans.create', {
          routeMemoryId: route.memoryId,
          procedureMemoryId: procedure.memoryId,
          mode: 'dry-run',
          parameters: { task_name: 'Nightly' }
        });
        const run = await service.invoke('memory.plans.execute', { id: plan.plan.id, mode: 'dry-run' });

        expect(plan.plan.kind).toBe('composite');
        expect(plan.plan.applicabilityStatus).toBe('partial');
        expect(plan.plan.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: 'route-procedure-handoff',
              status: 'pass'
            })
          ])
        );
        expect(plan.plan.steps.some((step) => step.sourceKind === 'route')).toBe(true);
        expect(plan.plan.steps.some((step) => step.sourceKind === 'procedure')).toBe(true);
        expect(run.run.steps.every((step) => step.status === 'dry-run')).toBe(true);
      },
      {
        activeUrl: 'https://portal.local/home',
        activeTitle: 'Home'
      }
    );
  });

  it('aligns direct composite memory applicability with route-plus-procedure planning', async () => {
    await withService(
      async ({ service, store }) => {
        const route = createRevisionFixture(store, {
          kind: 'route',
          title: 'Open automation console',
          goal: 'open automation console',
          steps: [
            { kind: 'goto', url: 'https://portal.local/spa' },
            { kind: 'click', locator: { css: '#tab-automation', text: 'Automation' } }
          ],
          entryUrl: 'https://portal.local/home',
          targetUrl: 'https://portal.local/spa'
        });
        const procedure = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Queue task from console',
          goal: 'queue task from console',
          steps: [{ kind: 'type', locator: { css: '#task-input' }, text: '{{task_name}}', clear: true }],
          targetUrl: 'https://portal.local/spa'
        });
        const directComposite = createRevisionFixture(store, {
          kind: 'composite',
          title: 'Open console and queue task',
          goal: 'open console and queue task',
          steps: [
            { kind: 'goto', url: 'https://portal.local/spa' },
            { kind: 'click', locator: { css: '#tab-automation', text: 'Automation' } },
            { kind: 'type', locator: { css: '#task-input' }, text: '{{task_name}}', clear: true }
          ],
          entryUrl: 'https://portal.local/home',
          targetUrl: 'https://portal.local/spa'
        });

        const composed = await service.invoke('memory.plans.create', {
          routeMemoryId: route.memoryId,
          procedureMemoryId: procedure.memoryId,
          mode: 'dry-run',
          parameters: { task_name: 'Nightly' }
        });
        const direct = await service.invoke('memory.plans.create', {
          memoryId: directComposite.memoryId,
          mode: 'dry-run',
          parameters: { task_name: 'Nightly' }
        });

        const checkMap = (checks: Array<{ key: string; status: string }>) => Object.fromEntries(checks.map((check) => [check.key, check.status]));
        expect(direct.plan.kind).toBe('composite');
        expect(direct.plan.applicabilityStatus).toBe(composed.plan.applicabilityStatus);
        expect(checkMap(direct.plan.checks)).toMatchObject({
          'route-entry-page': checkMap(composed.plan.checks)['route-entry-page'],
          'route-procedure-handoff': checkMap(composed.plan.checks)['route-procedure-handoff']
        });
      },
      {
        activeUrl: 'https://portal.local/home',
        activeTitle: 'Home'
      }
    );
  });

  it('keeps composite applicability explainable for weak entry fit and handoff mismatch', async () => {
    await withService(
      async ({ service, store }) => {
        const route = createRevisionFixture(store, {
          kind: 'route',
          title: 'Open billing',
          goal: 'open billing',
          steps: [{ kind: 'goto', url: 'https://portal.local/settings/billing' }],
          entryUrl: 'https://portal.local/home',
          targetUrl: 'https://portal.local/settings/billing'
        });
        const procedure = createRevisionFixture(store, {
          kind: 'procedure',
          title: 'Update billing name',
          goal: 'update billing name',
          steps: [{ kind: 'type', locator: { css: '#billing-name' }, text: '{{name}}' }],
          targetUrl: 'https://support.local/tickets'
        });
        const directComposite = createRevisionFixture(store, {
          kind: 'composite',
          title: 'Open billing and edit name',
          goal: 'open billing and edit name',
          steps: [
            { kind: 'goto', url: 'https://portal.local/settings/billing' },
            { kind: 'type', locator: { css: '#billing-name' }, text: '{{name}}' }
          ],
          entryUrl: 'https://portal.local/home',
          targetUrl: 'https://portal.local/settings/billing'
        });

        const mismatch = await service.invoke('memory.plans.create', {
          routeMemoryId: route.memoryId,
          procedureMemoryId: procedure.memoryId,
          mode: 'dry-run',
          parameters: { name: 'Alice' }
        });
        expect(mismatch.plan.applicabilityStatus).toBe('inapplicable');
        expect(mismatch.plan.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: 'route-procedure-handoff',
              status: 'fail'
            })
          ])
        );

        const weakEntry = await service.invoke('memory.plans.create', {
          memoryId: directComposite.memoryId,
          mode: 'dry-run',
          parameters: { name: 'Alice' }
        });
        expect(weakEntry.plan.applicabilityStatus).toBe('partial');
        expect(weakEntry.plan.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: 'route-entry-page',
              status: 'warn'
            }),
            expect.objectContaining({
              key: 'route-procedure-handoff',
              status: 'pass'
            })
          ])
        );
      },
      {
        activeUrl: 'https://portal.local/landing',
        activeTitle: 'Landing'
      }
    );
  });

  it('uses explicit url context when searching memories without a live tab target', async () => {
    await withService(async ({ service, store }) => {
      const billing = createRevisionFixture(store, {
        kind: 'procedure',
        title: 'Update profile on billing',
        goal: 'update profile',
        steps: [{ kind: 'type', locator: { css: '#billing-name' }, text: '{{name}}' }],
        targetUrl: 'https://billing.local/settings'
      });
      createRevisionFixture(store, {
        kind: 'procedure',
        title: 'Update profile on support',
        goal: 'update profile',
        steps: [{ kind: 'type', locator: { css: '#support-name' }, text: '{{name}}' }],
        targetUrl: 'https://support.local/settings'
      });

      const search = await service.invoke('memory.memories.search', {
        goal: 'update profile',
        url: 'https://billing.local/settings',
        kind: 'procedure'
      });

      expect(search.candidates[0]?.memoryId).toBe(billing.memoryId);
    });
  });

  it('can attach a persisted snapshot to debug.dumpState when explicitly requested', async () => {
    await withService(async ({ service, recorder }) => {
      const dump = await service.invoke('debug.dumpState', {
        includeSnapshot: true,
        includeSnapshotBase64: true
      });

      expect(dump.snapshot?.traceId).toBeTruthy();
      expect(dump.snapshot?.imagePath).toBeTruthy();
      expect(dump.snapshot?.elementsPath).toBeTruthy();
      expect(dump.snapshot?.imageBase64).toBe('base64-image');
      expect(dump.snapshot?.elementCount).toBeGreaterThan(0);
      expect(existsSync(dump.snapshot?.imagePath ?? '')).toBe(true);
      expect(existsSync(dump.snapshot?.elementsPath ?? '')).toBe(true);
      expect(recorder.snapshots).toHaveLength(1);
    });
  });

  it('redacts typed input and snapshot base64 content in traces', async () => {
    await withService(async ({ service, traceStore }) => {
      await service.invoke('element.type', { locator: { css: '#task-input' }, text: 'super-secret', clear: true });
      await service.invoke('page.snapshot', { includeBase64: true });

      const traceId = traceStore.listTraceIds()[0];
      const trace = traceStore.readTrace(traceId);
      const typedEntry = trace.find((entry) => entry.method === 'element.type');
      const snapshotResult = trace.find((entry) => entry.method === 'page.snapshot:result');

      expect(typedEntry?.params).toMatchObject({ text: '[REDACTED]' });
      expect(snapshotResult?.result).toMatchObject({ imageBase64: '[REDACTED:base64]' });
    });
  });
});
