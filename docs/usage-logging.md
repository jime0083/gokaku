# 利用量・費用ログ（8-3）

Cloud Functionsの構造化ログで、以下のeventを集計する。本番への反映は8-2のデプロイ後。

| event | 用途 |
|---|---|
| x_api_usage | 実HTTP呼出し数とUSD参考見積もり |
| x_posting_summary | 投稿処理の件数と状態別件数 |
| usage_summary / operation=daily_judgement | 判定処理・初期化・失敗・除外セッションの件数 |

## X APIの集計

- operationはpost_create / profile_read / token_exchange / token_refresh。
- requestCountの合計が実HTTP呼出し数。再試行も1回ずつ数える。プロフィールのキャッシュ再利用は数えない。
- measurement=validated_resourceは、HTTPで返ったプロフィール1件を検証した後の記録。requestCountは0なので要求数へ重複加算しない。
- estimatedCostMicroUsdを合計して1,000,000で割ると、既知部分のUSD参考値になる。
- nullは未算定。tokenの単価はunknown_unit_price、プロフィール要求段階はvalidated_resource_not_counted。nullを無料・0ドルと解釈しない。
- 投稿は1要求$0.015、検証済みプロフィールは1返却リソース$0.010。2026-10-31に[公式料金](https://docs.x.com/x-api/getting-started/pricing)を確認。
- プロフィール参考値はX側のUTC日単位の重複排除前。投稿の要求記録も成功や請求確定を意味しない。実請求額や円換算、自動停止は扱わない。

## 集計の意味

判定・投稿のsummaryは各実行の処理件数。再実行ではalready等も再び計上するため、合計をユニーク利用者数や確定日数として扱わない。

UID、Xアカウント情報、トークン、投稿本文、要求URL・ヘッダー、生例外は記録しない。ログ出力の失敗は本処理を失敗させず、投稿の再送も増やさない。その場合の記録欠落があるため請求台帳ではない。
