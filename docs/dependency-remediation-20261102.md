# 依存修正・互換性検証の経過（2026-11-02）

8-5の調査・方針承認に続く作業。P-159／8-3は未完了を保持する。P-161-A/B・P-162・P-163は独立review/security双方PASS。リリース可能の判定ではない。

## Functions（P-161-A）

lock差分はbody-parser 2.3.0→2.4.0と必須qs 6.16.0→6.17.1の2件。直接依存と公開Functionは変更していない。既存の親要求範囲内。旧版のgzip末尾データで子プロセス終了を確認し、更新後はNode 22の19ケースが成功した。JSON/rawBody/400/413と各圧縮形式を検証している。

更新後監査はFunctions dev込み26件（high 0、moderate 22、low 4）、dev除外7件（moderate 7）。残る警告を一括受入した結果ではない。実デプロイのFunctions Frameworkおよびそのparser解決先は未確認で、8-2で確認する。

## ビルド対象（P-163）

既存の本番ビルド設定がJest用性能測定ファイルも含め、Jest型を除いていたためビルドが失敗した。設定1行に__performance__の除外を追加した。通常の型チェックと性能テスト本文は保持し、製品入口の出力と性能測定ファイルの除外を別に検証する。最初のEmulator回帰はbuild段階で停止。修正後は現設定のfresh buildと安全な隔離Functions/Firestore Emulatorで既存47件・Callable未認証401が成功し、終了を確認した。

## iOS decoder（P-161-B／P-162）

本体の依存・SDK・製品コードは未変更。隔離したproduction iOS Metroで3構成を生成し、Node VMで各146操作を比較した。

| 構成 | 観測結果 |
|---|---|
| 現行0.2.2 | 146操作すべて成功 |
| 0.5.1単純差替え | 104操作でTypeError。互換性不成立 |
| query-stringのdefault橋渡し | query-string経由118操作は現行と一致。decoder直接require14件は失敗し、default importのa+bの意味も異なる |

橋渡しは隔離領域の候補であり、本体へ適用していない。親要求^0.2.2の範囲外、直接呼出しの非互換、実Hermes／full app export未検証を残す。ランナー初回の依存探索先不足とcache親未作成は、外部v2の3点修正後にbundle生成・実解決先・ソースhash照合まで確認した。

## 証跡

検証領域: /Users/jime0083/.codex/verification/gokaku/8-5-20261101

- p161-a/functions-full-after.json、functions-prod-after.json
- p161-a/review-body-parser-tests.json
- p163/implementation-f9bghd2y/REVIEW.md と summary.json
- p161-b-metro-v2-report.md
- p161-b-metro-cQ6Z8e/results.json

独立review/security双方のPASSにより上記4タスクを完了として進捗に反映した。P-161-Cの開発依存調査とdecoder本体修正は継続する。元の調査基準日は2026-11-01で、今回の更新後監査取得も同日。全依存の再監査を2026-11-02に取り直した記録ではない。

判定証跡: p161-a/review-after-p163.md、b-review-final.md、p163/review-final.md、p161-a/security-final.md。

## 開発依存の次候補

re2js 2.8.7、node-forge 1.4.2、root body-parser 1.20.9の既存親範囲内候補を公開資料で確認した。root parserだけの隔離lock候補は3フィールド差分・他依存不変で独立review PASS（P-161-C1）。本体導入・npm ci・回帰テストは未実施。P-161-C全体は未完了。証跡はp161-c/report.mdとc1-lock-candidate-__lp53si/review-final.md。
