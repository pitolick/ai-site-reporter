import { fetchJson } from '../http.js';
import type { HttpOptions, TokenProvider } from '../types.js';

export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/**
 * Search Console API が `rowLimit` を省略したときに適用する既定値。
 * 公式ドキュメント上、`rowLimit` の既定は 1,000（最大 25,000）。
 * レスポンスは総行数を返さないため、`rowLimit` 未指定時はこの値との
 * 一致を切り詰めの疑いの判定基準にする。
 */
export const DEFAULT_ROW_LIMIT = 1000;

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit?: number;
  [key: string]: unknown;
}

export interface SearchAnalyticsResult {
  rows: SearchAnalyticsRow[];
  /**
   * `rows.length` が要求した `rowLimit`（未指定なら既定の `DEFAULT_ROW_LIMIT`）
   * と一致したら true。Search Console API はレスポンスに総行数を返さないため、
   * 「一致した」だけでは確定ではなく疑いに過ぎない（ちょうど一致しただけの
   * 可能性もある）。
   *
   * **`false` は全件取得を保証しない。** `rows.length` が `rowLimit` に達しなかった
   * ことのみを示す。Google の Search Analytics API は内部制限により上位結果を優先
   * して返す仕様であり、API が明示的に「すべてのデータ行を返す」ことを保証していない。
   * たとえ `truncated: false` でも、別の理由で対象データが欠落している可能性がある。
   *
   * throw はしない。「上位 N 件だけ欲しい」という正当な使い方があるため、
   * 判断は呼び出し側に委ねる。全件の確認が必要なら、`rowLimit` を上げるか
   * `startRow` でページングし、返ってきた行数が要求行数を下回るまで続けること。
   */
  truncated: boolean;
}

/**
 * Search Console の searchAnalytics.query を呼ぶ薄いラッパ。
 * データが無い期間は rows キーごと返らないため、空配列に正規化する。
 *
 * 全件取得の保証はしない。`rowLimit`（既定 1,000・最大 25,000）で切り詰め
 * られることがある（詳細は `SearchAnalyticsResult.truncated` 参照）。
 */
export async function querySearchAnalytics(
  auth: TokenProvider,
  siteUrl: string,
  request: SearchAnalyticsRequest,
  options: HttpOptions = {},
): Promise<SearchAnalyticsResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const token = await auth.getToken([SEARCH_CONSOLE_SCOPE]);

  const { body } = await fetchJson<{ rows?: SearchAnalyticsRow[] }>(
    'search-console',
    fetchImpl,
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
  );

  const rows = body.rows ?? [];
  const effectiveLimit = request.rowLimit ?? DEFAULT_ROW_LIMIT;
  return { rows, truncated: rows.length === effectiveLimit };
}
