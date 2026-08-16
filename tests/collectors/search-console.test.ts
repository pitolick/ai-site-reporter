import { describe, it, expect, vi } from 'vitest';
import { querySearchAnalytics } from '../../src/collectors/search-console.js';
import type { TokenProvider } from '../../src/types.js';

const auth: TokenProvider = { getToken: async () => 'test-token' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('querySearchAnalytics', () => {
  it('rows を返す', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ keys: ['sample query'], clicks: 1, impressions: 4, ctr: 0.25, position: 4 }],
        responseAggregationType: 'byProperty',
      }),
    );

    const rows = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(rows).toEqual([
      { keys: ['sample query'], clicks: 1, impressions: 4, ctr: 0.25, position: 4 },
    ]);
  });

  it('データが無い期間は空配列を返す（rows キーごと無い応答）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ responseAggregationType: 'byProperty' }));

    const rows = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: [] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(rows).toEqual([]);
  });

  it('siteUrl を URL エンコードして埋め込む', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: [] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/sites/sc-domain%3Aexample.com/searchAnalytics/query');
  });

  it('403 を握りつぶさず ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'User does not have sufficient permission.' } }, 403),
    );

    await expect(
      querySearchAnalytics(
        auth,
        'sc-domain:example.com',
        { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: [] },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/search-console 403/);
  });
});
