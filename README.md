# ai-site-reporter

GA4 / Search Console / PageSpeed Insights からサイト分析データを取得する汎用 TypeScript ライブラリ。

## 責務

**データを取得するところまで。** 閾値・判定・レポートの文章生成は持たない。イベント名もパラメータ名も**すべて引数**で受け取るため、サイト固有の知識をこのパッケージは持たない。

## 依存

**なし。** 認証（サービスアカウントの JWT 署名）から API 呼び出しまで `node:crypto` と `fetch` だけで完結する。

**ESM 専用。** `"type": "module"` で CJS 向けの条件付き export を持たないため、CommonJS（`require`）の利用側では `ERR_REQUIRE_ESM` になる。`import` で読み込むこと。

## 使い方

```ts
import {
  createServiceAccountAuth,
  fetchEventCounts,
  fetchParameterBreakdown,
} from '@pitolick/ai-site-reporter';

const auth = createServiceAccountAuth(process.env.GCP_SERVICE_ACCOUNT_JSON!);
const dateRange = { startDate: '2026-07-01', endDate: '2026-07-31' };

const counts = await fetchEventCounts(auth, propertyId, {
  dateRange,
  eventNames: ['your_event'],
});

const breakdown = await fetchParameterBreakdown(auth, propertyId, {
  dateRange,
  eventName: 'your_event',
  parameter: 'your_parameter',
});
if (breakdown.truncated) throw new Error('breakdown is incomplete; retry later');
console.log(breakdown.notSetRate);
```

`GCP_SERVICE_ACCOUNT_JSON` は 1 行 JSON でも base64 でもよい。

## 使うときの注意

- **エラーを握りつぶさない。** 存在しないパラメータ名を指定すると GA4 は `400` を返す。この API は `ApiError` を throw するので、呼び出し側が「収集源の失敗」として扱うこと。0 件で代替しない
- **用途ごとにクエリを分ける。** 例えば広告収益のメトリックは、環境によって取得可否が変わる。基本 KPI と同じ `runReport` に混ぜると、片方が取れないだけで全体が落ちる。`Promise.allSettled` で受けて、落ちた群だけを欠損として扱う設計にすること
- **GA4 のカスタムディメンションは遡及適用されない。** 登録前に届いたイベントは、あとからそのディメンションで分解できない
- **GA4 のデータ保持期間**（イベントデータ）を超えた期間は、カスタムディメンションを使うクエリでは取得できない
- **Search Console の `querySearchAnalytics` は全件取得を保証しない。** `rowLimit`（既定 1,000・最大 25,000）で切り詰められることがあり、応答に総行数は含まれない。`truncated: false` でも API の内部制限により対象データが欠落している可能性があるため、API が公開している範囲の全行が必要な場合は `querySearchAnalyticsAll` を使うこと（Search Console 側の内部制限で落ちた行は取り戻せない）

## API

| 関数 / 定数 | 役割 |
| --- | --- |
| `createServiceAccountAuth(raw, options?)` | サービスアカウント JSON / base64 からトークンプロバイダを作る（スコープ別にキャッシュ） |
| `runReport(auth, propertyId, request, options?)` | GA4 Data API の `runReport` の薄いラッパ |
| `runReportAll(auth, propertyId, request, options?)` | `runReport` を GA4 の `offset` で全ページ取得する（ページサイズ 250,000・総数は 1 ページ目の `rowCount`）。空ページが返ったらそこで打ち切るため、`rows.length < rowCount` になりうる。`limit` / `offset` は型で禁止（変数で組み立てるときは `RunReportAllRequest` で注釈する） |
| `fetchEventCounts(auth, propertyId, params, options?)` | イベント名別の件数。指定したイベントが返らなければ 0 件として補完する。GA4 応答が `limit`（既定 200）で切り詰められていた場合は 0 件を捏造せず `ApiError` を throw する |
| `fetchParameterBreakdown(auth, propertyId, params, options?)` | 指定イベントを指定パラメータで分解し `(not set)` の件数と率を返す。常に `runReportAll` で全件をページングして取る（`limit` は指定できない）。**0.3.0 で `limit` 引数を削除した（常に全件を取る）。`truncated` の意味も「limit による切り詰め」から「ページングの途中で空ページが返り打ち切った」に変わった。** `truncated` はページングが空ページで打ち切られたときだけ `true` になるので、`notSetRate` 等の分母が不完全でないか呼び出し側で確認すること |
| `querySearchAnalytics(auth, siteUrl, request, options?)` | Search Console の `searchAnalytics.query` の薄いラッパ。`{ rows, truncated }` を返す。`rows.length` が `rowLimit`（未指定なら既定 1,000）と一致すると `truncated: true` になる。`truncated: false` でも API 内部制限により全件取得は保証されないため、API が公開している範囲の全行が必要な場合は `querySearchAnalyticsAll` を使うこと（Search Console 側の内部制限で落ちた行は取り戻せない） |
| `querySearchAnalyticsAll(auth, siteUrl, request, options?)` | `querySearchAnalytics` を `startRow` で全ページ取得し、`SearchAnalyticsRow[]` を返す（ページサイズ 25,000・0 行の応答で終了・100 ページで `ApiError`）。`rowLimit` / `startRow` は型で禁止。返すのは API が公開している範囲の全行で、Search Console 側の内部制限（1 日・検索タイプあたり 50,000 行など）で落ちた行は取り戻せない（変数で組み立てるときは `SearchAnalyticsAllRequest` で注釈する） |
| `fetchPageSpeed(url, params, options?)` | PageSpeed Insights（API キーは任意）。`retries`（既定 0）と `retryDelayMs`（既定 0）を指定すると、5xx の `ApiError` に限り待ってから再試行する |
| `DEFAULT_ROW_LIMIT` | Search Console API の既定行数制限（`querySearchAnalytics` で `rowLimit` 未指定時の値） |

## ライセンス

MIT
