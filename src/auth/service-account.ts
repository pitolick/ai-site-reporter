import { createSign } from 'node:crypto';
import { fetchJson } from '../http.js';
import { ApiError, type TokenProvider } from '../types.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** 期限ちょうどでの失効を避けるための前倒し秒数。 */
const EXPIRY_SKEW_SECONDS = 60;

export interface ServiceAccountCredential {
  client_email: string;
  private_key: string;
}

export interface AuthOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * `{` で始まれば JSON、そうでなければ base64 とみなしてデコードする。
 * 1 行 JSON を環境変数に貼るときの事故を吸収するため。
 */
export function parseServiceAccountCredential(raw: string): ServiceAccountCredential {
  const trimmed = raw.trim();
  const json = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');

  let parsed: Partial<ServiceAccountCredential>;
  try {
    parsed = JSON.parse(json) as Partial<ServiceAccountCredential>;
  } catch {
    throw new Error('サービスアカウントの資格情報を JSON としてパースできません');
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('サービスアカウントの資格情報に client_email / private_key がありません');
  }

  if (typeof parsed.client_email !== 'string' || parsed.client_email.trim() === '') {
    throw new Error('サービスアカウントの client_email は空でない文字列である必要があります');
  }

  if (typeof parsed.private_key !== 'string' || parsed.private_key.trim() === '') {
    throw new Error('サービスアカウントの private_key は空でない文字列である必要があります');
  }

  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function createServiceAccountAuth(raw: string, options: AuthOptions = {}): TokenProvider {
  const credential = parseServiceAccountCredential(raw);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  const cache = new Map<string, { token: string; expiresAtMs: number }>();

  return {
    async getToken(scopes: string[]): Promise<string> {
      const key = scopes.join(' ');
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAtMs) return cached.token;

      const issuedAt = Math.floor(now() / 1000);
      const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = base64url(
        JSON.stringify({
          iss: credential.client_email,
          scope: key,
          aud: TOKEN_ENDPOINT,
          iat: issuedAt,
          exp: issuedAt + 3600,
        }),
      );
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      const assertion = `${header}.${claims}.${base64url(signer.sign(credential.private_key))}`;

      const { status, body } = await fetchJson<{ access_token?: string; expires_in?: number }>(
        'oauth2',
        fetchImpl,
        TOKEN_ENDPOINT,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }).toString(),
        },
      );
      if (!body.access_token || typeof body.access_token !== 'string') {
        throw new ApiError(
          'oauth2',
          status,
          `access_token は空でない文字列である必要があります: ${JSON.stringify(body.access_token)}`,
        );
      }

      const lifetime = body.expires_in ?? 3600;
      cache.set(key, {
        token: body.access_token,
        expiresAtMs: now() + (lifetime - EXPIRY_SKEW_SECONDS) * 1000,
      });
      return body.access_token;
    },
  };
}
