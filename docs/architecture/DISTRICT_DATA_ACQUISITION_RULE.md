# POSTING MAP 地区データ自律調達・2段階マスター生成規程
## DISTRICT_DATA_ACQUISITION_RULE.md

Version: 2.0 (Phase 1 Area Skeleton 単一契約確定版)
Date: 2026-10-15
Author: AI Architecture Team (承認審査: 岩佐CEO)
System: Universal POSTING MAP Engine / 289 District Expansion OS
関連規程: `docs/architecture/01_DESIGN_CONTRACT.md` / `docs/architecture/ADDRESS_EXTRACTION_RULE.md` / `.agents/rules/district-data-transition-rule.md`

---

## 1. 目的と最上位絶対原則（Supreme Principles）

本規程は、Universal POSTING MAP における新地区展開（プロビジョニング）およびマスターデータ（`address_master.csv`, `boundaries.geojson`, `municipality_master.csv`）の生成において、**「人間によるデータ取得作業の完全排除（ゼロ手作業）」** と **「第1段階 Area Skeleton（3列骨格）確定と第2段階 属性・境界付与の厳格分離」** を担保するための標準実行規範である。

### 【原則 1】ゼロ人間介入の原則（Zero Human Intervention）— ABSOLUTE
- 地区マスターの生成に必要な公定一次資料の調達は、**100% AIエージェントが自律スクリプトにより実行**しなければならない。
- ユーザー（人間）にブラウザでダウンロードさせたり、フォルダーへの配置を指示・依頼することは**永久に禁止**する。
- 対象地区（構成自治体コード5桁）を確定するだけで、すべての調達・解凍・検証が完全自動で完結しなければならない。

### 【原則 2】Phase 1 Area Skeleton と Phase 2 後段属性付与の厳格分離原則 — ABSOLUTE
地区データの生成は、以下の2段階（Phase 1 / Phase 2）に厳格に分離し、後段データが第1段階の骨格（行集合・町名・順序・`rowId`）を支配・汚染してはならない。

1. **第 1 段階（Phase 1: Area Skeleton 確定 — 3列骨格生成）**:
   - 最初に対象地区（構成自治体）を確定する。
   - 次にその地区の `city_name` / `town_name` を全国共通の公式住所データから確定する。
   - **丁目の包含**: 公式に「丁目」が存在する場合は、丁目まで `town_name` に含める。
   - **下位分割・人工名称の禁止**: `town_name` より下位の小字・方角・通称・地番範囲・人工的括弧名称は、全国共通の公式ソースから一意取得できない限り、**探索・推測・生成・地区固有辞書補完を行わない**。
   - **Phase 1 成果物スキーマ（3列のみ）**:
     ```csv
     rowId,city_name,town_name
     ```
   - **`rowId` の採番**: 最終的な `city_name` / `town_name` の順序確定後に `1..N`（1始まりの連続整数、欠番・重複なし）を採番する。
   - **後段データの混入禁止**: Phase 1 の Skeleton 決定に e-Stat、`households`、`population`、`latitude`、`longitude`、`boundaries`、投票率等を一切使用してはならない。

2. **第 2 段階（Phase 2: 後段属性・境界付与 — Attribute & Boundary Enrichment）**:
   - Phase 1 で確定した3列 Area Skeleton（`rowId,city_name,town_name`）を不変の基準（Authority）として受け取る。
   - 総務省統計局「e-Stat 国勢調査小地域境界データ」等の公定統計・地理データから、代表座標（`latitude`, `longitude`）、世帯数（`households`）、人口（`population`）、小地域コード（`e_stat_code`）、および境界ポリゴン（`boundaries.geojson`）を後段責務として付与し、最終 Master Triad（`data/address_master.csv`, `data/boundaries.geojson`, `data/municipality_master.csv`）を完成させる。

