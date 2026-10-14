# District Provisioning Runbook (新地区標準プロビジョニング手順書)

- **Version**: 1.0.0
- **Status**: OFFICIAL STANDARD (SSOT)
- **Target**: Universal POSTING MAP Engine v1.0
- **Supreme Authority**: [AGENTS.md](../../AGENTS.md)
- **Release Baseline**: [UNIVERSAL_RELEASE_BASELINE.md](../architecture/UNIVERSAL_RELEASE_BASELINE.md)
- **Security Baseline**: [SECURITY_BASELINE.md](../security/SECURITY_BASELINE.md)

---

## 1. 目的と最上位原則

本書は、日本全国の新しい自治体・地域（以下「新地区」）を Universal POSTING MAP に投入し、安全・確実・反復可能に本番稼働（ACTIVE）させるための **唯一の標準運用手順書（SSOT）** である。

### 最重要不変原則
1. **Zero Code Duplication / Zero Runtime Modification**:
   - 新地区追加は **「データ投入（Provisioning）」** であり、開発ではない。
   - `active/` 配下のソースコード、HTML、共通GASスクリプトを1行たりとも変更してはならない。
   - プロビジョニング中に `active/` 変更が必要と判明した場合は、直ちに **HARD STOP（プロビジョニング失敗）** とする。
2. **単一親GAS・単一Web App維持**:
   - 新地区のために `clasp create` 等で別GASプロジェクトを作成することは永久に禁止する。
   - 全地区は単一の親GAS Standalone Web App URLを共有し、`DISTRICT_REGISTRY` によってスプレッドシート（DB）を動的分離する。
3. **再現性・自律性の担保**:
   - 各ステップには明確な 入力・アクション・検証・エビデンス・ロールバック・HARD STOP条件 を規定し、属人的判断を排除する。

---

## 2. プロビジョニング全体フロー

```text
[Stage 1: 地区計画・ID確定]
       ↓
[Stage 2: マスターデータ調達 & 検証 (CSV / GeoJSON)]
       ↓
[Stage 3: Spreadsheet Pure DB プロビジョニング (Template複製 & 整合性ガード)]
       ↓
[Stage 4: DISTRICT_REGISTRY & Routing 登録]
       ↓
[Stage 5: 地区別 Secrets & Maps API Key 設定 (GCP制限)]
       ↓
[Stage 6: 外部サービス連携設定 (LINE / LIFF / Contract)]
       ↓
[Stage 7: Production Acceptance Verification (実機・API・セキュリティ検品)]
       ↓
[Stage 8: ACTIVE 昇格 & 監視開始]
```

---

## 3. 各ステージ詳細手順

### Stage 1: 地区計画・ID確定 (District Planning & ID Formalization)

- **Preconditions**:
  - 新規展開対象の自治体・選挙区・支部が正式に決定していること。
- **Input**:
  - 自治体名（例: 三重県桑名市）
  - 自治体コード（JIS X 0402 / 総務省全国地方公共団体コード、例: `242055`）
  - 選挙種別（衆院小選挙区、参院選挙区、首長選、一般市議選 等）
- **Action**:
  1. 地区ID（`districtId`）を正規化命名規則に従い確定する。
     - 規則: 英大文字、数字、ハイフンのみ（例: `KUWANA`, `MIE-04`, `AICHI-01`）。
     - 空白・特殊文字・小文字は禁止。
  2. プロビジョニング管理簿に `districtId`、対象自治体、担当者を記録。
- **Validation**:
  - `districtId` が既存の登録済み地区と重複していないこと。
- **Evidence**:
  - 地区基本情報記録シート（またはチケット）
- **Rollback**:
  - 計画取消（リソース作成前のため実作業なし）
- **HARD STOP Condition**:
  - 自治体コードまたは選挙区の境界定義が曖昧・未確定の場合。

---

### Stage 2: マスターデータ調達 & 検証 (Master Data Acquisition & Verification)

- **Preconditions**:
  - Stage 1 で自治体コードおよび境界定義が確定していること。
- **Input**:
  - 国土交通省 街区レベル位置参照情報（大字・町丁目・小字境界・代表点）
  - 総務省 e-Stat 令和2年国勢調査小地域境界データ（Shapefile / 世界測地系）および人口・世帯数（JINKO / SETAI）
  - デジタル庁 アドレス・ベース・レジストリ（住所マスター原本）
