---
name: release-integrity
description: リリース完全性検証規範。V1〜V4検証ゲート執行、Scope Guard照合、原子的コミット完全性保証。
---

# Release Integrity Capability Pack

## 1. 概要と適用責務
本 Pack は、コードの変更から検証、コミット、プッシュ、本番配備に至る全行程において、未検証コードやスコープ外変更の混入を機械的に阻止し、リリースの完全性を保証するための監査・検証規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [verification-gates.md](../../../.agents/rules/verification-gates.md): 検証・検品規程 & HARD STOP条件 (V1〜V4)
- [workflow.md](../../../.agents/workflows/development/workflow.md): 開発・完了報告手順 (8-Stage Protocol)

## 3. 遵守すべき絶対規範
1. **多段階検証ゲートの厳格執行**:
   - **V1 (構文・単体テスト)**: `npm test` による全テストケース 100% PASS。
   - **V2 (スコープ・境界監査)**: `node scripts/check-scope.mjs` によるスコープ外変更ゼロ、Architecture Gate 適合。
   - **V3 (差分照合)**: `git diff` による事前宣言内容と実差分の完全一致。
   - **V4 (独立監査)**: MASTER が新規会話（Context Isolation）で起動する Independent Auditor による PASS 判定。
2. **2段階 Scope コミット原則**:
   - Scope 更新（`current-scope.json`）とコード変更は同一コミットにしてはならない。
   - Scope Transaction（`--scope-only`）➔ Implementation Transaction の順序を厳守する。
3. **客観的エビデンス主義**:
   - 推測や自己申告による「動作確認済み」を認めない。必ず実行コマンドのログ、終了コード `0`、客観的証跡をもって検証完了とする。
