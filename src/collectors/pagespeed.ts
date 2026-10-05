import { fetchJson, resolveFetch } from '../http.js';
import { ApiError } from '../types.js';
import type { HttpOptions } from '../types.js';

export interface CoreWebVitals {
  /** 0〜100。取得できなければ null。 */
  performanceScore: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  tbtMs: number | null;
  /** フィールドデータ（CrUX）由来。トラフィックが少ないサイトでは null になる。 */
  inpMs: number | null;
}

interface RawPageSpeedResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: Record<string, { numericValue?: number }>;
  };
  loadingExperience?: {
    metrics?: Record<string, { percentile?: number }>;
  };
}

async function fetchPageSpeedOnce(
  url: string,
  params: { strategy: 'mobile' | 'desktop'; apiKey?: string },
  options: HttpOptions = {},
): Promise<CoreWebVitals> {
  const fetchImpl = resolveFetch(options.fetchImpl);

  const query = new URLSearchParams({ url, strategy: params.strategy });
  if (params.apiKey) query.set('key', params.apiKey);

  const { body } = await fetchJson<RawPageSpeedResponse>(
    'pagespeed',
    fetchImpl,
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query.toString()}`,
  );

  const audits = body.lighthouseResult?.audits ?? {};
  const score = body.lighthouseResult?.categories?.performance?.score;

  return {
    performanceScore: typeof score === 'number' ? Math.round(score * 100) : null,
    lcpMs: audits['largest-contentful-paint']?.numericValue ?? null,
    clsScore: audits['cumulative-layout-shift']?.numericValue ?? null,
    tbtMs: audits['total-blocking-time']?.numericValue ?? null,
    inpMs: body.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
  };
}

/**
 * PageSpeed Insights。API キーは任意（無くても叩けるがクォータが低い）。
 * INP はラボ指標に存在しないため、フィールドデータがあるときだけ返る。
 *
 * `retries`（既定 0）を指定すると、5xx（`Lighthouse returned error` 等の一過性の
 * 失敗）に限って、`retryDelayMs`（既定 0）待ってから最大その回数だけ再試行する。
 * 4xx（キー誤り・クォータ超過）は繰り返しても直らないので再試行しない。
 * ネットワーク例外（`fetch` 自体の reject）も再試行しない。
 */
export async function fetchPageSpeed(
  url: string,
  params: {
    strategy: 'mobile' | 'desktop';
    apiKey?: string;
    retries?: number;
    retryDelayMs?: number;
  },
  options: HttpOptions = {},
): Promise<CoreWebVitals> {
  const retries = params.retries ?? 0;
  const retryDelayMs = params.retryDelayMs ?? 0;
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
      return await fetchPageSpeedOnce(url, params, options);
    } catch (error) {
      const retryable = error instanceof ApiError && error.status >= 500;
      if (!retryable || attempt >= retries) throw error;
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
