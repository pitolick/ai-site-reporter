import { describe, it, expect, vi } from 'vitest';
import { fetchPageSpeed } from '../../src/collectors/pagespeed.js';

function lighthouseResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      lighthouseResult: {
        categories: { performance: { score: 0.82 } },
        audits: {
          'largest-contentful-paint': { numericValue: 2600.5 },
          'cumulative-layout-shift': { numericValue: 0.04 },
          'total-blocking-time': { numericValue: 120 },
        },
      },
      ...overrides,
    }),
    { status: 200 },
  );
}

describe('fetchPageSpeed', () => {
  it('ラボ指標を取り出す', async () => {
    const fetchImpl = vi.fn(async () => lighthouseResponse());

    const vitals = await fetchPageSpeed(
      'https://example.com/',
      { strategy: 'mobile' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(vitals.performanceScore).toBe(82);
    expect(vitals.lcpMs).toBeCloseTo(2600.5);
    expect(vitals.clsScore).toBeCloseTo(0.04);
    expect(vitals.tbtMs).toBe(120);
  });

  it('フィールドデータが無ければ INP は null', async () => {
    const fetchImpl = vi.fn(async () => lighthouseResponse());

    const vitals = await fetchPageSpeed(
      'https://example.com/',
      { strategy: 'mobile' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(vitals.inpMs).toBeNull();
  });

  it('フィールドデータがあれば INP を取る', async () => {
    const fetchImpl = vi.fn(async () =>
      lighthouseResponse({
        loadingExperience: {
          metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 180 } },
        },
      }),
    );

    const vitals = await fetchPageSpeed(
      'https://example.com/',
      { strategy: 'mobile' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(vitals.inpMs).toBe(180);
  });

  it('API キーが無ければ key パラメータを付けない', async () => {
    const fetchImpl = vi.fn(async () => lighthouseResponse());

    await fetchPageSpeed(
      'https://example.com/',
      { strategy: 'desktop' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('strategy=desktop');
    expect(url).not.toContain('key=');
  });

  it('API キーがあれば key パラメータを付ける', async () => {
    const fetchImpl = vi.fn(async () => lighthouseResponse());

    await fetchPageSpeed(
      'https://example.com/',
      { strategy: 'mobile', apiKey: 'abc' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('key=abc');
  });

  it('429 を握りつぶさず ApiError を投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
    );

    await expect(
      fetchPageSpeed(
        'https://example.com/',
        { strategy: 'mobile' },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/pagespeed 429/);
  });
});
