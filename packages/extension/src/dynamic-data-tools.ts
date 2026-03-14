import type {
  DynamicDataSchemaHint,
  FreshnessTimestampCategory,
  InspectPageDataCandidateProbe,
  InspectPageDataRecommendation,
  InspectPageDataResult,
  InspectPageDataSource,
  InspectPageDataSourceMapping,
  NetworkEntry,
  TableExtractionMetadata,
  TableHandle,
  TableIntelligence,
  TableSchema
} from '@flrande/bak-protocol';

interface TimestampProbe {
  path: string;
  value: string;
  category: FreshnessTimestampCategory;
}

export interface InlineJsonInspectionSource {
  label: string;
  path: string;
  sample: unknown;
  sampleSize: number | null;
  schemaHint: DynamicDataSchemaHint | null;
  lastObservedAt: number | null;
  timestamps: TimestampProbe[];
}

export interface TableIntelligenceInput {
  kind: TableHandle['kind'];
  visibleRowCount: number;
  rowCount?: number;
  estimatedTotalRows?: number;
  hasScrollContainer: boolean;
  hasTranslatedRows: boolean;
  maxObservedRowIndex?: number;
  minObservedRowIndex?: number;
  knownGridKind: boolean;
}

export interface TableAnalysis {
  table: TableHandle;
  schema: TableSchema;
  sampleRows: Array<Record<string, unknown>>;
}

export interface DynamicSourceAnalysis {
  source: InspectPageDataSource;
  sampleRows: Array<Record<string, unknown>>;
  sampleValues: Set<string>;
  schemaColumns: string[];
}

export interface SourceMappingInput {
  tables: TableAnalysis[];
  windowSources: InspectPageDataCandidateProbe[];
  inlineJsonSources: InlineJsonInspectionSource[];
  recentNetwork: NetworkEntry[];
  now?: number;
}

export interface SourceMappingReport {
  dataSources: InspectPageDataSource[];
  sourceMappings: InspectPageDataSourceMapping[];
  recommendedNextActions: InspectPageDataRecommendation[];
  sourceAnalyses: DynamicSourceAnalysis[];
}

export interface ReplaySchemaMatch {
  table: TableHandle;
  schema: TableSchema;
  mappedRows: Array<Record<string, unknown>>;
  mappingSource: string;
}

interface StructuredRowsCandidate {
  rows: unknown[];
  path: string;
  rowType: 'object' | 'array' | 'scalar';
}

const DATA_PATTERN =
  /\b(updated|update|updatedat|asof|timestamp|generated|generatedat|refresh|freshness|latest|last|quote|trade|price|flow|market|time|snapshot|signal)\b/i;
const CONTRACT_PATTERN =
  /\b(expiry|expiration|expires|option|contract|strike|maturity|dte|call|put|exercise)\b/i;
const EVENT_PATTERN = /\b(earnings|event|report|dividend|split|meeting|fomc|release|filing)\b/i;
const ROW_CANDIDATE_KEYS = ['data', 'rows', 'results', 'items', 'records', 'entries'] as const;

function normalizeColumnName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizedComparableValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  return text.length > 0 ? text : null;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function latestTimestamp(timestamps: TimestampProbe[]): number | null {
  const values = timestamps
    .map((timestamp) => Date.parse(timestamp.value))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

export function sampleValue(value: unknown, depth = 0): unknown {
  if (depth >= 2 || value === null || value === undefined || typeof value !== 'object') {
    if (typeof value === 'string') {
      return value.length > 160 ? value.slice(0, 160) : value;
    }
    if (typeof value === 'function') {
      return '[Function]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => sampleValue(item, depth + 1));
  }
  const sampled: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 8)) {
    try {
      sampled[key] = sampleValue((value as Record<string, unknown>)[key], depth + 1);
    } catch {
      sampled[key] = '[Unreadable]';
    }
  }
  return sampled;
}

export function estimateSampleSize(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return null;
}

function classifyTimestamp(path: string, value: string, now = Date.now()): FreshnessTimestampCategory {
  const normalized = path.toLowerCase();
  if (DATA_PATTERN.test(normalized)) {
    return 'data';
  }
  if (CONTRACT_PATTERN.test(normalized)) {
    return 'contract';
  }
  if (EVENT_PATTERN.test(normalized)) {
    return 'event';
  }
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) && parsed > now + 36 * 60 * 60 * 1000 ? 'contract' : 'unknown';
}

