import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, resolveFetch } from '../src/http.js';
import { ApiError } from '../src/types.js';

function textResponse(body: string, status: number, contentType = 'text/html') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchJson', () => {
  it('2xx の JSON 応答を { status, body } として返す', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: 'world' }));

    const result = await fetchJson<{ hello: string }>(
      'test-api',
      fetchImpl as unknown as typeof fetch,
      'https://example.com/',
    );

    expect(result).toEqual({ status: 200, body: { hello: 'world' } });
  });

  it('非 2xx の JSON エラー応答から error.message を抽出して ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'something went wrong' } }, 400),
    );

    await expect(
      fetchJson('test-api', fetchImpl as unknown as typeof fetch, 'https://example.com/'),
    ).rejects.toThrow(/test-api 400.*something went wrong/s);
  });

  it('res.ok の判定より先に本文をパースしないため、非 JSON のエラー応答でも SyntaxError にならず ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse('<html><body>502 Bad Gateway</body></html>', 502),
    );

    await expect(
      fetchJson('test-api', fetchImpl as unknown as typeof fetch, 'https://example.com/'),
    ).rejects.toMatchObject({ name: 'ApiError', api: 'test-api', status: 502 });
  });

  it('2xx でも本文が JSON としてパースできなければ ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () => textResponse('not json at all', 200));

    await expect(
      fetchJson('test-api', fetchImpl as unknown as typeof fetch, 'https://example.com/'),
    ).rejects.toMatchObject({ name: 'ApiError', api: 'test-api', status: 200 });
  });

  it('本文が長いときはエラーメッセージ中のプレビューを切り詰める', async () => {
    const longBody = 'x'.repeat(1000);
    const fetchImpl = vi.fn(async () => textResponse(longBody, 503));

    await expect(
      fetchJson('test-api', fetchImpl as unknown as typeof fetch, 'https://example.com/'),
    ).rejects.toThrow(/x{500}…/);
  });

  it('2xx でも応答本文が null なら ApiError を投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      fetchJson('test-api', fetchImpl as unknown as typeof fetch, 'https://example.com/'),
    ).rejects.toMatchObject({ name: 'ApiError', api: 'test-api', status: 200, message: /null/ });
  });
});

describe('resolveFetch', () => {
  it('fetchImpl が渡されていればそれをそのまま返す', () => {
    const custom = vi.fn();
    expect(resolveFetch(custom as unknown as typeof fetch)).toBe(custom);
  });

  it('fetchImpl 未指定時、globalThis.fetch を detach された（束縛されていない）形で呼んでも動く', async () => {
    const originalFetch = globalThis.fetch;
    let calledWithGlobalThisAsReceiver = false;
    // this を要求する fetch 実装を模す（ブラウザ・一部 edge ランタイムの想定）。
    globalThis.fetch = function (this: unknown) {
      calledWithGlobalThisAsReceiver = this === globalThis;
      if (!calledWithGlobalThisAsReceiver) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(new Response('{}'));
    } as unknown as typeof fetch;

    try {
      const wrapped = resolveFetch();
      // http.ts / collectors は `fetchImpl(url, init)` のように、オブジェクトの
      // メソッドとしてではなく単なる関数として呼ぶ。ここでも同じ形で呼ぶ。
      const call = wrapped;
      await expect(call('https://example.com/')).resolves.toBeInstanceOf(Response);
      expect(calledWithGlobalThisAsReceiver).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('fetchJson の 5xx 再試行', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const serverError = () => jsonResponse({ error: { message: 'backend error' } }, 500);
  const asFetch = (fn: unknown) => fn as typeof fetch;
  const run = (fn: unknown, options?: { retries?: number; retryDelayMs?: number }) =>
    fetchJson<{ ok: boolean }>('test-api', asFetch(fn), 'https://example.com/', undefined, options);

  it('retries 指定時は 5xx を再試行し、成功した応答を返す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await run(fetchImpl, { retries: 2 });

    expect(result.body).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries 回を使い切ったら最後の ApiError を投げる', async () => {
    const fetchImpl = vi.fn(async () => serverError());

    await expect(run(fetchImpl, { retries: 2 })).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('JSON でない 502 の本文も再試行する', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('<html>Bad Gateway</html>', 502))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await run(fetchImpl, { retries: 1 });

    expect(result.body).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 429])('%i は再試行しない', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'no' } }, status));

    await expect(run(fetchImpl, { retries: 2 })).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetch 自体の reject（ネットワーク例外）は再試行しない', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(run(fetchImpl, { retries: 2 })).rejects.toThrow(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 未指定なら再試行しない', async () => {
    const fetchImpl = vi.fn(async () => serverError());

    await expect(run(fetchImpl)).rejects.toThrow(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retryDelayMs だけ待ってから再試行する', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const pending = run(fetchImpl, { retries: 1, retryDelayMs: 10_000 });
    // 途中で reject されても未処理の reject として二重に報告されないよう受けておく
    pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ body: { ok: true } });
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

    await expect(run(fetchImpl, invalid)).rejects.toThrow(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
