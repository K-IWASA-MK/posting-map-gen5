---
name: auth-security
description: 認証セキュリティ規範。Public / Dual Auth / 認可必須 API 境界の厳格維持、LINE LIFF 検証、管理者セッション管理。
---

# Auth Security Capability Pack

## 1. 概要と適用責務
本 Pack は、POSTING MAP システム全体の認証境界、トークン検証、セッション管理、認可判定において、不正アクセスやなりすまし、認証バイパスを物理的に遮断するためのセキュリティ規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [API_CONTRACT.md](../../../docs/api/API_CONTRACT.md): API仕様書（§6, §10 認証契約）
- [SECURITY_BASELINE.md](../../../docs/security/SECURITY_BASELINE.md): セキュリティベースライン（SEC-001〜SEC-005）

## 3. 遵守すべき絶対規範
1. **厳格な 3 層認証境界**:
   - **Public Bootstrap API**: 初期起動・ハンドシェイク用（`getMapsApiKey`, `getTier1`, `verifyManagerPassword`, `registerOrValidateDevice`, `getDeviceStatus` のみ）。無認証アクセス許容。
   - **Dual Auth API**: `getSystemSummary` のみ。LIFF Token または Dashboard Session Token の有無に応じて返却スコープを動的制御（未認証時は公開集約値のみ）。
   - **認可必須 API**: 上記以外の全業務 API（`submitDistribution`, `updateFlyerStock`, `getRoster` 等）。検証済み認証情報の提示が必須。
2. **LINE LIFF ID Token のサーバー検証**:
   - クライアントから送信された `liffToken` は、バックエンド Standalone GAS 側で必ず LINE 公式エンドポイント（`https://api.line.me/oauth2/v2.1/verify`）を呼び出して真正性を検証する。
   - クライアント側から渡される `lineUserId` や `staffId` を信用してはならない。
3. **機密情報のフロントエンド配置禁止**:
   - フロントエンド（HTML/JS）に管理者パスワード、APIシークレット、秘密鍵を埋め込んではならない（No Secrets in Frontend）。
   - セッショントークンを GET クエリパラメータで送信してはならない。
