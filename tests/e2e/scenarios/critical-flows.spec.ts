import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

test.describe('scenario-level e2e', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('form -> table -> spa -> upload happy path', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }
    const { page, tabId } = await harness.openPage('/form.html');
    try {
      await harness.rpcCall('element.type', { tabId, locator: { css: '#name-input' }, text: 'Scenario User', clear: true });
      await harness.rpcCall('element.type', { tabId, locator: { css: '#email-input' }, text: 'scenario@example.com', clear: true });
      await harness.rpcCall('element.click', { tabId, locator: { css: '#next-page' } });
      await harness.rpcCall('page.wait', { tabId, mode: 'text', value: 'Alpha', timeoutMs: 5000 });
      await expect(page).toHaveURL(/table\.html/);

      await harness.rpcCall('page.goto', { tabId, url: 'http://127.0.0.1:4173/spa.html' });
      await harness.rpcCall('page.wait', { tabId, mode: 'selector', value: '#tab-automation', timeoutMs: 5000 });
      await harness.rpcCall('element.click', { tabId, locator: { css: '#tab-automation' } });
      await harness.rpcCall('page.wait', { tabId, mode: 'text', value: 'Automation Console', timeoutMs: 5000 });
      await harness.rpcCall('element.type', { tabId, locator: { css: '#task-input' }, text: 'scenario task', clear: true });
      await harness.rpcCall('element.click', { tabId, locator: { css: '#queue-btn' } });
      await harness.rpcCall('page.wait', { tabId, mode: 'selector', value: '#task-list li[data-task-id=\"1\"]', timeoutMs: 5000 });
      await expect(page.locator('#task-list li').first()).toContainText('scenario task');

      await harness.rpcCall('page.goto', { tabId, url: 'http://127.0.0.1:4173/upload.html' });
      await harness.rpcCall('page.wait', { tabId, mode: 'selector', value: '#file-input', timeoutMs: 5000 });
      const upload = Buffer.from('scenario-upload', 'utf8').toString('base64');
      await harness.rpcCall('file.upload', {
        tabId,
        locator: { css: '#file-input' },
        files: [{ name: 'scenario.txt', mimeType: 'text/plain', contentBase64: upload }]
      });
      await expect(page.locator('#upload-result')).toContainText('files:1');
      harness.assertTraceHas('file.upload');
    } finally {
      await page.close();
    }
  });

  test('iframe + shadow + error recovery', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }
    const iframe = await harness.openPage('/iframe-host.html');
    try {
      await expect(iframe.page.frameLocator('#demo-frame').locator('#frame-input')).toBeVisible();
      await harness.rpcCall('context.enterFrame', { tabId: iframe.tabId, framePath: ['#demo-frame'] });
      await harness.rpcCall('element.type', { tabId: iframe.tabId, locator: { css: '#frame-input' }, text: 'inside-frame', clear: true });
      await harness.rpcCall('element.click', { tabId: iframe.tabId, locator: { css: '#frame-btn' } });
      await harness.rpcCall('context.exitFrame', { tabId: iframe.tabId });
      await expect(iframe.page.locator('#host-status')).toContainText('host:');

      await harness.rpcCall('page.goto', { tabId: iframe.tabId, url: 'http://127.0.0.1:4173/shadow.html' });
      await harness.rpcCall('page.wait', { tabId: iframe.tabId, mode: 'selector', value: '#shadow-host', timeoutMs: 5000 });
      await harness.rpcCall('context.enterShadow', { tabId: iframe.tabId, hostSelectors: ['#shadow-host'] });
      await harness.rpcCall('element.type', {
        tabId: iframe.tabId,
        locator: { css: '#shadow-input', shadow: 'pierce' },
        text: 'shadow-value',
        clear: true
      });
      await harness.rpcCall('element.click', { tabId: iframe.tabId, locator: { css: '#shadow-btn', shadow: 'pierce' } });
      await harness.rpcCall('context.exitShadow', { tabId: iframe.tabId });
      await expect(iframe.page.locator('#shadow-status')).toContainText('shadow:shadow-value');

      const blocked = await harness.rpcError('element.click', { tabId: iframe.tabId, locator: { css: '#not-exists' } });
      expect(blocked.bakCode).toBe('E_NOT_FOUND');
      harness.assertTraceHas('element.click:error');
    } finally {
      await iframe.page.close();
    }
  });

  test('network diagnostics and debug dump', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }
    const { page, tabId } = await harness.openPage('/network.html');
    try {
      const waitForSlowRequest = harness.rpcCall('network.waitFor', {
        tabId,
        urlIncludes: '/api/slow',
        timeoutMs: 5000
      }) as Promise<{ entry: { url: string } }>;

      await page.click('#fetch-ok');
      await page.click('#fetch-fail');
      await expect(page.locator('#network-log')).toContainText('fetch:503:');

      const waited = await waitForSlowRequest;
      expect(waited.entry.url).toContain('/api/slow');
      const list = (await harness.rpcCall('network.list', { tabId, limit: 10 })) as {
        entries: Array<{ id: string; status: number }>;
      };
      expect(list.entries.length).toBeGreaterThan(0);

      const dump = (await harness.rpcCall('debug.dumpState', { tabId, consoleLimit: 20, networkLimit: 20 })) as {
        dom: { totalElements: number };
        network: unknown[];
      };
      expect(dump.dom.totalElements).toBeGreaterThan(0);
      expect(dump.network.length).toBeGreaterThan(0);
      harness.assertTraceHas('debug.dumpState');
    } finally {
      await page.close();
    }
  });
});
