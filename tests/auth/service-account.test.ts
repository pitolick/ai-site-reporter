import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createServiceAccountAuth } from '../../src/auth/service-account.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const credential = {
  type: 'service_account',
  client_email: 'reporter@example-project.iam.gserviceaccount.com',
  private_key: privateKey,
};

const rawJson = JSON.stringify(credential);

function tokenResponse(token: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createServiceAccountAuth', () => {
  it('1 行 JSON の資格情報でトークンを取得できる', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-1'));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const token = await auth.getToken(['https://www.googleapis.com/auth/analytics.readonly']);

    expect(token).toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('base64 の資格情報も受け付ける', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-2'));
    const encoded = Buffer.from(rawJson).toString('base64');
    const auth = createServiceAccountAuth(encoded, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(auth.getToken(['scope-a'])).resolves.toBe('token-2');
  });

  it('サービスアカウントの秘密鍵で署名した JWT を送る', async () => {
    let sentAssertion = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentAssertion = new URLSearchParams(init.body as string).get('assertion') ?? '';
      return tokenResponse('token-3');
    });
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await auth.getToken(['scope-a', 'scope-b']);

    const [header, claims, signature] = sentAssertion.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect(decoded.iss).toBe(credential.client_email);
    expect(decoded.scope).toBe('scope-a scope-b');
    expect(decoded.aud).toBe('https://oauth2.googleapis.com/token');
  });

  it('同じスコープの 2 回目はキャッシュを返し fetch しない', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-4'));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await auth.getToken(['scope-a']);
    await auth.getToken(['scope-a']);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('スコープが違えば別のトークンを取りに行く', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-5'));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await auth.getToken(['scope-a']);
    await auth.getToken(['scope-b']);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('スコープの順序が違うだけなら同じキャッシュエントリを使う', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-order'));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await auth.getToken(['scope-a', 'scope-b']);
    await auth.getToken(['scope-b', 'scope-a']);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('同一スコープの並行取得は single-flight で 1 回の fetch にまとまる', async () => {
    // README が推奨する Promise.allSettled 的な並列取得を模す。JWT 署名〜
    // fetchImpl 呼び出しまでは同期的に進むため、2 回目の呼び出しは 1 回目が
    // 作った進行中の Promise を inFlight キャッシュから拾って共有できる。
    const fetchImpl = vi.fn(async () => tokenResponse('token-parallel'));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [first, second] = await Promise.all([
      auth.getToken(['scope-a']),
      auth.getToken(['scope-a']),
    ]);

    expect(first).toBe('token-parallel');
    expect(second).toBe('token-parallel');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('トークン取得に失敗しても次回の呼び出しで再試行できる', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      )
      .mockImplementationOnce(async () => tokenResponse('token-retry'));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(auth.getToken(['scope-a'])).rejects.toThrow(/oauth2 400/);
    await expect(auth.getToken(['scope-a'])).resolves.toBe('token-retry');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('EXPIRY_SKEW_SECONDS 分前倒しで期限切れとみなし取り直す', async () => {
    // expires_in は 3600 秒（= 3_600_000ms）。EXPIRY_SKEW_SECONDS(60s) 前倒しなので
    // キャッシュは issuedAt + 3_540_000ms で切れる。1 時間丸ごと進めると skew を
    // 0 にしても（=3_600_000ms 進めても本来の期限ちょうど）このテストは通ってしまう
    // ため、skew が効く範囲である 3_550_000ms（3_540_000 < 3_550_000 < 3_600_000）
    // だけ進めて、skew 抜きでは取り直されない状況で取り直されることを確認する。
    let current = 1_000_000;
    const fetchImpl = vi.fn(async () => tokenResponse('token-6', 3600));
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => current,
    });

    await auth.getToken(['scope-a']);
    current += 3_550_000;
    await auth.getToken(['scope-a']);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('トークン取得に失敗したら ApiError を投げる', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(auth.getToken(['scope-a'])).rejects.toThrow(/oauth2 400/);
  });

  it('200 でも access_token が無ければ ApiError を投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(auth.getToken(['scope-a'])).rejects.toThrow(/oauth2 200/);
  });

  it('資格情報がパースできなければ即座に失敗する', () => {
    expect(() => createServiceAccountAuth('not-json-not-base64-json')).toThrow(
      /サービスアカウント/,
    );
  });

  it('client_email / private_key を欠く JSON は即座に失敗する', () => {
    expect(() => createServiceAccountAuth(JSON.stringify({ foo: 1 }))).toThrow(
      /client_email.*private_key/,
    );
  });

  it('client_email が文字列でなければ即座に失敗する', () => {
    expect(() =>
      createServiceAccountAuth(
        JSON.stringify({
          client_email: { value: 'test' },
          private_key: privateKey,
        }),
      ),
    ).toThrow(/client_email は空でない文字列/);
  });

  it('private_key が文字列でなければ即座に失敗する', () => {
    expect(() =>
      createServiceAccountAuth(
        JSON.stringify({
          client_email: 'test@example.com',
          private_key: 12345,
        }),
      ),
    ).toThrow(/private_key は空でない文字列/);
  });

  it('200 でも access_token が文字列でなければ ApiError を投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: { token: 'not-a-string' }, expires_in: 3600 }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const auth = createServiceAccountAuth(rawJson, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(auth.getToken(['scope-a'])).rejects.toThrow(/oauth2 200.*access_token/);
  });
});
