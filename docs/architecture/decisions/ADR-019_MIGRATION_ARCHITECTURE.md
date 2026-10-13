# ADR-019: Universal Migration Architecture & Specification

- **Status**: ACCEPTED
- **Date**: 2026-09-25
- **Deciders**: Universal Engine Architecture Team
- **Consulted**: Master Plan Phase 18 Requirements, DATA_LIFECYCLE.md, ADR-016, ADR-017, ADR-018

---

## 1. Context & Background

マスタープラン Phase 18 では「Migration」として以下の 6 つの重要要素が要求されている：
1. **data mapping**
2. **ID mapping**
3. **compatibility**
4. **migration script**
5. **validation**
6. **rollback point**

Phase 18 の本質的責務は、現行環境（レガシー構成・旧スキーマ・概略町丁区分）から新環境（Universal Engine・Additive Schema・国勢調査小地域マスター）への**「移行計画・仕様・アーキテクチャ契約の確定」**である。
次工程である **Phase 19（Cutover / Rollback）** が「本番データの実際の切替・凍結・運用移行・スモークテスト」を担当するため、Phase 18 において本番データの一括書き換えや実移行を行わない厳格なフェーズ境界を維持する。

本ADRでは、安全かつ再現性のある移行を実現するための 6 大要素の仕様を正式に決定する。

---

## 2. Decision: 6-Core Migration Architecture Specifications

```mermaid
graph TD
    subgraph "Phase 18: Migration Architecture (確定契約)"
        DM[1. Data Mapping: Additive Schema Evolution]
        IM[2. ID Mapping: Strict 1:1 Binding]
        CP[3. Compatibility: Zero Downtime & Legacy Guard]
        MS[4. Migration Script: Dry-Run & Strict Name Match]
        VL[5. Validation: Zero Diff & Invariant Check]
        RB[6. Rollback Point: Column-level & Snapshot]
    end
    subgraph "Phase 19: Cutover & Execution (次工程)"
        Freeze[Production Freeze]
        RunMig[Execute Migration]
        Smoke[Smoke Test & Verification]
    end
    Phase 18 --> Phase 19
```

### 2.1 data mapping (非破壊的スキーマ拡張とデータマッピング)
既存の列を移動・削除・変更せず、末尾に新設列を追加する **Additive Schema Evolution（非破壊的列追加）** を絶対原則とする。

| テーブル (シート) | 既存列 | 追加列 | 目的・用途 |
| :--- | :--- | :--- | :--- |
| **`配布実績`** (`配布実績YYYY-MM`) | A〜O列 (15列) | **P列 (16列目)**: `lineUserId`<br>**Q列 (17列目)**: `requestId` | 配布員のLINE本人性バインディング、通信リトライ時の二重登録排除 (UUID v4) |
| **`保有チラシ枚数`** (`保有チラシ枚数YYYY-MM`) | A〜F列 (6列) | **G列 (7列目)**: `lineUserId` | 保管者のLINE本人性バインディング |
| **`受渡要請履歴`** (`受渡要請履歴YYYY-MM`) | A〜G列 (7列) | **13列目**: `requesterLineUserId`<br>**14列目**: `holderLineUserId` | 要請者・保管者間の安全な当事者バインディング |
| **`名簿`** (`名簿YYYY-MM`) | A〜D列 (4列) | 追加なし | 既に `[ID, 名前, LINE_USER_ID, 登録日時]` を保持 (SSOT) |
| **マスターデータ** (`address_master.csv`) | 1..N エリア | `data/area_mapping.json` | 旧1..N の親大字と国勢調査小地域（新rowId, e_stat_code, 人口, 世帯数）の全件マッピング |

### 2.2 ID mapping (識別子バインディング規則)
Universal POSTING MAP における識別子体系を以下のように厳格に定義・マッピングする。

1. **`staffId`**:
   - 名簿原本 A列で一意に管理される表示用スタッフID（例: `S001`〜`S999` または `K001` 等）。
2. **`lineUserId`**:
   - LINE プラットフォームが発行する一意の識別子（`U[0-9a-f]{32}`）。名簿原本 C列と 1:1 バインディング。
   - クライアントへの生値返却は絶対禁止（マスクまたは非露出）。
3. **`districtId`**:
   - 大文字英数・ハイフン・アンダースコア（例: `KUWANA`, `OKAYAMA-02`）。
   - `DISTRICT_REGISTRY` およびスプレッドシート `SYSTEM_INFO` と 1:1 バインディング。
