import { ApiError } from './types.js';
import type { HttpOptions } from './types.js';

/** ApiError のメッセージに含める本文の最大長。長すぎるレスポンスを丸めるため。 */
const BODY_PREVIEW_LENGTH = 500;

/**
 * `options.fetchImpl` が無いときに使う既定の fetch 実装を解決する。
 *
 * `globalThis.fetch` を値として取り出して渡すと、呼び出し時に `this` が
 * detach された状態で呼ばれる。Node は気にしないが、`this` を要求する実装
 * （ブラウザや一部の edge ランタイムの fetch）では `TypeError: Illegal
 * invocation` になるため、常に `globalThis` に束縛したクロージャを返す。
 */
export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? ((...args) => globalThis.fetch(...args));
}

export interface FetchJsonResult<T> {
  /** レスポンスの HTTP ステータス（呼び出し側が追加のドメイン検証をするとき用）。 */
  status: number;
  body: T;
}

/**
 * fetch を呼び、応答を JSON としてパースして返す共通ヘルパ。
 *
 * `res.json()` を `res.ok` の判定より先に呼ぶと、非 JSON のエラー応答
 * （プロキシが返す 502 の HTML、Google フロントエンドの 503 等）で
 * `res.ok` を見る前に `SyntaxError` が飛んでしまい `ApiError` として
 * 捕まえられなくなる。ここでは必ず先に `res.text()` でボディ文字列を
 * 読み、`JSON.parse` を試みたうえで、非 2xx またはパース失敗のときに
 * `ApiError` を投げる。
 */
async function fetchJsonOnce<T>(
  api: string,
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<FetchJsonResult<T>> {
  const res = await fetchImpl(url, init);
  const text = await res.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(api, res.status, previewOf(text));
  }

  if (!res.ok) {
    const message = extractErrorMessage(body) ?? previewOf(text);
    throw new ApiError(api, res.status, message);
  }

  if (body === null) {
    throw new ApiError(api, res.status, '応答本文が null です');
  }

  return { status: res.status, body: body as T };
}

/**
 * `fetchJsonOnce` を呼び、5xx の `ApiError` に限って `options.retries` 回まで再試行する。
 * 4xx（キー誤り・権限・quota 超過の 429）は繰り返しても直らず、`fetch` 自体の reject
 * （ネットワーク・タイムアウト）も再試行しない。
 */
export async function fetchJson<T>(
  api: string,
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
  options: Pick<HttpOptions, 'retries' | 'retryDelayMs'> = {},
): Promise<FetchJsonResult<T>> {
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 0;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`retries は 0 以上の整数で指定すること（受け取った値: ${retries}）`);
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError(
      `retryDelayMs は 0 以上の数で指定すること（受け取った値: ${retryDelayMs}）`,
    );
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJsonOnce<T>(api, fetchImpl, url, init);
    } catch (error) {
      const retryable = error instanceof ApiError && error.status >= 500;
      if (!retryable || attempt >= retries) throw error;
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return undefined;
}

function previewOf(text: string): string {
  return text.length > BODY_PREVIEW_LENGTH ? `${text.slice(0, BODY_PREVIEW_LENGTH)}…` : text;
}
