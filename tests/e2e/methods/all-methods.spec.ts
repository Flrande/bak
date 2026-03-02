import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import methodCaseIndex from './method-case-index.json';
import { createHarness, type E2EHarness } from '../helpers/harness';

type MethodName = keyof typeof methodCaseIndex;

interface MethodContext {
  page: Page;
  tabId: number;
}

interface FailureCase {
  params: Record<string, unknown>;
  expectedBakCode: string | string[];
  before?: () => Promise<void>;
  after?: () => Promise<void>;
}

let harness: E2EHarness | undefined;
let sharedSkillId: string | null = null;
let sharedEpisodeId: string | null = null;

const allMethods = Object.keys(methodCaseIndex).sort() as MethodName[];
const missingTargetCodes = ['E_NOT_FOUND', 'E_INTERNAL'];

async function prepareContext(method: MethodName): Promise<MethodContext> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  if (method.startsWith('network.')) {
    return harness.openPage('/network.html');
  }
  if (method === 'file.upload') {
    return harness.openPage('/upload.html');
  }
  if (method.startsWith('context.enterFrame') || method.startsWith('context.exitFrame') || method === 'context.reset') {
    return harness.openPage('/iframe-host.html');
  }
  if (method.startsWith('context.enterShadow') || method.startsWith('context.exitShadow')) {
    return harness.openPage('/shadow.html');
  }
  return harness.openPage('/form.html');
}

async function ensureMemorySkill(tabId: number): Promise<{ skillId: string; episodeId: string }> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  if (sharedSkillId && sharedEpisodeId) {
    return { skillId: sharedSkillId, episodeId: sharedEpisodeId };
  }

  await harness.rpcCall('page.goto', { tabId, url: 'http://127.0.0.1:4173/form.html' });
  await harness.rpcCall('memory.recordStart', { intent: 'fill profile form' });
  await harness.rpcCall('element.type', {
    tabId,
    locator: { css: '#name-input' },
    text: 'Seed User',
    clear: true
  });
  await harness.rpcCall('element.click', { tabId, locator: { css: '#next-page' } });
  await harness.rpcCall('page.wait', { tabId, mode: 'text', value: 'Alpha', timeoutMs: 5000 });
  const stop = (await harness.rpcCall('memory.recordStop', { outcome: 'success' })) as {
    episodeId: string;
    skillId?: string;
  };
  if (!stop.skillId) {
    throw new Error('Expected skillId from memory.recordStop');
  }
  sharedSkillId = stop.skillId;
  sharedEpisodeId = stop.episodeId;
  return { skillId: stop.skillId, episodeId: stop.episodeId };
}

