import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPageSpeed } from '../../src/collectors/pagespeed.js';
import { ApiError } from '../../src/types.js';

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

  const serverError = () =>
    new Response(JSON.stringify({ error: { message: 'Lighthouse returned error' } }), {
      status: 500,
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries 指定時は 5xx を再試行し、成功した応答を返す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(lighthouseResponse());

    const vitals = await fetchPageSpeed(
      'https://example.com/',
      { strategy: 'mobile', retries: 2 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(vitals.performanceScore).toBe(82);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries 回を使い切ったら最後の ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () => serverError());

    await expect(
      fetchPageSpeed(
        'https://example.com/',
        { strategy: 'mobile', retries: 2 },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries 未指定なら再試行しない（従来どおり）', async () => {
    const fetchImpl = vi.fn(async () => serverError());

    await expect(
      fetchPageSpeed(
        'https://example.com/',
        { strategy: 'mobile' },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('4xx は再試行しない（キー誤り・クォータ超過は繰り返しても直らない）', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 400 }),
    );

    await expect(
      fetchPageSpeed(
        'https://example.com/',
        { strategy: 'mobile', retries: 2 },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retryDelayMs だけ待ってから再試行する', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(lighthouseResponse());

    const pending = fetchPageSpeed(
      'https://example.com/',
      { strategy: 'mobile', retries: 1, retryDelayMs: 10_000 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    // 実装前（RED）は即座に reject されるので、未処理の reject として二重に報告されないよう受けておく
    pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ performanceScore: 82 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { retries: -1 },
    { retries: 1.5 },
    { retries: Number.NaN },
    { retryDelayMs: -1 },
    { retryDelayMs: Number.NaN },
  ])('%o は RangeError（NaN で無限に再試行しない）', async (invalid) => {
    const fetchImpl = vi.fn();

    await expect(
      fetchPageSpeed(
        'https://example.com/',
        { strategy: 'mobile', ...invalid },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
