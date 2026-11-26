import { describe, it, expect, vi } from 'vitest';
import {
  fetchGroupedCounts,
  eventParam,
  itemParam,
  NOT_SET,
  OTHER,
  MAX_DATE_RANGES,
  type GroupedCountsParams,
} from '../../src/collectors/ga4.js';
import { ApiError, type TokenProvider } from '../../src/types.js';

const auth: TokenProvider = { getToken: async () => 'test-token' };
const thisMonth = { name: 'current', startDate: '2026-07-01', endDate: '2026-07-31' };
const lastMonth = { name: 'previous', startDate: '2026-06-01', endDate: '2026-06-30' };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** dims / mets の配列から GA4 の応答を組み立てる。 */
function ga4Body(
  dimensionHeaders: string[],
  metricHeaders: string[],
  rows: [string[], string[]][],
  rowCount?: number,
) {
  return {
    dimensionHeaders: dimensionHeaders.map((name) => ({ name })),
    metricHeaders: metricHeaders.map((name) => ({ name })),
    rows: rows.map(([dims, mets]) => ({
      dimensionValues: dims.map((value) => ({ value })),
      metricValues: mets.map((value) => ({ value })),
    })),
    rowCount: rowCount ?? rows.length,
  };
}

function mockFetch(...bodies: unknown[]) {
  const queue = [...bodies];
  return vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(queue.shift()));
}

function requestBodyOf(fetchImpl: ReturnType<typeof mockFetch>, call = 0) {
  return JSON.parse(String(fetchImpl.mock.calls[call][1]?.body));
}

const viewAndClick: GroupedCountsParams = {
  dateRanges: [thisMonth],
  keys: [eventParam('item_id')],
  label: eventParam('item_title'),
  metrics: ['eventCount'],
  splitBy: 'eventName',
  filter: { dimension: 'eventName', values: ['sample_view', 'sample_click'] },
};

describe('eventParam / itemParam', () => {
  it('カスタムディメンション名を組み立てる', () => {
    expect(eventParam('item_id')).toBe('customEvent:item_id');
    expect(itemParam('item_color')).toBe('customItem:item_color');
  });
});

