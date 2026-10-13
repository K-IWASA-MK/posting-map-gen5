---
name: behavior-preservation
description: 既存挙動維持規範。リファクタリング時のUI/UX完全維持、副作用ゼロ、回帰防止原則。
---

# Behavior Preservation Capability Pack

## 1. 概要と適用責務
本 Pack は、コードの分割・整理・リファクタリングにおいて、ユーザーから見た機能・操作感・見た目・挙動を 100% 維持（副作用ゼロ）することを保証するための品質保証規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [SUPREME_PRODUCT_PRINCIPLES.md](../../../docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md): 最高位プロダクト原則 (Level 0 SSOT)
- [UNIVERSAL_QUALITY_DOCTRINE.md](../../../docs/architecture/UNIVERSAL_QUALITY_DOCTRINE.md): Universal 品質ドクトリン

## 3. 遵守すべき絶対規範
1. **最高位プロダクト挙動の絶対不可侵性 (Product Behavior Preservation)**:
   - 最高位原則第1条に基づき、現在完成しているHアプリ・Dashboardの機能、操作、表示、タイミングを1つも変えてはならない。
   - 不可侵対象には、UI、操作順、表示内容、画面遷移、Loading、Modal、Error、Optimistic First Paint、API firing order、await / no-await、Promise ordering、Concurrency、Timers、Existing quirks（既存の癖・特殊仕様）を全て含む。
   - 勝手なUI改善、アニメーション変更、エラーメッセージ変更を「ついで」に行うことを禁止する。
2. **回帰防止の自己検証**:
   - 変更後は必ず既存テスト（`npm test`）を実行し、全テストケースが 100% PASS することを確認する。
   - モジュール切り出しを行った場合は、切り出し前後で同一の引数・戻り値・DOM更新が再現されることを単体テストで担保する。
3. **予期せぬ状態の即時停止**:
   - リファクタリング中に既存テストが失敗した場合、自己判断でテスト側の期待値を書き換えて合格を偽装してはならない。直ちに作業を停止（HARD STOP）し、原因を究明してMASTERへ報告する。
