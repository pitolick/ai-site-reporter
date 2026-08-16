import { describe, it, expect, vi } from 'vitest';
import {
  runReport,
  fetchEventCounts,
  fetchParameterBreakdown,
  NOT_SET,
} from '../../src/collectors/ga4.js';
import type { TokenProvider } from '../../src/types.js';

const auth: TokenProvider = { getToken: async () => 'test-token' };
const dateRange = { startDate: '2026-07-01', endDate: '2026-07-31' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runReport', () => {
  it('応答を正規化して返す', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        dimensionHeaders: [{ name: 'eventName' }],
        metricHeaders: [{ name: 'eventCount' }],
        rows: [{ dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '61' }] }],
        rowCount: 1,
      }),
    );

    const report = await runReport(
      auth,
      '123',
      { dateRanges: [dateRange] },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(report.dimensionHeaders).toEqual(['eventName']);
    expect(report.metricHeaders).toEqual(['eventCount']);
    expect(report.rows).toEqual([{ dimensions: ['page_view'], metrics: ['61'] }]);
    expect(report.rowCount).toBe(1);
  });

  it('rows が無い応答を空配列として扱う', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ dimensionHeaders: [], metricHeaders: [] }));

    const report = await runReport(
      auth,
      '123',
      { dateRanges: [dateRange] },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(report.rows).toEqual([]);
    expect(report.rowCount).toBe(0);
  });

  it('Bearer トークンを付けて propertyId のエンドポイントを叩く', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await runReport(
      auth,
      '123456789',
      { dateRanges: [dateRange] },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/properties/123456789:runReport');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });

  it('400 を握りつぶさず ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Field customEvent:nope is not a valid dimension.' } }, 400),
    );

    await expect(
      runReport(
        auth,
        '123',
        { dateRanges: [dateRange] },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/ga4 400.*not a valid dimension/s);
  });

  it('非 JSON のエラー応答（プロキシの 502 HTML 等）でも SyntaxError ではなく ApiError を投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );

    await expect(
      runReport(
        auth,
        '123',
        { dateRanges: [dateRange] },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ name: 'ApiError', api: 'ga4', status: 502 });
  });
});

describe('fetchEventCounts', () => {
  it('イベント名と件数の配列を返す', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        dimensionHeaders: [{ name: 'eventName' }],
        metricHeaders: [{ name: 'eventCount' }],
        rows: [
          { dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '61' }] },
          { dimensionValues: [{ value: 'purchase_intent' }], metricValues: [{ value: '8' }] },
        ],
        rowCount: 2,
      }),
    );

    const counts = await fetchEventCounts(
      auth,
      '123',
      { dateRange },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(counts).toEqual([
      { eventName: 'page_view', count: 61 },
      { eventName: 'purchase_intent', count: 8 },
    ]);
  });

  it('eventNames を渡すと dimensionFilter で絞り込む', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await fetchEventCounts(
      auth,
      '123',
      { dateRange, eventNames: ['alpha', 'beta'] },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.dimensionFilter.filter.inListFilter.values).toEqual(['alpha', 'beta']);
  });

  it('eventNames を渡さないと dimensionFilter を付けない', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await fetchEventCounts(
      auth,
      '123',
      { dateRange },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.dimensionFilter).toBeUndefined();
  });

  it('limit を渡さないと 200 を既定値にする', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await fetchEventCounts(
      auth,
      '123',
      { dateRange },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.limit).toBe(200);
  });

  it('limit を渡すと request に反映する', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await fetchEventCounts(
      auth,
      '123',
      { dateRange, limit: 50 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.limit).toBe(50);
  });

  it('返らなかったイベントは 0 件として補完する', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'alpha' }], metricValues: [{ value: '3' }] }],
        rowCount: 1,
      }),
    );

    const counts = await fetchEventCounts(
      auth,
      '123',
      { dateRange, eventNames: ['alpha', 'beta'] },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(counts).toEqual([
      { eventName: 'alpha', count: 3 },
      { eventName: 'beta', count: 0 },
    ]);
  });

  it('rowCount が返った行数より大きい（limit で切り詰められた）ときは捏造したゼロを返さず ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'alpha' }], metricValues: [{ value: '3' }] }],
        // GA4 の実応答: limit で切られた rows と無関係に総マッチ行数が返る。
        rowCount: 500,
      }),
    );

    await expect(
      fetchEventCounts(
        auth,
        '123',
        { dateRange, eventNames: ['alpha', 'beta'] },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ name: 'ApiError', api: 'ga4', status: 200 });
  });

  it('メトリック値が数値でない文字列なら ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [
          { dimensionValues: [{ value: 'alpha' }], metricValues: [{ value: 'not-a-number' }] },
        ],
        rowCount: 1,
      }),
    );

    await expect(
      fetchEventCounts(
        auth,
        '123',
        { dateRange },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      api: 'ga4',
      status: 200,
      message: /メトリック値は非負整数/,
    });
  });

  it('メトリック値が欠損なら ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'alpha' }], metricValues: [{ value: '' }] }],
        rowCount: 1,
      }),
    );

    await expect(
      fetchEventCounts(
        auth,
        '123',
        { dateRange },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      api: 'ga4',
      status: 200,
      message: /メトリック値が欠損/,
    });
  });
});