export function collectTimestampProbes(
  value: unknown,
  path: string,
  options: { now?: number; limit?: number } = {}
): TimestampProbe[] {
  const collected: TimestampProbe[] = [];
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const limit = typeof options.limit === 'number' ? Math.max(1, Math.floor(options.limit)) : 16;

  const visit = (candidate: unknown, candidatePath: string, depth: number): void => {
    if (collected.length >= limit) {
      return;
    }
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const parsed = Date.parse(candidate.trim());
      if (Number.isFinite(parsed)) {
        collected.push({
          path: candidatePath,
          value: candidate,
          category: classifyTimestamp(candidatePath, candidate, now)
        });
      }
      return;
    }
    if (depth >= 3 || candidate === null || candidate === undefined) {
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.slice(0, 3).forEach((entry, index) => visit(entry, `${candidatePath}[${index}]`, depth + 1));
      return;
    }
    if (typeof candidate === 'object') {
      Object.keys(candidate as Record<string, unknown>)
        .slice(0, 8)
        .forEach((key) => {
          try {
            visit((candidate as Record<string, unknown>)[key], candidatePath ? `${candidatePath}.${key}` : key, depth + 1);
          } catch {
            // Ignore unreadable nested values.
          }
        });
    }
  };

  visit(value, path, 0);
  return collected;
}

export function inferSchemaHint(value: unknown): DynamicDataSchemaHint | null {
  const rowsCandidate = extractStructuredRows(value);
  if (rowsCandidate) {
    if (rowsCandidate.rowType === 'object') {
      const firstRecord = rowsCandidate.rows.find(
        (row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row)
      );
      return {
        kind: 'rows-object',
        columns: firstRecord ? Object.keys(firstRecord).slice(0, 12) : []
      };
    }
    if (rowsCandidate.rowType === 'array') {
      const firstRow = rowsCandidate.rows.find((row): row is unknown[] => Array.isArray(row));
      return {
        kind: 'rows-array',
        columns: firstRow ? firstRow.map((_, index) => `Column ${index + 1}`) : []
      };
    }
  }
  if (Array.isArray(value)) {
    return { kind: 'array' };
  }
  if (value && typeof value === 'object') {
    return {
      kind: 'object',
      columns: Object.keys(value as Record<string, unknown>).slice(0, 12)
    };
  }
  if (value === null || value === undefined) {
    return null;
  }
  return { kind: 'scalar' };
}

export function extractStructuredRows(value: unknown, path = '$'): StructuredRowsCandidate | null {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { rows: value, path, rowType: 'object' };
    }
    const first = value.find((item) => item !== null && item !== undefined);
    if (Array.isArray(first)) {
      return { rows: value, path, rowType: 'array' };
    }
    if (first && typeof first === 'object') {
      return { rows: value, path, rowType: 'object' };
    }
    return { rows: value, path, rowType: 'scalar' };
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ROW_CANDIDATE_KEYS) {
    if (Array.isArray(record[key])) {
      return extractStructuredRows(record[key], `${path}.${key}`);
    }
  }
  return null;
}

function toObjectRow(row: unknown, fallbackColumns: string[] = []): Record<string, unknown> | null {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row as Record<string, unknown>;
  }
  if (Array.isArray(row)) {
    const mapped: Record<string, unknown> = {};
    row.forEach((value, index) => {
      mapped[fallbackColumns[index] ?? `Column ${index + 1}`] = value;
    });
    return mapped;
  }
  if (row === null || row === undefined) {
    return null;
  }
  return { Value: row };
}

function sampleRowsFromValue(value: unknown, limit = 5): Array<Record<string, unknown>> {
  const rowsCandidate = extractStructuredRows(value);
  if (!rowsCandidate) {
    const singleRow = toObjectRow(value);
    return singleRow ? [singleRow] : [];
  }
  const fallbackColumns =
    rowsCandidate.rowType === 'array'
      ? Array.from({ length: Array.isArray(rowsCandidate.rows[0]) ? (rowsCandidate.rows[0] as unknown[]).length : 0 }, (_, index) => `Column ${index + 1}`)
      : [];
  return rowsCandidate.rows
    .slice(0, limit)
    .map((row) => toObjectRow(row, fallbackColumns))
    .filter((row): row is Record<string, unknown> => row !== null);
}

