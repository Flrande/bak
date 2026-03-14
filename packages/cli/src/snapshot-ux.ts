import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  BBox,
  ElementMapItem,
  SnapshotActionSummary,
  SnapshotActionability,
  SnapshotDiff,
  SnapshotDiffChangeField,
  SnapshotFocusChange,
  SnapshotRecommendation,
  SnapshotRef,
  SnapshotSummaryItem
} from '@flrande/bak-protocol';

const MAX_SNAPSHOT_REFS = 40;
const MAX_SUMMARY_ITEMS = 10;
const MAX_RECOMMENDATIONS = 4;
const MAX_FOCUS_ITEMS = 5;
const BBOX_CHANGE_THRESHOLD_PX = 6;

interface ViewportSize {
  width: number;
  height: number;
}

interface DiffableSnapshotRef extends SnapshotRef {
  label: string;
  tag?: string;
  rank: number;
}

type SnapshotComparisonInput =
  | { comparedTo: string; elements: ElementMapItem[] }
  | { comparedTo: string; refs: SnapshotRef[] };

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function toPublicRef(ref: DiffableSnapshotRef): SnapshotRef {
  return {
    ref: ref.ref,
    eid: ref.eid,
    role: ref.role,
    name: ref.name,
    text: ref.text,
    risk: ref.risk,
    bbox: ref.bbox,
    selectors: ref.selectors,
    actionability: ref.actionability
  };
}

function buildLabel(value: { name: string; text: string; selectors: SnapshotRef['selectors']; role: string | null }): string {
  return (
    value.name.trim() ||
    value.text.trim() ||
    value.selectors.text?.trim() ||
    value.selectors.aria?.trim() ||
    value.selectors.css?.trim() ||
    value.role?.trim() ||
    'interactive element'
  );
}

function isInViewport(bbox: BBox, viewport: ViewportSize | null): boolean {
  if (!viewport) {
    return true;
  }
  const right = bbox.x + bbox.width;
  const bottom = bbox.y + bbox.height;
  return right > 0 && bottom > 0 && bbox.x < viewport.width && bbox.y < viewport.height;
}

function bboxCenterDistance(a: BBox, b: BBox): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function inferActionability(element: Pick<ElementMapItem, 'tag' | 'role'>): SnapshotActionability {
  const tag = element.tag.toLowerCase();
  const role = element.role?.toLowerCase() ?? null;

  if (tag === 'select' || role === 'combobox' || role === 'listbox') {
    return 'select';
  }
  if (
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch' ||
    role === 'menuitemcheckbox' ||
    role === 'menuitemradio'
  ) {
    return 'check';
  }
  if (tag === 'textarea' || tag === 'input' || role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
    return 'type';
  }
  if (
    tag === 'button' ||
    tag === 'a' ||
    role === 'button' ||
    role === 'link' ||
    role === 'menuitem' ||
    role === 'tab'
  ) {
    return 'click';
  }
  return 'unknown';
}

function sortInteractiveElements(
  elements: ElementMapItem[],
  viewport: ViewportSize | null
): ElementMapItem[] {
  return [...elements].sort((left, right) => {
    const leftInViewport = isInViewport(left.bbox, viewport);
    const rightInViewport = isInViewport(right.bbox, viewport);
    if (leftInViewport !== rightInViewport) {
      return leftInViewport ? -1 : 1;
    }
    const yDiff = Math.round(left.bbox.y) - Math.round(right.bbox.y);
    if (yDiff !== 0) {
      return yDiff;
    }
    const xDiff = Math.round(left.bbox.x) - Math.round(right.bbox.x);
    if (xDiff !== 0) {
      return xDiff;
    }
    const areaDiff = Math.round(left.bbox.width * left.bbox.height) - Math.round(right.bbox.width * right.bbox.height);
    if (areaDiff !== 0) {
      return areaDiff;
    }
    return left.eid.localeCompare(right.eid);
  });
}

function buildDiffableRefsFromElements(
  elements: ElementMapItem[],
  viewport: ViewportSize | null,
  limit = MAX_SNAPSHOT_REFS
): DiffableSnapshotRef[] {
  const sorted = sortInteractiveElements(elements, viewport).slice(0, limit);
  return sorted.map((element, index) => {
    const ref = `@e${index + 1}`;
    return {
      ref,
      eid: element.eid,
      role: element.role,
      name: element.name,
      text: element.text,
      risk: element.risk,
      bbox: element.bbox,
      selectors: element.selectors,
      actionability: inferActionability(element),
      label: buildLabel(element),
      tag: element.tag,
      rank: index
    };
  });
}

function buildDiffableRefsFromPublic(refs: SnapshotRef[]): DiffableSnapshotRef[] {
  return refs.map((ref, index) => ({
    ...ref,
    label: buildLabel(ref),
    rank: index
  }));
}

