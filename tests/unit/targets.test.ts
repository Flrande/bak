import { describe, expect, it } from 'vitest';
import { buildTargetCandidates } from '../../packages/cli/src/memory/extract.js';

describe('buildTargetCandidates', () => {
  it('keeps locator priority eid -> role/name -> text -> css', () => {
    const candidates = buildTargetCandidates({
      eid: 'eid_1',
      role: 'button',
      name: 'Save',
      text: '保存',
      css: '#save-btn'
    });

    expect(candidates[0]).toEqual({ eid: 'eid_1' });
    expect(candidates[1]).toEqual({ role: 'button', name: 'Save' });
    expect(candidates[2]).toEqual({ text: '保存' });
    expect(candidates[3]).toEqual({ css: '#save-btn' });
  });
});