4. **`rowId`**:
   - 町丁目マスター行番号（1〜N の不変インデックス）。
   - 小地域細分化時も旧 `rowId`（1..N）を 100% 保持し、新規小地域には `N+1` からの連続連番を付番。
5. **`requestId`**:
   - Hアプリが送信ごとに発行する暗号学的 UUID v4（`req_xxxx`）。配布実績 Q列と照合して二重追記を防止。

### 2.3 compatibility (新旧互換性・共存プロトコル)
1. **レガシースプレッドシート互換**:
   - P列（`lineUserId`）や Q列（`requestId`）が存在しない旧スプレッドシートでも、GAS API はエラー（HTTP 500）とならず、フォールバックして正常動作を継続する。
2. **月次シート互換**:
   - `MonthlySheetResolver` により、当月シートが存在しない場合でも原本から動的に解決し、前月以前の過去シートは不変アーカイブとして安全に凍結される。
3. **掲示板コードの後方互換ガード（Legacy Compatibility Guard）**:
   - `active/gas/v2_migration.js` 内の掲示板マイグレーション処理（Line 153〜202）は、旧環境スプレッドシートが存在した場合のための後方互換ガード（`if (bSheet)`）として差分ゼロ（不可侵）で維持する。Universal Engine では無視され、無害である。

### 2.4 migration script (移行スクリプト規約)
移行スクリプト（`active/gas/v2_migration.js` の `migrateIdentityColumns(isDryRun)`）は以下の安全制約を厳守する：

1. **Dry-Run 必須化**:
   - `isDryRun: true` をデフォルトとし、事前シミュレーションレポート（追加予定ヘッダー数、更新予定行数、スキップ行数、不一致理由）を生成・確認してから本番適用する。
2. **厳格な名簿完全一致（Strict Name Match）**:
   - `staffId` および名前（氏名）の双方が名簿と完全一致する場合のみ、一意に確定して `lineUserId` を補完する。
3. **矛盾行の空欄保全（Preserve Contradictions as Blank）**:
   - `ST001`（例: 名簿では `S001`=なお だが、実績では `S001`=K. IWASA のように名前が矛盾する行）は、**絶対に推測で補正せず、空欄のまま保全**する。
4. **実行権限の保護**:
   - API エンドポイント `runIdentityMigration` は `verifyProvisioningToken` により厳格に認可保護される。

### 2.5 validation (移行検証・整合性監査プロトコル)
マイグレーション実施前後に以下の不変条件（Invariants）を機械監査する：
1. **行数不変性**: 移行前後でスプレッドシートの総データ行数が 1 行も増減していないこと。
2. **既存事実の不変性**: 配布完了日時、枚数、GPS座標、写真URL等の既存データが 1 文字も改変されていないこと。
3. **旧 rowId 保持率 100%**: `rowId: 1..N` が完全に維持され、欠番・改番がないこと。
4. **未解決行の明示**: 名簿と一致せず空欄保全された行のリストが監査ログとして完全に記録されていること。

### 2.6 rollback point (ロールバックポイントと復元制約)
1. **スプレッドシート全体の一括版復元は永久禁止**:
   - Google Spreadsheet の「版の履歴」からシート全体を一括復元することは**原則禁止**とする。障害発生後に現場配布員が正常に登録した「他の町丁目の正当な配布実績」まで不可逆的に巻き戻され消失するためである。
2. **事前スナップショットの確保**:
   - マイグレーション実行直前に、対象スプレッドシートを Google Drive 上で複製（`makeCopy`）し、タイムスタンプ付き退避バックアップを確保する。
3. **列レベルの外科的ロールバック（Surgical Column Rollback）**:
   - 移行で異常を検知した場合は、末尾に追加された新設列（P列、Q列等）を削除またはクリアすることで、安全かつ瞬時に旧スキーマ状態へ原状復帰する。

---

## 3. Consequences & Benefits

- **破壊的変更ゼロ**: Additive Schema により、旧クライアント・新クライアントが同一DBで共存可能。
- **データ改ざんリスクの排除**: 推測補正を禁止し、矛盾データを空欄保全することで、過去実績の監査性を完全維持。
- **明確なフェーズ境界**: 計画・仕様の確定（Phase 18）と、切替・運用移行（Phase 19）が明確に分離され、運用リスクを最小化。