function collectSampleValues(rows: Array<Record<string, unknown>>): Set<string> {
  const values = new Set<string>();
  for (const row of rows) {
    for (const value of Object.values(row)) {
      const comparable = normalizedComparableValue(value);
      if (comparable) {
        values.add(comparable);
      }
      if (values.size >= 24) {
        return values;
      }
    }
  }
  return values;
}

function buildSourceAnalysis(source: InspectPageDataSource, sample: unknown): DynamicSourceAnalysis {
  const sampleRows = sampleRowsFromValue(sample);
  return {
    source,
    sampleRows,
    sampleValues: collectSampleValues(sampleRows),
    schemaColumns: source.schemaHint?.columns?.map(normalizeColumnName).filter(Boolean) ?? []
  };
}

function parseNetworkBody(entry: NetworkEntry): unknown | null {
  const preview = typeof entry.responseBodyPreview === 'string' ? entry.responseBodyPreview.trim() : '';
  if (!preview || entry.responseBodyTruncated === true || entry.binary === true) {
    return null;
  }
  const contentType = typeof entry.contentType === 'string' ? entry.contentType.toLowerCase() : '';
  if (!contentType.includes('json') && !preview.startsWith('{') && !preview.startsWith('[')) {
    return null;
  }
  try {
    return JSON.parse(preview);
  } catch {
    return null;
  }
}

function buildWindowSources(candidates: InspectPageDataCandidateProbe[]): DynamicSourceAnalysis[] {
  return candidates.map((candidate) => {
    const source: InspectPageDataSource = {
      sourceId: `windowGlobal:${candidate.name}`,
      type: 'windowGlobal',
      label: candidate.name,
      path: candidate.name,
      sampleSize: candidate.sampleSize,
      schemaHint: candidate.schemaHint,
      lastObservedAt: candidate.lastObservedAt
    };
    return buildSourceAnalysis(source, candidate.sample);
  });
}

function buildInlineJsonAnalyses(sources: InlineJsonInspectionSource[]): DynamicSourceAnalysis[] {
  return sources.map((sourceItem, index) => {
    const source: InspectPageDataSource = {
      sourceId: `inlineJson:${index + 1}:${sourceItem.path}`,
      type: 'inlineJson',
      label: sourceItem.label,
      path: sourceItem.path,
      sampleSize: sourceItem.sampleSize,
      schemaHint: sourceItem.schemaHint,
      lastObservedAt: sourceItem.lastObservedAt
    };
    return buildSourceAnalysis(source, sourceItem.sample);
  });
}

function buildNetworkAnalyses(entries: NetworkEntry[]): DynamicSourceAnalysis[] {
  const analyses: DynamicSourceAnalysis[] = [];
  for (const entry of entries) {
    const parsed = parseNetworkBody(entry);
    if (parsed === null) {
      continue;
    }
    const rowsCandidate = extractStructuredRows(parsed);
    const schemaHint = inferSchemaHint(parsed);
    const url = new URL(entry.url, 'http://127.0.0.1');
    const source: InspectPageDataSource = {
      sourceId: `networkResponse:${entry.id}`,
      type: 'networkResponse',
      label: `${entry.method} ${url.pathname}`,
      path: rowsCandidate?.path ?? url.pathname,
      sampleSize: estimateSampleSize(rowsCandidate?.rows ?? parsed),
      schemaHint,
      lastObservedAt: entry.ts
    };
    analyses.push(buildSourceAnalysis(source, rowsCandidate?.rows ?? parsed));
  }
  return analyses;
}