- **Action**:
  1. `scripts/fetch-district-raw-data.py` を実行し、国土交通省および e-Stat 一次データを完全自律取得（ゼロ人間介入原則：`docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md` 厳格遵守）。
  2. `district-data-provisioning` プロトコルおよび `scripts/generate-boundaries-geojson.py` を実行し、国勢調査小地域（幾何・人口・世帯数）と国交省位置参照情報（小字・完成住所）を空間結合（Point in Polygon）。
  3. 飛び地（MultiPolygon）の統合、水面等非居住区域の除外、丁目・小地域コードの正規化を実施し、マスター3点セット（`boundaries.geojson`, `address_master.csv`, `municipality_master.csv`）を生成。
  4. **マスター3点セット同時一括交換 (Master Triad Simultaneous Replacement)**:
     - `address_master.csv` (点), `boundaries.geojson` (面), `municipality_master.csv` (枠) は不可分の3点セットである。必ず3点同時に新地区の確定データへ一括交換し、旧地区データの混在を絶対禁止とする。
  5. **`data/area_mapping.json` の初期化 (Area Mapping Initialization)**:
     - 新規立ち上げ地区（旧実績が存在しない地区）では、誤ったステータス継承・データ汚染を防止するため、**必ず空配列 `[]` に初期化**する。旧地区のマッピングを残存させることは重大事故（別地区エリアの誤爆完了扱い）となるため絶対禁止とする。
  6. **保管場所候補マスターの機械的導出 (Storage Locations Protocol)**:
     - `data/storage_locations.json`（チラシ保管場所選択肢）は、前地区からの流用や静的コピーを永久禁止する。
     - 対象自治体を入力条件とし、公式な衆議院小選挙区画定公定資料から機械的に導出（構成自治体一覧を取得してJSON配備）する。`active/` 内への自治体名ハードコードは禁止。
  7. **一次原本持ち込み禁止 (Raw Data Exclusion)**:
     - `data/raw/` および `data/raw_estat_r2/` などのコピー元地区の原本バイナリを新地区Gitリポジトリへ持ち込んではならない。原本は新地区専用 Google Drive（`SOURCE_ARCHIVE/`）へ保管する。
- **Validation (Master Triad Integrity Gate)**:
  - **Rule-01 (総件数 N の完全一致)**: $\text{address\_master 行数} = \text{boundaries Features} = \text{municipality total\_towns 合計} = N$
  - **Rule-02 (rowId 1..N 1:1 対応)**: `address_master.csv` の `rowId` と `boundaries.geojson` の `properties.rowId` が欠損・重複なく 1:1 一致。
  - **Rule-03 (自治体名完全一致)**: 出現するすべての `city_name` が `municipality_master.csv` と完全一致。
  - **Rule-04 (旧地区残骸ゼロ確認)**: 3点セット内に前地区の自治体名・町名・旧コードが 0件。
  - データ監査スキル `official-data-audit` のパス。
- **Evidence**:
  - 生成されたマスターデータファイル群
  - データ監査ログ（レコード件数、世帯数合計一致証跡、Integrity Gate PASS ログ）
- **Rollback**:
  - 生成データの破棄・スクリプト修正・再生成
- **HARD STOP Condition**:
  - 公式統計データと世帯数・人口の不整合が解明できない場合。
  - Master Triad Integrity Gate（Rule-01 〜 Rule-04）で 1 件でも不整合が検出された場合。

---

### Stage 3: Spreadsheet Pure DB プロビジョニング (Spreadsheet Provisioning / Canonical Drive Layout 準拠)

- **Preconditions**:
  - 親GAS Script Properties に `BRANCH_ROOT_FOLDER_ID`（`03_BRANCH` フォルダID）が設定されていること（未設定時は Fail-Closed）。
  - Google Drive 内に Universal 共通 Empty Template (`POSTING_MAP_EMPTY_TEMPLATE`) が存在すること。
