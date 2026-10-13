---
name: manager-architecture
description: Manager Dashboard アーキテクチャ規範。Leaflet地図分離、管理者セッション管理、全体集計境界維持。
---

# Manager Architecture Capability Pack

## 1. 概要と適用責務
本 Pack は、管理者ダッシュボード（`active/manager/`）の開発・改修において、全体観測の目的を達成しつつ、現場モバイルHアプリとの物理的・思想的干渉を完全に遮断するための専門能力規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [01_DESIGN_CONTRACT.md](../../../docs/architecture/01_DESIGN_CONTRACT.md): 最高位設計契約（§3 アプリケーション分離原則）

## 3. 遵守すべき絶対規範
1. **完全物理分離**:
   - Dashboard（`active/manager/`）のコード・DOM・スタイルは、Hアプリ（`active/h-app/`）と完全に分離する。共通化の名目でHアプリ側に管理者向けロジックを逆輸入してはならない。
2. **地図エンジンの非干渉 (Leaflet SSOT)**:
   - Dashboard は Leaflet を使用し、Hアプリ側の Google Maps Loader との競合を物理的に遮断する。
3. **管理者セッションのサーバーサイド検証**:
   - `verifyManagerPassword` による認証成功時に発行された `dashboardSessionToken` を用いて管理者権限 API（`getRoster` 等）を呼び出す。
   - トークンの GET 送信は厳禁（POST ペイロードのみ）。
4. **現場尊重の観測原則**:
   - 管理者画面は「全体の進捗と事実の観測」に徹し、個別配布員へのノルマ強制、リアルタイム監視、強制割当UIを実装してはならない。
