import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as api from '../src/index.js';

/** このテスト自身は禁止語を文字列として持つため検査対象から除外する。 */
const SELF = 'tests/public-api.test.ts';

/**
 * 語ベースの検査で使う禁止語リスト。**このリポジトリにハードコードしない。**
 * 利用側固有のサービス名・イベント名を書くとその漏洩自体を公開リポジトリに
 * 残してしまうため、カンマ区切りで環境変数 `LEAK_GUARD_WORDS` から渡す
 * （使い方は CLAUDE.md 参照）。空のときは語ベースの検査を skip する。
 */
const FORBIDDEN = (process.env.LEAK_GUARD_WORDS ?? '')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);

/** 9〜10 桁の数字列（GA4 プロパティ ID 等、実サイトの識別子の疑い）を抽出する。 */
function findNumericIds(content: string): string[] {
  return content.match(/\b\d{9,10}\b/g) ?? [];
}

/**
 * 利用側のドメインパターン（`<サブドメイン>.<運営ドメイン>` 形式）を抽出する。
 * domains リストから「ドットを含むエントリ」のみを対象にする
 * （ドット無し = 語ベース検査。ドット有り = ドメイン検査）。
 * 正規表現にする前にメタ文字をエスケープする。
 */
function findDomainPatterns(content: string, domains: string[]): string[] {
  const domainEntries = domains.filter((d) => d.includes('.'));
  if (domainEntries.length === 0) return [];

  // 各ドメインについて `<サブドメイン>.<ドメイン>` の形にマッチさせる
  const patterns = domainEntries.map((domain) => {
    // メタ文字をエスケープ（. → \. など）
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `[a-z0-9-]+\\.${escaped}`;
  });
  const regex = new RegExp(patterns.join('|'), 'gi');
  return content.match(regex) ?? [];
}

/** 禁止語（大小無視）を検出する。 */
function findForbiddenWords(content: string, words: string[]): string[] {
  const lower = content.toLowerCase();
  return words.filter((word) => lower.includes(word.toLowerCase()));
}

/**
 * テストで使う架空のプレースホルダ。9 桁だが単純な昇順の作り物の数字列で
 * 実サイトの識別子ではないため許可する（tests/collectors/ga4.test.ts）。
 */
const ALLOWED_NUMERIC_IDS = new Set(['123456789']);

/**
 * `git ls-files` の出力を走査対象にする。手書きの allowlist だと将来追加される
 * 設定ファイル等が漏れるため、追跡下のファイル全体を対象にし、
 * 自分自身（`SELF`）と `package-lock.json`（npm 由来の生成物）だけ除外する。
 */
function scanTargets(): string[] {
  const output = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path !== SELF && path !== 'package-lock.json');
}

/** バイナリ等で読めないファイルは検査をスキップする（過剰にしないための最小限の配慮）。 */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const targets = scanTargets();

describe('公開 API', () => {
  it('collector と認証を export している', () => {
    expect(typeof api.createServiceAccountAuth).toBe('function');
    expect(typeof api.runReport).toBe('function');
    expect(typeof api.fetchEventCounts).toBe('function');
    expect(typeof api.fetchParameterBreakdown).toBe('function');
    expect(typeof api.querySearchAnalytics).toBe('function');
    expect(typeof api.fetchPageSpeed).toBe('function');
  });

  it('走査対象となる git 追跡ファイルが 1 件以上存在する', () => {
    expect(targets.length).toBeGreaterThan(0);
  });
});

describe('サイト固有の語が混入していない（LEAK_GUARD_WORDS 必須）', () => {
  if (FORBIDDEN.length === 0) {
    it.skip('LEAK_GUARD_WORDS が未設定のため語ベースの検査を skip', () => {});
  } else {
    it.each(targets)('%s', (path) => {
      const content = readTextOrNull(path);
      if (content === null) return;
      expect(findForbiddenWords(content, FORBIDDEN)).toEqual([]);
    });
  }
});

describe('実サイトの数値 ID（9〜10 桁）が混入していない', () => {
  it.each(targets)('%s', (path) => {
    const content = readTextOrNull(path);
    if (content === null) return;
    const unexpected = findNumericIds(content).filter((id) => !ALLOWED_NUMERIC_IDS.has(id));
    expect(unexpected).toEqual([]);
  });
});

describe('利用側のドメイン識別子（運営ドメインのサブドメイン）が混入していない', () => {
  const domains = FORBIDDEN.filter((d) => d.includes('.'));
  if (FORBIDDEN.length === 0 || domains.length === 0) {
    it.skip(
      FORBIDDEN.length === 0
        ? 'LEAK_GUARD_WORDS が未設定のためドメイン検査を skip'
        : 'LEAK_GUARD_WORDS にドメイン（ドット含むエントリ）が無いため検査を skip',
      () => {},
    );
  } else {
    it.each(targets)('%s', (path) => {
      const content = readTextOrNull(path);
      if (content === null) return;
      expect(findDomainPatterns(content, domains)).toEqual([]);
    });
  }
});

describe('検出ロジックそのものの positive / negative テスト', () => {
  it('9〜10 桁の数値 ID を検出する', () => {
    expect(findNumericIds('property id is 987654321 here')).toEqual(['987654321']);
  });

  it('プレースホルダとして許可した数値 ID は不審 ID から除外できる', () => {
    const unexpected = findNumericIds('123456789').filter((id) => !ALLOWED_NUMERIC_IDS.has(id));
    expect(unexpected).toEqual([]);
  });

  it('サブドメイン付きのドメイン（ドット含むエントリ）を検出する', () => {
    expect(findDomainPatterns('see https://example.example.com/path', ['example.com'])).toEqual([
      'example.example.com',
    ]);
  });

  it('サブドメイン無しのドメイン単体は検出しない', () => {
    expect(findDomainPatterns('example.com はサブドメインが無い', ['example.com'])).toEqual([]);
  });

  it('複数ドメインを同時にチェックできる', () => {
    const content = 'check https://api.example.com and https://cdn.sample.org here';
    expect(findDomainPatterns(content, ['example.com', 'sample.org'])).toEqual([
      'api.example.com',
      'cdn.sample.org',
    ]);
  });

  it('ドット無しのエントリはドメイン検査から除外される', () => {
    // ドット無し = 語ベース検査として扱うため、ドメイン検査では無視される
    expect(findDomainPatterns('somebrand.example.com', ['somebrand'])).toEqual([]);
  });

  it('メタ文字がエスケープされ、ドット以外の任意文字にマッチしない', () => {
    // 'exampleXcom' は 'example.com' にマッチしてはいけない
    // （. がメタ文字として使われていないことを確認）
    expect(findDomainPatterns('exampleXcom should not match', ['example.com'])).toEqual([]);
  });

  it('ドメインリストが空なら何も検出しない', () => {
    expect(findDomainPatterns('example.example.com exists', [])).toEqual([]);
  });

  it('語リストを渡すとその語を検出する', () => {
    expect(findForbiddenWords('this contains FooBarBaz token', ['foobarbaz'])).toEqual([
      'foobarbaz',
    ]);
  });

  it('語リストが空なら何も検出しない', () => {
    expect(findForbiddenWords('foobarbaz', [])).toEqual([]);
  });
});