async function buildSuccessParams(method: MethodName, ctx: MethodContext): Promise<Record<string, unknown>> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }

  switch (method) {
    case 'session.create':
      return { clientName: 'e2e', protocolVersion: 'v2' };
    case 'session.close': {
      const created = (await harness.rpcCall('session.create', { clientName: 'close-case' })) as { sessionId: string };
      return { sessionId: created.sessionId };
    }
    case 'session.info':
      return {};

    case 'tabs.list':
      return {};
    case 'tabs.focus':
      return { tabId: ctx.tabId };
    case 'tabs.new':
      return { url: 'http://127.0.0.1:4173/form.html' };
    case 'tabs.close': {
      const created = (await harness.rpcCall('tabs.new', { url: 'http://127.0.0.1:4173/table.html' })) as { tabId: number };
      return { tabId: created.tabId };
    }
    case 'tabs.getActive':
      return {};
    case 'tabs.get':
      return { tabId: ctx.tabId };

    case 'page.goto':
      return { tabId: ctx.tabId, url: 'http://127.0.0.1:4173/table.html' };
    case 'page.back':
      await ctx.page.goto('http://127.0.0.1:4173/form.html');
      await ctx.page.goto('http://127.0.0.1:4173/table.html');
      return { tabId: ctx.tabId };
    case 'page.forward':
      await ctx.page.goto('http://127.0.0.1:4173/form.html');
      await ctx.page.goto('http://127.0.0.1:4173/table.html');
      await ctx.page.goBack();
      return { tabId: ctx.tabId };
    case 'page.reload':
      return { tabId: ctx.tabId };
    case 'page.wait':
      return { tabId: ctx.tabId, mode: 'selector', value: '#name-input', timeoutMs: 5000 };
    case 'page.snapshot':
      return { tabId: ctx.tabId };
    case 'page.title':
    case 'page.url':
    case 'page.dom':
    case 'page.metrics':
      return { tabId: ctx.tabId };
    case 'page.text':
      return { tabId: ctx.tabId, maxChunks: 8 };
    case 'page.accessibilityTree':
      return { tabId: ctx.tabId, limit: 24 };
    case 'page.scrollTo':
      return { tabId: ctx.tabId, y: 160 };
    case 'page.viewport':
      return { tabId: ctx.tabId };

    case 'element.click':
      return { tabId: ctx.tabId, locator: { css: '#next-page' } };
    case 'element.type':
      return { tabId: ctx.tabId, locator: { css: '#name-input' }, text: 'E2E', clear: true };
    case 'element.scroll':
      return { tabId: ctx.tabId, dy: 120 };
    case 'element.hover':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_hover = 0;
        document.querySelector('#cancel-btn')?.addEventListener('mousemove', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_hover = (state.__bak_hover ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, locator: { css: '#cancel-btn' } };
    case 'element.doubleClick':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_dbl = 0;
        document.querySelector('#cancel-btn')?.addEventListener('dblclick', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_dbl = (state.__bak_dbl ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, locator: { css: '#cancel-btn' } };
    case 'element.rightClick':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_ctx = 0;
        document.querySelector('#cancel-btn')?.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          const state = window as unknown as Record<string, number>;
          state.__bak_ctx = (state.__bak_ctx ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, locator: { css: '#cancel-btn' } };
    case 'element.dragDrop':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_drop = 0;
        document.querySelector('#next-page')?.addEventListener('drop', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_drop = (state.__bak_drop ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, from: { css: '#cancel-btn' }, to: { css: '#next-page' } };
    case 'element.select':
      return { tabId: ctx.tabId, locator: { css: '#role-select' }, values: ['admin'] };
    case 'element.check':
      return { tabId: ctx.tabId, locator: { css: '#agree-check' } };
    case 'element.uncheck':
      await harness.rpcCall('element.check', { tabId: ctx.tabId, locator: { css: '#agree-check' } });
      return { tabId: ctx.tabId, locator: { css: '#agree-check' } };
    case 'element.scrollIntoView':
      return { tabId: ctx.tabId, locator: { css: '#next-page' } };
    case 'element.focus':
      return { tabId: ctx.tabId, locator: { css: '#name-input' } };
    case 'element.blur':
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, locator: { css: '#name-input' } };
    case 'element.get':
      return { tabId: ctx.tabId, locator: { css: '#name-input' } };

    case 'keyboard.press':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_keydown = 0;
        document.addEventListener('keydown', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_keydown = (state.__bak_keydown ?? 0) + 1;
        });
      });
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, key: 'A' };
    case 'keyboard.type':
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, text: 'keyboard' };
    case 'keyboard.hotkey':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_hotkey = 0;
        document.addEventListener('keydown', (event) => {
          if (event.ctrlKey && event.key.toLowerCase() === 'a') {
            const state = window as unknown as Record<string, number>;
            state.__bak_hotkey = (state.__bak_hotkey ?? 0) + 1;
          }
        });
      });
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, keys: ['Control', 'A'] };

    case 'mouse.move':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_mousemove = 0;
        document.addEventListener('mousemove', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_mousemove = (state.__bak_mousemove ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, x: 80, y: 80 };
    case 'mouse.click':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_click = 0;
        document.addEventListener('click', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_click = (state.__bak_click ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, x: 90, y: 90, button: 'left' };
    case 'mouse.wheel':
      await ctx.page.evaluate(() => {
        (window as unknown as Record<string, number>).__bak_wheel = 0;
        document.addEventListener('wheel', () => {
          const state = window as unknown as Record<string, number>;
          state.__bak_wheel = (state.__bak_wheel ?? 0) + 1;
        });
      });
      return { tabId: ctx.tabId, dy: 120 };

    case 'file.upload': {
      const base64 = Buffer.from('hello-file', 'utf8').toString('base64');
      return {
        tabId: ctx.tabId,
        locator: { css: '#file-input' },
        files: [{ name: 'sample.txt', mimeType: 'text/plain', contentBase64: base64 }]
      };
    }

    case 'context.enterFrame':
      await expect(ctx.page.frameLocator('#demo-frame').locator('#frame-input')).toBeVisible();
      return { tabId: ctx.tabId, framePath: ['#demo-frame'] };
    case 'context.exitFrame':
      await expect(ctx.page.frameLocator('#demo-frame').locator('#frame-input')).toBeVisible();
      await harness.rpcCall('context.enterFrame', { tabId: ctx.tabId, framePath: ['#demo-frame'] });
      return { tabId: ctx.tabId };
    case 'context.enterShadow':
      await expect(ctx.page.locator('#shadow-host')).toBeVisible();
      return { tabId: ctx.tabId, hostSelectors: ['#shadow-host'] };
    case 'context.exitShadow':
      await expect(ctx.page.locator('#shadow-host')).toBeVisible();
      await harness.rpcCall('context.enterShadow', { tabId: ctx.tabId, hostSelectors: ['#shadow-host'] });
      return { tabId: ctx.tabId };
    case 'context.reset':
      await expect(ctx.page.frameLocator('#demo-frame').locator('#frame-input')).toBeVisible();
      await harness.rpcCall('context.enterFrame', { tabId: ctx.tabId, framePath: ['#demo-frame'] });
      return { tabId: ctx.tabId };

    case 'network.list':
      await ctx.page.click('#fetch-ok');
      await expect(ctx.page.locator('#network-log')).toContainText('fetch:200');
      return { tabId: ctx.tabId, limit: 20 };
    case 'network.get': {
      await ctx.page.click('#fetch-ok');
      await expect(ctx.page.locator('#network-log')).toContainText('fetch:200');
      const listed = (await harness.rpcCall('network.list', { tabId: ctx.tabId, limit: 1 })) as {
        entries: Array<{ id: string }>;
      };
      return { tabId: ctx.tabId, id: listed.entries[0]?.id };
    }
    case 'network.waitFor':
      await ctx.page.click('#fetch-ok');
      return { tabId: ctx.tabId, urlIncludes: '/api/slow', timeoutMs: 5000 };
    case 'network.clear':
      await ctx.page.click('#fetch-ok');
      await expect(ctx.page.locator('#network-log')).toContainText('fetch:200');
      return { tabId: ctx.tabId };

    case 'debug.getConsole':
      await ctx.page.evaluate(() => console.info('e2e-console-message'));
      return { tabId: ctx.tabId, limit: 30 };
    case 'debug.dumpState':
      await ctx.page.evaluate(() => console.warn('dump-state-signal'));
      return { tabId: ctx.tabId, consoleLimit: 30, networkLimit: 30 };

    case 'memory.recordStart':
      return { intent: 'record flow' };
    case 'memory.recordStop':
      await harness.rpcCall('page.goto', { tabId: ctx.tabId, url: 'http://127.0.0.1:4173/form.html' });
      await harness.rpcCall('memory.recordStart', { intent: 'record stop flow' });
      await harness.rpcCall('element.type', {
        tabId: ctx.tabId,
        locator: { css: '#name-input' },
        text: 'Stop Case',
        clear: true
      });
      return { outcome: 'success' };
    case 'memory.skills.list':
      return {};
    case 'memory.skills.show': {
      const memory = await ensureMemorySkill(ctx.tabId);
      return { id: memory.skillId };
    }
    case 'memory.skills.retrieve': {
      await ensureMemorySkill(ctx.tabId);
      return { intent: 'fill profile form', domain: '127.0.0.1', url: 'http://127.0.0.1:4173/form.html', limit: 5 };
    }
    case 'memory.skills.run': {
      const memory = await ensureMemorySkill(ctx.tabId);
      return { id: memory.skillId, tabId: ctx.tabId, params: { param_1: 'Replay User' } };
    }
    case 'memory.skills.delete': {
      await harness.rpcCall('memory.recordStart', { intent: 'delete tmp' });
      await harness.rpcCall('element.type', {
        tabId: ctx.tabId,
        locator: { css: '#name-input' },
        text: 'Delete Temp',
        clear: true
      });
      const stopped = (await harness.rpcCall('memory.recordStop', { outcome: 'success' })) as { skillId?: string };
      if (!stopped.skillId) {
        throw new Error('Expected skillId for delete case');
      }
      return { id: stopped.skillId };
    }
    case 'memory.skills.stats':
      await ensureMemorySkill(ctx.tabId);
      return {};
    case 'memory.episodes.list':
      return { limit: 10 };
    case 'memory.replay.explain': {
      const memory = await ensureMemorySkill(ctx.tabId);
      return { id: memory.skillId };
    }

    default:
      throw new Error(`Unhandled method: ${method}`);
  }
}

