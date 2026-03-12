import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

function singlePageValue<T>(payload: unknown): T {
  const result = payload as {
    result?: { value?: T; error?: { code: string; message: string } };
  };
  if (!result.result || !('value' in result.result)) {
    throw new Error(`Expected single page value, got ${JSON.stringify(payload)}`);
  }
  return result.result.value;
}

test.describe('dynamic data e2e', () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('reads runtime globals, xpath locators, all-frames values, and table data', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const tablePage = await harness.openPage('/table.html');
    try {
      const element = (await harness.rpcCall('element.get', {
        tabId: tablePage.tabId,
        locator: { xpath: '//button[contains(@class, "delete-btn")]' }
      })) as {
        matchedCount: number;
        visible: boolean;
        enabled: boolean;
        textPreview: string;
      };
      expect(element.matchedCount).toBe(3);
      expect(element.visible).toBe(true);
      expect(element.enabled).toBe(true);
      expect(element.textPreview).toContain('删除');

      const extracted = (await harness.rpcCall('page.extract', {
        tabId: tablePage.tabId,
        path: 'table_data'
      })) as unknown;
      const tableData = singlePageValue<Array<{ id: number; name: string }>>(extracted);
      expect(tableData).toHaveLength(3);
      expect(tableData[0]?.name).toBe('Alpha');

      const lexicalExtract = (await harness.rpcCall('page.extract', {
        tabId: tablePage.tabId,
        path: 'lexical_market_snapshot.QQQ.quotes.changePercent',
        resolver: 'auto'
      })) as unknown;
      expect(singlePageValue<number>(lexicalExtract)).toBe(2.34);

      const evaluated = (await harness.rpcCall('page.eval', {
        tabId: tablePage.tabId,
        expr: 'window.market_data?.QQQ?.quotes?.changePercent'
      })) as unknown;
      expect(singlePageValue<number>(evaluated)).toBe(1.23);

      const tables = (await harness.rpcCall('table.list', { tabId: tablePage.tabId })) as {
        tables: Array<{ id: string; kind: string; rowCount: number }>;
      };
      expect(tables.tables.length).toBeGreaterThan(0);
      expect(tables.tables[0]?.kind).toBe('html');

      const schema = (await harness.rpcCall('table.schema', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.id
      })) as {
        schema: { columns: Array<{ label: string }> };
      };
      expect(schema.schema.columns.map((column) => column.label)).toEqual(['ID', 'Name', 'Action']);

      const rows = (await harness.rpcCall('table.rows', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.id,
        all: true,
        maxRows: 100
      })) as {
        extractionMode: string;
        rows: Array<Record<string, unknown>>;
      };
      expect(rows.extractionMode).toBe('dataSource');
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows[1]?.Name).toBe('Beta');

      const exported = (await harness.rpcCall('table.export', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.id,
        format: 'json'
      })) as {
        rows: Array<Record<string, unknown>>;
      };
      expect(exported.rows).toHaveLength(3);

      const inspected = (await harness.rpcCall('inspect.pageData', {
        tabId: tablePage.tabId
      })) as {
        suspiciousGlobals: string[];
        tables: Array<{ id: string }>;
        pageDataCandidates?: Array<{ name: string; resolver: string }>;
      };
      expect(inspected.suspiciousGlobals).toEqual(expect.arrayContaining(['table_data', 'market_data']));
      expect(inspected.tables.length).toBeGreaterThan(0);
      expect(inspected.pageDataCandidates).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'lexical_market_snapshot', resolver: 'lexical' })])
      );

      await tablePage.page.evaluate(async () => {
        const response = await fetch('/api/table-rows');
        await response.json();
      });
      const tableReplaySearch = (await harness.rpcCall('network.search', {
        tabId: tablePage.tabId,
        pattern: 'table-rows',
        limit: 5
      })) as {
        entries: Array<{ id: string }>;
      };
      expect(tableReplaySearch.entries.length).toBeGreaterThan(0);
      const replayWithSchema = (await harness.rpcCall('network.replay', {
        tabId: tablePage.tabId,
        id: tableReplaySearch.entries[0]!.id,
        mode: 'json',
        withSchema: 'auto'
      })) as {
        schema?: { columns: Array<{ label: string }> };
        mappedRows?: Array<Record<string, unknown>>;
      };
      expect(replayWithSchema.schema?.columns.map((column) => column.label)).toEqual(['ID', 'Name', 'Action']);
      expect(replayWithSchema.mappedRows?.[1]?.Name).toBe('Beta');

      const iframePage = await harness.openPage('/iframe-host.html');
      try {
        await harness.rpcCall('context.enterFrame', {
          tabId: iframePage.tabId,
          framePath: ['#demo-frame']
        });
        const currentFrameEval = (await harness.rpcCall('page.eval', {
          tabId: iframePage.tabId,
          expr: 'window.frame_table_data?.[0]?.name ?? null'
        })) as unknown;
        expect(singlePageValue<string | null>(currentFrameEval)).toBe('Frame Alpha');
        await harness.rpcCall('context.reset', { tabId: iframePage.tabId });

        const allFrames = (await harness.rpcCall('page.eval', {
          tabId: iframePage.tabId,
          expr: 'window.frame_table_data?.[0]?.name ?? null',
          scope: 'all-frames'
        })) as {
          scope: string;
          results?: Array<{ framePath: string[]; value?: string | null }>;
        };
        expect(allFrames.scope).toBe('all-frames');
        expect(allFrames.results?.some((item) => item.value === 'Frame Alpha')).toBe(true);
      } finally {
        await iframePage.page.close();
      }
    } finally {
      await tablePage.page.close();
    }
  });

  test('captures network bodies, replays requests, assesses freshness, and exports artifacts', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/network.html');
    try {
      const runtimeFetch = (await harness.rpcCall('page.fetch', {
        tabId,
        url: 'http://127.0.0.1:4173/api/runtime-data?symbol=QQQ',
        mode: 'json'
      })) as unknown;
      const runtimePayload = singlePageValue<{
        status: number;
        ok: boolean;
        json?: { symbol: string; quotes: { changePercent: number } };
      }>(runtimeFetch);
      expect(runtimePayload.status).toBe(200);
      expect(runtimePayload.ok).toBe(true);
      expect(runtimePayload.json?.symbol).toBe('QQQ');

      const initialWaitPromise = harness.rpcCall('network.waitFor', {
        tabId,
        urlIncludes: '/api/echo',
        status: 200,
        timeoutMs: 10_000
      });

      const echoFetch = (await harness.rpcCall('page.fetch', {
        tabId,
        url: 'http://127.0.0.1:4173/api/echo',
        method: 'POST',
        body: '{"hello":"world"}',
        contentType: 'application/json',
        mode: 'json',
        requiresConfirm: true
      })) as unknown;
      const echoPayload = singlePageValue<{
        status: number;
        ok: boolean;
        json?: { body: string; method: string };
      }>(echoFetch);
      expect(echoPayload.status).toBe(200);
      expect(echoPayload.json?.method).toBe('POST');
      expect(echoPayload.json?.body).toContain('world');

      const waited = (await initialWaitPromise) as {
        entry: { id: string; url: string };
      };
      expect(waited.entry.url).toContain('/api/echo');

      const staleWaitError = await harness.rpcError('network.waitFor', {
        tabId,
        urlIncludes: '/api/echo',
        status: 200,
        timeoutMs: 250
      });
      expect(staleWaitError.bakCode).toBe('E_TIMEOUT');

      const freshWaitPromise = harness.rpcCall('network.waitFor', {
        tabId,
        urlIncludes: '/api/echo',
        status: 200,
        timeoutMs: 10_000
      });

      const secondEchoFetch = (await harness.rpcCall('page.fetch', {
        tabId,
        url: 'http://127.0.0.1:4173/api/echo',
        method: 'POST',
        body: '{"hello":"again"}',
        contentType: 'application/json',
        mode: 'json',
        requiresConfirm: true
      })) as unknown;
      const secondEchoPayload = singlePageValue<{
        status: number;
        ok: boolean;
        json?: { body: string; method: string };
      }>(secondEchoFetch);
      expect(secondEchoPayload.status).toBe(200);
      expect(secondEchoPayload.json?.body).toContain('again');

      const freshWaited = (await freshWaitPromise) as {
        entry: { id: string; requestBodyPreview?: string };
      };
      expect(freshWaited.entry.id).not.toBe(waited.entry.id);

      const fetched = (await harness.rpcCall('network.get', {
        tabId,
        id: freshWaited.entry.id,
        include: ['request', 'response'],
        bodyBytes: 4096
      })) as {
        entry: {
          requestBodyPreview?: string;
          responseBodyPreview?: string;
          contentType?: string;
        };
      };
      expect(fetched.entry.requestBodyPreview).toContain('again');
      expect(fetched.entry.responseBodyPreview).toContain('POST');
      expect(fetched.entry.contentType).toContain('application/json');

      const requestOnly = (await harness.rpcCall('network.get', {
        tabId,
        id: freshWaited.entry.id,
        include: ['request'],
        bodyBytes: 4096
      })) as {
        entry: {
          requestBodyPreview?: string;
          responseBodyPreview?: string;
          responseHeaders?: Record<string, string>;
        };
      };
      expect(requestOnly.entry.requestBodyPreview).toContain('again');
      expect(requestOnly.entry.responseBodyPreview).toBeUndefined();
      expect(requestOnly.entry.responseHeaders).toBeUndefined();

      const responseOnly = (await harness.rpcCall('network.get', {
        tabId,
        id: freshWaited.entry.id,
        include: ['response'],
        bodyBytes: 4096
      })) as {
        entry: {
          requestBodyPreview?: string;
          requestHeaders?: Record<string, string>;
          responseBodyPreview?: string;
        };
      };
      expect(responseOnly.entry.requestBodyPreview).toBeUndefined();
      expect(responseOnly.entry.requestHeaders).toBeUndefined();
      expect(responseOnly.entry.responseBodyPreview).toContain('POST');

      const search = (await harness.rpcCall('network.search', {
        tabId,
        pattern: 'again',
        limit: 10
      })) as {
        entries: Array<{ id: string }>;
      };
      expect(search.entries.some((entry) => entry.id === freshWaited.entry.id)).toBe(true);

      const replayed = (await harness.rpcCall('network.replay', {
        tabId,
        id: freshWaited.entry.id,
        mode: 'json',
        maxBytes: 4096,
        requiresConfirm: true
      })) as {
        status: number;
        json?: { body: string };
      };
      expect(replayed.status).toBe(200);
      expect(replayed.json?.body).toContain('again');

      await page.click('#fetch-ok');
      await expect(page.locator('#network-log')).toContainText('fetch:200:ok');

      const freshness = (await harness.rpcCall('page.freshness', {
        tabId
      })) as {
        assessment: string;
        latestInlineDataTimestamp: number | null;
        latestPageDataTimestamp: number | null;
        latestNetworkDataTimestamp: number | null;
        latestNetworkTimestamp: number | null;
      };
      expect(freshness.assessment).toBe('lagged');
      expect(freshness.latestInlineDataTimestamp).not.toBeNull();
      expect(freshness.latestPageDataTimestamp).not.toBeNull();
      expect(freshness.latestNetworkDataTimestamp).not.toBeNull();
      expect(freshness.latestNetworkTimestamp).not.toBeNull();
      expect(freshness.latestInlineDataTimestamp!).toBeLessThan(Date.now() + 36 * 60 * 60 * 1000);

      const relativeFreshness = (await harness.rpcCall('page.freshness', {
        tabId,
        patterns: ['Today', 'yesterday']
      })) as {
        assessment: string;
        domVisibleTimestamp: number | null;
      };
      expect(relativeFreshness.assessment).toBe('fresh');
      expect(relativeFreshness.domVisibleTimestamp).not.toBeNull();

      const inspectFreshness = (await harness.rpcCall('inspect.freshness', {
        tabId
      })) as {
        assessment: string;
        lagMs: number | null;
      };
      expect(inspectFreshness.assessment).toBe('lagged');
      expect(inspectFreshness.lagMs).not.toBeNull();

      const pageData = (await harness.rpcCall('inspect.pageData', {
        tabId
      })) as {
        suspiciousGlobals: string[];
        recentNetwork: unknown[];
      };
      expect(pageData.suspiciousGlobals).toContain('darkpool_json_data');
      expect(pageData.recentNetwork.length).toBeGreaterThan(0);

      const liveUpdates = (await harness.rpcCall('inspect.liveUpdates', {
        tabId
      })) as {
        networkCount: number;
        networkCadence?: { sampleCount: number; classification: string };
        recentNetwork: unknown[];
      };
      expect(liveUpdates.networkCount).toBeGreaterThan(0);
      expect(liveUpdates.networkCadence?.sampleCount).toBeGreaterThan(0);
      expect(liveUpdates.networkCadence?.classification).not.toBe('none');
      expect(liveUpdates.recentNetwork.length).toBeGreaterThan(0);

      const dump = (await harness.rpcCall('debug.dumpState', {
        tabId,
        section: ['scripts', 'network-summary']
      })) as {
        scripts?: { inlineCount: number };
        networkSummary?: { total: number; recent: unknown[] };
        dom?: unknown;
      };
      expect(dump.scripts?.inlineCount).toBeGreaterThan(0);
      expect(dump.networkSummary?.total).toBeGreaterThan(0);
      expect(dump).not.toHaveProperty('dom');

      const snapshot = (await harness.rpcCall('capture.snapshot', {
        tabId,
        networkLimit: 10
      })) as {
        visibleText: Array<{ text: string }>;
        network: unknown[];
        freshness: { assessment: string };
      };
      expect(snapshot.visibleText.some((chunk) => chunk.text.includes('Inline data updated'))).toBe(true);
      expect(snapshot.network.length).toBeGreaterThan(0);
      expect(snapshot.freshness.assessment).toBe('lagged');

      const har = (await harness.rpcCall('capture.har', {
        tabId,
        limit: 20
      })) as {
        har: { log: { entries: unknown[] } };
      };
      expect(har.har.log.entries.length).toBeGreaterThan(0);
      harness.assertTraceHas('capture.snapshot');
    } finally {
      await page.close();
    }
  });
});
