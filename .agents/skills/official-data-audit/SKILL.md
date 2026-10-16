---
name: official-data-audit
description: 公式データ確定監査規範。Phase 1 Area Skeleton（rowId,city_name,town_name）の公式住所照合、Phase 2 後段統計・境界属性の多層照合、および完全性機械検証。
---

# Official Data Audit Capability Pack

## 1. 概要と適用責務
本 Pack は、地区マスターデータ（`data/address_master.csv`, `boundaries.geojson`, `municipality_master.csv`）において、第1段階 Area Skeleton（`rowId,city_name,town_name` の3列）および第2段階の後段付与属性（座標・世帯数・人口・`e_stat_code`・境界ポリゴン）が公式一次資料と 100% 整合していることを客観的に機械検証・監査するための品質規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [UNIVERSAL_QUALITY_DOCTRINE.md](../../../docs/architecture/UNIVERSAL_QUALITY_DOCTRINE.md): Universal 品質ドクトリン
- [DISTRICT_DATA_ACQUISITION_RULE.md](../../../docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md): 地区データ自律調達・2段階マスター生成規程

## 3. 遵守すべき絶対規範
1. **Phase 1 Area Skeleton と Phase 2 後段属性の分離照合原則**:
   - **Phase 1（Area Skeleton 監査）**: `rowId,city_name,town_name` の3列が、正本 `docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md` の住所の母集合・公式区割り・正規化・整列規則（§3.1, §4）どおりに確定されていることを検証する。検証項目は同規程 QG-2 / QG-3（期待集合と出力集合の一致〔混入ゼロ・漏れゼロ〕、重複行ゼロ、`rowId` の `1..N` 連続採番、区割り判定不能・名称衝突の未解決・読み仮名欠落ゼロ）と、Provenance に記録された区割り根拠（適用法令の施行版・未施行改正・経過措置の判断）の確認とする。
   - **原本健全性と読み完全性の分離監査**: ABR原本の物理構造・コード体系・種別整合性検証と、母集合に対する読み仮名の完全性解決を明確に分離して照合する。ABR原本自体の読み欠損による不当停止がないこと、および母集合町域の読みが外部根拠JSON（`<city_code>:<town_code>` 複合キー）等により公的に100%解決されていることを検証する。
   - **案A衝突回避の監査**: 同一市町村内で大字除去により異なる公式コード間で衝突する場合に原文名称（大字表記）が正しく保持され、独立した町域として分離維持されていること（重複ゼロ）、および原文保持でも区別不能な衝突が存在する場合に停止することを検証する。
   - **原本対応根拠データの完全性監査**: 3列 CSV とは別の根拠データ（`skeleton_provenance.json`）に各町域の `rowId`、自治体コード、国交省町丁目コード、原文名称、正規化名称、原本緯度経度、出典が漏れなく1:1で記録され、再整列（`sort-address-master.py`）でも同一の名称・順序が完全再現されることを検証する。
   - `town_name` より下位の小字・方角・通称・人工的括弧名称の推測生成や、e-Stat 等による Phase 1 骨格の汚染がないことを確認する。
2. **構造的差異の全数解明（推測補完の禁止）**:
   - 公式一次資料間で差異がある場合、推測や人工名称合成による穴埋めを禁止し、公式根拠に基づき記録・検証する。外部根拠データ（JSON固定）が提供元・資料名・URL・該当箇所を含む公的資料に裏付けられていることを確認する。既存稼働地区の確定データは遡及的に Migration・改番しない。
3. **コピー元残骸の完全排除 (Universal Cleanliness)**:
   - マスター生成ツールやデータに、他地区の自治体コード、町名、特定地区専用の読み辞書・例外テーブル、境界座標の残骸が 1 件たりとも混入していないことを機械検証する。規程・スキル・テストコード内に実在地区名・町名のハードコードが存在しないことを確認する。