function toSummaryItem(ref: DiffableSnapshotRef): SnapshotSummaryItem {
  return {
    ref: ref.ref,
    eid: ref.eid,
    label: ref.label,
    role: ref.role,
    risk: ref.risk,
    actionability: ref.actionability
  };
}

function buildRecommendedActions(refs: DiffableSnapshotRef[]): SnapshotRecommendation[] {
  const recommendations: SnapshotRecommendation[] = [];
  const seen = new Set<string>();

  const addRecommendation = (ref: DiffableSnapshotRef | undefined, summary: string): void => {
    if (!ref || seen.has(ref.ref) || recommendations.length >= MAX_RECOMMENDATIONS) {
      return;
    }
    seen.add(ref.ref);
    recommendations.push({
      ref: ref.ref,
      actionability: ref.actionability,
      summary
    });
  };

  const primaryInput = refs.find((ref) => ref.actionability === 'type' || ref.actionability === 'select' || ref.actionability === 'check');
  const primaryClick = refs.find((ref) => ref.actionability === 'click' && ref.risk === 'low');
  const primaryHighRisk = refs.find((ref) => ref.risk === 'high');
  const fallbackClick = refs.find((ref) => ref.actionability === 'click');

  addRecommendation(
    primaryInput,
    primaryInput
      ? primaryInput.actionability === 'type'
        ? `Fill ${primaryInput.ref} before moving on.`
        : primaryInput.actionability === 'select'
          ? `Review the options on ${primaryInput.ref}.`
          : `Confirm the state of ${primaryInput.ref} before continuing.`
      : ''
  );
  addRecommendation(
    primaryClick ?? fallbackClick,
    primaryClick ?? fallbackClick ? `Review ${ (primaryClick ?? fallbackClick)!.ref } as the next clickable step.` : ''
  );
  addRecommendation(
    primaryHighRisk,
    primaryHighRisk ? `Treat ${primaryHighRisk.ref} as high-risk and verify intent before interacting.` : ''
  );

  for (const ref of refs) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) {
      break;
    }
    addRecommendation(ref, `Inspect ${ref.ref} if you need another likely interaction target.`);
  }

  return recommendations;
}

function scoreRefMatch(current: DiffableSnapshotRef, previous: DiffableSnapshotRef): number {
  let score = 0;
  if (current.eid === previous.eid) {
    return 100;
  }
  if (current.selectors.css && previous.selectors.css && current.selectors.css === previous.selectors.css) {
    score += 12;
  }
  if (current.role === previous.role && current.role !== null) {
    score += 3;
  }
  if (current.actionability === previous.actionability) {
    score += 3;
  }
  if (normalizeText(current.name) && normalizeText(current.name) === normalizeText(previous.name)) {
    score += 8;
  }
  if (normalizeText(current.text) && normalizeText(current.text) === normalizeText(previous.text)) {
    score += 5;
  }
  if (normalizeText(current.label) === normalizeText(previous.label)) {
    score += 4;
  }
  if (current.risk === previous.risk) {
    score += 1;
  }
  return score;
}

function buildRefState(ref: DiffableSnapshotRef) {
  return {
    name: ref.name,
    text: ref.text,
    risk: ref.risk,
    bbox: ref.bbox,
    actionability: ref.actionability
  };
}

function hasMeaningfulBBoxChange(previous: BBox, current: BBox): boolean {
  return (
    Math.abs(previous.x - current.x) > BBOX_CHANGE_THRESHOLD_PX ||
    Math.abs(previous.y - current.y) > BBOX_CHANGE_THRESHOLD_PX ||
    Math.abs(previous.width - current.width) > BBOX_CHANGE_THRESHOLD_PX ||
    Math.abs(previous.height - current.height) > BBOX_CHANGE_THRESHOLD_PX
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveViewport(elements: ElementMapItem[], viewport: ViewportSize | null): ViewportSize | null {
  if (viewport) {
    return viewport;
  }
  if (elements.length === 0) {
    return null;
  }
  const width = Math.max(
    1280,
    ...elements.map((element) => Math.ceil(Math.max(0, element.bbox.x + element.bbox.width)))
  );
  const height = Math.max(
    720,
    ...elements.map((element) => Math.ceil(Math.max(0, element.bbox.y + element.bbox.height)))
  );
  return { width, height };
}

export function parsePngDimensions(imageBase64: string): ViewportSize | null {
  try {
    const bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length < 24) {
      return null;
    }
    const signature = bytes.subarray(0, 8);
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!signature.equals(pngSignature)) {
      return null;
    }
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
    };
  } catch {
    return null;
  }
}

