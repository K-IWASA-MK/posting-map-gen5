# ADR-022: Multi-Region Architecture & Generic Validation Specification (マルチリージョン汎用成立仕様書)

## Status
Accepted (Approved) — Phase 21 最終汎用設計決定およびマルチリージョン成立契約

## Context
POSTING MAP Universal Engine は、「1地区 = 1完成アプリ = 1単独フォルダー = 1単独リポジトリ = 1単独ドメイン」のアーキテクチャ原則（`AGENTS.md` 第1条、`docs/architecture/01_DESIGN_CONTRACT.md`）の下、共通Runtime（`active/**`）を Universal Engine として全地区同一内容を維持し、地域差分をコード改変ではなくデータ・設定によって吸収することを最上位基本原則として制定している。

マスタープラン Phase 21 は最終フェーズとして以下を要求している：
> **「複数の地域データを投入して、地域が変わってもコードを複製・改変せず動作することを確認する」**
> - **合格条件**: 地域A用コード、地域B用コードを作らず、
>   ```text
>   同一共通Runtime（active/**）
>   +
>   異なる地域データ（data/**）
>   ```
>   による独立完成アプリ（1地区 = 1完成アプリ = 1単独フォルダー = 1単独リポジトリ = 1単独ドメイン）として成立すること。

本文書（ADR-022）は、マスタープラン上の直接的な未達要件ではなく、Phase 21 の最終検証結果、10大検証対象の機能独立性、および新地区の独立成立プロトコルを公式に記録・固定するための補助文書として策定する。

---

## Decision

### 1. Universal 成立の 5 大原則（Supreme Principles）

1. **Runtime Identity（同一コード原則）**:
   - `active/` 配下の全コード（JavaScript, HTML, CSS, GAS）はすべての地区で 100% 共通のバイナリ・コードとして実行される。
   - コード内に地区別の条件分岐（`if (district === 'A')`）や地区名・自治体コード・特定件数のハードコードを 1 行たりとも含めてはならない。
2. **Data-Driven Dynamic Binding（動的データバインディング原則）**:
   - 地区名、市区町村名、自治体コード、総エリア件数、地理座標系、地図表示範囲（bounds）、境界ポリゴン（GeoJSON）、月次シート名、スタッフ名簿、配布進捗、個人ランキングのすべては、投入された `data/` および接続先スプレッドシートから 100% 動的に解決される。
   - 桑名市の 337 件や自治体コード 24205 は「1 つの地区データ」であり、エンジンの上限や固定値ではない。
3. **Strict Tenant Isolation（厳格なテナント分離・認可境界原則）**:
   - 地区間でのデータ混線、集計混入、他地区データへの不正横断アクセスは、`DISTRICT_REGISTRY`（Script Property）と各スプレッドシートの `SYSTEM_INFO`（地区コード）による機械的照合ガード（`DISTRICT_MISMATCH`）によって物理的・論理的に完全に遮断される。
4. **Functional Independence（10大検証対象の完全独立性）**:
   - 支部、対象地域、党員、活動ログ、MAP、Dashboard、個人ランキング、API、認証、データ境界の 10 領域すべてが、地区ごとに完全に独立して整合性を維持する。
5. **Zero-Code District Provisioning（コード変更ゼロの新地区プロビジョニング）**:
   - 新しい地区を作るために必要な作業は、地区固有の `data/` ファイル（`address_master.csv`, `boundaries.geojson`, `config.js`）の配置、新スプレッドシート（EMPTY TEMPLATEから複製し実運用5種を直接生成、原本5種なし、`SYSTEM_INFO`に運用モード設定、ADR-024準拠）の接続、および `DISTRICT_REGISTRY` へのエントリ登録のみであり、Universal Runtime（`active/`）の変更行数は **0 行（差分ゼロ）** である。

---

### 2. 10大検証対象の機能独立性マトリクス