export function buildTableIntelligence(input: TableIntelligenceInput): TableIntelligence {
  const signals: TableIntelligence['signals'] = [];
  const visibleRowCount = Math.max(0, Math.floor(input.visibleRowCount));
  const estimatedTotalRows =
    typeof input.estimatedTotalRows === 'number' && Number.isFinite(input.estimatedTotalRows) && input.estimatedTotalRows > 0
      ? Math.max(visibleRowCount, Math.floor(input.estimatedTotalRows))
      : undefined;
  const maxObservedRowIndex =
    typeof input.maxObservedRowIndex === 'number' && Number.isFinite(input.maxObservedRowIndex)
      ? Math.max(0, Math.floor(input.maxObservedRowIndex))
      : undefined;
  const minObservedRowIndex =
    typeof input.minObservedRowIndex === 'number' && Number.isFinite(input.minObservedRowIndex)
      ? Math.max(0, Math.floor(input.minObservedRowIndex))
      : undefined;

  if (input.knownGridKind) {
    signals.push({
      code: 'known-grid-kind',
      detail: `Detected ${input.kind} container semantics`
    });
  }
  if (input.hasScrollContainer) {
    signals.push({
      code: 'scroll-container',
      detail: 'Scrollable container detected for the table region'
    });
  }
  if (input.hasTranslatedRows) {
    signals.push({
      code: 'row-transform-offsets',
      detail: 'Row transform offsets indicate viewport-based row reuse'
    });
  }
  if (maxObservedRowIndex !== undefined && maxObservedRowIndex > visibleRowCount) {
    signals.push({
      code: 'row-index-gap',
      detail: `Observed row indexes reach ${maxObservedRowIndex} while only ${visibleRowCount} rows are mounted`
    });
  }
  if (estimatedTotalRows !== undefined && estimatedTotalRows > visibleRowCount) {
    signals.push({
      code: 'dom-rows-less-than-expected',
      detail: `Estimated ${estimatedTotalRows} rows with ${visibleRowCount} currently mounted`
    });
  }

  const virtualized =
    input.hasTranslatedRows ||
    (input.hasScrollContainer &&
      ((estimatedTotalRows !== undefined && estimatedTotalRows > visibleRowCount) ||
        (maxObservedRowIndex !== undefined && maxObservedRowIndex > visibleRowCount + 1)));
  const lazyLoaded =
    input.hasScrollContainer &&
    !virtualized &&
    estimatedTotalRows !== undefined &&
    estimatedTotalRows > visibleRowCount;
  const preferredExtractionMode =
    input.kind === 'html' || input.kind === 'dataTables' ? 'dataSource' : input.hasScrollContainer ? 'scroll' : 'visibleOnly';
  const completeness =
    preferredExtractionMode === 'dataSource'
      ? 'complete'
      : estimatedTotalRows !== undefined && estimatedTotalRows > visibleRowCount
        ? 'partial'
        : minObservedRowIndex !== undefined && minObservedRowIndex > 1
          ? 'partial'
          : 'unknown';

  return {
    virtualized,
    lazyLoaded,
    preferredExtractionMode,
    estimatedTotalRows,
    completeness,
    signals
  };
}

export function buildExtractionMetadata(
  mode: TableExtractionMetadata['mode'],
  rows: Array<Record<string, unknown>>,
  intelligence?: TableIntelligence,
  warnings: string[] = [],
  options: { reachedEnd?: boolean; limitApplied?: boolean } = {}
): TableExtractionMetadata {
  const estimatedTotalRows = intelligence?.estimatedTotalRows;
  const complete =
    options.limitApplied
      ? false
      : mode === 'dataSource'
        ? true
        : options.reachedEnd === true
          ? true
          : intelligence?.completeness === 'complete';
  return {
    mode,
    complete: complete === true,
    observedRows: rows.length,
    estimatedTotalRows,
    warnings
  };
}

function scoreSourceMapping(table: TableAnalysis, source: DynamicSourceAnalysis, now: number): InspectPageDataSourceMapping | null {
  const tableColumns = table.schema.columns.map((column) => column.label);
  const normalizedTableColumns = new Map(tableColumns.map((label) => [normalizeColumnName(label), label]));
  const matchedColumns = [...new Set(source.schemaColumns.filter((column) => normalizedTableColumns.has(column)).map((column) => normalizedTableColumns.get(column)!))];
  const basis: InspectPageDataSourceMapping['basis'] = [];
  if (matchedColumns.length > 0) {
    basis.push({
      type: 'columnOverlap',
      detail: `Column overlap on ${matchedColumns.join(', ')}`
    });
  }

  const overlappingValues = [...table.sampleRows.flatMap((row) => Object.values(row))]
    .map((value) => normalizedComparableValue(value))
    .filter((value): value is string => value !== null)
    .filter((value) => source.sampleValues.has(value));
  const distinctOverlappingValues = [...new Set(overlappingValues)].slice(0, 5);
  if (distinctOverlappingValues.length > 0) {
    basis.push({
      type: 'sampleValueOverlap',
      detail: `Shared sample values: ${distinctOverlappingValues.join(', ')}`
    });
  }

  const explicitReferenceHit =
    table.table.name.toLowerCase().includes(source.source.label.toLowerCase()) ||
    (table.table.selector ?? '').toLowerCase().includes(source.source.label.toLowerCase()) ||
    source.source.label.toLowerCase().includes(table.table.name.toLowerCase());
  if (explicitReferenceHit) {
    basis.push({
      type: 'explicitReference',
      detail: `Table label and source label both mention ${source.source.label}`
    });
  }

  if (
    source.source.type === 'networkResponse' &&
    typeof source.source.lastObservedAt === 'number' &&
    Math.max(0, now - source.source.lastObservedAt) <= 90_000
  ) {
    basis.push({
      type: 'timeProximity',
      detail: 'Recent network response observed within the last 90 seconds'
    });
  }

  if (basis.length === 0) {
    return null;
  }

  const confidence =
    matchedColumns.length >= Math.max(2, Math.min(tableColumns.length, 3)) || (matchedColumns.length > 0 && distinctOverlappingValues.length > 0)
      ? 'high'
      : matchedColumns.length > 0 || distinctOverlappingValues.length > 0
        ? 'medium'
        : 'low';
  return {
    tableId: table.table.id,
    sourceId: source.source.sourceId,
    confidence,
    basis,
    matchedColumns
  };
}

