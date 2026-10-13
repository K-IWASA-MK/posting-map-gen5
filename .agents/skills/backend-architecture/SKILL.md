---
name: backend-architecture
description: Standalone GAS バックエンド規範。Pure DB スプレッドシート原則、並行性制御、ルーティングと認可の分離。
---

# Backend Architecture Capability Pack

## 1. 概要と適用責務
本 Pack は、バックエンド API（`active/api/v2_api.js`、`active/business/`、`active/gas/`）の開発・改修において、Standalone GAS の純粋性を保ち、スプレッドシート Pure DB 原則および並行性制御を厳守するための専門能力規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [API_CONTRACT.md](../../../docs/api/API_CONTRACT.md): API仕様書
- [v2_api.js](../../../active/api/v2_api.js): バックエンドエントリポイント

## 3. 遵守すべき絶対規範
1. **Spreadsheet = Pure DB 原則**:
   - スプレッドシート側には一切のスクリプト、マクロ、カスタム関数、トリガーを持たせない（コード完全ゼロ）。
   - コンテナバウンド GAS の作成・復元・依存は永久に禁止する。
2. **Standalone GAS の単一運用**:
   - 全てのバックエンドロジックはスタンドアロンな Google Apps Script（`v2_api.js`）として独立運用する。
3. **並行性・競合排他制御 (LockService)**:
   - スプレッドシートへの書き込みを伴うミューテーション API（`submitDistribution`, `updateFlyerStock`, `postBulletinMessage` 等）は、必ず `LockService.getScriptLock()` による排他ロックを取得して実行する。
4. **ルーティングと認可の分離**:
   - クライアントからの `districtId` は単なるルーティング候補（どのDBを開くか）に過ぎず、アクセス権限の根拠として信頼してはならない。
   - 認可は必ず検証済み `lineUserId` と対象DBの名簿照合によって判定する。
