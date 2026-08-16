# CLAUDE.md — ai-site-reporter

## プロジェクト概要

GA4・Search Console・PageSpeed Insights からサイト分析データを取得する汎用 TypeScript ライブラリ。

- GitHub Packages の npm パッケージ（`@pitolick/ai-site-reporter`）として利用側プロジェクトから消費される想定
- **データを取得するところまでが責務。** 閾値判定・レポート文章生成・通知・Issue 起票は持たない
- サイト固有設定（GA プロパティ ID・対象イベント名・パラメータ名等）は呼び出し側から渡す
- 単独で `npm test` / `npm run typecheck` / `npm run build` が成立する自己完結リポジトリ

---

## このリポジトリの責務

| モジュール | 役割 |
| --- | --- |
| `src/types.ts` | 共通の型（`DateRange` / `HttpOptions` / `TokenProvider`）と `ApiError` |
| `src/auth/service-account.ts` | サービスアカウント JSON / base64 からトークンプロバイダを作る（JWT 署名・スコープ別キャッシュ） |
| `src/collectors/ga4.ts` | GA4 Data API の `runReport` ラッパ・イベント件数・パラメータ分解取得 |
| `src/collectors/search-console.ts` | Search Console API の `searchAnalytics.query` ラッパ |
| `src/collectors/pagespeed.ts` | PageSpeed Insights API で Core Web Vitals 取得 |

---

## 重要な設計制約

### サイト固有設定はコードに持たない

GA プロパティ ID・サイト URL・イベント名・パラメータ名等はすべて呼び出し側から引数で渡す。コードにハードコードしない。

- **サイト固有の語（利用側サービス名・イベント名）をコード・テスト・ドキュメントに書かない。** 公開パッケージのため、利用側固有の文字列が混入すると即座に情報漏洩になる。`tests/public-api.test.ts` が機械的に検査する
- **テストに実在の作品名・人名を書かない**

#### 漏洩ガードの語ベース検査（`LEAK_GUARD_WORDS`）

`tests/public-api.test.ts` の語ベース検査（禁止語の混入チェック）は、リポジトリに具体的な語をハードコードしないため既定では skip される。検出したい語を実行環境の `LEAK_GUARD_WORDS` にカンマ区切りで渡すと、その語を対象に検査が有効になる（ドメイン・数値 ID のパターン検査は環境変数に関係なく常に走る）。

---

## 技術スタック

| 項目 | 採用技術 |
| --- | --- |
| 言語 | TypeScript 6.0+ |
| ランタイム | Node.js 20+ (ESM) |
| 外部 API | GA4 Data API / Search Console API / PageSpeed Insights API |
| 外部依存 | なし（`node:crypto` + `fetch` のみで認証・API 呼び出しを完結させる） |
| テスト | Vitest（外部 API はすべてモック） |
| Lint | ESLint 10 (flat config) |
| Formatter | Prettier 3 |

---

## 開発ルール

- コミットメッセージ・PR・Issue はすべて日本語で記述
- 外部 API 呼出しは必ずモックしてテスト可能にする
- サイト固有設定をコードにハードコードしない

### コミットメッセージ形式

```
feat: 〇〇機能を追加
fix: 〇〇のバグを修正
chore: ライブラリを更新
test: テストを追加・修正
refactor: 〇〇をリファクタリング
docs: ドキュメントを更新
```

---

## 動作確認とレビューの分担

- **機械的に検証できる「動くか」の確認は自動テスト（Vitest）と CI で行い、人間に手動確認させない**。本パッケージは UI を持たない汎用 TS のため通常は Vitest で十分。利用側での結合確認が必要なら、その E2E は利用側のリポジトリで回す。
- **実装が一通り終わった後のテストは必須**。途中の PR でも相応のテストを用意し、機械確認を人間に肩代わりさせない。
- **人間のレビューは人間にしか判断できない観点に限定する**：実装が要件・意図通りか、API 設計の妥当性、ほかに追加すべき要望がないか等。

---

## 仕様書の場所

設計の全体像は利用側プロジェクトの設計書を参照する。このリポジトリ単体での公開仕様は README.md と `src/types.ts` の TSDoc に集約する。
