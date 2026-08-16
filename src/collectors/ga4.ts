import { fetchJson, resolveFetch } from '../http.js';
import { ApiError } from '../types.js';
import type { DateRange, HttpOptions, TokenProvider } from '../types.js';

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/** GA4 が値の無いディメンションに返す文字列。行が落ちるのではなくこの値の行が返る。 */
export const NOT_SET = '(not set)';

/**
 * GA4 のメトリック値（文字列で返される）を有限の非負整数としてパースする。
 * 数値以外の文字列や負数、NaN が渡された場合は ApiError を throw する。
 */
function parseMetricCount(metricValue: string | undefined, source: string): number {
  if (metricValue === undefined || metricValue === '') {
    throw new ApiError('ga4', 200, `${source}: メトリック値が欠損しています`);
  }

  const num = Number(metricValue);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new ApiError(
      'ga4',
      200,
      `${source}: メトリック値は非負整数である必要があります（値: ${metricValue}）`,
    );
  }

  return num;
}

export interface Ga4Row {
  dimensions: string[];
  metrics: string[];
}

export interface Ga4Report {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Ga4Row[];
  rowCount: number;
}

interface RawGa4Response {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
}

/**
 * GA4 Data API の runReport をそのまま呼ぶ薄いラッパ。
 * KPI の問い合わせ形は無数にあるため、request は呼び出し側が組み立てる。
 */
export async function runReport(
  auth: TokenProvider,
  propertyId: string,
  request: Record<string, unknown>,
  options: HttpOptions = {},
): Promise<Ga4Report> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  const token = await auth.getToken([GA4_SCOPE]);

  const { body } = await fetchJson<RawGa4Response>(
    'ga4',
    fetchImpl,
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
  );

  return {
    dimensionHeaders: (body.dimensionHeaders ?? []).map((d) => d.name),
    metricHeaders: (body.metricHeaders ?? []).map((m) => m.name),
    rows: (body.rows ?? []).map((row) => ({
      dimensions: (row.dimensionValues ?? []).map((v) => v.value),
      metrics: (row.metricValues ?? []).map((v) => v.value),
    })),
    rowCount: body.rowCount ?? (body.rows ?? []).length,
  };
}

export interface EventCount {
  eventName: string;
  count: number;
}

/**
 * イベント名別の発生件数。eventNames を渡すと絞り込み、
 * **返らなかったイベントは 0 件として補完する**（「0 件だった」を呼び出し側が判定できるようにするため）。
 *
 * GA4 の応答は `limit`（既定 200）件までしか返らない。応答が `limit` で
 * 切り詰められていた場合（`rowCount` が返った行数より大きい場合）、返らなかった
 * イベントを本物の 0 件と区別できず「捏造したゼロ」になってしまうため、
 * 補完はせず `ApiError` を throw する（切り詰められたイベント件数クエリに
 * 正しい答えは無い）。取りこぼしが問題になる規模のプロパティでは `limit` を
 * 引き上げるか `eventNames` を絞ること。
 */
export async function fetchEventCounts(
  auth: TokenProvider,
  propertyId: string,
  params: { dateRange: DateRange; eventNames?: string[]; limit?: number },
  options: HttpOptions = {},
): Promise<EventCount[]> {
  const request: Record<string, unknown> = {
    dateRanges: [params.dateRange],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    limit: params.limit ?? 200,
  };
  if (params.eventNames?.length) {
    request.dimensionFilter = {
      filter: { fieldName: 'eventName', inListFilter: { values: params.eventNames } },
    };
  }

  const report = await runReport(auth, propertyId, request, options);
  if (report.rowCount > report.rows.length) {
    throw new ApiError(
      'ga4',
      200,
      `イベント件数の応答が limit で切り詰められています（rowCount=${report.rowCount}, rows=${report.rows.length}）。切り詰められたイベント件数クエリに正しい答えはないため、返らなかったイベントを 0 件として補完せず throw します。limit を上げるか eventNames を絞ってください。`,
    );
  }
  const found = new Map(
    report.rows.map((row) => [
      row.dimensions[0],
      parseMetricCount(row.metrics[0], `fetchEventCounts: eventName=${row.dimensions[0]}`),
    ]),
  );

  if (!params.eventNames?.length) {
    return [...found].map(([eventName, count]) => ({ eventName, count }));
  }
  return params.eventNames.map((eventName) => ({
    eventName,
    count: found.get(eventName) ?? 0,
  }));
}

export interface ParameterBreakdown {
  rows: { value: string; count: number }[];
  total: number;
  notSetCount: number;
  /** total が 0 のときは 0 を返す（NaN にしない）。 */
  notSetRate: number;
  /** GA4 が返した総マッチ行数（`limit` とは独立。`rows.length` より大きいことがある）。 */
  rowCount: number;
  /**
   * `rows.length < rowCount`。true のときは `limit` で切り詰められており、
   * `total` / `notSetRate` は取得できた `rows` だけを分母にした値になる。
   */
  truncated: boolean;
}

/**
 * 指定イベントを指定パラメータで分解し、(not set) の件数と率を返す。
 * パラメータ名はイベントスコープのカスタムディメンションとして解決される。
 *
 * 異なり値が `limit`（既定 200）を超えると GA4 は上位 `limit` 行だけを返す。
 * その場合 `truncated` が true になるので、`notSetRate` を「もっともらしいが
 * 誤った値」として扱わないよう呼び出し側で確認すること。
 */
export async function fetchParameterBreakdown(
  auth: TokenProvider,
  propertyId: string,
  params: { dateRange: DateRange; eventName: string; parameter: string; limit?: number },
  options: HttpOptions = {},
): Promise<ParameterBreakdown> {
  const report = await runReport(
    auth,
    propertyId,
    {
      dateRanges: [params.dateRange],
      dimensions: [{ name: `customEvent:${params.parameter}` }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: params.eventName } },
      },
      limit: params.limit ?? 200,
    },
    options,
  );

  const rows = report.rows.map((row) => ({
    value: row.dimensions[0] ?? NOT_SET,
    count: parseMetricCount(
      row.metrics[0],
      `fetchParameterBreakdown: parameter=${params.parameter}, value=${row.dimensions[0] ?? NOT_SET}`,
    ),
  }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const notSetCount = rows
    .filter((row) => row.value === NOT_SET)
    .reduce((sum, row) => sum + row.count, 0);

  return {
    rows,
    total,
    notSetCount,
    notSetRate: total === 0 ? 0 : notSetCount / total,
    rowCount: report.rowCount,
    truncated: rows.length < report.rowCount,
  };
}
