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

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows).toEqual([
      { keys: ['sample query'], clicks: 1, impressions: 4, ctr: 0.25, position: 4 },
    ]);
  });

  it('データが無い期間は空配列を返す（rows キーごと無い応答）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ responseAggregationType: 'byProperty' }));

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: [] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows).toEqual([]);
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

describe('querySearchAnalytics: truncated 判定', () => {
  function rowsOf(
    count: number,
  ): { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] {
    return Array.from({ length: count }, (_, i) => ({
      keys: [`query-${i}`],
      clicks: 1,
      impressions: 1,
      ctr: 1,
      position: 1,
    }));
  }

  it('rowLimit 指定時、返った行数が一致したら true', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: rowsOf(5) }));

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'], rowLimit: 5 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('rowLimit 指定時、返った行数が rowLimit を下回れば false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: rowsOf(3) }));

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'], rowLimit: 5 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('rowLimit 未指定で API 既定値の 1000 行ちょうど返ったら true', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: rowsOf(1000) }));

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('空配列なら（rowLimit 未指定でも）false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ responseAggregationType: 'byProperty' }));

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
