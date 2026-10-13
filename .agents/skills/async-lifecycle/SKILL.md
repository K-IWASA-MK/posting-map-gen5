---
name: async-lifecycle
description: 非同期ライフサイクル制御規範。In-flight二重リクエスト抑止、Promiseキャッシング、競合状態（Race Condition）排除。
---

# Async Lifecycle Capability Pack

## 1. 概要と適用責務
本 Pack は、Hアプリおよび管理画面における非同期通信（API呼び出し、地図初期化、IndexedDB読み書き）において、ユーザーの連続タップや通信遅延に伴う多重リクエスト、競合状態（Race Condition）、画面フリーズを排除するための専門制御規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [01_DESIGN_CONTRACT.md](../../../docs/architecture/01_DESIGN_CONTRACT.md): 最高位設計契約（§5 非同期整合性規程）

## 3. 遵守すべき絶対規範
1. **In-flight 二重呼び出し抑止**:
   - 通信中（In-flight）のリクエストが存在する場合、後続の同一リクエストは既存の実行中 Promise を再利用（Promise Caching）するか、または UI ロックにより重複発火を抑止する。
2. **Atomic Setter / Getter による状態管理**:
   - 非同期操作の開始フラグ（`isSubmitting`, `isRegistering` 等）および解決済みキャッシュは、該当 Feature Module のプライベート変数として原子的（Atomic）に更新・取得する。
3. **ライフサイクル競合の排除**:
   - DOM 要素の可視化前に非同期描画処理を実行してはならない（地図初期化、モーダルレンダリング等）。
   - 画面アンマウント時またはページ遷移時は、進行中のポーリングやタイマーを安全にクリーンアップする。
