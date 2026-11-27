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

/** GA4 が応答に付ける、集計の確からしさに関わる情報（`ResponseMetaData` の一部）。 */
export interface Ga4ReportMetadata {
  /** `(other)` 行にまとめられたデータがある（値の種類が多すぎるディメンション）。 */
  dataLossFromOtherRow: boolean;
  /** しきい値処理（少数のユーザーを隠す処理）が掛かっている可能性がある。 */
  subjectToThresholding: boolean;
  /** サンプリングされた集計である。 */
  sampled: boolean;
}

export interface Ga4Report {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Ga4Row[];
  rowCount: number;
  /** 0.5.0 で追加。応答に無い項目は false。 */
  metadata: Ga4ReportMetadata;
}

interface RawGa4Response {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
  metadata?: {
    dataLossFromOtherRow?: boolean;
    subjectToThresholding?: boolean;
    samplingMetadatas?: unknown[];
  };
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
    metadata: {
      dataLossFromOtherRow: body.metadata?.dataLossFromOtherRow === true,
      subjectToThresholding: body.metadata?.subjectToThresholding === true,
      sampled: (body.metadata?.samplingMetadatas ?? []).length > 0,
    },
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
  const metadata = { ...first.metadata };
  while (rows.length < first.rowCount) {
    const page = await fetchPage(rows.length);
    // どのページの応答に立っていても、集計全体に掛かる注意なので OR で集める。
    // 打ち切る空ページの注意も落とさないよう、空ページの判定より先に集める。
    metadata.dataLossFromOtherRow ||= page.metadata.dataLossFromOtherRow;
    metadata.subjectToThresholding ||= page.metadata.subjectToThresholding;
    metadata.sampled ||= page.metadata.sampled;
    if (page.rows.length === 0) break;
    // rows.push(...page.rows) は 25 万行で引数の上限を超えるため 1 行ずつ積む。
    for (const row of page.rows) rows.push(row);
  }