async function buildFailureCase(
  method: MethodName,
  ctx: MethodContext,
  successParams: Record<string, unknown>
): Promise<FailureCase> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }

  switch (method) {
    case 'session.create':
      return { params: { clientName: 'invalid', protocolVersion: 'v99' }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'session.close':
      return { params: { sessionId: 'session_missing' }, expectedBakCode: 'E_NOT_FOUND' };
    case 'session.info':
      return { params: { sessionId: 'session_missing' }, expectedBakCode: 'E_NOT_FOUND' };

    case 'tabs.list':
    case 'tabs.getActive':
    case 'tabs.new':
      return {
        params: method === 'tabs.new' ? { url: 'http://127.0.0.1:4173/form.html' } : {},
        expectedBakCode: 'E_NOT_READY',
        before: async () => harness.disconnectBridge(),
        after: async () => harness.reconnectBridge()
      };

    case 'tabs.focus':
    case 'tabs.close':
    case 'tabs.get':
      return { params: { tabId: -1 }, expectedBakCode: missingTargetCodes };

    case 'page.goto':
      return { params: { tabId: -1, url: 'http://127.0.0.1:4173/form.html' }, expectedBakCode: missingTargetCodes };
    case 'page.back':
    case 'page.forward':
    case 'page.reload':
    case 'page.snapshot':
    case 'page.title':
    case 'page.url':
    case 'page.text':
    case 'page.dom':
    case 'page.accessibilityTree':
    case 'page.scrollTo':
    case 'page.viewport':
    case 'page.metrics':
      return { params: { tabId: -1 }, expectedBakCode: missingTargetCodes };
    case 'page.wait':
      return { params: { tabId: -1, mode: 'selector', value: '#never', timeoutMs: 200 }, expectedBakCode: missingTargetCodes };

    case 'element.dragDrop':
      return {
        params: { tabId: ctx.tabId, from: { css: '#missing' }, to: { css: '#next-page' } },
        expectedBakCode: 'E_NOT_FOUND'
      };
    case 'element.scroll':
      return { params: { tabId: ctx.tabId, locator: { css: '#missing' }, dy: 120 }, expectedBakCode: 'E_NOT_FOUND' };
    case 'element.select':
    case 'element.check':
    case 'element.uncheck':
    case 'element.click':
    case 'element.type':
    case 'element.hover':
    case 'element.doubleClick':
    case 'element.rightClick':
    case 'element.scrollIntoView':
    case 'element.focus':
    case 'element.blur':
    case 'element.get':
      return { params: { tabId: ctx.tabId, locator: { css: '#missing' } }, expectedBakCode: 'E_NOT_FOUND' };

    case 'keyboard.press':
      return { params: { tabId: ctx.tabId, key: '' }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'keyboard.type':
      await ctx.page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      return { params: { tabId: ctx.tabId, text: 'keyboard' }, expectedBakCode: 'E_NOT_FOUND' };
    case 'keyboard.hotkey':
      return { params: { tabId: ctx.tabId, keys: [] }, expectedBakCode: 'E_INVALID_PARAMS' };

    case 'mouse.move':
      return { params: { tabId: ctx.tabId, x: -9999, y: -9999 }, expectedBakCode: 'E_NOT_FOUND' };
    case 'mouse.click':
      return { params: { tabId: ctx.tabId, x: -9999, y: -9999, button: 'left' }, expectedBakCode: 'E_NOT_FOUND' };
    case 'mouse.wheel':
      return { params: { tabId: -1, dy: 120 }, expectedBakCode: missingTargetCodes };

    case 'file.upload': {
      const base64 = Buffer.from('broken-upload', 'utf8').toString('base64');
      return {
        params: {
          tabId: ctx.tabId,
          locator: { css: '#upload-result' },
          files: [{ name: 'bad.txt', mimeType: 'text/plain', contentBase64: base64 }]
        },
        expectedBakCode: 'E_NOT_FOUND'
      };
    }

    case 'context.enterFrame':
      return { params: { tabId: ctx.tabId, framePath: ['#missing-frame'] }, expectedBakCode: 'E_NOT_FOUND' };
    case 'context.exitFrame':
    case 'context.reset':
    case 'context.exitShadow':
      return { params: { tabId: -1 }, expectedBakCode: missingTargetCodes };
    case 'context.enterShadow':
      return { params: { tabId: ctx.tabId, hostSelectors: ['#missing-shadow'] }, expectedBakCode: 'E_NOT_FOUND' };

    case 'network.list':
    case 'network.clear':
      return { params: { tabId: -1, limit: 10 }, expectedBakCode: missingTargetCodes };
    case 'network.get':
      return { params: { tabId: ctx.tabId, id: 'net_missing' }, expectedBakCode: 'E_NOT_FOUND' };
    case 'network.waitFor':
      return { params: { tabId: ctx.tabId, urlIncludes: '/never-match', timeoutMs: 120 }, expectedBakCode: 'E_TIMEOUT' };

    case 'debug.getConsole':
    case 'debug.dumpState':
      return { params: { tabId: -1 }, expectedBakCode: missingTargetCodes };

    case 'memory.recordStart':
      return { params: { intent: '   ' }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'memory.recordStop':
      return {
        params: { outcome: 'success' },
        expectedBakCode: 'E_NOT_FOUND',
        before: async () => {
          await harness.rpcCall('memory.recordStop', { outcome: 'success' });
        }
      };
    case 'memory.skills.list':
      return { params: { limit: 0 }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'memory.skills.show':
      return { params: { id: 'skill_missing' }, expectedBakCode: 'E_NOT_FOUND' };
    case 'memory.skills.retrieve':
      return { params: { intent: '' }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'memory.skills.run':
      return { params: { id: 'skill_missing', tabId: ctx.tabId }, expectedBakCode: 'E_NOT_FOUND' };
    case 'memory.skills.delete':
      return { params: { id: 'skill_missing' }, expectedBakCode: 'E_NOT_FOUND' };
    case 'memory.skills.stats':
      return { params: { id: '' }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'memory.episodes.list':
      return { params: { limit: 0 }, expectedBakCode: 'E_INVALID_PARAMS' };
    case 'memory.replay.explain':
      return { params: { id: 'skill_missing' }, expectedBakCode: 'E_NOT_FOUND' };

    default:
      return { params: successParams, expectedBakCode: 'E_INTERNAL' };
  }
}

async function assertSuccessBehavior(
  method: MethodName,
  ctx: MethodContext,
  params: Record<string, unknown>,
  result: unknown
): Promise<void> {
  switch (method) {
    case 'session.create': {
      const typed = result as { sessionId: string; protocolVersion: string };
      expect(typed.sessionId).toBeTruthy();
      expect(typed.protocolVersion).toBe('v2');
      return;
    }
    case 'session.close':
      expect((result as { closed: boolean }).closed).toBe(true);
      return;
    case 'session.info':
      expect((result as { protocolVersion: string }).protocolVersion).toBe('v2');
      return;

    case 'tabs.list':
      expect((result as { tabs: unknown[] }).tabs.length).toBeGreaterThan(0);
      return;
    case 'tabs.getActive':
      expect((result as { tab: { id: number } | null }).tab?.id).toBeTruthy();
      return;
    case 'tabs.get':
      expect((result as { tab: { id: number } }).tab.id).toBe(ctx.tabId);
      return;
    case 'tabs.focus':
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    case 'tabs.new':
      expect((result as { tabId: number }).tabId).toBeGreaterThan(0);
      return;
    case 'tabs.close':
      expect((result as { ok: boolean }).ok).toBe(true);
      return;

    case 'page.goto':
      await expect(ctx.page).toHaveURL(/table\.html/);
      return;
    case 'page.back':
      await expect(ctx.page).toHaveURL(/form\.html/);
      return;
    case 'page.forward':
      await expect(ctx.page).toHaveURL(/table\.html/);
      return;
    case 'page.reload':
      await expect(ctx.page).toHaveURL(/127\.0\.0\.1:4173/);
      return;
    case 'page.wait':
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    case 'page.snapshot':
      expect((result as { traceId: string }).traceId).toBeTruthy();
      expect((result as { imagePath: string }).imagePath).toContain('snapshots');
      expect((result as { elementsPath: string }).elementsPath).toContain('snapshots');
      expect(existsSync((result as { imagePath: string }).imagePath)).toBe(true);
      expect(existsSync((result as { elementsPath: string }).elementsPath)).toBe(true);
      expect((result as { elementCount: number }).elementCount).toBeGreaterThan(0);
      return;
    case 'page.title':
      expect((result as { title: string }).title).toContain('BAK Test');
      return;
    case 'page.url':
      expect((result as { url: string }).url).toContain('127.0.0.1:4173');
      return;
    case 'page.text':
      expect((result as { chunks: unknown[] }).chunks.length).toBeGreaterThan(0);
      return;
    case 'page.dom':
      expect((result as { summary: { totalElements: number } }).summary.totalElements).toBeGreaterThan(0);
      return;
    case 'page.accessibilityTree':
      expect((result as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
      return;
    case 'page.scrollTo': {
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    }
    case 'page.viewport': {
      const typed = result as { width: number; height: number };
      expect(typed.width).toBeGreaterThan(0);
      expect(typed.height).toBeGreaterThan(0);
      return;
    }
    case 'page.metrics': {
      const typed = result as { navigation: { durationMs: number }; resources: { count: number } };
      expect(typed.navigation.durationMs).toBeGreaterThanOrEqual(0);
      expect(typed.resources.count).toBeGreaterThanOrEqual(0);
      return;
    }

    case 'element.click':
      await expect(ctx.page).toHaveURL(/table\.html/);
      return;
    case 'element.type':
      await expect(ctx.page.locator('#name-input')).toHaveValue('E2E');
      return;
    case 'element.scroll': {
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    }
    case 'element.hover': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_hover ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'element.doubleClick': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_dbl ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'element.rightClick': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_ctx ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'element.dragDrop': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_drop ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'element.select':
      await expect(ctx.page.locator('#role-select')).toHaveValue('admin');
      return;
    case 'element.check':
      await expect(ctx.page.locator('#agree-check')).toBeChecked();
      return;
    case 'element.uncheck':
      await expect(ctx.page.locator('#agree-check')).not.toBeChecked();
      return;
    case 'element.scrollIntoView':
      await expect(ctx.page.locator('#next-page')).toBeVisible();
      return;
    case 'element.focus':
      await expect(ctx.page.locator('#name-input')).toBeFocused();
      return;
    case 'element.blur': {
      const focusedId = await ctx.page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? '');
      expect(focusedId).not.toBe('name-input');
      return;
    }
    case 'element.get':
      expect((result as { element: { tag: string } }).element.tag).toBeTruthy();
      return;

    case 'keyboard.press': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_keydown ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'keyboard.type':
      await expect(ctx.page.locator('#name-input')).toHaveValue('keyboard');
      return;
    case 'keyboard.hotkey': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_hotkey ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }

    case 'mouse.move': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_mousemove ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'mouse.click': {
      const count = await ctx.page.evaluate(() => (window as unknown as Record<string, number>).__bak_click ?? 0);
      expect(count).toBeGreaterThan(0);
      return;
    }
    case 'mouse.wheel': {
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    }

    case 'file.upload':
      await expect(ctx.page.locator('#upload-result')).toContainText('files:1');
      return;

    case 'context.enterFrame':
      expect((result as { frameDepth: number }).frameDepth).toBeGreaterThan(0);
      return;
    case 'context.exitFrame':
      expect((result as { frameDepth: number }).frameDepth).toBe(0);
      return;
    case 'context.enterShadow':
      expect((result as { shadowDepth: number }).shadowDepth).toBeGreaterThan(0);
      return;
    case 'context.exitShadow':
      expect((result as { shadowDepth: number }).shadowDepth).toBe(0);
      return;
    case 'context.reset': {
      const typed = result as { frameDepth: number; shadowDepth: number };
      expect(typed.frameDepth).toBe(0);
      expect(typed.shadowDepth).toBe(0);
      return;
    }

    case 'network.list':
      expect((result as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
      return;
    case 'network.get': {
      const typed = result as { entry: { id: string } };
      expect(typed.entry.id).toBe(String(params.id));
      return;
    }
    case 'network.waitFor':
      expect((result as { entry: { url: string } }).entry.url).toContain('/api/slow');
      return;
    case 'network.clear': {
      const listed = (await harness!.rpcCall('network.list', { tabId: ctx.tabId, limit: 10 })) as { entries: unknown[] };
      expect(listed.entries.length).toBe(0);
      return;
    }

    case 'debug.getConsole': {
      const entries = (result as { entries: Array<{ message: string }> }).entries;
      expect(Array.isArray(entries)).toBe(true);
      return;
    }
    case 'debug.dumpState': {
      const typed = result as { dom: { totalElements: number }; console: unknown[] };
      expect(typed.dom.totalElements).toBeGreaterThan(0);
      expect(typed.console.length).toBeGreaterThanOrEqual(0);
      return;
    }

    case 'memory.recordStart':
      expect((result as { recordingId: string }).recordingId).toBeTruthy();
      return;
    case 'memory.recordStop':
      expect((result as { episodeId: string }).episodeId).toBeTruthy();
      return;
    case 'memory.skills.list':
      expect(Array.isArray((result as { skills: unknown[] }).skills)).toBe(true);
      return;
    case 'memory.skills.show':
      expect((result as { skill: { id: string } }).skill.id).toBe(String(params.id));
      return;
    case 'memory.skills.retrieve':
      expect(Array.isArray((result as { skills: unknown[] }).skills)).toBe(true);
      return;
    case 'memory.skills.run':
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    case 'memory.skills.delete':
      expect((result as { ok: boolean }).ok).toBe(true);
      return;
    case 'memory.skills.stats':
      expect((result as { stats: unknown[] }).stats.length).toBeGreaterThan(0);
      return;
    case 'memory.episodes.list':
      expect(Array.isArray((result as { episodes: unknown[] }).episodes)).toBe(true);
      return;
    case 'memory.replay.explain':
      expect((result as { steps: unknown[] }).steps.length).toBeGreaterThan(0);
      return;

    default:
      expect(result).toBeDefined();
  }
}

test.describe('method-level e2e coverage', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  for (const method of allMethods) {
    const caseId = methodCaseIndex[method];

    test(`[${caseId.successCaseId}] ${method} success`, async () => {
      const ctx = await prepareContext(method);
      try {
        const params = await buildSuccessParams(method, ctx);
        const result = await harness!.rpcCall(method, params);
        await assertSuccessBehavior(method, ctx, params, result);
        harness!.assertTraceHas(method);
      } finally {
        await ctx.page.close();
      }
    });

    test(`[${caseId.failureCaseId}] ${method} failure`, async () => {
      const ctx = await prepareContext(method);
      try {
        const successParams = await buildSuccessParams(method, ctx);
        const failure = await buildFailureCase(method, ctx, successParams);
        await failure.before?.();
        try {
          const error = await harness!.rpcError(method, failure.params);
          const expectedCodes = Array.isArray(failure.expectedBakCode)
            ? failure.expectedBakCode
            : [failure.expectedBakCode];
          expect(expectedCodes).toContain(error.bakCode);
          harness!.assertTraceHas(`${method}:error`);
        } finally {
          await failure.after?.();
        }
      } finally {
        await ctx.page.close();
      }
    });
  }
});
