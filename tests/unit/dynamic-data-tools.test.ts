import { describe, expect, it } from 'vitest';
import type { InspectPageDataCandidateProbe, InspectPageDataSourceMapping, TableHandle } from '../../packages/protocol/src/types.js';
import {
  buildSourceMappingReport,
  buildTableIntelligence,
  selectReplaySchemaMatch,
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
      name: 'Virtual positions',
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
          name: 'Flow table',
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

  it('does not force unrelated replayed object rows onto the first table schema', () => {
    const tables: TableAnalysis[] = [
      {
        table: {
          id: 'html:1',
          name: 'Orders',
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
});