### 【原則 3】公式町字粒度原則（Official Town Granularity Doctrine）— ABSOLUTE
- `docs/architecture/ADDRESS_EXTRACTION_RULE.md` に基づき、`town_name` は公式に存在する町字名（公式に丁目が存在する場合は丁目まで含めた名称）で確定する。
- e-Stat 側の調査区分割（枝番）に合わせて人工的な方角名（`（北部）`、`（北東部）` 等）や小字括弧名（`（〇〇）`）を合成・推測・地区固有辞書補完することを禁止する。

### 【原則 4】原本はDrive・確定データはGit（Drive Storage & Provenance Doctrine）— ABSOLUTE
- **「Driveに原本 ➔ Gitに確定データ」**: 外部から取得した地区固有の原本・公定一次資料は、最初から地区専用 Google Drive（`SOURCE_ARCHIVE` 領域）へ恒久保存する。
- Git リポジトリには、汎用OS本体、検証・監査済みの確定実行データ（`data/`）、正式スクリプト、監査記録のみを保持し、原本バイナリをGitに持ち込まない。

### 【原則 5】既存稼働地区データの非遡及保護原則（Non-Migration Principle）— ABSOLUTE
- 既に確定・稼働している既存地区の `data/**`（`address_master.csv`, `boundaries.geojson`, `municipality_master.csv`）および既存の `rowId` は、本規程の改定によって遡及的に再生成・改番・Migrationしてはならない。

---

## 2. 2段階生成アーキテクチャ（Two-Phase Generation Architecture）

```text
┌─────────────────────────────────────────────────────────────┐
│             Step 1: 対象地区・構成自治体コード確定              │
│                     （例: <CITY_CODE>）                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│        【Phase 1: Area Skeleton 生成（第1段階・骨格確定）】     │
│  ・全国共通の公式住所データから city_name / town_name を確定   │
│  ・公式に丁目が存在する場合は丁目まで town_name に含める        │
│  ・town_name より下位の小字/方角/通称/人工括弧は探索・生成しない │
│  ・e-Stat / 人口 / 世帯数 / 座標 / 境界は一切使用しない        │
│  ・最終 city_name / town_name 順序確定後に rowId = 1..N 採番  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
               ［Phase 1 成果物: 3列 Area Skeleton］
                    rowId,city_name,town_name
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│   【Phase 2: 後段属性・境界付与（Attribute & Boundary 付与）】  │
│  ・確定済み Area Skeleton (rowId,city_name,town_name) を基準に │
│    e-Stat 国勢調査データ等から後段属性を付与                   │
│  ・付与項目: latitude, longitude, households, population,    │
│    e_stat_code, および boundaries.geojson                    │
└──────────────┬───────────────────────────────┬──────────────┘
               ▼                               ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐
│   data/address_master.csv    │ │    data/boundaries.geojson   │
│ (Skeleton 3列 + 後段属性5列)   │ │  (rowId 1..N 対応ポリゴン)    │
└──────────────────────────────┘ └──────────────────────────────┘
```

---

## 3. 調達データソース仕様と段階別責務

### 3.1 Phase 1（Area Skeleton 確定用）：公式住所データソース
- **責務**: 対象自治体の公式な `city_name` および `town_name`（公式に丁目が存在する場合は丁目まで）の一意確定。
- **取得単位**: 市区町村コード（`<CITY_CODE>`）単位で自動取得・UTF-8正規化。
- **抽出・正規化規則**:
  - `city_name`: 対象市区町村の公式名称。
  - `town_name`: 先頭の形式的な「大字」接頭辞（`^大字`、ただし町名自体が「大字」のみの場合を除く）を除去した公式町字名（公式に丁目が存在する場合は丁目まで含める）。
  - **非抽出項目（Phase 1 で使用禁止）**: 小字・通称名、街区符号・地番、代表緯度・経度、人口、世帯数、e-Stat境界。