export function buildSnapshotPresentation(
  elements: ElementMapItem[],
  options: { viewport?: ViewportSize | null; limit?: number } = {}
): { refs: SnapshotRef[]; actionSummary: SnapshotActionSummary } {
  const rankedRefs = buildDiffableRefsFromElements(elements, options.viewport ?? null, options.limit ?? MAX_SNAPSHOT_REFS);

  const clickable = rankedRefs
    .filter((ref) => ref.actionability === 'click')
    .slice(0, MAX_SUMMARY_ITEMS)
    .map(toSummaryItem);
  const inputs = rankedRefs
    .filter((ref) => ref.actionability === 'type' || ref.actionability === 'select' || ref.actionability === 'check')
    .slice(0, MAX_SUMMARY_ITEMS)
    .map(toSummaryItem);
  const highRisk = rankedRefs.filter((ref) => ref.risk === 'high').slice(0, MAX_SUMMARY_ITEMS).map(toSummaryItem);

  return {
    refs: rankedRefs.map(toPublicRef),
    actionSummary: {
      clickable,
      inputs,
      highRisk,
      recommendedNextActions: buildRecommendedActions(rankedRefs)
    }
  };
}

export function renderAnnotatedSnapshotSvg(
  imageBase64: string,
  refs: SnapshotRef[],
  viewport: ViewportSize | null
): string {
  const resolvedViewport = resolveViewport(refs.map((ref) => ({
    eid: ref.eid,
    tag: 'interactive',
    role: ref.role,
    name: ref.name,
    text: ref.text,
    bbox: ref.bbox,
    selectors: ref.selectors,
    risk: ref.risk
  })), viewport);
  const width = resolvedViewport?.width ?? 1280;
  const height = resolvedViewport?.height ?? 720;

  const overlays = refs.map((ref) => {
    const stroke = ref.risk === 'high' ? '#d83b01' : '#1a5fb4';
    const labelWidth = Math.max(34, 12 + ref.ref.length * 8);
    const labelX = Math.max(0, Math.min(width - labelWidth, Math.round(ref.bbox.x)));
    const labelY = ref.bbox.y > 22 ? Math.round(ref.bbox.y - 22) : Math.round(ref.bbox.y + 4);
    return [
      `<rect x="${ref.bbox.x.toFixed(1)}" y="${ref.bbox.y.toFixed(1)}" width="${ref.bbox.width.toFixed(1)}" height="${ref.bbox.height.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="2" rx="4" />`,
      `<rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="18" fill="${stroke}" rx="4" />`,
      `<text x="${labelX + 6}" y="${labelY + 13}" fill="#ffffff">${escapeXml(ref.ref)}</text>`
    ].join('');
  }).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<style>text{font-family:Consolas,Menlo,monospace;font-size:12px;font-weight:700}</style>',
    `<image href="data:image/png;base64,${imageBase64}" x="0" y="0" width="${width}" height="${height}" />`,
    overlays,
    '</svg>'
  ].join('');
}

function resolveLinkedSnapshotPath(basePath: string, linkedPath: string): string {
  return isAbsolute(linkedPath) ? linkedPath : resolve(dirname(basePath), linkedPath);
}

function parseSnapshotComparisonInput(parsed: unknown, comparedTo: string): SnapshotComparisonInput {
  if (Array.isArray(parsed)) {
    return {
      comparedTo,
      elements: parsed as ElementMapItem[]
    };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.elements)) {
      return {
        comparedTo,
        elements: record.elements as ElementMapItem[]
      };
    }
    if (Array.isArray(record.refs)) {
      return {
        comparedTo,
        refs: record.refs as SnapshotRef[]
      };
    }
    if (typeof record.elementsPath === 'string') {
      const linkedPath = resolveLinkedSnapshotPath(comparedTo, record.elementsPath);
      return parseSnapshotComparisonInput(JSON.parse(readFileSync(linkedPath, 'utf8')) as unknown, linkedPath);
    }
    if (typeof record.snapshot === 'object' && record.snapshot !== null) {
      return parseSnapshotComparisonInput(record.snapshot, comparedTo);
    }
  }
  throw new Error(`Unsupported snapshot diff payload at ${comparedTo}`);
}

export function readSnapshotComparisonInput(diffWith: string): SnapshotComparisonInput {
  const comparedTo = resolve(diffWith);
  const parsed = JSON.parse(readFileSync(comparedTo, 'utf8')) as unknown;
  return parseSnapshotComparisonInput(parsed, comparedTo);
}

