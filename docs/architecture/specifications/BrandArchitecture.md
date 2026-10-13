# Specification: Brand Architecture

Version: 1.6.0 (Brand Unification Approved)
Status: APPROVED
Author: POSTING MAP AI Architecture Department
Target System: POSTING MAP / FIELD OPERATIONS OS

---

## 1. Overview & Brand Identity

POSTING MAP は「初期費用100万円・月額10万円以上」で展開される超プレミアムな選挙DX / ポスティング統制 SaaS プラットフォームである。
本ドキュメントは、販売版サービスとして展開するにあたり、LINE Developers・GitHub Pages・独自ドメイン・各種チャネルにおける世界観と名称定義を一元管理するためのブランド基盤仕様書である。

---

## 2. Core Architecture Principles (基本設計原則)

POSTING MAP は **入力システム (App)** と **集計システム (Dashboard)** の2つで構成され、両者を明確に分離する。

1. **Dual-Interface Principle (App & Dashboard)**
   - **App**: 現場でのデータ入力専用ツール（ボランティア・配布員向け PWA / LIFF アプリ）。
     - **主な役割**: LINEログイン、配布実績入力、GPS取得、写真送信、データ送信。
     - **制約**: 管理機能は一切持たない。
   - **Dashboard**: 組織管理・集計・分析を行う単一システム。
     - **主な役割**: ボランティアが App から送信したデータを組織単位で自動集計し表示する。
     - **制約**: ログインした組織に応じ、集計対象・名称・権限のみを動的に切り替える。

2. **Design Principle (最重要原則)**
   - **Dashboard は常に 1 つだけ実装する。**
   - **全階層で共通とするもの**: Dashboard UI・機能・コードベース・データモデル
   - **組織によってのみ変化するもの**:
     1. **名称** (例: 支部 Dashboard / 県連 Dashboard / ブロック Dashboard / 本部 Dashboard)
     2. **集計対象** (例: 自支部ボランティア / 配下全支部 / 配下全県連 / 配下全ブロック)
     3. **権限** (例: エリア管理 / 広域比較 / 全体統制 / 全国戦略)

3. **High-Ticket SaaS Mindset**
   - 安っぽいUI、サイバー過剰、ネオン装飾を徹底排除する。
   - 漆黒UI (`#000000`)、ガラスモーフィズム、微発光、Apple級余白設計を採用し、重厚かつ洗練されたプロダクト体験を提供する。

---

## 3. Anti-Pattern, Rule & Future Rule (開発ルール & 禁止事項)

### Anti-Pattern (禁止事項)
- 🛑 **Dashboard を組織単位（支部・県連・ブロック・本部）ごとに別実装してはならない。**

### Rule (実装ルール)
- ✅ **Dashboard は単一システムとして実装する。**
- ✅ **ログインした組織に応じて、「名称」「集計対象」「権限」のみを動的に切り替えて表示する。**

### Future Rule (将来の開発ルール)
- 🚀 **今後追加されるすべての Dashboard 機能（AI分析、KPI、地図、レポート、配布予測、エリア分析等）は、単一 Dashboard に追加しなければならない。**
- 🚀 **組織別に機能を分岐・複製してはならない。**

---

## 4. Organizational Data Flow & Aggregation Scope (組織データフロー)

現場ボランティアが App から入力したデータは、以下の階層構造に沿って自動集計される。

```
ボランティア
    │
    ▼
App（現場入力）
    │
    ▼
支部 Dashboard
    │
    ▼
県連 Dashboard
    │
    ▼
ブロック Dashboard
    │
    ▼
本部 Dashboard
```

| 組織階層 | Dashboard 名称 | 集計対象 | 権限範囲 |
| :--- | :--- | :--- | :--- |
| **支部** | 支部 Dashboard | 支部所属ボランティアのデータ | 自支部の活動・エリア管理 |
| **県連** | 県連 Dashboard | 配下の全支部データ | 自県連配下の全支部比較・進捗監視 |
| **ブロック** | ブロック Dashboard | 配下の全県連データ | ブロック全体の広域分析・統制 |
| **本部** | 本部 Dashboard | 配下の全ブロック（全国データ） | 全国統括・全体戦略分析 |

---

## 5. Unified Brand Naming & Component Architecture

旧名称（H-App / K-Dashboard / 開発時仮名称）を完全廃止し、構築済みの LINE Developers リソースと一読で合致する確定名称体系へ統一する。

| コンポーネント | 販売版確定正式名称 | 略称 / 識別子 | ステータス / 概要 |
| :--- | :--- | :--- | :--- |
| **Provider** | `Civic Tech Inc.` | `CivicTech` | 既存・構築済みプロバイダー |
| **Service Name** | `POSTING MAP` | `PMS` | プラットフォーム統合名称 |
| **App** | `POSTING MAP` | `App` | 現場入力専用（GPS、写真、実績入力、LINEログイン） |
| **Dashboard** | `POSTING MAP Dashboard` | `Dashboard` | 組織運営・管理・分析用（単一システム） |
| **LINE Login Channel** | `POSTING MAP Login` | `POSTING MAP Login` | 既存・構築済み LINE Login チャネル |
| **Messaging API Channel** | `POSTING MAP Official` | `POSTING MAP Official` | リッチメニュー配信・通知チャネル |
| **LIFF Application** | `POSTING MAP Field` | `LIFF-App` | App 用 LIFF アプリケーション |

---

## 6. Visual Identity & Design System

### 6.1. Color System
- **Background**: `#000000` (Pure Black)
- **Primary Brand Blue**: `#2563eb` (Royal Executive Blue)
- **Primary Text**: `#ffffff` (Pure White)
- **Secondary Text**: `rgba(255, 255, 255, 0.72)`
- **Border & Glass Divider**: `rgba(255, 255, 255, 0.08)`

### 6.2. Glassmorphism Card Standard
```css
border-radius: 28px;
background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.008));
box-shadow: inset 0 0 0 1px rgba(120, 140, 255, 0.08), 0 0 30px rgba(37, 99, 235, 0.05);
backdrop-filter: blur(20px);
-webkit-backdrop-filter: blur(20px);
```

---

## 7. Unified Domain & Endpoint Architecture

全仕様書共通の統制ドメインポリシーに基づくエンドポイント定義。

- **Root Domain**: `https://posting-map.jp/`
- **App URL**: `https://app.posting-map.jp/`
- **Dashboard URL**: `https://admin.posting-map.jp/`
- **API Proxy Gateway**: `https://api.posting-map.jp/`
- **LIFF Endpoint URL**: `https://app.posting-map.jp/active/h-app/index.html`