### 3.2 Phase 2（後段属性・境界付与用）：総務省統計局 e-Stat 国勢調査小地域データ等
- **提供元**: 政府統計の総合窓口（e-Stat）等
- **責務**: Phase 1 で確定した Area Skeleton の各行に対する地理・統計属性（`latitude`, `longitude`, `households`, `population`, `e_stat_code`）および境界ポリゴン（`boundaries.geojson`）の後段付与。
- **注意**: Phase 2 のデータソースの都合によって Phase 1 の `rowId,city_name,town_name` を分割・統合・改名・再採番してはならない。

---

## 4. Phase 1 Area Skeleton 確定・採番ルール

### ルール 4.1: 公式町字・丁目の確定（Official Town & Chome Determination）
- 公式データに丁目が存在しない町字は、町字名そのものを1行の `town_name` とする。
  - 例: `大字〇〇` ➔ **`〇〇`**
  - 例: `△△町` ➔ **`△△町`**
- 公式データに丁目が存在する町字は、各丁目まで含めた名称をそれぞれの `town_name` とする。
  - 例: `□□町一丁目`, `□□町二丁目`

### ルール 4.2: 下位階層・人工的括弧名称の絶対禁止（No Sub-Town Fabrication）
- `town_name` より下位の小字・方角（`北部`/`南部`/`北東部`等）・通称・地番範囲・人工的括弧名称（`〇〇（△△）` 等）は、全国共通の公式ソースから一意取得できない限り、**探索・推測・生成・地区固有辞書補完を一切行わない**。
- 同一自治体内で完全一致する同一 `town_name` が複数行発生してはならない（重複ゼロ保証）。

### ルール 4.3: 整列と `rowId`（`1..N`）の確定採番（Deterministic Ordering & Numbering）
- 新規地区の Phase 1 Area Skeleton 生成では、対象地区の全 `(city_name, town_name)` の最終順序を確定した後に、先頭から **`rowId` を `1..N`（1始まりの連続整数）で一意に採番**する。
- 特定地区専用の読みカナ辞書をスクリプト内にハードコードしてはならない。
- 一方、**既存稼働地区の確定済みデータ** については、既存の `rowId`（`1..N`）を100%保護し、遡及的な改番・振り直し（Migration）を絶対に行わない。

---

## 5. 品質保証ゲート（Verification Gates: QG-1 〜 QG-5）

マスター生成完了時、以下の5層ゲートをすべてPASSしなければデプロイ・本番反映を禁止する。

| Gate | 検証項目 | 合格基準 |
| :--- | :--- | :--- |
| **QG-1: 完全自律調達ゲート** | 人間介入ゼロの客観証明 | スクリプト実行で公式データ取得から生成までエラーなく完走し、人間の手動操作や地区固有ハードコード辞書が介在していないこと。 |
| **QG-2: Phase 1 Area Skeleton 純度ゲート** | 3列骨格の純粋性・重複ゼロ | Phase 1 Skeleton が `rowId,city_name,town_name` の3列のみで確定し、e-Stat等の後段データ非依存であり、人工的括弧名称や同一自治体内の `town_name` 重複が0件であること。 |
| **QG-3: `rowId` 採番・参照整合性ゲート** | `rowId` 1..N 完全性 | 新規地区では最終順序確定後に `rowId` が `1..N` 連番で欠番・重複なく採番され、Master Triad 間で 1:1 完全一致すること（既存稼働地区は既存 `rowId` 不変）。 |
| **QG-4: Phase 2 後段属性整合ゲート** | 統計・座標属性の整合性 | Phase 2 で付与された `latitude`, `longitude`, `households`, `population`, `e_stat_code` が欠損・不正値なく Area Skeleton に結合されていること。 |
| **QG-5: 幾何トポロジーゲート** | GeoJSON正常性 | `boundaries.geojson` の Feature 数が Area Skeleton 行数 $N$ と完全一致し、自己交差が0件、CRSがCRS84であること。 |

---

## 6. 禁止事項（Prohibited Actions）— ABSOLUTE