- **Input**:
  - 共通 Empty Template ID (`POSTING_MAP_EMPTY_TEMPLATE`)
  - `districtId`
  - 運用モード（`ELECTION` または `SUBSCRIPTION`）
  - 契約終了日（`YYYY-MM-DD`）
  - ※Caller による格納先フォルダIDおよびDBファイル名の任意指定は禁止（サーバー側自動導出）。
- **Action**:
  1. **Server-side 決定論的 Drive 構造解決**:
     - `DistrictProvisioner.getInstance().resolveOrCreateDistrictDriveStructure(districtId)` を実行。
     - `BRANCH_ROOT_FOLDER_ID` 配下に `03_BRANCH/{districtId}/`、`{districtId} 支部_STORAGE/`、および `SOURCE_ARCHIVE/` を自動探索または正規生成する。
  2. **Canonical DB 複製・生成**:
     - `DistrictProvisioner.getInstance().createDistrictDatabase(templateSpreadsheetId, null, null, options)` を実行。
     - 共通 Empty Template（`SYSTEM_INFO` および `端末管理` のみを保持、原本5種なし、初期状態空欄）から、導出済み `districtFolder` 直下にファイル名 `<districtId>` として複製する。
     - **自動破壊（Auto-Trash）完全抑止**: 既に同名 DB が存在する場合、自動上書き・ゴミ箱送りは永久に禁止され、`DISTRICT_DB_ALREADY_EXISTS` で安全停止（Fail-Closed）する。
  3. **`SYSTEM_INFO` シート設定（Key-Value形式）**:
     - `地区コード` (必須): Stage 1 で決定した `districtId` を正確に入力（Integrity Guard 照合対象）。
     - `運用モード` (必須): `ELECTION` または `SUBSCRIPTION` を明示設定（推論禁止、SSOT）。
     - `Active Dataset Key`: ELECTION の場合は開始時に確定した永続キー（例: `2026-10`）。SUBSCRIPTION の場合は現在年月。
     - `契約開始日時`: プロビジョニング実行時の JST 日時。
     - `契約終了日` (必須): 契約有効期限（YYYY-MM-DD）。
     - `Manager認証パスワード`: 初期管理者PIN（英数字6桁ランダム数値）。
  4. **実運用 5 シート直接生成**:
     - `DistrictProvisioner.getInstance().provisionNewDistrict(addresses, options, districtId)` を実行。
     - `address_master.csv` から実運用 5 シート（`配布実績<Key>`, `名簿<Key>`, `保有チラシ枚数<Key>`, `受渡要請履歴<Key>`, `PinStatus<Key>`）を直接生成する（原本5種は生成しない、計6シート構成）。
     - 5シートの直接生成成功後、`SYSTEM_INFO` の「状態」を `ACTIVE` に確定する。
  5. スプレッドシートID（`spreadsheetId`）を取得。
- **Validation**:
  - **Human Navigation Contract**: スプレッドシートが `03_BRANCH/{districtId}/` 直下に実体として存在し、ショートカット（`application/vnd.google-apps.shortcut`）ではないこと。
  - `SYSTEM_INFO` の `地区コード` とリクエスト `districtId` が完全一致すること（Integrity Guard）。
  - `SYSTEM_INFO` の `運用モード` が `ELECTION` または `SUBSCRIPTION` として確定していること。
  - 実運用 5 シートが欠損なく 5/5 生成されていること。原本5種が存在しないこと。
  - コンテナバインドスクリプト（Apps Script）が **存在しない** こと（Pure DB の完全維持）。
- **Evidence**:
  - 新規スプレッドシートの URL / ID
  - `SYSTEM_INFO` 設定スナップショット
  - Google Drive 物理配置確認ログ（親フォルダID照合証跡）
- **Rollback**:
  - 複製したスプレッドシートの完全削除（ゴミ箱破棄）
- **HARD STOP Condition**:
  - `BRANCH_ROOT_FOLDER_ID` が Script Properties に設定されていない場合。
  - スプレッドシートが `03_BRANCH/{districtId}/` 以外のフォルダ（Templates 等）に生成された場合。
  - スプレッドシート内にコンテナバインドスクリプトが混入している場合。
  - 運用モードが未設定または不明な値の場合。
  - 実運用 5 シートの生成が 1〜4/5 の不完全状態で停止した場合（All-or-Nothing 違反）。

