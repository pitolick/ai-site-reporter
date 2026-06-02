# CLAUDE.md — ai-site-reporter

## プロジェクト概要

サイト分析・改善提案の汎用 TypeScript ライブラリ。GA4・Search Console・PageSpeed・AdSense からデータを取得し、Claude API で分析して GitHub Issue 起票 + Slack 通知を行う。

- 複数の WordPress 投稿プロジェクトから submodule として利用される想定
- WordPress と連携しない（外部 API → Claude → Issue/Slack のパイプライン）
- サイト固有設定（GA プロパティ ID・対象リポジトリ等）は呼び出し側から渡す
- 単独で `npm test` / `npm run typecheck` が成立する自己完結リポジトリ

Issue の起票・Claude Code GitHub Actions の起動は通常、利用側の親リポジトリで行う（このライブラリは PR レビューのみ）。

---

## このリポジトリの責務

| モジュール | 役割 |
|---|---|
| `src/collectors/ga4.ts` | GA4 Data API でデータ取得 |
| `src/collectors/search-console.ts` | Search Console API でクエリ・順位取得 |
| `src/collectors/pagespeed.ts` | PageSpeed Insights API で Core Web Vitals 取得 |
| `src/collectors/adsense.ts` | AdSense Management API で広告収益取得 |
| `src/analyzer.ts` | Claude API で分析・改善提案を構造化 JSON で生成 |
| `src/reporters/github-issues.ts` | 改善提案を GitHub Issue として個別起票（`@claude` メンション付き） |
| `src/reporters/slack.ts` | Slack に月次サマリ通知 |
| `src/pipeline.ts` | 上記を組み合わせた月次レポート実行 |

---

## 重要な設計制約

### Issue 起票ロジック

- `improvements: []` （改善点 0 件）→ Issue 起票なし（Slack サマリのみ）
- `improvements: [...]` → 提案ごとに個別 Issue を起票

### Claude 認証の抽象化

API キー（従量課金）と Claude Code OAuth Token（既存サブスク）の両方をサポート（`@pitolick/ai-article-poster` と同じ `ClaudeAuth` インターフェース）。

### サイト固有設定はコードに持たない

GA プロパティ ID・対象リポジトリ・サイト URL・分析対象スコープ等はすべて `siteContext` オプションで呼び出し側から渡す。コードにハードコードしない。

---

## 技術スタック

| 項目 | 採用技術 |
|---|---|
| 言語 | TypeScript 5.6+ |
| ランタイム | Node.js 20+ (ESM) |
| 外部 API | GA4 Data API / Search Console API / PageSpeed Insights API / AdSense Management API（Google API Client ライブラリ） |
| AI | Claude API（分析・提案生成） |
| 通知 | Slack Incoming Webhook / GitHub REST API |
| テスト | Vitest（外部 API はすべてモック） |
| Lint | ESLint 9 (flat config) |
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

- **機械的に検証できる「動くか」の確認は自動テスト（Vitest）と CI で行い、人間に手動確認させない**。UI を持つ実装は Playwright による E2E で検証する（本パッケージは UI を持たない汎用 TS のため通常は Vitest で十分。利用側での結合確認が必要なら、その E2E は CI または Docker 上の実行環境で回す）。
- **実装が一通り終わった後のテストは必須**。途中の PR でも相応のテストを用意し、機械確認を人間に肩代わりさせない。
- **人間のレビューは人間にしか判断できない観点に限定する**：実装が要件・意図通りか、API 設計の妥当性、ほかに追加すべき要望がないか等。

---

## 仕様書の場所

設計の全体像は利用側プロジェクトの設計書を参照する。このリポジトリ単体での公開仕様は README.md と `src/types.ts` の TSDoc に集約する。