1. **手作業ダウンロードの要請**: ユーザー（人間）にデータ取得・ZIP解凍を指示すること。
2. **Phase 1 への後段データ混入**: Phase 1 Area Skeleton（`rowId,city_name,town_name`）の決定に、e-Stat、`households`、`population`、`latitude`、`longitude`、`boundaries`、投票率等を使用すること。
3. **下位小字・方角・人工括弧名称の生成・辞書補完**: `town_name` より下位の小字・方角・通称・人工的括弧名称を探索・推測・生成したり、特定地区専用の辞書・オーバーライド表をコード内に持つこと。
4. **既存稼働地区データの無断Migration・改番**: 既に稼働している地区の既存 `data/**` や `rowId` を勝手に再生成・振り直すこと。
5. **外部有料API依存**: Google Maps Geocoding API等の外部課金APIや検索結果をデータ生成パイプラインの前提にすること（完全オフライン・公定オープンデータで完結させること）。
6. **scratch への原本保存の絶対禁止**: `scratch/` は外部原本の恒久的保存場所ではない。一時作業で利用した場合でも、変換・監査完了後は速やかに削除し、Git追跡下やローカル作業領域に残存させてはならない。
7. **前地区一次原本の持ち込み絶対禁止**: 前地区の一次原本（PDF, Excel, Shapefile, ZIP, 中間GeoJSON等）を新地区Gitリポジトリへ持ち込んではならない。新地区の外部原本は新地区専用Driveで新規取得・管理する。

---

## 7. 原本恒久保管・追跡可能性統制 (Drive Storage & Provenance)

### 7.1 Google Drive 保管構造 (Drive Storage Architecture)
各地区専用の Google Drive（親フォルダー `03_BRANCH/{DISTRICT_NAME}`）内に、原本専用の保管領域を設ける。
```text
03_BRANCH/{DISTRICT_NAME}/
├── {DISTRICT_NAME} (スプレッドシート Pure DB)
├── {DISTRICT_NAME} 支部_STORAGE (アプリ稼働用ストレージ)
└── SOURCE_ARCHIVE/ (原本恒久保管領域)
    ├── election/ (選挙関連公式一次資料: 第49回/, 第50回/, 第51回/)
    ├── census/ (国勢調査・e-Stat統計原本)
    └── postal/ (住所・郵便関連公的資料)
```

### 7.2 原本の追跡可能性 (Provenance & Traceability)
外部原本を Google Drive へ保存し、確定データを生成・監査した場合、以下のメタデータを監査記録（`.agents/records/`）に明記する。
1. **情報源（発行元機関）**: （例: 都道府県選挙管理委員会、総務省、e-Stat、デジタル庁）
2. **資料名 & 公表日**: （例: 衆議院小選挙区開票結果、公表年月日）
3. **公式 URL または取得経路**: 公定公開URL
4. **Drive 上の保存先 & ファイル名**: （例: `SOURCE_ARCHIVE/election/...`）
5. **整合性検証証跡**: ファイルサイズ、SHA-256 / MD5 ハッシュ、確定データ（`data/`）との突合検算結果

### 7.3 決定論的データ生成パイプライン (Deterministic Data Pipeline)
アプリケーション（Hアプリ、Manager、GAS）は、Google Drive 上の原本を直接 fetch したり動的に解釈する構造を持ってはならない。
```text
Drive 原本 ➔ [Phase 1: Area Skeleton (3列)] ➔ [Phase 2: 後段属性・境界付与] ➔ [機械監査ゲート] ➔ 確定 ➔ data/ 配置
```
1. **Phase 1（Area Skeleton 生成）**: 公式住所原本から `rowId,city_name,town_name`（3列のみ）を決定論的に確定・`1..N` 採番。
2. **Phase 2（後段属性・境界付与）**: 確定した Area Skeleton に対し、後段で統計・座標・GeoJSON境界を付与。
3. **監査・検証**: Master Triad 閉包整合性およびトポロジーを全数機械監査。
4. **Git 配置**: 検証 PASS を確認した成果物のみを `data/` へ配置し、Git コミットする。