---

### Stage 4: DISTRICT_REGISTRY & Routing 登録 (Routing Configuration)

- **Preconditions**:
  - Stage 3 で `spreadsheetId` および正規 `storageFolderId` が決定論的に発行されていること。
  - 親GAS Script Properties へのアクセス権限を有すること。
- **Input**:
  - `districtId`
  - `spreadsheetId` (Stage 3 導出値)
  - `storageFolderId` (Stage 3 導出値: `{districtId} 支部_STORAGE`)
- **Action**:
  1. 親GASの Script Properties から `DISTRICT_REGISTRY` を取得。
  2. JSON をパースし、新規エントリを追加（または `bootstrapEnvironment` API で一元登録）：
     ```json
     {
       "spreadsheetId": "<CANONICAL_SPREADSHEET_ID>",
       "storageFolderId": "<CANONICAL_STORAGE_FOLDER_ID>",
       "name": "<DISTRICT_NAME>",
       "enabled": false
     }
     ```
     ※ Acceptance完了までは `enabled: false` または検証専用フラグとする。
  3. 更新した JSON を `DISTRICT_REGISTRY` に保存。
- **Validation**:
  - JSON 構文が妥当であること。
  - 登録された `spreadsheetId` および `storageFolderId` が Stage 3 の正規導出値と完全一致すること。
  - 既存の他地区設定が1件も破壊・消失・変更されていないこと（テナント分離保全）。
- **Evidence**:
  - `DISTRICT_REGISTRY` 更新前後の比較ログ（他地区不変の確認）
- **Rollback**:
  - `DISTRICT_REGISTRY` を更新前スナップショットへ即座に戻す。
- **HARD STOP Condition**:
  - `DISTRICT_REGISTRY` のパース失敗、または他地区IDが意図せず書き換わった場合。

---

### Stage 5: 地区別 Secrets & Maps API Key 設定 (Secrets & API Restrictions)

- **Preconditions**:
  - GCP プロジェクト管理者権限を有すること。
  - `districtId` が確定していること。
- **Input**:
  - GCP Console アクセス
  - `districtId`
  - クライアント配信元ドメイン（GitHub Pages 等の公開URL）
- **Action**:
  1. GCP Console にて、当該地区専用の Google Maps API Key を新規発行。
  2. **API制限**: Maps JavaScript API, Places API, Geocoding API のみに厳格制限。
  3. **アプリケーション制限**: HTTP リファラー制限を適用（本番Web Appドメイン、LINE LIFF URLのみを許可。ワイルドカード `*` 単独の全開放は禁止）。
  4. 親GASの Script Properties に以下を設定：
     - キー名: `GOOGLE_MAPS_API_KEY_<districtId>`
     - 値: 発行したAPIキー
- **Validation**:
  - キー名が `GOOGLE_MAPS_API_KEY_<districtId>` で完全一致していること（SEC-007 準拠）。
  - APIキー実値が Git、ログ、チャット、ドキュメントに露出していないこと。
- **Evidence**:
  - Script Properties 設定完了ログ（キー名のみ。値は `[SECURED]`）
  - GCP API制限 / HTTPリファラー制限の設定スクリーンショットまたは設定JSON
- **Rollback**:
  - GCP Console で該当APIキーを即時 Revoke（削除）。
  - Script Properties から該当キーを削除。
- **HARD STOP Condition**:
  - APIキーを HTTP リファラー無制限（全開放）で作成しようとした場合。
  - APIキー実値をGit等にコミットした場合。

---

### Stage 6: 外部サービス連携設定 (LINE / LIFF / Contract)

- **Preconditions**:
  - 当該地区用の LINE Developers 設定（Provider: `Civic Tech Inc.` 配下）が存在すること。
- **Input**:
  - LINE Login チャネル ID（`POSTING MAP Login`）
  - LIFF ID（`POSTING MAP Field`）
  - 契約終了日