describe('fetchGroupedCounts', () => {
  it('キー・ラベル・列のディメンションと絞り込みを 1 本の問い合わせで送る', async () => {
    const fetchImpl = mockFetch(
      ga4Body(['customEvent:item_id', 'customEvent:item_title', 'eventName'], ['eventCount'], []),
    );

    await fetchGroupedCounts(auth, '123', viewAndClick, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = requestBodyOf(fetchImpl);
    expect(body.dateRanges).toEqual([thisMonth]);
    expect(body.dimensions).toEqual([
      { name: 'customEvent:item_id' },
      { name: 'customEvent:item_title' },
      { name: 'eventName' },
    ]);
    expect(body.metrics).toEqual([{ name: 'eventCount' }]);
    expect(body.dimensionFilter).toEqual({
      filter: {
        fieldName: 'eventName',
        // GA4 の既定は大文字小文字を区別しない。綴りの違う値で列が割れないよう区別させる。
        inListFilter: { values: ['sample_view', 'sample_click'], caseSensitive: true },
      },
    });
  });

  it('キーごとに列へ分けて足し合わせ、返らなかった列は 0 で埋める', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName'],
        ['eventCount'],
        [
          [['A1', 'Alpha', 'sample_view'], ['40']],
          [['A1', 'Alpha', 'sample_click'], ['3']],
          [['B2', 'Beta', 'sample_view'], ['12']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(auth, '123', viewAndClick, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.periods).toEqual(['current']);
    expect(result.columns).toEqual(['sample_view', 'sample_click']);
    expect(result.rows).toEqual([
      { keys: ['A1'], label: 'Alpha', counts: { current: { sample_view: 40, sample_click: 3 } } },
      { keys: ['B2'], label: 'Beta', counts: { current: { sample_view: 12, sample_click: 0 } } },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('同じキーに複数のラベルがあれば件数の多いほうを採り、(not set) は採らない', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName'],
        ['eventCount'],
        [
          [['A1', 'Old Name', 'sample_view'], ['5']],
          [['A1', 'New Name', 'sample_view'], ['30']],
          [['A1', NOT_SET, 'sample_view'], ['99']],
          [['C3', NOT_SET, 'sample_view'], ['7']],
          [['D4', 'Zeta', 'sample_view'], ['2']],
          [['D4', 'Eta', 'sample_view'], ['2']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(auth, '123', viewAndClick, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.rows.map((row) => [row.keys[0], row.label])).toEqual([
      ['A1', 'New Name'],
      ['C3', null],
      ['D4', 'Eta'],
    ]);
    // ラベルが (not set) の行も件数には含める。
    expect(result.rows[0].counts.current.sample_view).toBe(134);
  });

  it('キーが (not set) / (other) の行は rows から外して excluded に数える', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName'],
        ['eventCount'],
        [
          [['A1', 'Alpha', 'sample_view'], ['10']],
          [[NOT_SET, NOT_SET, 'sample_view'], ['4']],
          [[NOT_SET, NOT_SET, 'sample_click'], ['1']],
          [[OTHER, OTHER, 'sample_view'], ['6']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(auth, '123', viewAndClick, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.rows.map((row) => row.keys[0])).toEqual(['A1']);
    expect(result.excluded.notSet).toEqual({ current: { sample_view: 4, sample_click: 1 } });
    expect(result.excluded.other).toEqual({ current: { sample_view: 6, sample_click: 0 } });
  });

  it('(other) 行は列を増やさず、期間や列が (other) で分からない分は otherUnattributed に数える', async () => {
    const fetchImpl = mockFetch({
      ...ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName', 'dateRange'],
        ['eventCount'],
        [
          [['A1', 'Alpha', 'sample_view', 'current'], ['10']],
          [[OTHER, OTHER, 'sample_view', 'previous'], ['3']],
          [[OTHER, OTHER, OTHER, OTHER], ['7']],
          [['B2', 'Beta', OTHER, 'current'], ['2']],
        ],
      ),
      metadata: { dataLossFromOtherRow: true },
    });

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, dateRanges: [thisMonth, lastMonth] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.columns).toEqual(['sample_view', 'sample_click']);
    expect(result.rows.map((row) => row.keys[0])).toEqual(['A1']);
    expect(result.excluded.other).toEqual({
      current: { sample_view: 0, sample_click: 0 },
      previous: { sample_view: 3, sample_click: 0 },
    });
    expect(result.excluded.otherUnattributed).toEqual({ eventCount: 9 });
    expect(result.metadata.dataLossFromOtherRow).toBe(true);
  });

  it('キーが (not set) でも、列や期間が (other) の行は (other) として扱い、列を増やさず throw しない', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'eventName', 'dateRange'],
        ['eventCount'],
        [
          [['A1', 'sample_view', 'current'], ['5']],
          [[NOT_SET, OTHER, 'current'], ['2']],
          [[NOT_SET, 'sample_view', OTHER], ['4']],
          [[NOT_SET, 'sample_click', 'previous'], ['1']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, label: undefined, dateRanges: [thisMonth, lastMonth] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.columns).toEqual(['sample_view', 'sample_click']);
    expect(result.excluded.notSet).toEqual({
      current: { sample_view: 0, sample_click: 0 },
      previous: { sample_view: 0, sample_click: 1 },
    });
    expect(result.excluded.otherUnattributed).toEqual({ eventCount: 6 });
  });

  it('splitBy 無しでは otherUnattributed をメトリックごとに分ける', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['itemId', 'dateRange'],
        ['itemsViewed', 'itemsClickedInList'],
        [
          [
            ['SKU-1', 'current'],
            ['50', '4'],
          ],
          [
            [OTHER, OTHER],
            ['1000', '30'],
          ],
          [
            [OTHER, 'previous'],
            ['7', '1'],
          ],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      {
        dateRanges: [thisMonth, lastMonth],
        keys: ['itemId'],
        metrics: ['itemsViewed', 'itemsClickedInList'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.excluded.otherUnattributed).toEqual({
      itemsViewed: 1000,
      itemsClickedInList: 30,
    });
    expect(result.excluded.other.previous).toEqual({ itemsViewed: 7, itemsClickedInList: 1 });
  });

  it('複数期間でも excluded を期間ごとに分ける', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'eventName', 'dateRange'],
        ['eventCount'],
        [
          [[NOT_SET, 'sample_view', 'current'], ['4']],
          [[NOT_SET, 'sample_click', 'previous'], ['2']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, label: undefined, dateRanges: [thisMonth, lastMonth] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.excluded.notSet).toEqual({
      current: { sample_view: 4, sample_click: 0 },
      previous: { sample_view: 0, sample_click: 2 },
    });
  });

  it('ラベルは先頭の期間で件数の多い値を採り、先頭の期間に無ければ次の期間を見る', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName', 'dateRange'],
        ['eventCount'],
        [
          [['A1', 'Old Name', 'sample_view', 'previous'], ['1000']],
          [['A1', 'New Name', 'sample_view', 'current'], ['10']],
          [['B2', 'Only Before', 'sample_view', 'previous'], ['5']],
          [['B2', NOT_SET, 'sample_view', 'current'], ['3']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, dateRanges: [thisMonth, lastMonth] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows.map((row) => [row.keys[0], row.label])).toEqual([
      ['A1', 'New Name'],
      ['B2', 'Only Before'],
    ]);
  });

  it('splitBy の各列の件数をラベルの重みに足す', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName'],
        ['eventCount'],
        [
          [['A1', 'Viewed Name', 'sample_view'], ['3']],
          [['A1', 'Clicked Name', 'sample_click'], ['5']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(auth, '123', viewAndClick, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.rows[0].label).toBe('Clicked Name');
  });

  it('応答にキーやラベルのディメンションが無ければ ApiError', async () => {
    const fetchImpl = mockFetch(ga4Body(['eventName'], ['eventCount'], [[['sample_view'], ['1']]]));

    await expect(
      fetchGroupedCounts(auth, '123', viewAndClick, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/customEvent:item_id/);
  });

  it('応答の metadata を返す（無ければすべて false）', async () => {
    const withMeta = mockFetch({
      ...ga4Body(['customEvent:item_id', 'eventName'], ['eventCount'], []),
      metadata: { subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: '1' }] },
    });
    const withoutMeta = mockFetch(
      ga4Body(['customEvent:item_id', 'eventName'], ['eventCount'], []),
    );
    const params = { ...viewAndClick, label: undefined };

    const a = await fetchGroupedCounts(auth, '123', params, {
      fetchImpl: withMeta as unknown as typeof fetch,
    });
    const b = await fetchGroupedCounts(auth, '123', params, {
      fetchImpl: withoutMeta as unknown as typeof fetch,
    });

    expect(a.metadata).toEqual({
      dataLossFromOtherRow: false,
      subjectToThresholding: true,
      sampled: true,
    });
    expect(b.metadata).toEqual({
      dataLossFromOtherRow: false,
      subjectToThresholding: false,
      sampled: false,
    });
  });

  it('readonly な配列（as const）をそのまま渡せる', async () => {
    const fetchImpl = mockFetch(ga4Body(['customEvent:item_id', 'eventName'], ['eventCount'], []));
    const events = ['sample_view', 'sample_click'] as const;
    const keys = [eventParam('item_id')] as const;

    const result = await fetchGroupedCounts(
      auth,
      '123',
      {
        dateRanges: [thisMonth] as const,
        keys,
        metrics: ['eventCount'] as const,
        splitBy: 'eventName',
        filter: { dimension: 'eventName', values: events },
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.columns).toEqual(['sample_view', 'sample_click']);
  });

  it('複数の期間は dateRange 列で見分け、片方の期間に無いキーは 0 で埋める', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'customEvent:item_title', 'eventName', 'dateRange'],
        ['eventCount'],
        [
          [['A1', 'Alpha', 'sample_view', 'current'], ['40']],
          [['A1', 'Alpha', 'sample_view', 'previous'], ['25']],
          [['A1', 'Alpha', 'sample_click', 'previous'], ['2']],
          [['B2', 'Beta', 'sample_view', 'previous'], ['8']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, dateRanges: [thisMonth, lastMonth] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(requestBodyOf(fetchImpl).dateRanges).toEqual([thisMonth, lastMonth]);
    expect(result.periods).toEqual(['current', 'previous']);
    expect(result.rows).toEqual([
      {
        keys: ['A1'],
        label: 'Alpha',
        counts: {
          current: { sample_view: 40, sample_click: 0 },
          previous: { sample_view: 25, sample_click: 2 },
        },
      },
      {
        keys: ['B2'],
        label: 'Beta',
        counts: {
          current: { sample_view: 0, sample_click: 0 },
          previous: { sample_view: 8, sample_click: 0 },
        },
      },
    ]);
  });

  it('dateRange 列の位置に依存しない（列名で探す）', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['dateRange', 'customEvent:item_id', 'eventName'],
        ['eventCount'],
        [[['previous', 'A1', 'sample_view'], ['9']]],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, label: undefined, dateRanges: [thisMonth, lastMonth] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows[0].counts.previous.sample_view).toBe(9);
    expect(result.rows[0].label).toBeNull();
  });

  it('複数キーで分けられる（例: ページ × アイテム）', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['pagePath', 'customEvent:item_id', 'eventName'],
        ['eventCount'],
        [
          [['/b/', 'A1', 'sample_view'], ['3']],
          [['/a/', 'A1', 'sample_view'], ['5']],
          [['/a/', 'B2', 'sample_click'], ['1']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, label: undefined, keys: ['pagePath', eventParam('item_id')] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.rows.map((row) => row.keys)).toEqual([
      ['/a/', 'A1'],
      ['/a/', 'B2'],
      ['/b/', 'A1'],
    ]);
  });

  it('splitBy 無しならメトリックごとに列を作る（アイテムスコープの例）', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['itemId', 'itemName'],
        ['itemsViewed', 'itemsClickedInList'],
        [
          [
            ['SKU-1', 'Sample One'],
            ['50', '4'],
          ],
          [
            ['SKU-2', 'Sample Two'],
            ['20', '0'],
          ],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      {
        dateRanges: [thisMonth],
        keys: ['itemId'],
        label: 'itemName',
        metrics: ['itemsViewed', 'itemsClickedInList'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const body = requestBodyOf(fetchImpl);
    expect(body.metrics).toEqual([{ name: 'itemsViewed' }, { name: 'itemsClickedInList' }]);
    expect(body.dimensionFilter).toBeUndefined();
    expect(result.columns).toEqual(['itemsViewed', 'itemsClickedInList']);
    expect(result.rows[0]).toEqual({
      keys: ['SKU-1'],
      label: 'Sample One',
      counts: { current: { itemsViewed: 50, itemsClickedInList: 4 } },
    });
  });

  it('filter が splitBy と別のディメンションなら、列は応答に出た値の順', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'eventName'],
        ['eventCount'],
        [
          [['A1', 'sample_click'], ['1']],
          [['A1', 'sample_view'], ['8']],
        ],
      ),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      {
        dateRanges: [thisMonth],
        keys: [eventParam('item_id')],
        metrics: ['eventCount'],
        splitBy: 'eventName',
        filter: { dimension: 'pagePath', values: ['/a/'] },
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.columns).toEqual(['sample_click', 'sample_view']);
  });

  it('ページングで全件を取り、途中で空ページなら truncated を立てる', async () => {
    const headers = ['customEvent:item_id', 'eventName'];
    const fetchImpl = mockFetch(
      ga4Body(headers, ['eventCount'], [[['A1', 'sample_view'], ['1']]], 3),
      ga4Body(headers, ['eventCount'], [[['B2', 'sample_view'], ['2']]], 3),
      ga4Body(headers, ['eventCount'], [], 3),
    );

    const result = await fetchGroupedCounts(
      auth,
      '123',
      { ...viewAndClick, label: undefined },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('複数期間なのに応答に dateRange 列が無ければ ApiError', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'eventName'],
        ['eventCount'],
        [[['A1', 'sample_view'], ['1']]],
      ),
    );

    await expect(
      fetchGroupedCounts(
        auth,
        '123',
        { ...viewAndClick, label: undefined, dateRanges: [thisMonth, lastMonth] },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('応答に知らない期間名があれば ApiError', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'eventName', 'dateRange'],
        ['eventCount'],
        [[['A1', 'sample_view', 'date_range_0'], ['1']]],
      ),
    );

    await expect(
      fetchGroupedCounts(
        auth,
        '123',
        { ...viewAndClick, label: undefined, dateRanges: [thisMonth, lastMonth] },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/未知の期間/);
  });

  it('メトリック値が非負整数でなければ ApiError', async () => {
    const fetchImpl = mockFetch(
      ga4Body(
        ['customEvent:item_id', 'eventName'],
        ['eventCount'],
        [[['A1', 'sample_view'], ['1.5']]],
      ),
    );

    await expect(
      fetchGroupedCounts(
        auth,
        '123',
        { ...viewAndClick, label: undefined },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  describe('引数の検証（問い合わせる前に RangeError）', () => {
    const cases: [string, Partial<GroupedCountsParams>, RegExp][] = [
      ['期間が 0 個', { dateRanges: [] }, /1〜4/],
      [
        `期間が ${MAX_DATE_RANGES + 1} 個`,
        {
          dateRanges: Array.from({ length: MAX_DATE_RANGES + 1 }, (_, i) => ({
            ...thisMonth,
            name: `p${i}`,
          })),
        },
        /1〜4/,
      ],
      ['期間名が重複', { dateRanges: [thisMonth, { ...lastMonth, name: 'current' }] }, /重複/],
      [
        '期間名が予約済みの接頭辞',
        { dateRanges: [{ ...thisMonth, name: 'date_range_0' }] },
        /date_range_/,
      ],
      [
        '期間名が RESERVED_ で始まる',
        { dateRanges: [{ ...thisMonth, name: 'RESERVED_x' }] },
        /RESERVED_/,
      ],
      ['期間名が空', { dateRanges: [{ ...thisMonth, name: '' }] }, /空/],
      ['keys が空', { keys: [] }, /keys/],
      ['metrics が空', { metrics: [], splitBy: undefined }, /metrics/],
      ['splitBy なのに metrics が 2 つ', { metrics: ['eventCount', 'totalUsers'] }, /splitBy/],
      ['ディメンションが重複', { label: eventParam('item_id') }, /重複/],
      ['dateRange をキーに指定', { keys: ['dateRange'] }, /dateRange/],
      ['filter.values が空', { filter: { dimension: 'eventName', values: [] } }, /filter/],
      [
        'filter.values が重複',
        { filter: { dimension: 'eventName', values: ['a', 'a'] } },
        /filter.values/,
      ],
      ['filter.dimension が空', { filter: { dimension: '', values: ['a'] } }, /filter.dimension/],
      ['metrics が重複', { metrics: ['eventCount', 'eventCount'], splitBy: undefined }, /metrics/],
      ['metrics の要素が空', { metrics: [''] }, /metrics/],
      ['keys の要素が空', { keys: [''] }, /keys/],
      ['label が空', { label: '' }, /label/],
      ['splitBy が空', { splitBy: '' }, /splitBy/],
    ];

    it.each(cases)('%s', async (_title, override, message) => {
      const fetchImpl = mockFetch();
      await expect(
        fetchGroupedCounts(
          auth,
          '123',
          { ...viewAndClick, ...override },
          { fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toThrow(message);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