  return {
    dimensionHeaders: first.dimensionHeaders,
    metricHeaders: first.metricHeaders,
    rows,
    rowCount: first.rowCount,
    metadata,
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
      dimensions: [{ name: eventParam(params.parameter) }],
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

/** GA4 が、値の種類が多すぎるディメンションの残りを 1 行にまとめるときの値。 */
export const OTHER = '(other)';

/** GA4 Data API が 1 リクエストで受け付ける日付範囲の数の上限（公式リファレンス `DateRange`）。 */
export const MAX_DATE_RANGES = 4;

/** 複数の日付範囲を区別するために GA4 が応答へ自動で足すディメンション名。 */
const DATE_RANGE_DIMENSION = 'dateRange';

/** GA4 が日付範囲名として予約している接頭辞（公式リファレンス `DateRange.name`）。 */
const RESERVED_DATE_RANGE_PREFIXES = ['date_range_', 'RESERVED_'];

/** イベントスコープのカスタムディメンション名（`customEvent:<name>`）を組み立てる。 */
export function eventParam(name: string): string {
  return `customEvent:${name}`;
}

/** アイテムスコープのカスタムディメンション名（`customItem:<name>`）を組み立てる。 */
export function itemParam(name: string): string {
  return `customItem:${name}`;
}

/** 名前付きの日付範囲。名前は応答の期間を見分けるキーになる。 */
export interface NamedDateRange extends DateRange {
  name: string;
}

export interface GroupedCountsParams {
  /**
   * 1〜4 個。名前は空・重複不可で、`date_range_` / `RESERVED_` で始めてはいけない。
   * GA4 がまとめた行の印と見分けられなくなるため、`(other)` / `(not set)` も使えない。
   * 複数渡すと 1 回の問い合わせで期間ごとの件数を返す（前月比など）。
   * 先頭の期間がラベル選びの基準になる（`label` を参照）。
   */
  dateRanges: readonly NamedDateRange[];
  /** 分ける GA4 ディメンション名（1 つ以上）。例: `[eventParam('item_id')]` / `['pagePath', eventParam('item_id')]` / `['itemId']`。 */
  keys: readonly string[];
  /**
   * キーごとのラベルにする GA4 ディメンション名。キーごとに、**先頭の期間で、第 1 メトリック
   * （`splitBy` 指定時は列で分けない値）の件数が最も多い値**を採る。先頭の期間に値が無ければ次の期間を見る。
   * `(not set)` / `(other)` は採らない。同数なら文字列として小さいほう。
   * 件数とは別の問い合わせでラベルを取るので、指定すると GA4 への問い合わせが 1 本増える。
   */
  label?: string;
  /** 数える GA4 メトリック名（1 つ以上・重複不可）。値は非負整数であること（件数専用）。 */
  metrics: readonly string[];
  /**
   * この GA4 ディメンションの値ごとに件数を列に分ける（例: `'eventName'`）。指定時は `metrics` を 1 つに限る。
   * 値の種類が少ないディメンション向け（列の数だけ全キー・全期間のセルを作るため）。
   */
  splitBy?: string;
  /** 指定ディメンションが `values` のいずれかに**大文字小文字まで一致する**行だけを数える。 */
  filter?: { dimension: string; values: readonly string[] };
}

/** 期間名 → 列名 → 件数。列名は `splitBy` 指定時はその値、無指定時はメトリック名。 */
export type CountsByPeriod = Record<string, Record<string, number>>;

export interface GroupedCountRow {
  /** `keys` と同じ順のキーの値。 */
  keys: string[];
  /** `label` を指定しなかった、または採れる値が無かったときは null。 */
  label: string | null;
  /** 全期間・全列を持つ。応答に返らなかった期間・列は 0 で埋める。 */
  counts: CountsByPeriod;
}

export interface GroupedCounts {
  /** `dateRanges` の名前（指定順）。 */
  periods: string[];
  /** 列名。`splitBy` 指定時は `filter` の値（同じディメンションのとき）→ 応答に出た値の順。無指定時は `metrics`。 */
  columns: string[];
  /** キーの値を文字列として比べた昇順（`"10"` は `"9"` より前）。 */
  rows: GroupedCountRow[];
  /**
   * `rows` に入れなかった件数。
   * - `notSet`: キーのどれかが `(not set)` の行（期間・列ごと）
   * - `other`: キー・`splitBy` の値・期間のどれかが `(other)` の行（期間・列ごと）
   * - `otherUnattributed`: `(other)` の行のうち、期間か列が `(other)` で振り分けられない分。
   *   **メトリック名ごと**に合計する（`splitBy` 指定時はその 1 つのメトリック）
   * `(other)` と `(not set)` の両方に当たる行は `other` に数える。
   *
   * どれも複数の行を足した値なので、ユーザー数のような加算できないメトリックでは実際の値より
   * 大きく出うる（上限の目安として読む）。`rows` の件数は行を足さずに取るので、この影響は無い。
   */
  excluded: {
    notSet: CountsByPeriod;
    other: CountsByPeriod;
    otherUnattributed: Record<string, number>;
  };
  /**
   * GA4 の応答に付いた注意。`dataLossFromOtherRow` が true なら、`(other)` 行にまとめられた分だけ
   * キー別の数字が欠けている（期間を短くするなどして問い合わせを分ける）。件数の問い合わせの値。
   */
  metadata: Ga4ReportMetadata;
  /** 件数の問い合わせで GA4 が返した総行数（最初のページの値）。 */
  rowCount: number;
  /** 件数の問い合わせのページングの途中で空ページが返り打ち切った（`rows` と `excluded` が不完全）。 */
  truncated: boolean;
  /**
   * ラベルを決める問い合わせの注意と打ち切り。`label` を指定しなかったときは null。
   * 件数とは別の問い合わせなので、ここが立っても件数は欠けていない（欠けうるのは `label` だけ）。
   */
  labelQuery: { metadata: Ga4ReportMetadata; truncated: boolean } | null;
}

function assertUnique(name: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new RangeError(`${name} が重複している（${values.join(', ')}）`);
  }
}

function assertNotEmpty(name: string, value: string): void {
  if (value === '') throw new RangeError(`${name} は空にできない`);
}

function validateGroupedCountsParams(params: GroupedCountsParams): void {
  const { dateRanges, keys, metrics, label, splitBy, filter } = params;
  if (dateRanges.length < 1 || dateRanges.length > MAX_DATE_RANGES) {
    throw new RangeError(
      `dateRanges は 1〜${MAX_DATE_RANGES} 個で指定すること（受け取った数: ${dateRanges.length}）`,
    );
  }
  const names = dateRanges.map((range) => range.name);
  for (const name of names) {
    assertNotEmpty('dateRanges の name', name);
    const reserved = RESERVED_DATE_RANGE_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (reserved) {
      throw new RangeError(`dateRanges の name は ${reserved} で始めてはいけない（${name}）`);
    }
  }
  for (const name of names) {
    // 期間の列に GA4 が返す (other) / (not set) と区別できなくなる。
    if (name === OTHER || name === NOT_SET) {
      throw new RangeError(`dateRanges の name に ${name} は使えない`);
    }
  }
  assertUnique('dateRanges の name', names);
  if (keys.length === 0) throw new RangeError('keys は 1 つ以上指定すること');
  if (metrics.length === 0) throw new RangeError('metrics は 1 つ以上指定すること');
  for (const key of keys) assertNotEmpty('keys の要素', key);
  for (const metric of metrics) assertNotEmpty('metrics の要素', metric);
  assertUnique('metrics', metrics);
  if (label !== undefined) assertNotEmpty('label', label);
  if (splitBy !== undefined) {
    assertNotEmpty('splitBy', splitBy);
    if (metrics.length !== 1) {
      throw new RangeError(
        `splitBy を指定するときは metrics を 1 つに限ること（受け取った数: ${metrics.length}）`,
      );
    }
  }
  const dimensions = [
    ...keys,
    ...(label !== undefined ? [label] : []),
    ...(splitBy !== undefined ? [splitBy] : []),
  ];
  assertUnique('keys / label / splitBy のディメンション', dimensions);
  if (dimensions.includes(DATE_RANGE_DIMENSION)) {
    throw new RangeError(
      `${DATE_RANGE_DIMENSION} は期間の区別に使われるため keys / label / splitBy に指定できない`,
    );
  }
  if (filter) {
    assertNotEmpty('filter.dimension', filter.dimension);
    if (filter.values.length === 0) throw new RangeError('filter.values は 1 つ以上指定すること');
    assertUnique('filter.values', filter.values);
  }
}

function emptyCounts(periods: readonly string[], columns: readonly string[]): CountsByPeriod {
  return Object.fromEntries(
    periods.map((period) => [period, Object.fromEntries(columns.map((column) => [column, 0]))]),
  );
}

/**
 * 指定したキー（GA4 ディメンション）ごとに件数を数え、期間・列ごとに返す。
 *
 * 例えば「アイテム ID ごとの表示イベントとクリックイベントの件数を、今月と前月で」
 * 1 回の問い合わせで取れる（`keys: [eventParam('item_id')]`, `splitBy: 'eventName'`,
 * `filter: { dimension: 'eventName', values: [...] }`, `dateRanges` に 2 期間）。
 * 率（CTR など）や閾値の判断は呼び出し側で行う。
 *
 * 自分で書くと間違えやすい次の処理をこの関数に閉じ込めている。
 * - キーが `(not set)` の行と、キー・`splitBy` の値・期間のどれかが `(other)` の行を `rows` から外し、
 *   `excluded` に数える（両方に当たる行は `(other)` 側）
 * - 同じキーにラベルが複数あるとき、先頭の期間で件数の多い値を採る。件数はラベルを含めない
 *   問い合わせで取り、ラベルは別の問い合わせ（重みは `metrics` の先頭）で決める。ラベルで
 *   分けた行を足すと、ユーザー数のような加算できないメトリックが水増しされるため
 * - 複数期間の応答から GA4 が自動で足す `dateRange` 列を列名で探し、期間ごとに分ける
 * - 返らなかった期間・列を 0 で埋める
 * - 全件をページングで取り、打ち切りを `truncated`、`(other)` による欠損を `metadata` で知らせる
 *   （ラベルの問い合わせの分は `labelQuery` に分けて返す）
 *
 * ディメンションとメトリックの組み合わせによっては GA4 が 400 を返す（例: `eventName`
 * とアイテムスコープのディメンション）。その場合は `ApiError` を throw する。
 */
export async function fetchGroupedCounts(
  auth: TokenProvider,
  propertyId: string,
  params: GroupedCountsParams,
  options: HttpOptions = {},
): Promise<GroupedCounts> {
  validateGroupedCountsParams(params);
  const { dateRanges, keys, label, metrics, splitBy, filter } = params;
  const periods = dateRanges.map((range) => range.name);
  const buildRequest = (
    dimensions: readonly string[],
    metricNames: readonly string[],
  ): RunReportAllRequest => {
    const request: RunReportAllRequest = {
      dateRanges: dateRanges.map(({ startDate, endDate, name }) => ({ startDate, endDate, name })),
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metricNames.map((name) => ({ name })),
    };
    if (filter) {
      // GA4 の inListFilter は既定で大文字小文字を区別しない。イベント名などは区別されるため、
      // 指定と違う綴りの値が混ざって列が割れないよう、区別させる。
      request.dimensionFilter = {
        filter: {
          fieldName: filter.dimension,
          inListFilter: { values: [...filter.values], caseSensitive: true },
        },
      };
    }
    return request;
  };

  // 件数はラベルを含めずに取る。ラベルで分けた行を足すと、ユーザー数のような加算できない
  // メトリックが水増しされる。ラベルは別の問い合わせで、先頭のメトリックを重みにして決める。
  const [report, labelReport] = await Promise.all([
    runReportAll(
      auth,
      propertyId,
      buildRequest([...keys, ...(splitBy !== undefined ? [splitBy] : [])], metrics),
      options,
    ),
    label !== undefined
      ? runReportAll(auth, propertyId, buildRequest([...keys, label], [metrics[0]]), options)
      : null,
  ]);

  const indexOf = (target: Ga4Report, name: string): number => {
    const index = target.dimensionHeaders.indexOf(name);
    if (index === -1) {
      throw new ApiError(
        'ga4',
        200,
        `fetchGroupedCounts: 応答にディメンション ${name} がありません`,
      );
    }
    return index;
  };
  const keyIndexes = keys.map((name) => indexOf(report, name));
  const splitIndex = splitBy !== undefined ? indexOf(report, splitBy) : -1;
  const periodIndex = periods.length > 1 ? indexOf(report, DATE_RANGE_DIMENSION) : -1;
  const periodSet = new Set(periods);

  // 1 周目: 行を読み、列を確定させる。(other) 行は列を増やさない。
  const columnSet = new Set<string>(
    splitBy !== undefined ? (filter?.dimension === splitBy ? filter.values : []) : metrics,
  );
  const parsed = report.rows.map((row) => {
    const values = metrics.map((metric, i) =>
      parseMetricCount(row.metrics[i], `fetchGroupedCounts: metric=${metric}`),
    );
    const keyValues = keyIndexes.map((i) => row.dimensions[i] ?? NOT_SET);
    const splitValue = splitIndex === -1 ? null : (row.dimensions[splitIndex] ?? NOT_SET);
    const rawPeriod = periodIndex === -1 ? periods[0] : row.dimensions[periodIndex];
    // (other) はキー・列・期間のどれに出ても「まとめられて振り分けられない行」なので、
    // (not set) より先に判定する（列を増やさず、期間の検査もしない）。
    const isOther = keyValues.includes(OTHER) || splitValue === OTHER || rawPeriod === OTHER;
    const isNotSet = !isOther && keyValues.includes(NOT_SET);
    if (!isOther && !periodSet.has(rawPeriod)) {
      throw new ApiError(
        'ga4',
        200,
        `fetchGroupedCounts: 応答に未知の期間 ${rawPeriod} があります`,
      );
    }
    // [列, 件数, メトリック名]
    const cells: [string, number, string][] =
      splitValue !== null
        ? [[splitValue, values[0], metrics[0]]]
        : metrics.map((metric, i) => [metric, values[i], metric]);
    if (!isOther) for (const [column] of cells) columnSet.add(column);
    return { period: rawPeriod, keyValues, cells, isNotSet, isOther };
  });
  const columns = [...columnSet];

  // 2 周目: 0 埋めした器に足し込む。
  const excluded = {
    notSet: emptyCounts(periods, columns),
    other: emptyCounts(periods, columns),
    otherUnattributed: Object.fromEntries(metrics.map((metric) => [metric, 0])) as Record<
      string,
      number
    >,
  };
  const groups = new Map<string, { keys: string[]; counts: CountsByPeriod }>();
  for (const row of parsed) {
    if (row.isOther) {
      for (const [column, value, metric] of row.cells) {
        if (periodSet.has(row.period) && columnSet.has(column)) {
          excluded.other[row.period][column] += value;
        } else {
          excluded.otherUnattributed[metric] += value;
        }
      }
      continue;
    }
    if (row.isNotSet) {
      for (const [column, value] of row.cells) excluded.notSet[row.period][column] += value;
      continue;
    }
    const id = JSON.stringify(row.keyValues);
    let group = groups.get(id);
    if (!group) {
      group = { keys: row.keyValues, counts: emptyCounts(periods, columns) };
      groups.set(id, group);
    }
    for (const [column, value] of row.cells) group.counts[row.period][column] += value;
  }

  // ラベルの重み: キー → 期間 → ラベル → 件数。キー・ラベル・期間が (not set) / (other) の行や
  // 未知の期間の行はラベル選びに使わない（件数には影響しないので throw しない）。
  const labelWeights = new Map<string, Map<string, Map<string, number>>>();
  if (labelReport !== null && label !== undefined) {
    const labelKeyIndexes = keys.map((name) => indexOf(labelReport, name));
    const labelIndex = indexOf(labelReport, label);
    const labelPeriodIndex = periods.length > 1 ? indexOf(labelReport, DATE_RANGE_DIMENSION) : -1;
    for (const row of labelReport.rows) {
      const keyValues = labelKeyIndexes.map((i) => row.dimensions[i] ?? NOT_SET);
      const labelValue = row.dimensions[labelIndex] ?? NOT_SET;
      const period = labelPeriodIndex === -1 ? periods[0] : row.dimensions[labelPeriodIndex];
      if (
        keyValues.includes(NOT_SET) ||
        keyValues.includes(OTHER) ||
        labelValue === NOT_SET ||
        labelValue === OTHER ||
        !periodSet.has(period)
      ) {
        continue;
      }
      const weight = parseMetricCount(row.metrics[0], `fetchGroupedCounts: metric=${metrics[0]}`);
      const id = JSON.stringify(keyValues);
      const byPeriod = labelWeights.get(id) ?? new Map<string, Map<string, number>>();
      const byLabel = byPeriod.get(period) ?? new Map<string, number>();
      byLabel.set(labelValue, (byLabel.get(labelValue) ?? 0) + weight);
      byPeriod.set(period, byLabel);
      labelWeights.set(id, byPeriod);
    }
  }

  // 先頭の期間から順に見て、値のある最初の期間で件数の多いラベルを採る。
  const pickLabel = (
    weightsByPeriod: Map<string, Map<string, number>> | undefined,
  ): string | null => {
    if (!weightsByPeriod) return null;
    for (const period of periods) {
      const weights = weightsByPeriod.get(period);
      if (!weights || weights.size === 0) continue;
      let best: string | null = null;
      let bestWeight = -1;
      for (const [value, weight] of weights) {
        if (weight > bestWeight || (weight === bestWeight && best !== null && value < best)) {
          best = value;
          bestWeight = weight;
        }
      }
      return best;
    }
    return null;
  };

  const rows = [...groups.values()]
    .map((group) => ({
      keys: group.keys,
      label: pickLabel(labelWeights.get(JSON.stringify(group.keys))),
      counts: group.counts,
    }))
    .sort((a, b) => {
      for (let i = 0; i < a.keys.length; i += 1) {
        if (a.keys[i] !== b.keys[i]) return a.keys[i] < b.keys[i] ? -1 : 1;
      }
      return 0;
    });

  return {
    periods,
    columns,
    rows,
    excluded,
    metadata: report.metadata,
    rowCount: report.rowCount,
    truncated: report.rows.length < report.rowCount,
    // ラベル側の注意・打ち切りは件数の欠けと取り違えないよう、件数の項目に混ぜず分けて返す。
    labelQuery:
      labelReport === null
        ? null
        : {
            metadata: labelReport.metadata,
            truncated: labelReport.rows.length < labelReport.rowCount,
          },
  };
}
