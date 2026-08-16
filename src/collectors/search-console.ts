import { fetchJson } from '../http.js';
import type { HttpOptions, TokenProvider } from '../types.js';

export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

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

/**
 * Search Console の searchAnalytics.query を呼ぶ薄いラッパ。
 * データが無い期間は rows キーごと返らないため、空配列に正規化する。
 */
export async function querySearchAnalytics(
  auth: TokenProvider,
  siteUrl: string,
  request: SearchAnalyticsRequest,
  options: HttpOptions = {},
): Promise<SearchAnalyticsRow[]> {
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

  return body.rows ?? [];
}
