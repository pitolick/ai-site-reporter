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
if (breakdown.truncated) throw new Error('breakdown is truncated by limit; narrow the query');
console.log(breakdown.notSetRate);
```

`GCP_SERVICE_ACCOUNT_JSON` は 1 行 JSON でも base64 でもよい。

## 使うときの注意

- **エラーを握りつぶさない。** 存在しないパラメータ名を指定すると GA4 は `400` を返す。この API は `ApiError` を throw するので、呼び出し側が「収集源の失敗」として扱うこと。0 件で代替しない
- **用途ごとにクエリを分ける。** 例えば広告収益のメトリックは、環境によって取得可否が変わる。基本 KPI と同じ `runReport` に混ぜると、片方が取れないだけで全体が落ちる。`Promise.allSettled` で受けて、落ちた群だけを欠損として扱う設計にすること
- **GA4 のカスタムディメンションは遡及適用されない。** 登録前に届いたイベントは、あとからそのディメンションで分解できない
- **GA4 のデータ保持期間**（イベントデータ）を超えた期間は、カスタムディメンションを使うクエリでは取得できない

## API

| 関数 | 役割 |
| --- | --- |
| `createServiceAccountAuth(raw, options?)` | サービスアカウント JSON / base64 からトークンプロバイダを作る（スコープ別にキャッシュ） |
| `runReport(auth, propertyId, request, options?)` | GA4 Data API の `runReport` の薄いラッパ |
| `fetchEventCounts(auth, propertyId, params, options?)` | イベント名別の件数。指定したイベントが返らなければ 0 件として補完する。GA4 応答が `limit`（既定 200）で切り詰められていた場合は 0 件を捏造せず `ApiError` を throw する |
| `fetchParameterBreakdown(auth, propertyId, params, options?)` | 指定イベントを指定パラメータで分解し `(not set)` の件数と率を返す。応答が `limit`（既定 200）件を超えると `rowCount` は総マッチ行数を保持したまま `truncated: true` になるので、`notSetRate` 等の分母が不完全でないか呼び出し側で確認すること |
| `querySearchAnalytics(auth, siteUrl, request, options?)` | Search Console の `searchAnalytics.query` の薄いラッパ |
| `fetchPageSpeed(url, params, options?)` | PageSpeed Insights（API キーは任意） |

## ライセンス

MIT
