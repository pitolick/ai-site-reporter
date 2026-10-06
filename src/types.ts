/** GA4 / Search Console に渡す日付範囲（YYYY-MM-DD）。 */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/** スコープを指定してアクセストークンを返す。 */
export interface TokenProvider {
  getToken(scopes: string[]): Promise<string>;
}

/**
 * HTTP 呼び出しの共通オプション（fetch の差し替え・5xx の再試行）。
 *
 * `retries`（既定 0）を指定すると、5xx に限って `retryDelayMs`（既定 0）待ってから
 * 最大その回数だけ再試行する。4xx とネットワーク例外（`fetch` 自体の reject）は再試行しない。
 */
export interface HttpOptions {
  fetchImpl?: typeof fetch;
  /** 5xx の再試行回数（0 以上の整数）。 */
  retries?: number;
  /** 再試行までの待ち時間（ミリ秒、0 以上）。 */
  retryDelayMs?: number;
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
