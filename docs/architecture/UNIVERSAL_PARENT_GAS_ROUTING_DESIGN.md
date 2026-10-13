# POSTING MAP Universal — 親Standalone GAS 1本化・Version更新方式 実装設計書 (確定版 v2.0.0)
*(Universal Parent GAS & Multi-District Routing Specification - Finalized)*

**Status**: ACCEPTED (Reflected MASTER Audit Corrections)
**Date**: 2026-09-23
**Target**: POSTING MAP Universal Engine (Architecture Layer)
**Related Documents**:
- 最高位就業規則: [AGENTS.md](../../AGENTS.md)
- 最高位設計契約: [01_DESIGN_CONTRACT.md](01_DESIGN_CONTRACT.md)
- アーキテクチャ決定: [ADR-010.md](decisions/ADR-010.md)
- API契約: [API_CONTRACT.md](../api/API_CONTRACT.md) §6.1
- データライフサイクル: [DATA_LIFECYCLE.md](../data/DATA_LIFECYCLE.md) §6

---

## 1. 最上位原則とアーキテクチャ概要

### 1.1 基本憲法
[AGENTS.md](../../AGENTS.md) 第1条に基づき、クライアント層は「1地区 = 1完成アプリ = 1単独フォルダー = 1単独リポジトリ = 1単独ドメイン」として配備され、共通Runtime（`active/**`）は Universal Engine として全地区同一内容を維持する。

一方、バックエンド層においては新地区追加時に GAS プロジェクトを複製することを永久に禁止し、以下の不変構造を厳守する：
```text
[各地区独立Client (1地区=1repo=1domain)] ─── 単一親Standalone GAS ─── 単一固定Web App URL ─── 動的DBルーティング
```

新地区追加時に `clasp create` 等で GAS プロジェクトを新規作成・複製することは永久に禁止する。
Universal Engine 用の **親 Standalone GAS プロジェクトを「たった1つ」だけ維持** し、**単一の固定 Deployment から公開される Web App URL** を通じて各地区の独立した Spreadsheet（DB）へアクセスを振り分ける **動的ルーティングモデル** を採用する。

### 1.2 全体構成図

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        クライアント層 (Client Layer)                    │
│                                                                        │
│   【地区A: KUWANA】                          【地区B: AICHI-01】        │
│   ・data/config.js (districtId: "KUWANA")    ・data/config.js (districtId: "AICHI-01")
│   ・active/ (共通Hアプリ/Dashboard)          ・active/ (共通Hアプリ/Dashboard)
└───────────────────┬──────────────────────────────────┬─────────────────┘
                    │                                  │
                    │ POST (action, districtId, token) │
                    ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│             親 Standalone GAS (Universal Engine 単一Web App)            │
