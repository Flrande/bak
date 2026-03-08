import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

function chunkTexts(chunks: Array<{ text: string }>): string {
  return chunks.map((chunk) => chunk.text).join('\n');
}

test.describe('context-aware reading e2e', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('reads and debugs from the active frame context', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/iframe-host.html');
    try {
      await harness.rpcCall('context.enterFrame', { tabId, framePath: ['#demo-frame'] });

      const text = (await harness.rpcCall('page.text', { tabId, maxChunks: 10 })) as {
        chunks: Array<{ text: string }>;
      };
      const url = (await harness.rpcCall('page.url', { tabId })) as { url: string };
      const title = (await harness.rpcCall('page.title', { tabId })) as { title: string };
      const dom = (await harness.rpcCall('page.dom', { tabId })) as {
        summary: { totalElements: number; url: string; title: string };
      };
      const a11y = (await harness.rpcCall('page.accessibilityTree', { tabId, limit: 50 })) as {
        nodes: Array<{ name: string }>;
      };
      const dump = (await harness.rpcCall('debug.dumpState', {
        tabId,
        includeAccessibility: true
      })) as {
        url: string;
        title: string;
        context: { framePath: string[]; shadowPath: string[] };
        text: Array<{ text: string }>;
        accessibility?: Array<{ name: string }>;
      };

      expect(chunkTexts(text.chunks)).toContain('Iframe Child');
      expect(url.url).toContain('/iframe-child.html');
      expect(title.title).toContain('Iframe Child');
      expect(dom.summary.totalElements).toBeGreaterThan(0);
      expect(dom.summary.url).toContain('/iframe-child.html');
      expect(dom.summary.title).toContain('Iframe Child');
      expect(a11y.nodes.some((node) => node.name.includes('Frame Action'))).toBe(true);
      expect(dump.url).toContain('/iframe-child.html');
      expect(dump.title).toContain('Iframe Child');
      expect(dump.context.framePath).toEqual(['#demo-frame']);
      expect(chunkTexts(dump.text)).toContain('Iframe Child');
      expect(dump.accessibility?.some((node) => node.name.includes('Frame Action'))).toBe(true);

      await harness.rpcCall('context.reset', { tabId });
      await expect(page.locator('#host-status')).toContainText('host:idle');
    } finally {
      await page.close();
    }
  });

  test('reads from nested shadow contexts and supports nested shadow traversal', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/shadow.html');
    try {
      await harness.rpcCall('context.enterShadow', { tabId, hostSelectors: ['#shadow-host'] });
      const outerUrl = (await harness.rpcCall('page.url', { tabId })) as { url: string };
      const outerTitle = (await harness.rpcCall('page.title', { tabId })) as { title: string };
      const outerText = (await harness.rpcCall('page.text', { tabId, maxChunks: 10 })) as {
        chunks: Array<{ text: string }>;
      };
      expect(chunkTexts(outerText.chunks)).toContain('Shadow Action');
      expect(outerUrl.url).toContain('/shadow.html');
      expect(outerTitle.title).toContain('Shadow');

      await harness.rpcCall('context.enterShadow', { tabId, hostSelectors: ['#inner-shadow-host'] });
      const nestedText = (await harness.rpcCall('page.text', { tabId, maxChunks: 10 })) as {
        chunks: Array<{ text: string }>;
      };
      const dump = (await harness.rpcCall('debug.dumpState', {
        tabId,
        includeAccessibility: true
      })) as {
        url: string;
        title: string;
        context: { shadowPath: string[] };
        text: Array<{ text: string }>;
        accessibility?: Array<{ name: string }>;
      };

      expect(chunkTexts(nestedText.chunks)).toContain('Inner Shadow Action');
      expect(dump.url).toContain('/shadow.html');
      expect(dump.title).toContain('Shadow');
      expect(dump.context.shadowPath).toEqual(['#shadow-host', '#inner-shadow-host']);
      expect(chunkTexts(dump.text)).toContain('Inner Shadow Action');
      expect(dump.accessibility?.some((node) => node.name.includes('Inner Shadow Action'))).toBe(true);
      await harness.rpcCall('context.reset', { tabId });
      await expect(page.locator('#shadow-status')).toContainText('shadow:idle');
    } finally {
      await page.close();
    }
  });

  test('keeps reading and actions aligned across frame plus shadow combinations', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/iframe-host.html');
    try {
      await harness.rpcCall('context.enterFrame', { tabId, framePath: ['#demo-frame'] });
      await harness.rpcCall('context.enterShadow', { tabId, hostSelectors: ['#frame-shadow-host'] });

      const text = (await harness.rpcCall('page.text', { tabId, maxChunks: 10 })) as {
        chunks: Array<{ text: string }>;
      };
      const url = (await harness.rpcCall('page.url', { tabId })) as { url: string };
      const title = (await harness.rpcCall('page.title', { tabId })) as { title: string };
      const a11y = (await harness.rpcCall('page.accessibilityTree', { tabId, limit: 50 })) as {
        nodes: Array<{ name: string }>;
      };
      const dump = (await harness.rpcCall('debug.dumpState', {
        tabId,
        includeAccessibility: true
      })) as {
        url: string;
        title: string;
        context: { framePath: string[]; shadowPath: string[] };
      };

      expect(chunkTexts(text.chunks)).toContain('Frame Shadow Action');
      expect(url.url).toContain('/iframe-child.html');
      expect(title.title).toContain('Iframe Child');
      expect(a11y.nodes.some((node) => node.name.includes('Frame Shadow Action'))).toBe(true);
      expect(dump.url).toContain('/iframe-child.html');
      expect(dump.title).toContain('Iframe Child');
      expect(dump.context.framePath).toEqual(['#demo-frame']);
      expect(dump.context.shadowPath).toEqual(['#frame-shadow-host']);
      await harness.rpcCall('context.reset', { tabId });
      await expect(page.frameLocator('#demo-frame').locator('#frame-result')).toContainText('idle');
    } finally {
      await page.close();
    }
  });
});
