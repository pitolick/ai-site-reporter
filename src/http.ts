import { ApiError } from './types.js';

/** ApiError のメッセージに含める本文の最大長。長すぎるレスポンスを丸めるため。 */
const BODY_PREVIEW_LENGTH = 500;

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
export async function fetchJson<T>(
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

  return { status: res.status, body: body as T };
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
