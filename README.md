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
- **5xx の再試行は `HttpOptions` の `retries`（既定 0）と `retryDelayMs`（既定 0）で指定する。** 全 collector と `createServiceAccountAuth` の `options` で共通。**collector の `options` はトークン取得には効かない**（トークン取得を再試行したいときは `createServiceAccountAuth` にも `retries` / `retryDelayMs` を渡す）。再試行するのは 5xx の `ApiError` だけで、4xx（429 を含む）とネットワーク・中断の例外は再試行しない。ページングする関数（`runReportAll` / `querySearchAnalyticsAll`）はページ単位で再試行する
- **Search Console の `querySearchAnalytics` は全件取得を保証しない。** `rowLimit`（既定 1,000・最大 25,000）で切り詰められることがあり、応答に総行数は含まれない。`truncated: false` でも API の内部制限により対象データが欠落している可能性があるため、API が公開している範囲の全行が必要な場合は `querySearchAnalyticsAll` を使うこと（Search Console 側の内部制限で落ちた行は取り戻せない）

## API

| 関数 / 定数 | 役割 |
| --- | --- |
| `createServiceAccountAuth(raw, options?)` | サービスアカウント JSON / base64 からトークンプロバイダを作る（スコープ別にキャッシュ）。collector に渡す `options` はここには引き継がれないので、必要なら別途渡す。トークン取得も `options.retries` / `options.retryDelayMs` で 5xx を再試行できる |
| `runReport(auth, propertyId, request, options?)` | GA4 Data API の `runReport` の薄いラッパ。0.5.0 から、応答の注意（`(other)` 行による欠損・しきい値処理・サンプリング）を `metadata` で返す（`runReportAll` はページをまたいで OR でまとめる）。**`Ga4Report` 型の `metadata` は必須なので、テストなどで `Ga4Report` を型付きで組み立てている場合は `metadata` を足すこと** |
| `runReportAll(auth, propertyId, request, options?)` | `runReport` を GA4 の `offset` で全ページ取得する（ページサイズ 250,000・総数は 1 ページ目の `rowCount`）。空ページが返ったらそこで打ち切るため、`rows.length < rowCount` になりうる。`limit` / `offset` は型で禁止（変数で組み立てるときは `RunReportAllRequest` で注釈する） |
| `fetchEventCounts(auth, propertyId, params, options?)` | イベント名別の件数。指定したイベントが返らなければ 0 件として補完する。GA4 応答が `limit`（既定 200）で切り詰められていた場合は 0 件を捏造せず `ApiError` を throw する |
| `fetchParameterBreakdown(auth, propertyId, params, options?)` | 指定イベントを指定パラメータで分解し `(not set)` の件数と率を返す。常に `runReportAll` で全件をページングして取る（`limit` は指定できない）。**0.3.0 で `limit` 引数を削除した（常に全件を取る）。`truncated` の意味も「limit による切り詰め」から「ページングの途中で空ページが返り打ち切った」に変わった。** `truncated` はページングが空ページで打ち切られたときだけ `true` になるので、`notSetRate` 等の分母が不完全でないか呼び出し側で確認すること |
| `fetchGroupedCounts(auth, propertyId, params, options?)` | 指定したキー（GA4 ディメンション、1 つ以上）ごとに件数を数え、期間・列ごとに返す（0.5.0 で追加）。`dateRanges`（1〜4 個・名前付き）で前月比なども 1 回で取れる。`splitBy` でディメンションの値ごとに列を分ける（例: `eventName`）か、無指定ならメトリックごとに列を作る。キーが `(not set)` の行と、キー・`splitBy` の値・期間のどれかが `(other)` の行は `rows` から外して `excluded` に数え、ラベル（`label`）はキーごとに先頭の期間で件数の多い値を採る。返らなかった期間・列は 0 で埋める。率や閾値の判断は呼び出し側で行う。使い方は下の「キーごとの件数」 |
| `eventParam(name)` / `itemParam(name)` | イベントスコープ / アイテムスコープのカスタムディメンション名（`customEvent:<name>` / `customItem:<name>`）を組み立てる |
| `NOT_SET` / `OTHER` / `MAX_DATE_RANGES` | GA4 が値の無いディメンションに返す `(not set)`、値の種類が多すぎるときにまとめる `(other)`、1 リクエストの日付範囲の上限（4） |
| `querySearchAnalytics(auth, siteUrl, request, options?)` | Search Console の `searchAnalytics.query` の薄いラッパ。`{ rows, truncated }` を返す。`rows.length` が `rowLimit`（未指定なら既定 1,000）と一致すると `truncated: true` になる。`truncated: false` でも API 内部制限により全件取得は保証されないため、API が公開している範囲の全行が必要な場合は `querySearchAnalyticsAll` を使うこと（Search Console 側の内部制限で落ちた行は取り戻せない） |
| `querySearchAnalyticsAll(auth, siteUrl, request, options?)` | `querySearchAnalytics` を `startRow` で全ページ取得し、`SearchAnalyticsRow[]` を返す（ページサイズ 25,000・0 行の応答で終了・100 ページで `ApiError`）。`rowLimit` / `startRow` は型で禁止。返すのは API が公開している範囲の全行で、Search Console 側の内部制限（1 日・検索タイプあたり 50,000 行など）で落ちた行は取り戻せない（変数で組み立てるときは `SearchAnalyticsAllRequest` で注釈する） |
| `fetchPageSpeed(url, params, options?)` | PageSpeed Insights（`params` は `{ strategy, apiKey? }`・API キーは任意）。再試行は他の collector と同じく `options.retries` / `options.retryDelayMs` で指定する。**0.4.0 で `params.retries` / `params.retryDelayMs` を削除した。`options` で渡すこと。型付きの変数や素の JavaScript 経由で `params.retries` を渡しても型エラーにならず、黙って無視される（再試行されない）ので、必ず `options` へ移すこと。** |
| `DEFAULT_ROW_LIMIT` | Search Console API の既定行数制限（`querySearchAnalytics` で `rowLimit` 未指定時の値） |

