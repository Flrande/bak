import { describe, expect, it } from 'vitest';
import type { ElementMapItem, Locator } from '@flrande/bak-protocol';
import { rankCandidates } from '../../packages/cli/src/memory/extract.js';

const elements: ElementMapItem[] = [
  {
    eid: 'eid_save',
    tag: 'button',
    role: 'button',
    name: '提交保存',
    text: '提交保存',
    bbox: { x: 10, y: 20, width: 80, height: 28 },
    selectors: { css: '#save-btn', text: '提交保存', aria: 'button:提交保存' },
    risk: 'high'
  },
  {
    eid: 'eid_cancel',
    tag: 'button',
    role: 'button',
    name: '取消',
    text: '取消',
    bbox: { x: 10, y: 60, width: 80, height: 28 },
    selectors: { css: '#cancel-btn', text: '取消', aria: 'button:取消' },
    risk: 'low'
  }
];

describe('rankCandidates', () => {
  it('prefers exact eid match', () => {
    const locators: Locator[] = [{ eid: 'eid_save' }, { text: '保存' }];
    const ranked = rankCandidates(elements, locators, 2);

    expect(ranked[0]?.eid).toBe('eid_save');
  });

  it('falls back to text similarity', () => {
    const locators: Locator[] = [{ text: '取消' }];
    const ranked = rankCandidates(elements, locators, 1);

    expect(ranked[0]?.eid).toBe('eid_cancel');
  });
});


