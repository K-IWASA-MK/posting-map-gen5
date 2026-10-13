---
name: h-app-architecture
description: H-App Target Architecture B' 準拠規範。状態所有権の分離、DOM操作制約、モジュール境界維持。
---

# H-App Architecture Capability Pack

## 1. 概要と適用責務
本 Pack は、Hアプリ（配布員用モバイルUI: `active/h-app/`）の開発・改修において、Target Architecture B' を遵守し、モノリス化（`app.js` の肥大化）を防止して関心事分離（Separation of Concerns）を貫徹するための専門能力規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [01_DESIGN_CONTRACT.md](../../../docs/architecture/01_DESIGN_CONTRACT.md): 最高位設計契約（§19 Target Architecture B'）
- [03_CURRENT_H_APP_INVENTORY.md](../../../docs/architecture/03_CURRENT_H_APP_INVENTORY.md): 現行Hアプリ構造台帳

## 3. 遵守すべき絶対規範
1. **Architecture Gate 準拠**:
   - `app.js` への新規 Domain / Feature 関数の追加禁止。
   - `app.js` への新規 Feature 状態変数の追加禁止。
   - `app.js` から `window.*` への新規状態・関数露出の禁止。
   - `app.js` への新規 `innerHTML` / DOM-string 生成の追加禁止。
2. **Feature Module の自律カプセル化**:
   - 各機能（Activity, Transfer, Ranking, Bulletin, PinStatus, Storage, StaffRegistration, Auth, Summary）は独立した Feature Module（`active/h-app/modules/*.js`）として完結させる。
   - 内部 private state はクロージャまたはスコープ内に閉じ込め、公開 API（Getter / Setter / Action）のみを提供する。
3. **責務分離Wave限定 RatchetDown**:
   - 明示的に宣言された「責務分離・モジュール切り出しWave」においては、`app.js` の行数が直前の Approved HEAD より減少していなければならない（Ratchet Down 原則）。通常の軽微修正では強制しないが、行数増加は原則禁止。
