import { describe, it, expect, vi } from 'vitest';
import {
  querySearchAnalytics,
  querySearchAnalyticsAll,
} from '../../src/collectors/search-console.js';
import type { TokenProvider } from '../../src/types.js';
import type { SearchAnalyticsAllRequest } from '../../src/collectors/search-console.js';
import { ApiError } from '../../src/types.js';

const auth: TokenProvider = { getToken: async () => 'test-token' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('querySearchAnalytics', () => {
  it('options.retries により 503 を再試行して成功する', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'unavailable' } }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          rows: [{ keys: ['sample query'], clicks: 1, impressions: 4, ctr: 0.25, position: 4 }],
        }),
      );

    const result = await querySearchAnalytics(
      auth,
      'sc-domain:example.com',
      { startDate: '2026-07-01', endDate: '2026-07-31', dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 1 },
    );

    expect(result.rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

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

function scPage(from: number, to: number) {
  return jsonResponse({
    rows: Array.from({ length: to - from }, (_, i) => ({
      keys: [`q-${from + i}`],
      clicks: 1,
      impressions: 1,
      ctr: 1,
      position: 1,
    })),
  });
}

function scBodyOf(fetchImpl: ReturnType<typeof vi.fn>, call: number) {
  const [, init] = fetchImpl.mock.calls[call] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const range = { startDate: '2026-07-01', endDate: '2026-07-31' };

describe('querySearchAnalyticsAll', () => {
  it('0 行の応答が返るまで startRow を進めて全行をまとめる', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scPage(0, 25000))
      .mockResolvedValueOnce(scPage(25000, 25003))
      .mockResolvedValueOnce(scPage(0, 0));

    const rows = await querySearchAnalyticsAll(
      auth,
      'sc-domain:example.com',
      { ...range, dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(rows).toHaveLength(25003);
    expect(rows.at(-1)?.keys).toEqual(['q-25002']);
    expect(scBodyOf(fetchImpl, 0)).toMatchObject({
      ...range,
      dimensions: ['query'],
      rowLimit: 25000,
      startRow: 0,
    });
    expect(scBodyOf(fetchImpl, 1)).toMatchObject({ rowLimit: 25000, startRow: 25000 });
    expect(scBodyOf(fetchImpl, 2)).toMatchObject({ rowLimit: 25000, startRow: 25003 });
  });

  it('データが無ければ 1 回叩いて空配列を返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}));

    const rows = await querySearchAnalyticsAll(
      auth,
      'sc-domain:example.com',
      { ...range, dimensions: ['page'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(rows).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('startRow を無視して行を返し続ける API でも無限ループせず ApiError にする', async () => {
    const fetchImpl = vi.fn(async () => scPage(0, 1));

    await expect(
      querySearchAnalyticsAll(
        auth,
        'sc-domain:example.com',
        { ...range, dimensions: ['query'] },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(101);
  });

  it('データを含むページがちょうど上限（100 ページ）でも、終端の空応答が来ればエラーにしない', async () => {
    const fullPage = JSON.stringify({
      rows: Array.from({ length: 25000 }, (_, i) => ({
        keys: [`q-${i}`],
        clicks: 1,
        impressions: 1,
        ctr: 1,
        position: 1,
      })),
    });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(calls <= 100 ? fullPage : '{}', { status: 200 });
    });

    const rows = await querySearchAnalyticsAll(
      auth,
      'sc-domain:example.com',
      { ...range, dimensions: ['query'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(rows).toHaveLength(2_500_000);
    expect(fetchImpl).toHaveBeenCalledTimes(101);
  }, 20_000);

  it('rowLimit / startRow は型で弾く', () => {
    // 複数行のリテラルでは型エラーがプロパティの行に出るので、directive はその直前に置く
    const withRowLimit: SearchAnalyticsAllRequest = {
      ...range,
      dimensions: [],
      // @ts-expect-error rowLimit は querySearchAnalyticsAll が制御する
      rowLimit: 10,
    };
    const withStartRow: SearchAnalyticsAllRequest = {
      ...range,
      dimensions: [],
      // @ts-expect-error startRow も同じ
      startRow: 10,
    };
    expect([withRowLimit, withStartRow]).toHaveLength(2);
  });
});
