---
name: development
description: 開発・完了報告手順 (9-Stage Protocol)。Stage 1 調査・Knowledge Impact Analysis から MASTER 承認、Scope Lock、実装、自己検証、内部ディスパッチ独立監査・Mechanical Gate、Commit/Push、Remote Sync、Stage 9 残骸＆Governance Closure 二重監査ゲートまでの全行程を規定。
---

# Workflow: Development (開発・完了報告フロー)

AI社員の作業は、必ず以下の「9-Stage Execution Protocol」と「Verification Gate」に従う。この順序の省略・逆転・自己判断による短縮は絶対禁止とする。

---

## 9-Stage Execution Protocol (正式開発フロー)
※ AI役職定義およびツール統制の詳細は Canonical SSOT である [docs/ai-foundation.md](../../../docs/ai-foundation.md) を参照すること。

### Stage 1: Plan (調査・計画策定 & Knowledge Impact Analysis) — [主担当: Execution AI]
- READ ONLYで対象範囲と既存実装を調査（ファイル改変禁止）。
- **Knowledge Impact Analysis**: 変更予定の Canonical Source が `.agents/os-registry.json` のどの Capability Pack に影響するかを事前に特定・宣言。
- Scope（変更対象ファイル）を最小限に確定する（全域ホワイトリスト運用の絶対禁止）。
- チャット画面上で実装計画・完了条件・Verification Plan を提示（`implementation_plan.md` 等のリポジトリ内ファイル生成は禁止）。
- **🛑 HARD STOP**: 実装計画提示後、直ちに作業を停止し MASTER の着手承認（Proceed + Authorization Envelope）を待つ。

### Stage 2: Approve & Scope Lock (MASTER承認 & 事前Scope固定)
- MASTERから明示的な着手承認（`Proceed`）および Authorization Envelope を受領する（取得前の実装・コミット等は絶対禁止）。
- **事前Scope固定**: Proceed受領後、コード変更前に `.agents/current-scope.json` にMASTER承認Scope全体（文字列配列: `string[]`）を記録・固定する（既存 `scripts/check-scope.mjs` との完全互換を維持）。
- `node scripts/check-scope.mjs --scope-only` を通過後、**単独ローカルコミット** を行う。

### Stage 3: Implement (承認Scope内最小侵襲実装・並列ディスパッチ) — [主担当: Execution AI / Parallel Workers]
- 承認されたScope内のみを変更。Scope外変更、仕様の勝手な追加・変更は絶対禁止。
- **並列ディスパッチ時**:
  - 親Executionが `invoke_subagent` により各Workerへ排他的単一ファイルのみを割り当てて起動。指示プロンプトで参照すべき Capability Pack を明示指定。
  - 各Workerは割当ファイルのみを変更し、親指定の固定単体テストを実行後、`send_message` で `[WORKER REPORT]` を親へ返却。
  - **Strict Subagent Depth = 1**: Workerからの再委任（`invoke_subagent`, `manage_subagents`）は絶対禁止。
  - **異常検知時の停止制御**: エラー・テスト失敗・未承認差分を検知した場合、新規ディスパッチ・編集を即時停止し、親Executionから実行中Workerに対して `manage_subagents(Action: "kill" / "kill_all")` による停止を要求・確認する。
- **指示外変更の即時停止（発見 ➔ 報告 ➔ STOP）**: 作業中に別機能や他ファイルの改善点・問題を発見した場合、勝手に修正コードを追加してはならない。
- **失敗時の自己拡張禁止**: テスト失敗時に自己判断でScope外ファイルへ修正を拡大してはならない。Scope外が必要な場合は作業をSTOPして追加指示を仰ぐ。

### Stage 4: Self Verify (自己検証 & 機械監査) — [主担当: Execution AI]
- V1 Static Verification: `git diff`, `git diff --check`, Scope確認, Dead Code確認。
- V2 Runtime Verification: 実機起動、DOM/Console/Network、Google Maps 実描画確認（`.gm-style`）。
- V3 Regression Verification: 全テストスイート実行（`npm test`、並列統合テスト）。
- Mechanical Governance Gate: `node scripts/check-scope.mjs`（Scope Guard & Architecture Guard 通過必須）。
- 統合差分固定（Freeze）: 検証完了状態のWorking Treeを静止させ、Stage 5 への進行準備を行う。

### Stage 5: Internal Independent Audit & Mechanical Gate (内部ディスパッチ独立監査) — [主担当: Execution AI / Independent Auditor AI]
- Execution AI が `invoke_subagent` により Independent Auditor をディスパッチ（Prompt に BASE, TARGET, MISSION_SCOPE を完全バインド）。
- **Auditor の独立性要件**: Fresh isolated child context、Policy-Level Zero Write、必須コマンド独立再実行（`git diff`, `npm test`, `check-scope.mjs`）。
- Auditor は `[AUDITOR VERDICT]`（PASS / REJECT）を親Executionへ返却。
- 親Executionは Mechanical Auditor Gate を執行する：
  ```bash
  npm run gate:auditor -- --base <BASE_COMMIT> --target <HEAD_COMMIT>
  ```
  - Gate は Event A ➔ Event B ➔ Event C 相関チェーンおよび **Post-Audit Zero Mutation**（監査PASS後の改変遮断）を機械検証。
  - 監査PASS後にファイル変更が1件でも検出された場合、PASS即時VOID / Exit 1 で HARD STOP。

