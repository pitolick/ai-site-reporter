import { describe, it, expect, vi } from 'vitest';
import { fetchJson } from '../src/http.js';

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
});
