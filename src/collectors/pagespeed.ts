import { fetchJson } from '../http.js';
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

/**
 * PageSpeed Insights。API キーは任意（無くても叩けるがクォータが低い）。
 * INP はラボ指標に存在しないため、フィールドデータがあるときだけ返る。
 */
export async function fetchPageSpeed(
  url: string,
  params: { strategy: 'mobile' | 'desktop'; apiKey?: string },
  options: HttpOptions = {},
): Promise<CoreWebVitals> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

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
