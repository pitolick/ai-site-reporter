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
   * 1〜4 個。名前は重複不可で、`date_range_` / `RESERVED_` で始めてはいけない。
   * 複数渡すと 1 回の問い合わせで期間ごとの件数を返す（前月比など）。
   */
  dateRanges: NamedDateRange[];
  /** 分ける GA4 ディメンション名（1 つ以上）。例: `[eventParam('item_id')]` / `['pagePath', eventParam('item_id')]` / `['itemId']`。 */
  keys: string[];
  /** キーごとのラベルにする GA4 ディメンション名。キーごとに件数の多い値を採る。 */
  label?: string;
  /** 数える GA4 メトリック名（1 つ以上）。値は非負整数であること（件数専用）。 */
  metrics: string[];
  /** この GA4 ディメンションの値ごとに件数を列に分ける（例: `'eventName'`）。指定時は `metrics` を 1 つに限る。 */
  splitBy?: string;
  /** 指定ディメンションが `values` のいずれかに一致する行だけを数える。 */
  filter?: { dimension: string; values: string[] };
}

/** 期間名 → 列名 → 件数。列名は `splitBy` 指定時はその値、無指定時はメトリック名。 */
export type CountsByPeriod = Record<string, Record<string, number>>;

export interface GroupedCountRow {
  /** `keys` と同じ順のキーの値。 */
  keys: string[];
  /** `label` を指定しなかった、または有効な値が無かったときは null。 */
  label: string | null;
  /** すべての期間・列が 0 で埋まっている（返らなかった組み合わせは 0）。 */
  counts: CountsByPeriod;
}

export interface GroupedCounts {
  /** `dateRanges` の名前（指定順）。 */
  periods: string[];
  /** 列名。`splitBy` 指定時は `filter` の値（同じディメンションのとき）→ 応答に出た値の順。無指定時は `metrics`。 */
  columns: string[];
  /** キーの値の昇順。 */
  rows: GroupedCountRow[];
  /**
   * `rows` に入れなかった件数。キーのどれかが `(not set)` の行は `notSet`、
   * `(other)` の行は `other` に数える（両方に当たる行は `notSet`）。
   */
  excluded: { notSet: CountsByPeriod; other: CountsByPeriod };
  /** GA4 が返した総行数（最初のページの値）。 */
  rowCount: number;
  /** ページングの途中で空ページが返り打ち切った（`rows` が不完全）。 */
  truncated: boolean;
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
    if (name === '') throw new RangeError('dateRanges の name は空にできない');
    const reserved = RESERVED_DATE_RANGE_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (reserved) {
      throw new RangeError(`dateRanges の name は ${reserved} で始めてはいけない（${name}）`);
    }
  }
  if (new Set(names).size !== names.length) {
    throw new RangeError(`dateRanges の name が重複している（${names.join(', ')}）`);
  }
  if (keys.length === 0) throw new RangeError('keys は 1 つ以上指定すること');
  if (metrics.length === 0) throw new RangeError('metrics は 1 つ以上指定すること');
  if (splitBy !== undefined && metrics.length !== 1) {
    throw new RangeError(
      `splitBy を指定するときは metrics を 1 つに限ること（受け取った数: ${metrics.length}）`,
    );
  }
  const dimensions = [...keys, ...(label ? [label] : []), ...(splitBy ? [splitBy] : [])];
  if (new Set(dimensions).size !== dimensions.length) {
    throw new RangeError(
      `keys / label / splitBy のディメンションが重複している（${dimensions.join(', ')}）`,
    );
  }
  if (dimensions.includes(DATE_RANGE_DIMENSION)) {
    throw new RangeError(
      `${DATE_RANGE_DIMENSION} は期間の区別に使われるため keys / label / splitBy に指定できない`,
    );
  }
  if (filter && filter.values.length === 0) {
    throw new RangeError('filter.values は 1 つ以上指定すること');
  }
}

