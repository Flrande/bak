import { describe, expect, it } from 'vitest';
import { buildNetworkEntryDerivedFields, networkEntryMatchesFilters, summarizeNetworkPayload } from '../../packages/extension/src/network-tools.js';

describe('network tools', () => {
  it('builds query and response previews from network entries', () => {
    const derived = buildNetworkEntryDerivedFields({
      url: 'https://api.example.test/feed?mode=historical&date=2026-03-25&limit=50',
      requestHeaders: {
        'content-type': 'application/json'
      },
      requestBodyPreview: undefined,
      requestBodyTruncated: false,
      contentType: 'application/json',
      responseBodyPreview: JSON.stringify({
        rows: [{ symbol: 'QQQ' }, { symbol: 'SPY' }],
        page: 1,
        limit: 50
      }),
      responseBodyTruncated: false
    });

    expect(derived.hostname).toBe('api.example.test');
    expect(derived.pathname).toBe('/feed');
    expect(derived.preview?.query).toContain('mode=historical');
    expect(derived.preview?.response).toBe('json rows(2) via rows');
  });

  it('matches the new domain, resourceType, kind, and sinceTs filters', () => {
    const matched = networkEntryMatchesFilters(
      {
        id: 'net_1',
        url: 'https://api.example.test/feed?mode=historical',
        method: 'GET',
        status: 200,
        ok: true,
        kind: 'fetch',
        ts: 500,
        durationMs: 12,
        resourceType: 'Fetch',
        hostname: 'api.example.test',
        pathname: '/feed'
      },
      {
        domain: 'example.test',
        resourceType: 'fetch',
        kind: 'fetch',
        sinceTs: 400
      }
    );

    expect(matched).toBe(true);
    expect(
      networkEntryMatchesFilters(
        {
          id: 'net_2',
          url: 'https://api.example.test/feed',
          method: 'GET',
          status: 200,
          ok: true,
          kind: 'fetch',
          ts: 300,
          durationMs: 12,
          resourceType: 'Fetch'
        },
        {
          sinceTs: 400
        }
      )
    ).toBe(false);
  });

  it('summarizes form and truncated text payloads', () => {
    expect(summarizeNetworkPayload('mode=latest&symbol=QQQ', 'application/x-www-form-urlencoded')).toContain('form:');
    expect(summarizeNetworkPayload('plain body preview', 'text/plain', true)).toContain('(truncated)');
  });
});