- **Action**:
  1. **LINE Developers プラットフォーム設計仕様の適用**:
     - **Provider**: `Civic Tech Inc.` (共通最上位コンテナ)
     - **LINE Login Channel**: `POSTING MAP Login` (共通認証チャネル、App type: Web app、Callback URL: `https://app.posting-map.jp/`、Linked Messaging API: `POSTING MAP Official`)
     - **Messaging API Channel**: `POSTING MAP Official` (Auto-reply: OFF, Greeting messages: ON [アプリ起動案内], Webhook: ON)
     - **LIFF Application**: `POSTING MAP Field`
       - Size: `Full` (全画面表示)
       - Endpoint URL: `https://app.posting-map.jp/active/h-app/index.html` (独自ドメイン絶対パス)
       - Scopes: `profile`, `openid`
       - Bot Prompt: `Aggressive` (友だち追加自動推奨)
       - Module Mode: 無効 (OFF)
  2. **トークン・リッチメニューの配備**:
     - 親GASの `ScriptProperties` に Messaging API 長期チャネルアクセストークンを設定。
     - LIFF URL を組み込んだリッチメニューを適用（`createRichMenuForHApp()`）。
  3. **地区契約情報設定**:
     - 地区の `SYSTEM_INFO` シートに `contract_expiry`（契約終了日）を設定。
  4. **クライアント設定バインド**:
     - クライアント配信設定ファイル（`data/config.js`）に `districtId` と `liffId` を設定。
- **Validation**:
  - LINE ログインから LIFF アプリが正常に全画面起動すること。
  - LIFF 初期化時に `liffToken` が正しく取得できること。
  - チャネルシークレットがクライアント側に一切露出していないこと。
- **Evidence**:
  - LIFF 設定画面情報（機密情報はマスク）
  - リッチメニュー適用確認ログ
- **Rollback**:
  - LIFF アプリの削除または非公開化。
  - Script Properties の該当トークン削除。
- **HARD STOP Condition**:
  - LINE チャネルシークレットをクライアント側 JS や Git にハードコードした場合。

---

### Stage 7: Production Acceptance Verification (実機・API・セキュリティ検品)

- **Preconditions**:
  - Stage 1〜6 がすべて完了していること。
- **Input**:
  - 検証用テスター端末（スマートフォン実機 iOS/Android）
  - 管理者用ブラウザ（PC）
- **Action**:
  1. 機械的受入ゲート `node tests/test_registry_provisioning_gate.mjs` を実行し、全13ゲート（Registry整合、enabled検証、Pure DB完全性、フォールバック不発生、MapsKey、Drive物理階層契約・Human Navigation等）の全件合格を確認する。
  2. 本書第4章「District Production Acceptance Gate」の全21項目を順次実行・検品する。
- **Validation**:
  - `test_registry_provisioning_gate.mjs` が 100% PASS すること。
  - 全20項目がすべて **PASS** すること（1項目でもFAILなら不合格）。
- **Evidence**:
  - `test_registry_provisioning_gate.mjs` 実行ログ
  - Production Acceptance レポート
  - 実機スクリーンショット
  - API Smoke Test 通信ログ
- **Rollback**:
  - 発見された不具合の是正（データ・設定のみ。`active/` は不可侵）。
  - 是正不能な場合は Stage 4 の `DISTRICT_REGISTRY` 削除および Stage 3 の DB 破棄。
- **HARD STOP Condition**:
  - 他地区のデータが閲覧・更新できる（テナント分離破壊）。
  - `active/` のコード修正を行わないと動かない事象が判明した場合。

---

### Stage 8: ACTIVE 昇格 & 監視開始 (Activation & Monitoring)

- **Preconditions**:
  - MASTER の初回 Proceed で承認された Scope に、本 Stage 8（本番有効化: `enabled: true`）が含まれていること。
  - Stage 7 の Production Acceptance（実機・API・セキュリティ全20項目実環境検証および機械受入ゲート全件合格）と必要な検証証跡について、Independent Auditor AI の PASS 判定を取得していること。
  - ※上記2条件を満たす場合、追加の MASTER 承認なしで自律的に本番昇格を実行する（AGENTS.md §6.2, §7.2 準拠）。
- **Input**:
  - Acceptance 完了エビデンス
- **Action**:
  1. 親GAS Script Properties の `DISTRICT_REGISTRY` において、当該地区の `enabled` を `true` に更新（Gateway レベルでの本番ルーティング有効化）。
  2. 地区ステータスを正式に `ACTIVE` に更新・記録。
  3. Phase 20 / 本番監視システムに当該地区を監視対象として登録。
