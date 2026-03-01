import { expect, test, type Page } from '@playwright/test';
import methodCaseIndex from './method-case-index.json';
import { createHarness, type E2EHarness } from '../helpers/harness';

type MethodName = keyof typeof methodCaseIndex;

interface MethodContext {
  page: Page;
  tabId: number;
}

let harness: E2EHarness | undefined;
let sharedSkillId: string | null = null;
let sharedEpisodeId: string | null = null;

const allMethods = Object.keys(methodCaseIndex).sort() as MethodName[];

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
  if (method.startsWith('context.enterFrame') || method.startsWith('context.exitFrame')) {
    return harness.openPage('/iframe-host.html');
  }
  if (method.startsWith('context.enterShadow') || method.startsWith('context.exitShadow')) {
    return harness.openPage('/shadow.html');
  }
  if (method === 'memory.skills.run' || method.startsWith('memory.')) {
    return harness.openPage('/form.html');
  }
  if (method.startsWith('page.')) {
    return harness.openPage('/form.html');
  }
  if (method.startsWith('element.') || method.startsWith('keyboard.') || method.startsWith('mouse.')) {
    return harness.openPage('/form.html');
  }
  if (method.startsWith('tabs.') || method.startsWith('session.')) {
    return harness.openPage('/form.html');
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
  const memory = method.startsWith('memory.') ? await ensureMemorySkill(ctx.tabId) : null;

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
      return { tabId: ctx.tabId, locator: { css: '#cancel-btn' } };
    case 'element.doubleClick':
      return { tabId: ctx.tabId, locator: { css: '#cancel-btn' } };
    case 'element.rightClick':
      return { tabId: ctx.tabId, locator: { css: '#cancel-btn' } };
    case 'element.dragDrop':
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
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, key: 'A' };
    case 'keyboard.type':
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, text: 'keyboard' };
    case 'keyboard.hotkey':
      await harness.rpcCall('element.focus', { tabId: ctx.tabId, locator: { css: '#name-input' } });
      return { tabId: ctx.tabId, keys: ['Control', 'A'] };

    case 'mouse.move':
      return { tabId: ctx.tabId, x: 80, y: 80 };
    case 'mouse.click':
      return { tabId: ctx.tabId, x: 90, y: 90, button: 'left' };
    case 'mouse.wheel':
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
    case 'memory.skills.show':
      return { id: memory!.skillId };
    case 'memory.skills.retrieve':
      return { intent: 'fill profile form', domain: '127.0.0.1', url: 'http://127.0.0.1:4173/form.html', limit: 5 };
    case 'memory.skills.run':
      return { id: memory!.skillId, tabId: ctx.tabId, params: { param_1: 'Replay User' } };
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
      return {};
    case 'memory.episodes.list':
      return { limit: 10 };
    case 'memory.replay.explain':
      return { id: memory!.skillId };

    default:
      throw new Error(`Unhandled method: ${method}`);
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
        const result = await harness.rpcCall(method, params);
        expect(result).toBeDefined();

        if (!method.startsWith('session.')) {
          await expect(ctx.page).toHaveURL(/127\.0\.0\.1:4173/);
        }
        // trace assertion
        harness.assertTraceHas(method);
      } finally {
        await ctx.page.close();
      }
    });

    test(`[${caseId.failureCaseId}] ${method} failure`, async () => {
      const ctx = await prepareContext(method);
      try {
        const successParams = await buildSuccessParams(method, ctx);
        const error = await harness.rpcError(method, { ...successParams, __forceError: true });
        expect(error.bakCode).toBe('E_INVALID_PARAMS');
        if (!method.startsWith('session.')) {
          await expect(ctx.page).toHaveURL(/127\.0\.0\.1:4173/);
        }
        harness.assertTraceHas(`${method}:error`);
      } finally {
        await ctx.page.close();
      }
    });
  }
});