export function buildSnapshotDiff(
  currentRefs: SnapshotRef[],
  previousInput: SnapshotComparisonInput
): SnapshotDiff {
  const current = buildDiffableRefsFromPublic(currentRefs);
  const previous =
    'elements' in previousInput
      ? buildDiffableRefsFromElements(previousInput.elements, null, MAX_SNAPSHOT_REFS)
      : buildDiffableRefsFromPublic(previousInput.refs);

  const previousByEid = new Map(previous.map((ref) => [ref.eid, ref]));
  const previousUnused = new Set(previous.map((ref) => ref.eid));
  const matchedPairs: Array<{ current: DiffableSnapshotRef; previous: DiffableSnapshotRef }> = [];
  const addedRefs: SnapshotRef[] = [];

  for (const currentRef of current) {
    let matched = previousByEid.get(currentRef.eid);
    if (matched && !previousUnused.has(matched.eid)) {
      matched = undefined;
    }
    if (!matched) {
      const candidates = previous
        .filter((candidate) => previousUnused.has(candidate.eid))
        .map((candidate) => ({
          ref: candidate,
          score: scoreRefMatch(currentRef, candidate),
          distance: bboxCenterDistance(currentRef.bbox, candidate.bbox)
        }))
        .filter((candidate) => candidate.score >= 8)
        .sort((left, right) => right.score - left.score || left.distance - right.distance);
      matched = candidates[0]?.ref;
    }

    if (!matched) {
      addedRefs.push(toPublicRef(currentRef));
      continue;
    }

    previousUnused.delete(matched.eid);
    matchedPairs.push({ current: currentRef, previous: matched });
  }

  const removedRefs = previous.filter((ref) => previousUnused.has(ref.eid)).map(toPublicRef);
  const changedRefs = matchedPairs
    .map(({ current: currentRef, previous: previousRef }) => {
      const changes: SnapshotDiffChangeField[] = [];
      if (normalizeText(currentRef.name) !== normalizeText(previousRef.name)) {
        changes.push('name');
      }
      if (normalizeText(currentRef.text) !== normalizeText(previousRef.text)) {
        changes.push('text');
      }
      if (currentRef.risk !== previousRef.risk) {
        changes.push('risk');
      }
      if (currentRef.actionability !== previousRef.actionability) {
        changes.push('actionability');
      }
      if (hasMeaningfulBBoxChange(previousRef.bbox, currentRef.bbox)) {
        changes.push('bbox');
      }
      if (changes.length === 0) {
        return null;
      }
      return {
        ref: currentRef.ref,
        previousRef: previousRef.ref,
        eid: currentRef.eid,
        previousEid: previousRef.eid,
        label: currentRef.label,
        changes,
        before: buildRefState(previousRef),
        after: buildRefState(currentRef)
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  const previousTop = previous.slice(0, MAX_FOCUS_ITEMS);
  const currentTop = current.slice(0, MAX_FOCUS_ITEMS);
  const previousTopByEid = new Map(previousTop.map((ref, index) => [ref.eid, { ref, index }]));
  const currentTopByEid = new Map(currentTop.map((ref, index) => [ref.eid, { ref, index }]));
  const focusChanges: SnapshotFocusChange[] = [];

  for (const [eid, { ref, index }] of currentTopByEid.entries()) {
    const previousMatch = previousTopByEid.get(eid)
      ?? matchedPairs
        .map((pair) => ({ pair, previousIndex: previousTop.findIndex((candidate) => candidate.eid === pair.previous.eid) }))
        .find((entry) => entry.pair.current.eid === eid && entry.previousIndex >= 0);
    if (!previousMatch) {
      focusChanges.push({
        type: 'entered',
        ref: ref.ref,
        previousRef: null,
        eid,
        label: ref.label,
        previousRank: null,
        currentRank: index
      });
      continue;
    }
    const previousIndex = 'index' in previousMatch ? previousMatch.index : previousMatch.previousIndex;
    const previousRef = 'ref' in previousMatch ? previousMatch.ref : previousMatch.pair.previous;
    if (previousIndex !== index) {
      focusChanges.push({
        type: 'moved',
        ref: ref.ref,
        previousRef: previousRef.ref,
        eid,
        label: ref.label,
        previousRank: previousIndex,
        currentRank: index
      });
    }
  }

  for (const [eid, { ref, index }] of previousTopByEid.entries()) {
    const currentMatch = currentTopByEid.get(eid)
      ?? matchedPairs
        .map((pair) => ({ pair, currentIndex: currentTop.findIndex((candidate) => candidate.eid === pair.current.eid) }))
        .find((entry) => entry.pair.previous.eid === eid && entry.currentIndex >= 0);
    if (currentMatch) {
      continue;
    }
    focusChanges.push({
      type: 'left',
      ref: null,
      previousRef: ref.ref,
      eid,
      label: ref.label,
      previousRank: index,
      currentRank: null
    });
  }

  return {
    comparedTo: previousInput.comparedTo,
    addedRefs,
    removedRefs,
    changedRefs,
    focusChanges,
    summary: {
      added: addedRefs.length,
      removed: removedRefs.length,
      changed: changedRefs.length,
      focusChanged: focusChanges.length
    }
  };
}
