import { describe, expect, it } from 'vitest';
import { hasPageGotoReuseOptions, selectReusableTab } from '../../packages/cli/src/page-goto-tools.js';

describe('page goto reuse tools', () => {
  it('detects when reuse options are enabled', () => {
    expect(hasPageGotoReuseOptions({})).toBe(false);
    expect(hasPageGotoReuseOptions({ reuseDomain: true })).toBe(true);
    expect(hasPageGotoReuseOptions({ reuseUrlContains: 'barchart.com/options' })).toBe(true);
  });

  it('prefers an active same-domain tab when reuse-domain is enabled', () => {
    const match = selectReusableTab(
      'https://www.barchart.com/options/unusual-activity/stocks',
      [
        { id: 1, url: 'https://www.barchart.com/options/overview/stocks', active: false },
        { id: 2, url: 'https://www.barchart.com/options/flow', active: true }
      ],
      { reuseDomain: true }
    );

    expect(match).toEqual(
      expect.objectContaining({
        tab: expect.objectContaining({ id: 2 }),
        matchedBy: 'domain'
      })
    );
  });

  it('requires both domain and substring when both reuse modes are supplied', () => {
    const match = selectReusableTab(
      'https://www.barchart.com/options/unusual-activity/stocks',
      [
        { id: 1, url: 'https://www.barchart.com/quotes/overview', active: true },
        { id: 2, url: 'https://www.barchart.com/options/flow', active: false }
      ],
      { reuseDomain: true, reuseUrlContains: 'barchart.com/options' }
    );

    expect(match?.tab.id).toBe(2);
    expect(match?.matchedBy).toBe('domain+url-contains');
  });
});