## キーごとの件数（`fetchGroupedCounts`）

表示イベントとクリックイベントの件数を、アイテム ID ごとに今月と前月で取り、率は呼び出し側で計算する例:

```ts
import { eventParam, fetchGroupedCounts } from '@pitolick/ai-site-reporter';

const result = await fetchGroupedCounts(auth, propertyId, {
  dateRanges: [
    { name: 'current', startDate: '2026-07-01', endDate: '2026-07-31' },
    { name: 'previous', startDate: '2026-06-01', endDate: '2026-06-30' },
  ],
  keys: [eventParam('your_item_id')],
  label: eventParam('your_item_title'),
  metrics: ['eventCount'],
  splitBy: 'eventName',
  filter: { dimension: 'eventName', values: ['your_view_event', 'your_click_event'] },
});
if (result.truncated) throw new Error('grouped counts are incomplete; retry later');
if (result.metadata.dataLossFromOtherRow) console.warn('some items are folded into (other)');

for (const row of result.rows) {
  const now = row.counts.current;
  const rate = now.your_view_event === 0 ? null : now.your_click_event / now.your_view_event;
  console.log(row.label ?? row.keys[0], rate, row.counts.previous);
}
```

- **キーを複数にする**: `keys: ['pagePath', eventParam('your_item_id')]` で「ページ × アイテム」に分けられる
- **e コマースのアイテム**: `keys: ['itemId']`, `label: 'itemName'`, `metrics: ['itemsViewed', 'itemsClickedInList']` のように、`splitBy` を付けずにメトリックごとの列で取る
- **組み合わせられないディメンションとメトリックがある。** 例えば `eventName` とアイテムスコープのディメンション（`itemId` など）は一緒に使えず、GA4 は `400` を返す（`ApiError` が throw される）
- **件数専用。** メトリックの値は非負整数として読む（売上の合計や平均時間のような値は扱えない）
- **`metadata.dataLossFromOtherRow` が true なら、アイテム別の数字が欠けている。** GA4 は値の種類が多すぎるディメンションの残りを `(other)` 行にまとめる。まとめられた件数は `excluded.other`（期間・列ごと）と `excluded.otherUnattributed`（期間や列まで `(other)` になって分けられない分。メトリック名ごと）に入る。普通のキーでも `splitBy` の値が `(other)` の行はそのキーの件数から外れるので、`rows` の件数は少なめに出る。期間を短くするなどして問い合わせを分けること
- **ラベルは先頭の期間を基準に選ぶ。** 名前が途中で変わったとき、今月（`dateRanges` の先頭）の名前が出るように、先頭の期間で件数の多い値を採る（`splitBy` 指定時は全列の合計、無指定時は第 1 メトリック）。先頭の期間に値が無いキーは次の期間を見る
- **`filter` は大文字小文字まで一致させる。** GA4 の既定は区別しないが、イベント名などは区別されるため、この関数は区別して絞り込む
- **`splitBy` は値の種類が少ないディメンションに使う。** 列の数だけ全キー・全期間のセルを作るため、`pagePath` のような値の多いディメンションを列にすると重くなる。値の多いものは `keys` に入れる

## ライセンス

MIT
