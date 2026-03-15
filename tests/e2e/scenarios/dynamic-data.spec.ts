import { expect, test } from '@playwright/test';
import { createHarness, TEST_SITE_ORIGIN, type E2EHarness } from '../helpers/harness';

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
        tables: Array<{
          id: string;
          label?: string;
          kind: string;
          rowCount: number;
          intelligence?: { preferredExtractionMode: string; completeness: string };
        }>;
      };
      expect(tables.tables.length).toBeGreaterThan(0);
      expect(tables.tables[0]?.kind).toBe('html');
      expect(tables.tables[0]?.intelligence?.preferredExtractionMode).toBe('dataSource');
      expect(tables.tables[0]?.intelligence?.completeness).toBe('complete');

      const schema = (await harness.rpcCall('table.schema', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.id
      })) as {
        table?: { intelligence?: { preferredExtractionMode: string } };
        schema: { columns: Array<{ label: string }> };
      };
      expect(schema.schema.columns.map((column) => column.label)).toEqual(['ID', 'Name', 'Action']);
      expect(schema.table?.intelligence?.preferredExtractionMode).toBe('dataSource');

      const rows = (await harness.rpcCall('table.rows', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.id,
        all: true,
        maxRows: 100
      })) as {
        extractionMode: string;
        extraction: { mode: string; complete: boolean; observedRows: number; estimatedTotalRows?: number };
        rows: Array<Record<string, unknown>>;
      };
      expect(rows.extractionMode).toBe('dataSource');
      expect(rows.extraction.mode).toBe('dataSource');
      expect(rows.extraction.complete).toBe(true);
      expect(rows.extraction.observedRows).toBe(3);
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows[1]?.Name).toBe('Beta');

      const rowsByLabel = (await harness.rpcCall('table.rows', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.label ?? tables.tables[0]!.id,
        all: true,
        maxRows: 100
      })) as {
        rows: Array<Record<string, unknown>>;
      };
      expect(rowsByLabel.rows[0]?.Name).toBe('Alpha');

      const exported = (await harness.rpcCall('table.export', {
        tabId: tablePage.tabId,
        table: tables.tables[0]!.id,
        format: 'json',
        all: true,
        maxRows: 100
      })) as {
        extraction: { mode: string; complete: boolean; observedRows: number };
        rows: Array<Record<string, unknown>>;
      };
      expect(exported.extraction.mode).toBe('dataSource');
      expect(exported.extraction.complete).toBe(true);
      expect(exported.rows).toHaveLength(3);

      const inspected = (await harness.rpcCall('inspect.pageData', {
        tabId: tablePage.tabId
      })) as {
        suspiciousGlobals: string[];
        tables: Array<{ id: string }>;
        pageDataCandidates?: Array<{ name: string; resolver: string; schemaHint?: { columns?: string[] } }>;
        dataSources?: Array<{ sourceId: string; type: string; path: string }>;
        sourceMappings?: Array<{ tableId: string; sourceId: string; confidence: string; matchedColumns: string[] }>;
        recommendedNextActions?: Array<{ command: string }>;
      };
      expect(inspected.suspiciousGlobals).toEqual(expect.arrayContaining(['table_data', 'market_data']));
      expect(inspected.tables.length).toBeGreaterThan(0);
      expect(inspected.pageDataCandidates).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'lexical_market_snapshot', resolver: 'lexical' })])
      );
      expect(inspected.dataSources).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceId: 'windowGlobal:table_data', type: 'windowGlobal', path: 'table_data' })])
      );
      expect(inspected.sourceMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tableId: tables.tables[0]!.id,
            sourceId: 'windowGlobal:table_data',
            confidence: 'high'
          })
        ])
      );
      expect(inspected.recommendedNextActions).toEqual(
        expect.arrayContaining([expect.objectContaining({ command: 'bak page extract --path "table_data" --resolver auto' })])
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

  test('detects virtualized grids and stitches all rows with scroll extraction', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const virtualPage = await harness.openPage('/virtual-table.html');
    try {
      const tables = (await harness.rpcCall('table.list', { tabId: virtualPage.tabId })) as {
        tables: Array<{
          id: string;
          intelligence?: {
            virtualized: boolean;
            preferredExtractionMode: string;
            completeness: string;
            estimatedTotalRows?: number;
          };
        }>;
      };
      expect(tables.tables).toHaveLength(1);
      expect(tables.tables[0]?.intelligence?.virtualized).toBe(true);
      expect(tables.tables[0]?.intelligence?.preferredExtractionMode).toBe('scroll');
      expect(tables.tables[0]?.intelligence?.completeness).toBe('partial');
      expect(tables.tables[0]?.intelligence?.estimatedTotalRows).toBe(40);

      const rows = (await harness.rpcCall('table.rows', {
        tabId: virtualPage.tabId,
        table: tables.tables[0]!.id,
        all: true,
        maxRows: 100,
        timeoutMs: 90_000
      })) as {
        extractionMode: string;
        extraction: { mode: string; complete: boolean; observedRows: number; estimatedTotalRows?: number; warnings: string[] };
        rows: Array<Record<string, unknown>>;
      };
      expect(rows.extractionMode).toBe('scroll');
      expect(rows.extraction.mode).toBe('scroll');
      expect(rows.extraction.complete).toBe(true);
      expect(rows.extraction.observedRows).toBe(40);
      expect(rows.extraction.estimatedTotalRows).toBe(40);
      expect(rows.rows).toHaveLength(40);
      expect(rows.rows[0]).toEqual({ ID: '1', Name: 'Virtual Row 1', Bucket: 'Primary' });
      expect(rows.rows[39]).toEqual({ ID: '40', Name: 'Virtual Row 40', Bucket: 'Secondary' });

      const exported = (await harness.rpcCall('table.export', {
        tabId: virtualPage.tabId,
        table: tables.tables[0]!.id,
        format: 'json',
        all: true,
        maxRows: 100,
        timeoutMs: 90_000
      })) as {
        extraction: { mode: string; complete: boolean; observedRows: number };
        rows: Array<Record<string, unknown>>;
      };
      expect(exported.extraction.mode).toBe('scroll');
      expect(exported.extraction.complete).toBe(true);
      expect(exported.rows).toHaveLength(40);

      const inspected = (await harness.rpcCall('inspect.pageData', {
        tabId: virtualPage.tabId
      })) as {
        recommendedNextActions?: Array<{ command: string }>;
      };
      expect(inspected.recommendedNextActions).toEqual(
        expect.arrayContaining([expect.objectContaining({ command: `bak table rows --table ${tables.tables[0]!.id} --all --max-rows 10000` })])
      );
    } finally {
      await virtualPage.page.close();
    }
  });

  test('maps network-backed tables to recent responses and reuses schema on replay', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const networkTablePage = await harness.openPage('/network-table.html');
    try {
      await expect(networkTablePage.page.locator('#network-table-status')).toContainText('loaded');

      const tables = (await harness.rpcCall('table.list', { tabId: networkTablePage.tabId })) as {
        tables: Array<{ id: string; intelligence?: { preferredExtractionMode: string } }>;
      };
      expect(tables.tables).toHaveLength(1);
      expect(tables.tables[0]?.intelligence?.preferredExtractionMode).toBe('dataSource');

      const rows = (await harness.rpcCall('table.rows', {
        tabId: networkTablePage.tabId,
        table: tables.tables[0]!.id,
        all: true,
        maxRows: 20
      })) as {
        rows: Array<Record<string, unknown>>;
      };
      expect(rows.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ID: '101', Symbol: 'QQQ', Side: 'Buy', Premium: '125000' })
        ])
      );

      const inspected = (await harness.rpcCall('inspect.pageData', {
        tabId: networkTablePage.tabId
      })) as {
        dataSources?: Array<{ sourceId: string; type: string }>;
        sourceMappings?: Array<{ tableId: string; sourceId: string; confidence: string; matchedColumns: string[] }>;
      };
      const networkSource = inspected.dataSources?.find((source) => source.type === 'networkResponse' && source.sourceId.includes('networkResponse:'));
      expect(networkSource).toBeDefined();
      expect(inspected.sourceMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tableId: tables.tables[0]!.id,
            sourceId: networkSource?.sourceId,
            confidence: 'high',
            matchedColumns: ['ID', 'Symbol', 'Side', 'Premium']
          })
        ])
      );

      const search = (await harness.rpcCall('network.search', {
        tabId: networkTablePage.tabId,
        pattern: 'network-table-rows',
        limit: 5
      })) as {
        entries: Array<{ id: string }>;
      };
      expect(search.entries.length).toBeGreaterThan(0);

      const replay = (await harness.rpcCall('network.replay', {
        tabId: networkTablePage.tabId,
        id: search.entries[0]!.id,
        mode: 'json',
        withSchema: 'auto'
      })) as {
        schema?: { columns: Array<{ label: string }> };
        mappedRows?: Array<Record<string, unknown>>;
      };
      expect(replay.schema?.columns.map((column) => column.label)).toEqual(['ID', 'Symbol', 'Side', 'Premium']);
      expect(replay.mappedRows?.[0]).toEqual({
        ID: 101,
        Symbol: 'QQQ',
        Side: 'Buy',
        Premium: 125000
      });
    } finally {
      await networkTablePage.page.close();
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
        url: `${TEST_SITE_ORIGIN}/api/runtime-data?symbol=QQQ`,
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

      const protectedSeed = singlePageValue<{
        status: number;
        ok: boolean;
        json?: { ok: boolean; symbol: string; headerToken: string | null };
        authApplied?: string[];
      }>(
        await harness.rpcCall('page.fetch', {
          tabId,
          url: `${TEST_SITE_ORIGIN}/api/protected-core?symbol=SPY`,
          mode: 'json',
          auth: 'off'
        })
      );
      expect(protectedSeed.status).toBe(419);
      expect(protectedSeed.ok).toBe(false);
      expect(protectedSeed.json?.ok).toBe(false);
      expect(protectedSeed.authApplied).toBeUndefined();

      const protectedAuto = singlePageValue<{
        status: number;
        ok: boolean;
        json?: { ok: boolean; symbol: string; headerToken: string | null };
        authApplied?: string[];
        authSources?: string[];
      }>(
        await harness.rpcCall('page.fetch', {
          tabId,
          url: `${TEST_SITE_ORIGIN}/api/protected-core?symbol=QQQ`,
          mode: 'json',
          auth: 'auto'
        })
      );
      expect(protectedAuto.status).toBe(200);
      expect(protectedAuto.ok).toBe(true);
      expect(protectedAuto.json?.ok).toBe(true);
      expect(protectedAuto.json?.symbol).toBe('QQQ');
      expect(protectedAuto.authApplied).toContain('X-XSRF-TOKEN');
      expect(protectedAuto.authSources).toContain('cookie:XSRF-TOKEN');

      const protectedSearch = (await harness.rpcCall('network.search', {
        tabId,
        pattern: 'protected-core?symbol=SPY',
        limit: 10
      })) as {
        entries: Array<{ id: string; url: string }>;
        scanned: number;
        matched: number;
        bodyCoverage: {
          request: { full: number; partial: number; none: number };
          response: { full: number; partial: number; none: number };
        };
      };
      expect(protectedSearch.scanned).toBeGreaterThan(0);
      expect(protectedSearch.matched).toBeGreaterThanOrEqual(protectedSearch.entries.length);
      expect(protectedSearch.entries.some((entry) => entry.url.includes('symbol=SPY'))).toBe(true);
      expect(
        protectedSearch.bodyCoverage.request.full +
          protectedSearch.bodyCoverage.request.partial +
          protectedSearch.bodyCoverage.request.none
      ).toBe(protectedSearch.scanned);
      expect(
        protectedSearch.bodyCoverage.response.full +
          protectedSearch.bodyCoverage.response.partial +
          protectedSearch.bodyCoverage.response.none
      ).toBe(protectedSearch.scanned);

      const protectedReplayOff = (await harness.rpcCall('network.replay', {
        tabId,
        id: protectedSearch.entries[0]!.id,
        mode: 'json',
        auth: 'off'
      })) as {
        status: number;
        ok: boolean;
        json?: { ok: boolean };
        authApplied?: string[];
      };
      expect(protectedReplayOff.status).toBe(419);
      expect(protectedReplayOff.ok).toBe(false);
      expect(protectedReplayOff.json?.ok).toBe(false);
      expect(protectedReplayOff.authApplied).toBeUndefined();

      const protectedReplayAuto = (await harness.rpcCall('network.replay', {
        tabId,
        id: protectedSearch.entries[0]!.id,
        mode: 'json',
        auth: 'auto'
      })) as {
        status: number;
        ok: boolean;
        json?: { ok: boolean; headerToken: string | null };
        authApplied?: string[];
        authSources?: string[];
      };
      expect(protectedReplayAuto.status).toBe(200);
      expect(protectedReplayAuto.ok).toBe(true);
      expect(protectedReplayAuto.json?.ok).toBe(true);
      expect(protectedReplayAuto.authApplied).toContain('X-XSRF-TOKEN');
      expect(protectedReplayAuto.authSources).toContain('cookie:XSRF-TOKEN');

      const initialWaitPromise = harness.rpcCall('network.waitFor', {
        tabId,
        urlIncludes: '/api/echo',
        status: 200,
        timeoutMs: 10_000
      });

      const echoFetch = (await harness.rpcCall('page.fetch', {
        tabId,
        url: `${TEST_SITE_ORIGIN}/api/echo`,
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
        url: `${TEST_SITE_ORIGIN}/api/echo`,
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
        scanned: number;
        matched: number;
        bodyCoverage: {
          request: { full: number; partial: number; none: number };
          response: { full: number; partial: number; none: number };
        };
      };
      expect(search.entries.some((entry) => entry.id === freshWaited.entry.id)).toBe(true);
      expect(search.scanned).toBeGreaterThan(0);
      expect(search.matched).toBeGreaterThanOrEqual(search.entries.length);
      expect(search.bodyCoverage.request.full).toBeGreaterThan(0);
      expect(search.bodyCoverage.response.full).toBeGreaterThan(0);
      expect(search.bodyCoverage.request.full + search.bodyCoverage.request.partial + search.bodyCoverage.request.none).toBe(
        search.scanned
      );
      expect(
        search.bodyCoverage.response.full + search.bodyCoverage.response.partial + search.bodyCoverage.response.none
      ).toBe(search.scanned);

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

      const largeJson = singlePageValue<{
        status: number;
        ok: boolean;
        truncated: boolean;
        degradedReason?: string;
        json?: unknown;
        schema?: { columns: Array<{ label: string }> };
        mappedRows?: Array<Record<string, unknown>>;
      }>(
        await harness.rpcCall('page.fetch', {
          tabId,
          url: `${TEST_SITE_ORIGIN}/api/large-json`,
          mode: 'json',
          maxBytes: 512
        })
      );
      expect(largeJson.status).toBe(200);
      expect(largeJson.ok).toBe(true);
      expect(largeJson.truncated).toBe(true);
      expect(largeJson.degradedReason).toContain('summarized');
      expect(largeJson.json).toBeUndefined();
      expect(largeJson.schema?.columns.map((column) => column.label)).toEqual(
        expect.arrayContaining(['id', 'symbol', 'side', 'premium'])
      );
      expect(largeJson.mappedRows?.length).toBeGreaterThan(0);

      const fullLargeJson = singlePageValue<{
        status: number;
        ok: boolean;
        truncated: boolean;
        degradedReason?: string;
        json?: { rows: Array<Record<string, unknown>> };
      }>(
        await harness.rpcCall('page.fetch', {
          tabId,
          url: `${TEST_SITE_ORIGIN}/api/large-json`,
          mode: 'json',
          maxBytes: 512,
          fullResponse: true
        })
      );
      expect(fullLargeJson.status).toBe(200);
      expect(fullLargeJson.ok).toBe(true);
      expect(fullLargeJson.truncated).toBe(false);
      expect(fullLargeJson.degradedReason).toBeUndefined();
      expect(fullLargeJson.json?.rows.length).toBeGreaterThan(200);

      await page.click('#fetch-ok');
      await expect(page.locator('#network-log')).toContainText('fetch:200:ok');

      const verify = (await harness.rpcCall('page.verify', {
        tabId,
        patterns: ['Today', 'yesterday']
      })) as {
        title: string;
        url: string;
        context: Record<string, unknown>;
        elementCount: number;
        refs: Array<{ ref: string }>;
        actionSummary: { clickable: Array<{ ref: string }> };
        freshness: {
          assessment: string;
          primaryTimestamp: number | null;
          primaryCategory: string | null;
          primarySource: string | null;
          suppressedEvidenceCount: number;
        };
        networkHeartbeat: {
          latestNetworkTimestamp: number | null;
          networkCount: number;
          recentRequestIds: string[];
          networkCadence?: { classification: string };
        };
        captureStatus: string;
        captureError?: unknown;
      };
      expect(verify.captureStatus).toBe('skipped');
      expect(verify.captureError).toBeUndefined();
      expect(verify.title).toContain('Network');
      expect(verify.url).toContain('/network.html');
      expect(verify.context).toBeTruthy();
      expect(verify.elementCount).toBeGreaterThan(0);
      expect(verify.refs.length).toBeGreaterThan(0);
      expect(verify.actionSummary.clickable.length).toBeGreaterThan(0);
      expect(verify.freshness.primaryCategory).toBe('data');
      expect(verify.freshness.primaryTimestamp).not.toBeNull();
      expect(verify.freshness.suppressedEvidenceCount).toBeGreaterThan(0);
      expect(verify.networkHeartbeat.latestNetworkTimestamp).not.toBeNull();
      expect(verify.networkHeartbeat.networkCount).toBeGreaterThan(0);
      expect(verify.networkHeartbeat.recentRequestIds.length).toBeGreaterThan(0);
      expect(verify.networkHeartbeat.networkCadence?.classification).not.toBe('none');

      const freshness = (await harness.rpcCall('page.freshness', {
        tabId
      })) as {
        assessment: string;
        latestInlineDataTimestamp: number | null;
        latestPageDataTimestamp: number | null;
        latestNetworkDataTimestamp: number | null;
        latestNetworkTimestamp: number | null;
        primaryTimestamp: number | null;
        primaryCategory: string | null;
        primarySource: string | null;
        confidence: string | null;
        suppressedEvidenceCount: number;
      };
      expect(freshness.assessment).toBe('lagged');
      expect(freshness.latestInlineDataTimestamp).not.toBeNull();
      expect(freshness.latestPageDataTimestamp).not.toBeNull();
      expect(freshness.latestNetworkDataTimestamp).not.toBeNull();
      expect(freshness.latestNetworkTimestamp).not.toBeNull();
      expect(freshness.primaryTimestamp).toBe(freshness.latestNetworkDataTimestamp);
      expect(freshness.primaryCategory).toBe('data');
      expect(freshness.primarySource).toBe('network');
      expect(freshness.confidence).not.toBeNull();
      expect(freshness.suppressedEvidenceCount).toBeGreaterThan(0);
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
