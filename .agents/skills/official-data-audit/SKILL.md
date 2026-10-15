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
   - **Phase 1（Area Skeleton 監査）**: `rowId,city_name,town_name` の3列は全国共通の公式住所データ（公式に丁目が存在する場合は丁目まで含める）から確定され、最終順序確定後に `rowId` が `1..N` で採番されていることを検証する。`town_name` より下位の小字・方角・通称・人工的括弧名称の推測生成や、e-Stat 等による Phase 1 骨格の汚染がないことを確認する。
   - **Phase 2（後段属性・境界監査）**: 確定済み Area Skeleton に対して付与された `latitude`, `longitude`, `households`, `population`, `e_stat_code`, および `boundaries.geojson` が公式統計・境界データと整合していることを検証する。
2. **構造的差異の全数解明（推測補完の禁止）**:
   - 公式一次資料間で差異がある場合、推測や人工名称合成による穴埋めを禁止し、公式根拠に基づき記録・検証する。既存稼働地区の確定データは遡及的に Migration・改番しない。
3. **コピー元残骸の完全排除 (Universal Cleanliness)**:
   - マスター生成ツールやデータに、他地区の自治体コード、町名、特定地区専用の読み辞書・例外テーブル、境界座標の残骸が 1 件たりとも混入していないことを機械検証する。
