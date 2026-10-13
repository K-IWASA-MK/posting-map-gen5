---
name: official-data-audit
description: 公式データ確定監査規範。国勢調査・自治体一次資料との多層照合、構造的差異の全数解明、完全性機械検証。
---

# Official Data Audit Capability Pack

## 1. 概要と適用責務
本 Pack は、地区マスターデータ（`data/address_master.csv`, `boundaries.geojson`, `municipality_master.csv`）が公式一次資料（e-Stat国勢調査、自治体公式統計）と 100% 整合していることを客観的に機械検証・監査するための品質規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [UNIVERSAL_QUALITY_DOCTRINE.md](../../../docs/architecture/UNIVERSAL_QUALITY_DOCTRINE.md): Universal 品質ドクトリン

## 3. 遵守すべき絶対規範
1. **多層公式照合原則**:
   - 住所マスターの各行は、e-Stat 国勢調査小地域データ（`KEY_CODE` 単位）または自治体公式公称町名一覧と 1 対 1 または明確に定義された多対 1 の対応関係を持たなければならない。
2. **構造的差異の全数解明**:
   - 公式統計とマスターデータ間で世帯数・人口・町丁目数に乖離がある場合、推測による穴埋めを禁止する。必ず公式の統合理由（住居表示未実施、飛び地、国勢調査調査区境界と行政界の差異等）を解明・記録すること。
3. **コピー元残骸の完全排除 (Universal Cleanliness)**:
   - 他地区からマスター生成ツールや設定を流用した場合、他地区の自治体コード、町名、郵便番号、境界座標の残骸が 1 件たりとも混入していないことを機械検証する。