### Stage 6: Commit Gate (認可エンベロープ執行関門) — [主担当: Execution AI]
- `gate:auditor` Exit 0 確認後、Authorization Envelope において `COMMIT: YES` が付与されている場合、親Executionは手動Resumeを挟まず `git commit` を自律執行する。
- 未認可または異常検知時は HARD STOP とする。

### Stage 7: Push Gate (認可エンベロープ執行関門) — [主担当: Execution AI]
- Authorization Envelope において `PUSH: YES` が付与されている場合、親Executionは `git push` を執行する（Stage 2 の Scope Commit を含めて一括プッシュ）。

### Stage 8: Deployment Gate & Remote Sync Verification — [主担当: Execution AI]
- Push完了後、実稼働環境への反映が必要な変更（Deployment対象変更）であり、かつ Authorization Envelope において `DEPLOY: YES` が認可されている場合のみデプロイを実施。
- 実環境反映不要な変更は「Deployment対象外 (N/A)」と明示記録。
- Remote Sync 確認（HEAD == origin/main, clean working tree）を行い、実機確認へ移行。
- 実機確認 PASS 後、直ちに Stage 9 へ移行する（Stage 9 の省略・自己判断終了は全面禁止）。

### Stage 9: Post-Verification Residual Cleanup & Governance Closure Gate — [主担当: Cleanup Worker & Execution AI]
- **起動条件**: Stage 8 実機確認 PASS 直後に、親Executionが必ず Cleanup Worker を起動（**全Mission必須執行・Stage 9 N/A 禁止**）。
- **プロンプト要件**: `invoke_subagent` プロンプト（Event A）に `ORIGINAL_BASE`、`HEAD_COMMIT`、`APPROVED_DIFF` を完全一致バインド。
- **監査規範**: Policy-Level Zero Write、`run_command` 禁止。
- **Dual Audit 成果報告**:
  - Cleanup Worker は `[CLEANUP REPORT]`（`DELETE-CANDIDATE`, `GOVERNANCE-RESIDUAL`, `KEEP`, `OUT-OF-SCOPE`）を返却。
  - 親Executionは Mechanical Cleanup Gate を執行：
    ```bash
    npm run gate:cleanup -- --base <BASE_COMMIT> --target <HEAD_COMMIT>
    ```
  - **CLOSED 条件**: `DELETE-CANDIDATE: 0` かつ `GOVERNANCE-RESIDUAL: 0` かつ `gate:cleanup` Exit 0。
  - どちらか > 0 の場合、自動削除は絶対禁止とし、MASTER へエスカレーションして HARD STOP。
  - 両方 0件確認後、`[MISSION COMPLETION REPORT]` を提出して Wave CLOSED。

### Rollback ガバナンス規程 (History-Preserving Rollback Protocol)
万一、本番・検証・運用のいずれかで重大な障害が発生しロールバックが必要となった場合、履歴保持型revertのみを許可する。

1. **ロールバック実行手順 (明示的逆順 revert)**:
   - Step 1: `git revert --no-edit <C_impl>` （実装コミットの明示的反転）
   - Step 2: `git revert --no-edit <C_scope>` （Scope コミットの明示的反転）
   ※ Implementation Commit ➔ Scope Commit の明示的逆順で1コミットずつ確実にrevertする。曖昧な commit range revert は禁止。

2. **履歴破壊型操作の絶対禁止**:
   - `git reset --hard`, `git reset --mixed`, `git reset --soft`
   - `git push --force`, `git push --force-with-lease`
   - その他履歴破壊型rollback（`rebase`, `commit --amend` 等の既出コミット改変）は永久に禁止する。

---

## 完了報告の禁止事項

以下の状態で「完了報告」（Mission CLOSED / 完全終了 / 全工程完了 / Release Complete / 最終PASS等）として提出することは絶対禁止とする：
- 「あとでcommitします」「あとでpushします」という状態。
- 「ユーザーに実機確認してもらう」「検証は別途行う」状態。
- 「問題ないと思われる」「コード上は正しいはず」という推測状態。
- 報告時点で未解決のエラーが存在する状態。
- Stage 5 で `npm run gate:auditor` を実行・通過していない状態。
- 監査PASS後にファイルを改変した状態（Post-Audit Mutation）。
- Stage 8 実機PASS後に Stage 9 Cleanup Worker（Residual & Governance Closure Auditor Profile）を起動していない状態。
- Cleanup Worker からの正式な `[CLEANUP REPORT]` を受領していない状態。
- `npm run gate:cleanup -- --base <BASE> --target <TARGET>` による機械検証（Exit 0）を通過していない状態。
- `DELETE-CANDIDATE > 0` または `GOVERNANCE-RESIDUAL > 0` の残骸・残滓候補が存在したまま、または是正サイクル後の累積全差分に対する再Stage 9監査を完了していない状態。
