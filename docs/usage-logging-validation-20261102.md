# 8-3再開時の検証（2026-11-02）

2026-11-02時点の検証記録。2026-11-04に修正と統合回帰を完了した。

- Node 22.19.0・demo-gokakuの隔離Firestore Emulatorで統合を1回実施。
- 36 suite中35成功。テスト本体1543件すべて成功、失敗・skipは0。
- historyReaderの既存afterAllが5000msでtimeoutとなり、suite/CLIはexit 1。
- 全体型チェック・lint・差分チェックは成功。所有Emulatorの終了とポート解放を確認。
- P-160の1ケースだけの30秒budget修正は独立review/security PASS。既存3 assertion・SDK・製品は保持。元timeoutの直接原因未確定という監視は継続。
- P-159はNode 22でも再現。Node世代だけを原因としない。過去cacheを削除せず、元test/SDK/timeout/業務処理も変更していない。
- SDKを使わないInspector事前fixtureは2回とも5秒deadlineで不成立。2回目は接続開始後のDebugger.enable応答前まで確認した。根因は未確定（P-164）。実historyReaderの追加実行は行っていない。
- AGENTS.mdの同じ問題2回で停止する規定に従い、3回目の試行は行わない。

## 証跡

外部検証領域 /Users/jime0083/.codex/verification/gokaku/8-3-resume-20261102:

- integration/integration-summary.json / integration-tests.json / integration.log
- checks.json
- p160-independent-review.md / security-p160-verdict.md
- review-final.md / security-8-3-verdict.md

P-159/P-164の計画と事前検証要約:
 /Users/jime0083/.codex/verification/gokaku/p159-20261102/observation-plan.md / fixture-results.json

根因の特定・終了処理の正常完了を実証できるまで、8-3を完了扱いにしない。個人情報・秘密情報をログへ追加したり、テストをskipしたりする対応は行っていない。

## 2026-11-04の完了結果

履歴読み取りの失敗時に開始済みの読み取りを待ってから元の例外を返す修正を適用。制御テスト2件、対象Emulatorテスト61件と終了フック、統合36スイート1,543件、型チェック、lintが成功した。独立review/securityともにPASS。過去に残った3件のRPC種別は未特定。証跡は /Users/jime0083/.codex/verification/gokaku/8-3-p159-regression-20261104 に保存。