function buildRecommendedNextActions(
  tables: TableAnalysis[],
  mappings: InspectPageDataSourceMapping[],
  sourceAnalyses: DynamicSourceAnalysis[]
): InspectPageDataRecommendation[] {
  const recommendations: InspectPageDataRecommendation[] = [];
  const pushRecommendation = (item: InspectPageDataRecommendation): void => {
    if (recommendations.some((existing) => existing.command === item.command)) {
      return;
    }
    recommendations.push(item);
  };

  for (const table of tables) {
    if (table.table.intelligence?.preferredExtractionMode === 'scroll') {
      pushRecommendation({
        title: `Read all rows from ${table.table.id}`,
        command: `bak table rows --table ${table.table.id} --all --max-rows 10000`,
        note: 'The table looks virtualized or lazy-loaded, so a scroll pass is preferred.'
      });
    }
  }

  for (const mapping of mappings.filter((item) => item.confidence !== 'low')) {
    const source = sourceAnalyses.find((analysis) => analysis.source.sourceId === mapping.sourceId);
    if (!source) {
      continue;
    }
    if (source.source.type === 'windowGlobal') {
      pushRecommendation({
        title: `Read ${source.source.label} directly from page data`,
        command: `bak page extract --path "${source.source.path}" --resolver auto`,
        note: `Mapped to ${mapping.tableId} with ${mapping.confidence} confidence.`
      });
      continue;
    }
    if (source.source.type === 'networkResponse') {
      const requestId = source.source.sourceId.replace(/^networkResponse:/, '');
      pushRecommendation({
        title: `Replay ${requestId} with table schema`,
        command: `bak network replay --request-id ${requestId} --mode json --with-schema auto`,
        note: `Recent response mapped to ${mapping.tableId} with ${mapping.confidence} confidence.`
      });
      continue;
    }
    pushRecommendation({
      title: `Inspect ${source.source.label} inline JSON`,
      command: 'bak page freshness',
      note: `Inline JSON source mapped to ${mapping.tableId}; use freshness or capture commands to inspect it further.`
    });
  }

  if (recommendations.length === 0) {
    pushRecommendation({
      title: 'Check data freshness',
      command: 'bak page freshness',
      note: 'No strong data-source mapping was found yet.'
    });
  }
  return recommendations.slice(0, 6);
}

export function buildSourceMappingReport(input: SourceMappingInput): SourceMappingReport {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const windowAnalyses = buildWindowSources(input.windowSources);
  const inlineAnalyses = buildInlineJsonAnalyses(input.inlineJsonSources);
  const networkAnalyses = buildNetworkAnalyses(input.recentNetwork);
  const sourceAnalyses = [...windowAnalyses, ...inlineAnalyses, ...networkAnalyses];
  const sourceMappings = input.tables
    .flatMap((table) => sourceAnalyses.map((source) => scoreSourceMapping(table, source, now)))
    .filter((mapping): mapping is InspectPageDataSourceMapping => mapping !== null)
    .sort((left, right) => {
      const confidenceRank = { high: 0, medium: 1, low: 2 } as const;
      return (
        confidenceRank[left.confidence] - confidenceRank[right.confidence] ||
        left.tableId.localeCompare(right.tableId) ||
        left.sourceId.localeCompare(right.sourceId)
      );
    });
  return {
    dataSources: sourceAnalyses.map((analysis) => analysis.source),
    sourceMappings,
    recommendedNextActions: buildRecommendedNextActions(input.tables, sourceMappings, sourceAnalyses),
    sourceAnalyses
  };
}

