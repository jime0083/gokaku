# 8-5 依存脆弱性の再確認（2026-11-01）

調査のみを実施。8-3・P-159は未完了のまま保持する。依存・lock・製品コードの更新、本番操作、旧リスク受入の変更は行っていない。調査はreview/security PASS、方針も2026-11-01にユーザー承認。8-5の調査/方針決定は完了し、実修正・互換性検証はP-161-A/B/Cで継続する。

| 対象 | 影響package数 | high / moderate / low | 重複除外GHSA数 |
|---|---:|---|---:|
| root・dev込み | 93 | 24 / 63 / 6 | 55 |
| root・dev除外 | 54 | 16 / 33 / 5 | 37 |
| Functions・dev込み | 28 | 1 / 23 / 4 | 6 |
| Functions・dev除外 | 9 | 1 / 8 / 0 | 5 |

package数には依存元への伝播が含まれる。npmのprod分類は、iOSで実行されるコードの分類とは異なる。critical報告は0件。

## 優先対応と確認できた範囲

| 対象 | 現在 | 調査結果・更新候補 |
|---|---|---|
| decode-uri-component | 0.2.2 / highを含む2 GHSA | production iOSソースマップに含有。query-string 7.1.3経由、親要求は^0.2.2。修正版0.5.1は範囲外かつESM。CJS呼出元との相互運用・Metro・既存URL挙動の互換性検証が先。実攻撃成立や全deep linkの到達性は未確認。 |
| body-parser | Functions 2.3.0 / high | firebase-functions 7.4.0 → express 5.2.1 → body-parser。2.4.0は親要求^2.2.1内。公開Functions Framework v5.0.5はアプリhandler前にparserを登録しinflateを無効にしていない。実デプロイのFramework版・解決先・前段proxy・悪用到達は未検証。lock更新だけで実runtimeが直るとは断定しない。 |
| @grpc/grpc-js等 | rootで複数報告 | advisory発生元18 packageのうち、今回のiOS JSに載るのはdecoderのみ。grpc・xmldom・node-forge・re2js・zod・uuid等17 packageは非含有。native SDKの安全性や、CLI/ビルド/テスト経路の安全性を保証する結果ではない。 |
| Functions qs / glob / minimatch | moderate | qsの今回の条件はcomma形式のstringify。確認したHTTP parserはparseを使う。globはserver optional依存にもあるが通常requestからの発火経路は未確認。互換更新候補と親のmajor更新を分ける。 |
| Functions uuid | 9.0.1 / moderate | gaxios 6.7.1の確認した呼出しは現在も無引数v4()。当該advisoryのv3/v5/v6＋buffer条件に該当しない。この限定した既存利用についての根拠であり、全利用・将来コードの悪用不可の保証ではない。 |

iOS含有は現在のproduction exportの1,537 sourcesを照合した結果。含有自体は実行・攻撃成立の証明ではない。未検出はこの生成JSに限定する。

## 過去の判断との違い

P-001のdecoderのmoderateに、別のhigh advisoryが追加されている。旧受入を新しい警告へ自動適用しない。旧braces・sprintf-js系統は今回のaudit報告に現れなかったが、旧problemの解決状態は変更していない。

P-010のFunctions uuid利用条件は確認した経路で維持されている。body-parser・qs等の新規警告まで旧受入で覆わない。P-020のgrpc/xmldomについても今回のJS含有結果を追加資料とし、元の状態・承認有無は変更しない。

## 対応方針（2026-11-01ユーザー承認）

1. リリース前の優先対応を、Functionsのbody-parser互換更新候補と、iOS decoder修正方法の互換性検証に置く。修正版があることと、既存構成へそのまま入ることは分けて確認する。
2. 開発・ビルド・テスト依存は、親の既存範囲に収まる候補から小単位で検討する。すべての警告を一括で受け入れたり、自動更新で解消済みにしたりしない。
3. uuidの確認済み無引数v4利用は、継続受入の判断材料とする。新規・別経路は別評価。
4. auditが提案するRNFirebase 26→20、Firebase 12→9、Jest 29→25等のdowngrade、Expo Router 57→58やESM overrideは検証済みの安全な更新案ではない。必要なmajor変更は別途確認する。
5. 実修正時は対象の回帰・型・lintと隔離環境で検証し、最後に監査を再実行する。実runtimeのparser解決先は本番設定準備でも確認する。

## 根拠と限界

- [body-parser maintainer advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828)：圧縮本文の末尾データによる未処理error、修正版2.4.0/1.20.9。
- [decoder maintainer advisory](https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-qr28-fpjm-wq7f)：不正なpercent-encoded入力の計算量、修正版0.5.1。
- [decoder 0.5.1 package定義](https://github.com/SamVerschueren/decode-uri-component/blob/v0.5.1/package.json)：ESM。
- [Functions Framework v5.0.5](https://github.com/GoogleCloudPlatform/functions-framework-nodejs/blob/v5.0.5/src/server.ts)：parser登録とhandler順序。これは実デプロイの解決版を示す資料ではない。
- [監査の生集計](/Users/jime0083/.codex/verification/gokaku/8-5-20261101/audit-summary.json)
- [rootの全経路・advisory一覧](/Users/jime0083/.codex/verification/gokaku/8-5-20261101/root-analysis.md)
- [Functionsの全経路・利用条件](/Users/jime0083/.codex/verification/gokaku/8-5-20261101/functions-dependency-analysis.md)
- [iOS JS含有の照合](/Users/jime0083/.codex/verification/gokaku/8-5-20261101/ios-bundle-membership.json)

本調査は修正実装・互換性試験・本番での悪用実証を含まない。P-159の根因特定や8-3合格を意味しない。
