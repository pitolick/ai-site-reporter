# CLAUDE.md — pitolick/ai-site-reporter

## プロジェクト概要

「ええこみ！」ブログ（`e-comi.pitolick.com`）で使用する **汎用サイト分析レポートプラグイン**。

- **ecomi リポジトリのサブモジュール**として `plugins/ai-site-reporter/` に配置される
- GA4 Data API と Search Console API からデータを取得し、Claude API で分析・改善提案を生成して Slack に送信する
- ええこみ固有のロジックは含めない。サイト URL・プロパティ ID は設定画面から入力する

Issue の起票・Claude Code GitHub Actions の起動は **`pitolick/ecomi` リポジトリで行う**。

---

## このリポジトリの責務

| クラス | 役割 |
|--------|------|
| `src/AnalyticsCollector.php` | GA4 Data API + Search Console API でデータ取得 |
| `src/ReportGenerator.php` | Claude API でデータを分析・改善提案テキストを生成 |
| `src/SlackNotifier.php` | Slack Incoming Webhook でレポートを送信 |
| `src/Settings.php` | GCP サービスアカウント JSON・Slack URL を WP 管理画面で設定 |

**実行タイミング**: WP-Cron で月1回（毎月1日）

---

## ディレクトリ構成

```
ai-site-reporter/
├── CLAUDE.md
├── composer.json
├── grumphp.yml
├── phpcs.xml
├── .php-cs-fixer.php
├── phpunit.xml
├── .coderabbit.yaml
├── .env.example
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── auto-merge.yml
│   ├── dependabot.yml
│   └── pull_request_template.md
├── src/
│   ├── AnalyticsCollector.php
│   ├── ReportGenerator.php
│   ├── SlackNotifier.php
│   └── Settings.php
├── tests/
│   └── Unit/
├── vendor/
└── ai-site-reporter.php
```

---

## 重要な設計制約

### GCP サービスアカウントの管理

- JSON キーはサーバー上のファイルとして保存しない
- WordPress 管理画面のテキストエリアに JSON の全文を貼り付けて保存する
- `get_option()` で取得した JSON テキストを `json_decode()` してクライアント初期化に使う
- 保存時は AES-256-CBC で暗号化する

```php
// 例: GCP クライアント初期化
$json = json_decode(decrypt_option('ai_site_reporter_gcp_json'), true);
$client = new Google_Client();
$client->setAuthConfig($json);
```

### Slack レポートのフォーマット

Slack へ送信するレポートには以下を含める:

```
【月次サイトレポート】YYYY年MM月
━━━━━━━━━━━━━━━
📊 トラフィック概要
  セッション数: X,XXX（前月比 +XX%）
  ページビュー: X,XXX
  直帰率: XX%

🔍 検索パフォーマンス
  クリック数: X,XXX
  表示回数: XX,XXX
  平均掲載順位: XX位

💡 Claude による分析・改善提案
  [Claude が生成したテキスト]

⚠️ 要対応事項
  [優先度の高い改善点]
━━━━━━━━━━━━━━━
```

### 権限設定（GCP）

- GA4: サービスアカウントを「閲覧者」として追加
- Search Console: サービスアカウントを「制限付きユーザー」として追加
- 権限は読み取り専用に限定すること

### API キー管理

設定値はすべて WordPress 管理画面（`設定 > AI Site Reporter`）から入力し、AES-256-CBC で暗号化して DB に保存する。

---

## 技術スタック

| 項目 | 採用技術 |
|------|---------|
| 言語 | PHP 8.1 |
| 外部 API | GA4 Data API・Search Console API（Google Client Library for PHP） |
| AI | Claude API（分析・提案テキスト生成） |
| 通知 | Slack Incoming Webhook |
| テスト | PHPUnit + WP_Mock（外部 API はモック） |
| Lint | PHP_CodeSniffer（WordPress Coding Standards） |
| フォーマット | PHP CS Fixer |
| Git フック | GrumPHP |

---

## 開発ルール

- コミットメッセージ・PR・Issue はすべて日本語で記述する
- GA4 API・Search Console API・Claude API の呼び出しはすべてモックしてテストを書く
- ええこみ固有の設定値（サイト URL・プロパティ ID 等）をコードにハードコードしない

### コミットメッセージ形式

```
feat: 〇〇機能を追加
fix: 〇〇のバグを修正
chore: ライブラリを更新
test: テストを追加・修正
refactor: 〇〇をリファクタリング
style: フォーマット修正
```

---

## GCP セットアップ手順（初回のみ・人間が実施）

1. Google Cloud Console でプロジェクト作成
2. GA4 Data API・Search Console API を有効化
3. サービスアカウントを作成し JSON キーをダウンロード
4. GA4 プロパティに「閲覧者」としてサービスアカウントを追加
5. Search Console に「制限付きユーザー」としてサービスアカウントを追加
6. WordPress 管理画面 → 設定 > AI Site Reporter に JSON テキストを貼り付けて保存

---

## 仕様書の場所

| ドキュメント | 参照すべきセクション |
|------------|------------------|
| Cowork: `docs/01_企画・要件定義.md` | §4-7（サイト分析レポートプラグイン仕様）・§8（運用管理方針・レポートフォーマット） |
| Cowork: `docs/02_プラグイン開発・運用手順書.md` | §5（API キー管理）・§6（テスト）・§7（lint） |

---

## 関連リポジトリ

| リポジトリ | 関係 |
|-----------|------|
| `pitolick/ecomi` | 親リポジトリ（Issue 起票・WP-Cron スケジュール管理） |