│             単一固定 Web App URL (Deployment ID 固定運用)              │
│             実行主体: Execute as Me / Who has access: Anyone           │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 1. Routing Hint 取得: districtId を受信                           │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 2. 動的ルーティング (SpreadsheetResolver v2)                       │  │
│  │    Script Properties: DISTRICT_REGISTRY (DB接続情報SSOT)         │  │
│  │    "KUWANA"   ➔ Spreadsheet ID (KUWANA_DB)                       │  │
│  │    "AICHI-01" ➔ Spreadsheet ID (AICHI_DB)                        │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 3. 認証ゲート (Auth Gateway): LINE Token ➔ lineUserId 確定         │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 4. 認可・名簿照合 (Staff Identity Chain):                          │  │
│  │    対象DBの名簿シートで lineUserId を照合                          │  │
│  │    【認可境界】所属確認 PASS ➔ 業務実行 / 不一致 ➔ 越境拒絶 (DENY)   │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      │ Sheets API (openById)
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
│  地区A Spreadsheet (DB)              │  │  地区B Spreadsheet (DB)              │
│  ID: 1mk346cj... (KUWANA)            │  │  ID: 1_fvgpNs... (AICHI-01)          │
│  ・SYSTEM_INFO (地区情報/契約SSOT)   │  │  ・SYSTEM_INFO (地区情報/契約SSOT)   │
│  ・名簿                              │  │  ・名簿                              │
│  ・配布実績_YYYY-MM                  │  │  ・配布実績_YYYY-MM                  │
│  ・チラシ管理_YYYY-MM                │  │  ・チラシ管理_YYYY-MM                │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
```

---

## 2. 核心設計修正事項 (MASTER Audit 反映)

### 修正①: 「districtId によるルーティング」と「認証・認可」の完全分離
- **`districtId` は「Routing Hint」であり、認証情報（Identity Proof）ではない**:
  - `districtId` は「どのDBを候補として調べるか」の指定に過ぎない。
  - クライアントが `districtId: "KUWANA"` を送信したこと自体を根拠に対象DBを操作できる構造は絶対に採用しない。
- **厳格な処理順序パイプライン**:
  ```text
  1. Request 受信
  2. districtId 取得 (Routing Hint: 対象DB候補の指定)
  3. DISTRICT_REGISTRY による対象DB（Spreadsheet ID）候補の解決
  4. LINE Access Token 検証 ➔ 認証済み lineUserId 取得 (Identity Proof: 本人性証明)
  5. 対象DB（名簿シート）との照合 ➔ 地区所属・利用資格確認 (Authorization: 認可判定)
  6. 認可判定:
     ├─ PASS ➔ 対象スプレッドシートの業務操作・永続化
     └─ DENY ➔ 処理を即時遮断し、エラー（NOT_REGISTERED / UNAUTHORIZED）を返却
  ```

### 修正②: 認可境界の実装要件とテスト検証マトリクス
- **仕様規定**:
  - 「認証済み `lineUserId` と対象地区DBの名簿照合を認可境界として実装し、地区越境アクセスを拒否する。」
- **テスト検証条件マトリクス**:
  実機・単体テストにおいて、以下の全条件をパスすることを必須とする。

  | テストシナリオ | LINE Token | 本人所属地区 | 指定 districtId | 認可判定 | レスポンスコード | 期待挙動 |
  | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
  | **正当アクセス** | 正常 (User A) | District A | District A | **PASS** | `200 OK` | 正常に業務処理を完了・永続化 |
  | **地区越境アクセス** | 正常 (User A) | District A | District B | **DENY** | `NOT_REGISTERED` | 越境操作を拒絶し、DB書き込み遮断 |
  | **名簿未登録ユーザー**| 正常 (Unknown) | なし | District A | **DENY** | `NOT_REGISTERED` | 初回登録画面へ誘導 |
  | **不正/失効トークン** | 無効/失効 | - | District A | **DENY** | `UNAUTHORIZED` | 認証エラーとして即時拒絶 |
  | **未知の地区ID** | 正常 (User A) | District A | Unknown-99 | **DENY** | `DISTRICT_NOT_FOUND` | ルーティング失敗として即時拒絶 |

### 修正③: 二段階SSOT境界（DISTRICT_REGISTRY と SYSTEM_INFO）
二重管理を防ぎつつ、確実なデータ整合性を担保するため、以下の役割分担を定義する：
- **`DISTRICT_REGISTRY` (Script Properties)**:
  - 役割: **「地区DB接続情報（どのSpreadsheetか）」の唯一のSSOT**。
  - 形式: JSON形式のキー・バリュー（`{ "KUWANA": "ss_id_1", "OKAYAMA-01": "ss_id_2" }`）。
- **`SYSTEM_INFO` (各地区スプレッドシート第1シート)**:
  - 役割: **「接続後の地区DB自身が持つ地区情報・契約状態等（そのSpreadsheetは何地区で、利用可能か）」のSSOT**。
- **二段階検証フロー**:
  親GASは `DISTRICT_REGISTRY` でDBを特定してオープンした後、必ず当該DB内の `SYSTEM_INFO` を検証し、地区名の取り違え（Integrity Guard）や契約終了状態がないことを二重検証する。

### 修正④: 新地区立ち上げ正規9段階ライフサイクル
「新地区立ち上げ＝Registry登録だけ」ではなく、以下の正規9段階プロトコルを順守する：
1. **テンプレート原本複製**: 公式原本 `POSTING_MAP_EMPTY_TEMPLATE` を複製（既存地区本番DBの複製は永久禁止）。
2. **03_BRANCH配置**: Google Drive の公式保管場所 `03_BRANCH` フォルダ配下に格納・命名（例: `OKAYAMA-01`）。
3. **SYSTEM_INFO初期化**: 第1シート `SYSTEM_INFO` に地区名、契約終了日、管理パスワード等の初期値を書き込む。
4. **地区データ投入**: 当該地区の `address_master.csv` を基に原本シートへ町丁目マスター行データを投入。
5. **DISTRICT_REGISTRY登録**: 親GASの `Script Properties` に `districtId: spreadsheetId` を追加登録。
6. **接続確認**: 親GAS環境から `SpreadsheetApp.openById(ssId)` で対象スプレッドシートが開けることを確認。
7. **API疎通確認**: Web App URL に対して `{ action: "getSystemSummary", districtId: "..." }` を投げ、200 OK を確認。
8. **LINE/LIFF側districtId設定確認**: 当該地区の `data/config.js` の `districtId` が登録名と完全一致することを確認。
9. **実機確認**: ブラウザ / LINE 実機で Hアプリ・Dashboard を開き、動作検品を完了。

### 修正⑤: Version更新方式とDeployment ID固定ルール
- **運用ルール**:
  - Universal Engine の正式 Deployment ID を **単一の本番 Web App として固定** し、Version 更新では Deployment ID を変更しない。
  - Web App URL は運用上固定とする（「永久に不変」という絶対保証ではなく、Deployment ID 固定運用によって URL 不変を維持する）。
- **3大識別子の独立管理**:
  1. `Script ID`: 親GASプロジェクトの不変ID
  2. `Deployment ID`: 本番公開エンドポイントの固定ID
  3. `Web App URL`: クライアントがアクセスする固定URL (`https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`)
- **Version更新およびロールバック手順（抽象化）**:
  - 新機能・バグ修正時: コード反映後、新 Version を作成し、**「既存 Deployment を対象 Version へ更新（redeploy）」** する。
  - ロールバック時: 障害発生時、**「既存 Deployment の向け先を旧 Version へ再指定（redeploy）」** する。
  - 所要時間は数秒であり、Web App URL およびクライアント側設定は一切変更不要である。
- **Web App 実行主体**:
  - `Execute as: Me`（デプロイ者権限）: 全地区スプレッドシートに対する Sheets API アクセスを親GASの統一権限で実行。
  - `Who has access: Anyone`（全員アクセス可能）: LINE LIFF および外部ブラウザからの通信を受容。

### 修正⑥: セキュリティおよび PROVISIONING_TOKEN_HASH の整理
- `PROVISIONING_TOKEN_HASH` は、マルチ地区 Runtime Routing の必須スコープには含めない。
- 新地区の `DISTRICT_REGISTRY` への登録は、現フェーズでは **Apps Script 管理者操作（またはプロジェクト内管理者スクリプト）** で安全に行う。
- 外部向けの Provisioning API（`POST /provision` 等）は、勝手に追加・新設しない。

---

## 3. 実装変更対象（Gate 7 最小侵襲スコープ）

本設計の具現化にあたり、変更が必要なファイルは以下の4系統のみに厳格に限定される。

```text
[1] GAS Infrastructure Layer
    active/infrastructure/spreadsheet/spreadsheet_adapter.js
        ↓
    DISTRICT_REGISTRY 照合
        ↓
    SpreadsheetResolver.getSpreadsheet(districtId)