function mapObjectRowToSchema(row: Record<string, unknown>, schema: TableSchema): Record<string, unknown> {
  const normalizedKeys = new Map(Object.keys(row).map((key) => [normalizeColumnName(key), key]));
  const mapped: Record<string, unknown> = {};
  for (const column of schema.columns) {
    const normalized = normalizeColumnName(column.label);
    const sourceKey = normalizedKeys.get(normalized);
    if (sourceKey) {
      mapped[column.label] = row[sourceKey];
    }
  }
  if (Object.keys(mapped).length > 0) {
    return mapped;
  }
  return { ...row };
}

export function selectReplaySchemaMatch(
  responseJson: unknown,
  tables: TableAnalysis[],
  options: { preferredSourceId?: string; mappings?: InspectPageDataSourceMapping[] } = {}
): ReplaySchemaMatch | null {
  const candidate = extractStructuredRows(responseJson);
  if (!candidate || candidate.rows.length === 0 || tables.length === 0) {
    return null;
  }

  const preferredTableId =
    options.preferredSourceId && options.mappings
      ? options.mappings.find((mapping) => mapping.sourceId === options.preferredSourceId && mapping.confidence !== 'low')?.tableId
      : undefined;
  const orderedTables = preferredTableId
    ? tables.slice().sort((left, right) => {
        if (left.table.id === preferredTableId) {
          return -1;
        }
        if (right.table.id === preferredTableId) {
          return 1;
        }
        return left.table.id.localeCompare(right.table.id);
      })
    : tables;

  const firstRow = candidate.rows[0];
  if (Array.isArray(firstRow)) {
    const matchingTable =
      orderedTables.find((table) => table.schema.columns.length === firstRow.length) ??
      orderedTables.find((table) => table.schema.columns.length > 0) ??
      null;
    if (!matchingTable) {
      return null;
    }
    return {
      table: matchingTable.table,
      schema: matchingTable.schema,
      mappedRows: candidate.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => {
          const mapped: Record<string, unknown> = {};
          matchingTable.schema.columns.forEach((column, index) => {
            mapped[column.label] = row[index];
          });
          return mapped;
        }),
      mappingSource: candidate.path
    };
  }

  if (firstRow && typeof firstRow === 'object') {
    const rowObject = firstRow as Record<string, unknown>;
    const rowKeys = new Set(Object.keys(rowObject).map(normalizeColumnName));
    const matchingEntry =
      orderedTables
        .map((table) => ({
          table,
          score: table.schema.columns.filter((column) => rowKeys.has(normalizeColumnName(column.label))).length
        }))
        .sort((left, right) => compareNumbers(right.score, left.score))[0] ?? null;
    if (!matchingEntry || matchingEntry.score <= 0) {
      return null;
    }
    const matchingTable = matchingEntry.table;
    return {
      table: matchingTable.table,
      schema: matchingTable.schema,
      mappedRows: candidate.rows
        .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row))
        .map((row) => mapObjectRowToSchema(row, matchingTable.schema)),
      mappingSource: candidate.path
    };
  }

  return null;
}

export function buildInspectPageDataResult(input: {
  suspiciousGlobals: string[];
  tables: TableHandle[];
  visibleTimestamps: string[];
  inlineTimestamps: string[];
  pageDataCandidates: InspectPageDataCandidateProbe[];
  recentNetwork: NetworkEntry[];
  tableAnalyses: TableAnalysis[];
  inlineJsonSources: InlineJsonInspectionSource[];
  now?: number;
}): Pick<InspectPageDataResult, 'dataSources' | 'sourceMappings' | 'recommendedNextActions'> {
  const report = buildSourceMappingReport({
    tables: input.tableAnalyses,
    windowSources: input.pageDataCandidates,
    inlineJsonSources: input.inlineJsonSources,
    recentNetwork: input.recentNetwork,
    now: input.now
  });
  return {
    dataSources: report.dataSources,
    sourceMappings: report.sourceMappings,
    recommendedNextActions: report.recommendedNextActions
  };
}

export function buildPageDataProbe(name: string, resolver: 'globalThis' | 'lexical', sample: unknown): InspectPageDataCandidateProbe {
  const timestamps = collectTimestampProbes(sample, name);
  return {
    name,
    resolver,
    sample: sampleValue(sample),
    sampleSize: estimateSampleSize(sample),
    schemaHint: inferSchemaHint(sample),
    lastObservedAt: latestTimestamp(timestamps),
    timestamps
  };
}