function emptyCounts(periods: string[], columns: string[]): CountsByPeriod {
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
 * - キーが `(not set)` / `(other)` の行を `rows` から外し、`excluded` に数える
 * - 同じキーにラベルが複数あるとき、件数の多い値を採る（`(not set)` / `(other)` は採らない。同数なら辞書順で前のもの）
 * - 複数期間の応答から GA4 が自動で足す `dateRange` 列を探し、期間ごとに分ける
 * - 返らなかった期間・列を 0 で埋める
 * - 全件をページングで取り、打ち切りを `truncated` で知らせる
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

  const request: RunReportAllRequest = {
    dateRanges: dateRanges.map(({ startDate, endDate, name }) => ({ startDate, endDate, name })),
    dimensions: [...keys, ...(label ? [label] : []), ...(splitBy ? [splitBy] : [])].map((name) => ({
      name,
    })),
    metrics: metrics.map((name) => ({ name })),
  };
  if (filter) {
    request.dimensionFilter = {
      filter: { fieldName: filter.dimension, inListFilter: { values: filter.values } },
    };
  }

  const report = await runReportAll(auth, propertyId, request, options);

  const indexOf = (name: string): number => {
    const index = report.dimensionHeaders.indexOf(name);
    if (index === -1) {
      throw new ApiError(
        'ga4',
        200,
        `fetchGroupedCounts: 応答にディメンション ${name} がありません`,
      );
    }
    return index;
  };
  const keyIndexes = keys.map(indexOf);
  const labelIndex = label ? indexOf(label) : -1;
  const splitIndex = splitBy ? indexOf(splitBy) : -1;
  const periodIndex = periods.length > 1 ? indexOf(DATE_RANGE_DIMENSION) : -1;

  const columns: string[] = splitBy
    ? filter?.dimension === splitBy
      ? [...filter.values]
      : []
    : [...metrics];
  const periodOf = (row: Ga4Row): string => {
    if (periodIndex === -1) return periods[0];
    const period = row.dimensions[periodIndex];
    if (!periods.includes(period)) {
      throw new ApiError('ga4', 200, `fetchGroupedCounts: 応答に未知の期間 ${period} があります`);
    }
    return period;
  };

  // 1 周目で列を確定させ、2 周目で 0 埋めした器に足し込む。
  const parsed = report.rows.map((row) => {
    const values = metrics.map((metric, i) =>
      parseMetricCount(row.metrics[i], `fetchGroupedCounts: metric=${metric}`),
    );
    const cells: [string, number][] = splitBy
      ? [[row.dimensions[splitIndex] ?? NOT_SET, values[0]]]
      : metrics.map((metric, i) => [metric, values[i]]);
    for (const [column] of cells) if (!columns.includes(column)) columns.push(column);
    return {
      period: periodOf(row),
      keyValues: keyIndexes.map((i) => row.dimensions[i] ?? NOT_SET),
      labelValue: labelIndex === -1 ? null : (row.dimensions[labelIndex] ?? NOT_SET),
      weight: values[0],
      cells,
    };
  });

  const excluded = { notSet: emptyCounts(periods, columns), other: emptyCounts(periods, columns) };
  const groups = new Map<
    string,
    { keys: string[]; counts: CountsByPeriod; labelWeights: Map<string, number> }
  >();
  for (const row of parsed) {
    const bucket = row.keyValues.includes(NOT_SET)
      ? excluded.notSet
      : row.keyValues.includes(OTHER)
        ? excluded.other
        : null;
    if (bucket) {
      for (const [column, value] of row.cells) bucket[row.period][column] += value;
      continue;
    }
    const id = JSON.stringify(row.keyValues);
    let group = groups.get(id);
    if (!group) {
      group = {
        keys: row.keyValues,
        counts: emptyCounts(periods, columns),
        labelWeights: new Map(),
      };
      groups.set(id, group);
    }
    for (const [column, value] of row.cells) group.counts[row.period][column] += value;
    if (row.labelValue !== null && row.labelValue !== NOT_SET && row.labelValue !== OTHER) {
      group.labelWeights.set(
        row.labelValue,
        (group.labelWeights.get(row.labelValue) ?? 0) + row.weight,
      );
    }
  }

  const pickLabel = (weights: Map<string, number>): string | null => {
    let best: string | null = null;
    let bestWeight = -1;
    for (const [value, weight] of weights) {
      if (weight > bestWeight || (weight === bestWeight && best !== null && value < best)) {
        best = value;
        bestWeight = weight;
      }
    }
    return best;
  };

  const rows = [...groups.values()]
    .map((group) => ({
      keys: group.keys,
      label: pickLabel(group.labelWeights),
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
    rowCount: report.rowCount,
    truncated: report.rows.length < report.rowCount,
  };
}
