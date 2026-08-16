/** GA4 / Search Console に渡す日付範囲（YYYY-MM-DD）。 */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/** スコープを指定してアクセストークンを返す。 */
export interface TokenProvider {
  getToken(scopes: string[]): Promise<string>;
}

/** テスト用に fetch 実装を差し替えるための共通オプション。 */
export interface HttpOptions {
  fetchImpl?: typeof fetch;
}

/** 外部 API の応答が期待どおりでないときに throw される。握りつぶさないこと。 */
export class ApiError extends Error {
  constructor(
    readonly api: string,
    readonly status: number,
    message: string,
  ) {
    super(`${api} ${status}: ${message}`);
    this.name = 'ApiError';
  }
}