describe('fetchParameterBreakdown', () => {
  it('(not set) の件数と率を計算する', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [
          { dimensionValues: [{ value: 'store-a' }], metricValues: [{ value: '3' }] },
          { dimensionValues: [{ value: NOT_SET }], metricValues: [{ value: '1' }] },
        ],
        rowCount: 2,
      }),
    );

    const result = await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.total).toBe(4);
    expect(result.notSetCount).toBe(1);
    expect(result.notSetRate).toBeCloseTo(0.25);
    expect(result.rows).toEqual([
      { value: 'store-a', count: 3 },
      { value: NOT_SET, count: 1 },
    ]);
  });

  it('全件が (not set) なら率は 1', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: NOT_SET }], metricValues: [{ value: '20' }] }],
        rowCount: 1,
      }),
    );

    const result = await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.notSetRate).toBe(1);
  });

  it('データが 0 件なら率は 0（NaN にしない）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [], rowCount: 0 }));

    const result = await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.total).toBe(0);
    expect(result.notSetRate).toBe(0);
  });

  it('customEvent 接頭辞を付けてディメンションを指定する', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [] }));

    await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.dimensions).toEqual([{ name: 'customEvent:store' }]);
    expect(body.dimensionFilter.filter.stringFilter.value).toBe('alpha');
  });

  it('limit を渡さないと 200 を既定値にする', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [], rowCount: 0 }));

    await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.limit).toBe(200);
  });

  it('limit を渡すと request に反映する', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [], rowCount: 0 }));

    await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store', limit: 50 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.limit).toBe(50);
  });

  it('rowCount が rows.length を超えると truncated が true になり分母の切り詰めが分かる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'store-a' }], metricValues: [{ value: '3' }] }],
        // GA4 の実応答: limit で切られた rows と無関係に総マッチ行数が返る。
        rowCount: 1500,
      }),
    );

    const result = await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rowCount).toBe(1500);
    expect(result.truncated).toBe(true);
  });

  it('rowCount が rows.length と等しければ truncated は false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'store-a' }], metricValues: [{ value: '3' }] }],
        rowCount: 1,
      }),
    );

    const result = await fetchParameterBreakdown(
      auth,
      '123',
      { dateRange, eventName: 'alpha', parameter: 'store' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('メトリック値が数値でない文字列なら ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'store-a' }], metricValues: [{ value: 'invalid' }] }],
        rowCount: 1,
      }),
    );

    await expect(
      fetchParameterBreakdown(
        auth,
        '123',
        { dateRange, eventName: 'alpha', parameter: 'store' },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      api: 'ga4',
      status: 200,
      message: /メトリック値は非負整数/,
    });
  });

  it('メトリック値が欠損なら ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        rows: [{ dimensionValues: [{ value: 'store-a' }], metricValues: [] }],
        rowCount: 1,
      }),
    );

    await expect(
      fetchParameterBreakdown(
        auth,
        '123',
        { dateRange, eventName: 'alpha', parameter: 'store' },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      api: 'ga4',
      status: 200,
      message: /メトリック値が欠損/,
    });
  });
});