- **Validation**:
  - 一般配布員端末から H App が正常に稼働開始できること。
  - 管理者が Dashboard に正常ログインできること。
  - エラーログが Cloud Logging / Executions に発生していないこと。
- **Evidence**:
  - ACTIVE 昇格完了通知
  - 初回稼働ログ証跡
- **Rollback**:
  - `enabled: false` および `active: FALSE` への即時切り戻し（一時停止）。
- **HARD STOP Condition**:
  - 昇格直後に予期せぬシステム例外・アクセス拒絶が発生した場合。

---

## 4. District Production Acceptance Gate (受入検査規程)

新地区を `ACTIVE` に昇格させる前に、以下の全項目について独立検品を実施する。

| No | 検査項目 | 検証内容 | 合否基準 |
|:---:|:---|:---|:---:|
| 1 | **districtId 正規化** | 英大文字・数字・ハイフンのみ、他地区と重複なし | PASS / FAIL |
| 2 | **DISTRICT_REGISTRY 整合** | 親GAS Registry に登録され、対象 spreadsheetId と一致 | PASS / FAIL |
| 3 | **SYSTEM_INFO Integrity Guard** | DB側 `district_id` とリクエスト `districtId` が一致 | PASS / FAIL |
| 4 | **Pure DB 完全性** | スプレッドシート内にバインドスクリプトが存在しない | PASS / FAIL |
| 5 | **シート構造整合** | `DATA_DICTIONARY.md` 準拠（初期11 Core Sheets複製、運用時13シート標準構造）のヘッダー完全一致 | PASS / FAIL |
| 6 | **地区別 Maps Key 運用** | `GOOGLE_MAPS_API_KEY_<districtId>` が設定済み | PASS / FAIL |
| 7 | **Legacy Fallback 不使用** | 新規地区において無印 `GOOGLE_MAPS_API_KEY` を参照しない | PASS / FAIL |
| 8 | **Maps API 制限確認** | HTTPリファラー制限および許可API制限が有効 | PASS / FAIL |
| 9 | **LINE / LIFF 認証** | LIFF 経由で `lineUserId` が正常取得され偽装不可 | PASS / FAIL |
| 10 | **H App 起動検証** | スマートフォン実機で地図・町丁目ポリゴンが描画される | PASS / FAIL |
| 11 | **Posting Flow 完走** | 配布開始 → 完了 → 確定までの一連フローが正常完走 | PASS / FAIL |
| 12 | **Offline Queue & 復旧** | 機内モードでの配布記録保存 → オンライン復帰で自動同期 | PASS / FAIL |
| 13 | **Idempotency (冪等性)** | 通信切断時の再送で `requestId` による二重登録遮断 | PASS / FAIL |
| 14 | **Dashboard PIN 認証** | 正しいPINでログイン成功、不正PINで明確に拒絶 | PASS / FAIL |
| 15 | **Session District Binding** | 発行されたセッショントークンが該当地区にのみ有効 | PASS / FAIL |
| 16 | **Tenant Isolation (越境遮断)** | 当該セッションで他地区のデータ取得・更新を試行し完全拒絶 | PASS / FAIL |
| 17 | **No lineUserId Exposure** | APIレスポンスに他者の `lineUserId` が一切含まれない | PASS / FAIL |
| 18 | **Manager PIN 秘匿** | `getSystemInfo` 等のパブリックAPIでPINが露出しない | PASS / FAIL |
| 19 | **Formula Injection 耐性** | スタッフ名・連絡先等に数式文字を入力しても無害化される | PASS / FAIL |
| 20 | **実機レンダリング & パフォーマンス** | 地図描画・ポリゴン表示が遅延なくスムーズに動作する | PASS / FAIL |
| 21 | **Drive Physical Layout 整合** | `03_BRANCH/{districtId}/` 直下への正規配置、ショートカット排除、Human Navigation 充足、自動破壊ゼロ | PASS / FAIL |

> [!CAUTION]
> 上記のいずれか1項目でも FAIL した場合、当該地区の `ACTIVE` 昇格は **厳格に却下（HARD STOP）** される。