| # | 検証対象 | Universal 実装機構 | 地区分離のメカニズム | 混線防止保証 |
|---|---|---|---|---|
| **1** | **支部** | `SYSTEM_INFO` シート / `districtId` | `SYSTEM_INFO` の「支部名」「地区名」から動的取得 | 他支部の名称・設定が混入しない |
| **2** | **対象地域** | `AddressMasterService` (`data/address_master.csv`) | CSV行数・町名から動的にエリア一覧を生成（件数非固定） | 別地区の町名・エリアが混入しない |
| **3** | **党員** | `StaffService` / `名簿YYYY-MM` シート | 該当地区スプレッドシートの当月名簿シートを参照 | A地区の名簿にB地区党員が混入しない |
| **4** | **活動ログ** | `DistributionService` / `配布実績YYYY-MM` シート | 該当地区スプレッドシートの当月実績シートへ追記 | A地区の実績がB地区シートに記録されない |
| **5** | **MAP** | `render.js` / `google.maps` / Leaflet | 投入されたピン群の座標から動的に `fitBounds` 算出 | A地区の地図にB地区のピンが表示されない |
| **6** | **Dashboard** | `app.js` / `manager.js` | 該当地区の完了数とCSV総エリア数から進捗率を算出 | 総エリア数・進捗率が正しく個別算出される |
| **7** | **個人ランキング** | `DistributionRepository.fetchRankingData` | 該当地区の `配布実績YYYY-MM` のみを走査・集計 | ランキングに他地区スタッフが集計されない |
| **8** | **API** | `v2_api.js` / `SpreadsheetResolver` | リクエストスコープの `districtId` でDBを動的解決 | 異なる地区IDのリクエストが正しく個別DBへ到達 |
| **9** | **認証** | `auth.js` / `staff_identity_boundary` | LINE User ID と該当地区名簿の突合 | A地区のLINEユーザーがB地区で未認可となる |
| **10** | **データ境界** | `verifyIntegrityGuard` (`DISTRICT_MISMATCH`) | スプレッドシート `SYSTEM_INFO` の地区コードと照合 | 越境アクセス試行時は即座に例外スロー・拒否 |

---

### 3. 異種テストFixture（Region A vs Region B）による成立検証仕様

本番環境の破壊・書き込みを排除し、テスト環境内で以下の完全に異質な 2 つの独立地区データを用いて検証を担保する。

| 観点 | Region A (桑名地区構造) | Region B (倉敷地区異種テストFixture) | 検証合格判定条件 |
|---|---|---|---|
| **地区ID** | `KUWANA` | `KURASHIKI` | コード内に地区ID依存の特別扱いがないこと |
| **自治体名** | 桑名市 (コード: 24205) | 倉敷市 (コード: 33202) | 市区町村名・コードが動的に取得されること |
| **総エリア件数** | **337 件** | **120 件** | エリア総数が 337 固定でなく動的に 120 となること |
| **地理座標系** | 三重県桑名市 (Lat ~35.06, Lng ~136.68) | 岡山県倉敷市 (Lat ~34.58, Lng ~133.77) | 地図バウンディングボックスが各座標群へ自動適合すること |
| **Spreadsheet ID**| `ss-kuwana-id` | `ss-kurashiki-id` | `DISTRICT_REGISTRY` を通じて完全に別DBへ到達すること |
| **所属スタッフ** | K001 (桑名 太郎), K002 (桑名 花子) | B001 (倉敷 三郎), B002 (倉敷 四郎) | スタッフ一覧・名簿が完全に独立して取得されること |
| **配布実績** | K001: 100枚 | B001: 250枚 | ランキング1位がそれぞれの地区で正しく独立算出されること |
| **越境アクセス** | KUWANA ➔ KURASHIKI 要求 | KURASHIKI ➔ KUWANA 要求 | いずれも `DISTRICT_MISMATCH` で即座に遮断されること |

---

### 4. 新地区独立成立プロトコル (New District Provisioning Protocol)

Universal POSTING MAP において、新しい地区を立ち上げる手順は以下の通りであり、Runtime コード（`active/`）への変更は永久に不要である：

```text
[Step 1: 地区マスターの調達]
  DISTRICT_DATA_ACQUISITION_RULE.md に基づき、市区町村コードから
  address_master.csv / boundaries.geojson を自動生成し data/ 配下に配置。

[Step 2: スプレッドシートの準備]
  POSTING_MAP_EMPTY_TEMPLATE から複製し、SYSTEM_INFO に「地区コード」「運用モード」「契約開始日時」「契約終了日」を記載。
  DistrictProvisioner により実運用5種シートを直接初期化（原本5種は生成しない、ADR-024 準拠）。

[Step 3: 接続レジストリの登録]
  親 Standalone GAS の Script Properties (DISTRICT_REGISTRY) に
  {"NEW_DISTRICT": "new_spreadsheet_id"} を追記。

[Step 4: 独立完成アプリ成立]
  同一の Universal Web App / Dashboard / Hアプリ から、
  districtId="NEW_DISTRICT" を指定してアクセスするだけで、
  コード変更 0 行で完全に独立した新地区アプリケーションとして稼働。
```

---

## Consequences & Compliance
- **Universal POSTING MAP の完全成立**:
  マスタープラン Phase 1〜21 の全要求が同一コードベース内で完結し、地域ごとのリポジトリ分裂・コード改変が永久に撲滅される。
- **289 地区展開への即時対応**:
  日本全国 289 の小選挙区・自治体への展開が、コード改変なし（純粋なデータ・設定追加のみ）で完全にスケール可能であることが保証される。