[2] GAS API Gateway Layer
    active/api/v2_api.js
        ↓
    リクエストから districtId (Routing Hint) 取得
        ↓
    SpreadsheetResolver 呼出
        ↓
    LINE Token 検証 ➔ 対象DB名簿照合 (Authorization Boundary)

[3] Frontend Configuration Layer
    data/config.js
        ↓
    districtId: "KUWANA" (地区識別子の定義)

[4] Frontend Communication Layer
    active/h-app/modules/api.js
        ↓
    callApiPost: 全リクエストに config.districtId を自動マージ
```

---

## 4. 移行・実証計画 (Transition & Verification)

1. **Phase 1: 親Standalone GAS プロジェクトの初回確立**:
   - Universal 専用 Standalone GAS を 1 つ作成（Script ID 確定）。
   - マニフェスト（`active/appsscript.json`）を適用し、本番 Deployment を作成（Deployment ID / Web App URL 確定）。
   - 初回 OAuth 承認（MASTER による 1 クリック承認）。
2. **Phase 2: テスト用スプレッドシートを用いた 5大認可シナリオ実証**:
   - `DISTRICT_REGISTRY` に検証用エントリを登録。
   - 認可検証マトリクス（正当アクセス、越境アクセス、未登録、無効トークン、未知地区ID）の全ケースを実機テスト。
3. **Phase 3: Version 更新・ロールバック実機実証**:
   - Version 1 ➔ Version 2 への Deployment 更新。
   - Version 2 ➔ Version 1 への即時切り戻し実証。
