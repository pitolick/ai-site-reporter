# ai-site-reporter

サイト分析・改善提案の汎用 TypeScript ライブラリ。GA4・Search Console・PageSpeed・AdSense からデータを取得し、Claude API で分析して GitHub Issue + Slack 通知。

## 責務

- 外部分析データ収集（GA4 / SC / PageSpeed / AdSense）
- Claude API で分析・改善提案生成
- 改善点がある場合のみ GitHub Issue を個別起票
- Slack に月次サマリ通知

## ステータス

骨組みのみ。実装は Phase 3（[`pitolick/ecomi`](https://github.com/pitolick/ecomi) の plan 参照）で進める。

## ライセンス

MIT
