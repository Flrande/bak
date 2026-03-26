import { describe, expect, it } from 'vitest';
import type { InspectPageDataCandidateProbe, InspectPageDataSourceMapping, TableHandle } from '../../packages/protocol/src/types.js';
import {
  buildSourceMappingReport,
  buildTableIntelligence,
  deriveLatestArchiveDate,
  selectCurrentMode,
  selectReplaySchemaMatch,
  summarizeAvailableModes,
  type TableAnalysis
} from '../../packages/extension/src/dynamic-data-tools.js';

describe('dynamic data tools', () => {
  it('classifies virtualized grid tables as scroll-preferring partial views', () => {
    const intelligence = buildTableIntelligence({
      kind: 'aria-grid',
      visibleRowCount: 8,
      estimatedTotalRows: 40,
      hasScrollContainer: true,
      hasTranslatedRows: true,
      maxObservedRowIndex: 12,
      minObservedRowIndex: 5,
      knownGridKind: false
    });

    expect(intelligence.virtualized).toBe(true);
    expect(intelligence.lazyLoaded).toBe(false);
    expect(intelligence.preferredExtractionMode).toBe('scroll');
    expect(intelligence.completeness).toBe('partial');
    expect(intelligence.signals.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(['scroll-container', 'row-transform-offsets', 'row-index-gap', 'dom-rows-less-than-expected'])
    );
  });

  it('builds high-confidence source mappings from columns and sample values', () => {
    const table: TableHandle = {
      id: 'aria-grid:1',
      label: 'Virtual positions',
      kind: 'aria-grid',
      intelligence: buildTableIntelligence({
        kind: 'aria-grid',
        visibleRowCount: 8,
        estimatedTotalRows: 40,
        hasScrollContainer: true,
        hasTranslatedRows: true,
        maxObservedRowIndex: 10,
        minObservedRowIndex: 3,
        knownGridKind: false
      })
    };
    const tables: TableAnalysis[] = [
      {
        table,
        schema: {
          columns: [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'bucket', label: 'Bucket' }
          ]
        },
        sampleRows: [
          { ID: 1, Name: 'Alpha', Bucket: 'Primary' },
          { ID: 2, Name: 'Beta', Bucket: 'Secondary' }
        ]
      }
    ];
    const candidates: InspectPageDataCandidateProbe[] = [
      {
        name: 'virtual_table_rows',
        resolver: 'globalThis',
        sample: [
          { id: 1, name: 'Alpha', bucket: 'Primary' },
          { id: 2, name: 'Beta', bucket: 'Secondary' }
        ],
        sampleSize: 40,
        schemaHint: {
          kind: 'rows-object',
          columns: ['id', 'name', 'bucket']
        },
        lastObservedAt: Date.now(),
        timestamps: []
      }
    ];

    const report = buildSourceMappingReport({
      tables,
      windowSources: candidates,
      inlineJsonSources: [],
      recentNetwork: [],
      now: Date.now()
    });

    expect(report.dataSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'windowGlobal:virtual_table_rows',
          type: 'windowGlobal',
          path: 'virtual_table_rows'
        })
      ])
    );
    expect(report.sourceMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableId: 'aria-grid:1',
          sourceId: 'windowGlobal:virtual_table_rows',
          confidence: 'high',
          matchedColumns: ['ID', 'Name', 'Bucket']
        })
      ])
    );
    expect(report.recommendedNextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'bak table rows --table aria-grid:1 --all --max-rows 10000'
        }),
        expect.objectContaining({
          command: 'bak page extract --path "virtual_table_rows" --resolver auto'
        })
      ])
    );
  });

  it('maps replayed object rows onto the best matching table schema', () => {
    const tables: TableAnalysis[] = [
      {
        table: {
          id: 'html:1',
          label: 'Flow table',
          kind: 'html'
        },
        schema: {
          columns: [
            { key: 'id', label: 'ID' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'side', label: 'Side' },
            { key: 'premium', label: 'Premium' }
          ]
        },
        sampleRows: [{ ID: 101, Symbol: 'QQQ', Side: 'Buy', Premium: 125000 }]
      }
    ];
    const mappings: InspectPageDataSourceMapping[] = [
      {
        tableId: 'html:1',
        sourceId: 'networkResponse:req_network',
        confidence: 'high',
        basis: [
          {
            type: 'columnOverlap',
            detail: 'Column overlap on ID, Symbol, Side, Premium'
          }
        ],
        matchedColumns: ['ID', 'Symbol', 'Side', 'Premium']
      }
    ];

    const match = selectReplaySchemaMatch(
      {
        rows: [
          { id: 101, symbol: 'QQQ', side: 'Buy', premium: 125000 },
          { id: 102, symbol: 'SPY', side: 'Sell', premium: 98000 }
        ]
      },
      tables,
      {
        preferredSourceId: 'networkResponse:req_network',
        mappings
      }
    );

    expect(match?.table.id).toBe('html:1');
    expect(match?.schema.columns.map((column) => column.label)).toEqual(['ID', 'Symbol', 'Side', 'Premium']);
    expect(match?.mappedRows[0]).toEqual({
      ID: 101,
      Symbol: 'QQQ',
      Side: 'Buy',
      Premium: 125000
    });
  });

  it('summarizes available modes and derives the latest archive date', () => {
    const modeGroups = [
      {
        controlType: 'tabs' as const,
        label: 'Data mode',
        options: [
          { label: 'Latest', value: 'latest', selected: false },
          { label: 'Historical', value: 'historical', selected: true },
          { label: 'Archive', value: 'archive', selected: false }
        ]
      }
    ];

    expect(summarizeAvailableModes(modeGroups)).toEqual(['Latest', 'Historical', 'Archive']);
    expect(selectCurrentMode(modeGroups)).toEqual({
      controlType: 'tabs',
      label: 'Historical',
      value: 'historical',
      groupLabel: 'Data mode'
    });
    expect(
      deriveLatestArchiveDate([
        {
          controlType: 'input',
          value: '2026-03-25',
          max: '2026-03-25'
        },
        {
          controlType: 'dataset',
          dataMaxDate: '2026-03-24'
        }
      ])
    ).toBe('2026-03-25');
  });

  it('does not force unrelated replayed object rows onto the first table schema', () => {
    const tables: TableAnalysis[] = [
      {
        table: {
          id: 'html:1',
          label: 'Orders',
          kind: 'html'
        },
        schema: {
          columns: [
            { key: 'id', label: 'ID' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'side', label: 'Side' }
          ]
        },
        sampleRows: [{ ID: 101, Symbol: 'QQQ', Side: 'Buy' }]
      }
    ];

    const match = selectReplaySchemaMatch(
      {
        rows: [{ foo: 'bar', baz: 1 }]
      },
      tables
    );

    expect(match).toBeNull();
  });

  it('prefers clone recommendations and selects a mapped primary endpoint', () => {
    const table: TableHandle = {
      id: 'html:1',
      label: 'Flow table',
      kind: 'html'
    };
    const tables: TableAnalysis[] = [
      {
        table,
        schema: {
          columns: [
            { key: 'symbol', label: 'Symbol' },
            { key: 'mode', label: 'Mode' },
            { key: 'sessionDate', label: 'Session Date' },
            { key: 'premium', label: 'Premium' }
          ]
        },
        sampleRows: [{ Symbol: 'QQQ', Mode: 'historical', 'Session Date': '2026-03-25', Premium: 125000 }]
      }
    ];

    const report = buildSourceMappingReport({
      tables,
      windowSources: [],
      inlineJsonSources: [],
      recentNetwork: [
        {
          id: 'net_1',
          url: 'https://example.test/api/page-data-semantic?mode=historical&date=2026-03-25',
          method: 'GET',
          status: 200,
          ok: true,
          kind: 'fetch',
          ts: Date.now(),
          durationMs: 10,
          contentType: 'application/json',
          responseBodyPreview: JSON.stringify({
            rows: [{ symbol: 'QQQ', mode: 'historical', sessionDate: '2026-03-25', premium: 125000 }]
          })
        }
      ],
      pageUrl: 'https://example.test/page-data-semantic.html',
      now: Date.now()
    });

    expect(report.primaryEndpoint).toEqual(
      expect.objectContaining({
        requestId: 'net_1',
        matchedTableId: 'html:1'
      })
    );
    expect(report.recommendedNextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: 'bak network clone net_1' })])
    );
  });
});
