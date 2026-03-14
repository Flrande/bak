import { describe, expect, it } from 'vitest';
import type { ElementMapItem } from '@flrande/bak-protocol';
import {
  buildSnapshotDiff,
  buildSnapshotPresentation,
  inferActionability
} from '../../packages/cli/src/snapshot-ux.js';

function element(
  overrides: Partial<ElementMapItem> & Pick<ElementMapItem, 'eid' | 'tag' | 'bbox'>
): ElementMapItem {
  return {
    eid: overrides.eid,
    tag: overrides.tag,
    role: overrides.role ?? null,
    name: overrides.name ?? '',
    text: overrides.text ?? '',
    visible: overrides.visible ?? true,
    enabled: overrides.enabled ?? true,
    bbox: overrides.bbox,
    selectors: overrides.selectors ?? {
      css: `#${overrides.eid}`,
      xpath: null,
      text: overrides.text ?? null,
      aria: overrides.name ? `${overrides.tag} "${overrides.name}"` : null
    },
    risk: overrides.risk ?? 'low'
  };
}

describe('snapshot UX helpers', () => {
  it('orders refs by viewport priority and stable geometry sorting', () => {
    const presentation = buildSnapshotPresentation(
      [
        element({
          eid: 'offscreen',
          tag: 'button',
          role: 'button',
          name: 'Offscreen',
          text: 'Offscreen',
          bbox: { x: 1800, y: 10, width: 90, height: 32 }
        }),
        element({
          eid: 'lower',
          tag: 'button',
          role: 'button',
          name: 'Lower',
          text: 'Lower',
          bbox: { x: 40, y: 160, width: 90, height: 32 }
        }),
        element({
          eid: 'upper',
          tag: 'button',
          role: 'button',
          name: 'Upper',
          text: 'Upper',
          bbox: { x: 12, y: 24, width: 90, height: 32 }
        })
      ],
      {
        viewport: { width: 1280, height: 720 }
      }
    );

    expect(presentation.refs.map((ref) => [ref.ref, ref.eid])).toEqual([
      ['@e1', 'upper'],
      ['@e2', 'lower'],
      ['@e3', 'offscreen']
    ]);
  });

  it('infers actionability for common interactive controls', () => {
    expect(inferActionability({ tag: 'button', role: 'button' })).toBe('click');
    expect(inferActionability({ tag: 'a', role: 'link' })).toBe('click');
    expect(inferActionability({ tag: 'input', role: 'textbox' })).toBe('type');
    expect(inferActionability({ tag: 'select', role: 'combobox' })).toBe('select');
    expect(inferActionability({ tag: 'input', role: 'checkbox' })).toBe('check');
    expect(inferActionability({ tag: 'div', role: null })).toBe('unknown');
  });

  it('surfaces high-risk candidates in the action summary', () => {
    const presentation = buildSnapshotPresentation([
      element({
        eid: 'safe-save',
        tag: 'button',
        role: 'button',
        name: 'Save draft',
        text: 'Save draft',
        bbox: { x: 16, y: 20, width: 110, height: 36 }
      }),
      element({
        eid: 'danger-delete',
        tag: 'button',
        role: 'button',
        name: 'Delete record',
        text: 'Delete',
        bbox: { x: 16, y: 72, width: 130, height: 36 },
        risk: 'high'
      })
    ]);

    expect(presentation.actionSummary.highRisk).toHaveLength(1);
    expect(presentation.actionSummary.highRisk[0]).toMatchObject({
      ref: '@e2',
      eid: 'danger-delete',
      actionability: 'click',
      risk: 'high'
    });
  });

  it('builds structured diffs with added, removed, changed, and focus changes', () => {
    const previousElements = [
      element({
        eid: 'cancel-old',
        tag: 'button',
        role: 'button',
        name: 'Cancel',
        text: 'Cancel',
        bbox: { x: 12, y: 16, width: 90, height: 32 },
        selectors: { css: '#cancel', xpath: null, text: 'Cancel', aria: 'button "Cancel"' }
      }),
      element({
        eid: 'save-old',
        tag: 'button',
        role: 'button',
        name: 'Save draft',
        text: 'Save draft',
        bbox: { x: 12, y: 72, width: 100, height: 32 },
        selectors: { css: '#save', xpath: null, text: 'Save draft', aria: 'button "Save draft"' }
      })
    ];
    const currentRefs = buildSnapshotPresentation([
      element({
        eid: 'save-new',
        tag: 'button',
        role: 'button',
        name: 'Save',
        text: 'Save',
        bbox: { x: 12, y: 16, width: 120, height: 40 },
        selectors: { css: '#save', xpath: null, text: 'Save', aria: 'button "Save"' }
      }),
      element({
        eid: 'search-new',
        tag: 'input',
        role: 'textbox',
        name: 'Search',
        text: '',
        bbox: { x: 12, y: 72, width: 220, height: 36 },
        selectors: { css: '#search', xpath: null, text: null, aria: 'textbox "Search"' }
      })
    ]).refs;

    const diff = buildSnapshotDiff(currentRefs, {
      comparedTo: 'previous-elements.json',
      elements: previousElements
    });

    expect(diff.summary).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      focusChanged: 3
    });
    expect(diff.addedRefs.map((ref) => ref.eid)).toEqual(['search-new']);
    expect(diff.removedRefs.map((ref) => ref.eid)).toEqual(['cancel-old']);
    expect(diff.changedRefs[0]).toMatchObject({
      eid: 'save-new',
      previousEid: 'save-old'
    });
    expect(diff.changedRefs[0].changes).toEqual(expect.arrayContaining(['name', 'text', 'bbox']));
    expect(diff.focusChanges.map((change) => change.type).sort()).toEqual(['entered', 'left', 'moved']);
  });
});
