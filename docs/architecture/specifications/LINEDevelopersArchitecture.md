# Specification: LINE Developers Architecture

Version: 1.6.0 (Brand Unification Approved)
Status: APPROVED
Author: POSTING MAP Integration Department
Target System: POSTING MAP / LINE Developers Platform

---

## 1. Overview

本仕様書は、POSTING MAP を販売版サービスとして展開するための LINE Developers コンソール上での Provider (`Civic Tech Inc.`)、LINE Login チャネル (`POSTING MAP Login`)、Messaging API チャネル (`POSTING MAP Official`)、および LIFF アプリケーション (`POSTING MAP Field`) の全体統一設計を定義する。

---

## 2. Provider Structure (確定・構築済み)

既存の構築済みプロバイダーを使用し、本Sprintでの新規プロバイダー作成は行わない。

- **Provider Name**: `Civic Tech Inc.` (既存・構築済み)
- **Provider Role**: POSTING MAP プラットフォームに関連する全 LINE チャネルを一括保有・統制する最上位コンテナ。

---

## 3. Channel Architecture & Specifications

`Civic Tech Inc.` プロバイダー内に構成される 2 つの主要チャネル。

```
Civic Tech Inc. (Provider)
 ├── 1. POSTING MAP Login (LINE Login Channel / 構築済み)
 │    └── LIFF Application: POSTING MAP Field (LIFF-App)
 └── 2. POSTING MAP Official (Messaging API Channel)
      └── Rich Menu: App Launch Menu
```

### 3.1. LINE Login Channel Specification (既存・構築済み)
* **Channel Name**: `POSTING MAP Login` (変更不可・既存維持)
* **Channel Description**: POSTING MAP 現場入力アプリ (App) および統制ダッシュボード (Dashboard) 共通認証チャネル。
* **App Types**: Web app
* **Linked Messaging API**: `POSTING MAP Official` (Bot 友だち追加インフィード連携有効化)
* **Callback URL**: `https://app.posting-map.jp/`

### 3.2. Messaging API Channel Specification
* **Channel Name**: `POSTING MAP Official`
* **Channel Icon**: 漆黒背景＋ブランドロゴアイコン (`v=73` キャッシュバスター管理)
* **Auto-reply messages**: **無効 (OFF)**
* **Greeting messages**: **有効 (ON)** （アプリ起動導線案内）
* **Webhook**: **有効 (ON)** （URL: `https://api.posting-map.jp/webhook` または GAS Web App）

---

## 4. LIFF Application Specification (App)

現場入力アプリ (App) を LINE アプリ内でネイティブ起動させるための LIFF 設定。

| 設定項目 | 販売版確定設定値 | 開発時設定値 (旧) | 備考 |
| :--- | :--- | :--- | :--- |
| **LIFF Application Name**| `POSTING MAP Field` | `MIE-02/H` | 販売用正式名称 |
| **Size** | `Full` | `Full` | 全画面表示 |
| **Endpoint URL** | `https://app.posting-map.jp/active/h-app/index.html` | `https://k-iwasa-mk.github.io/...` | 独自ドメイン絶対パス |
| **Scopes** | `profile`, `openid` | `profile`, `openid` | ユーザー識別用 |
| **Bot Prompt** | `Aggressive` (友だち追加の自動推奨) | `Normal` | LINE公式アカウント登録促進 |
| **Module Mode** | **無効 (OFF)** | **無効 (OFF)** | 通常LIFFモード |

---

## 5. Audit & Delta Matrix (整合性確認・設定更新項目一覧)

### 5.1. 既存維持項目 (No Action Required - Existing)
1. **Provider**: `Civic Tech Inc.` (変更なし)
2. **LINE Login Channel**: `POSTING MAP Login` (新規作成なし・既存使用)

### 5.2. 設定・ドメイン連携更新項目 (Configuration Updates Only)
1. **Endpoint URL**: 独自ドメイン `https://app.posting-map.jp/active/h-app/index.html` へ統一設定
2. **Callback URL**: `https://app.posting-map.jp/` へ統一設定
3. **チャネルアクセストークン (長期)**: 本番用トークンを GAS の `PropertiesService` へ設定
4. **リッチメニュー (Rich Menu)**: LIFF URL を組み込んだリッチメニューの適用 (`createRichMenuForHApp()`)
