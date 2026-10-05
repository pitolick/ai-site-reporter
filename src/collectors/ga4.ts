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
    options,
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

/** GA4 Data API が 1 リクエストで返す行数の上限（公式リファレンス `limit`）。 */
const GA4_MAX_ROWS_PER_REQUEST = 250_000;

/** `runReportAll` の request。`limit` / `offset` は関数が制御するので型で禁止する。 */
export type RunReportAllRequest = Record<string, unknown> & { limit?: never; offset?: never };

/**
 * `runReport` を `offset` でページングし、全行を 1 つの `Ga4Report` にまとめて返す。
 * ページサイズは API の上限（250,000 行）なので、通常は 1 リクエストで終わる。
 *
 * `limit` / `offset` はこの関数が制御するため、`request` の型で禁止している
 * （「上位 N 件」のつもりで渡した呼び出しを黙って全件にしないため）。リテラルも
 * 型が推論された変数（`const req = { ..., limit: 10 }`）も型エラーになる。黙って
 * すり抜けるのは `Record<string, unknown>` と注釈した変数や JS からの呼び出しで、
 * 渡された値はこの関数の値で上書きされる。変数で組み立てるときは
 * `RunReportAllRequest` で注釈する。
 *
 * 総行数は最初のページの `rowCount` を使う。途中で空ページが返ったら打ち切り、
 * `rows.length < rowCount` のまま返すので、呼び出し側は `runReport` と同じく
 * 両者の突合で欠損を検出できる（空ページの `rowCount` で上書きしないのは、
 * proto3 の JSON が 0 を省くため `runReport` がそれを `rows.length`＝0 で埋め、
 * 欠損が見えなくなるから）。
 */
export async function runReportAll(
  auth: TokenProvider,
  propertyId: string,
  request: RunReportAllRequest,
  options: HttpOptions = {},
): Promise<Ga4Report> {
  const fetchPage = (offset: number) =>
    runReport(auth, propertyId, { ...request, limit: GA4_MAX_ROWS_PER_REQUEST, offset }, options);

  const first = await fetchPage(0);
  const rows: Ga4Row[] = [...first.rows];
  while (rows.length < first.rowCount) {
    const page = await fetchPage(rows.length);
    if (page.rows.length === 0) break;
    // rows.push(...page.rows) は 25 万行で引数の上限を超えるため 1 行ずつ積む。
    for (const row of page.rows) rows.push(row);
  }

  return {
    dimensionHeaders: first.dimensionHeaders,
    metricHeaders: first.metricHeaders,
    rows,
    rowCount: first.rowCount,
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
  /** GA4 が返した総行数（最初のページの値）。 */
  rowCount: number;
  /**
   * `rows.length < rowCount`。ページングの途中で空ページが返り打ち切った場合に true。
   * そのときの `total` / `notSetRate` は取得できた `rows` だけを分母にした値。
   */
  truncated: boolean;
}

/**
 * 指定イベントを指定パラメータで分解し、(not set) の件数と率を返す。
 * パラメータ名はイベントスコープのカスタムディメンションとして解決される。
 *
 * `notSetRate` は全行を分母にしないと「もっともらしいが誤った値」になるため、
 * 異なり値の数に関わらず `runReportAll` で全件を取る。`truncated` が true に
 * なるのは、ページングの途中で API が空ページを返して打ち切ったときだけ。
 */
export async function fetchParameterBreakdown(
  auth: TokenProvider,
  propertyId: string,
  params: { dateRange: DateRange; eventName: string; parameter: string },
  options: HttpOptions = {},
): Promise<ParameterBreakdown> {
  const report = await runReportAll(
    auth,
    propertyId,
    {
      dateRanges: [params.dateRange],
      dimensions: [{ name: `customEvent:${params.parameter}` }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: params.eventName } },
      },
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
