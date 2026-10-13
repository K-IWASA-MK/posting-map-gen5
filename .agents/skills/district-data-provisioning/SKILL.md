---
name: district-data-provisioning
description: 地区プロビジョニング規範。国勢調査小地域単位のマスターデータ生成、MultiPolygon統合、新旧対応表構築手順。
---

# District Data Provisioning Capability Pack

## 1. 概要と適用責務
本 Pack は、新地区の開設および既存地区のデータ移行において、公式生データ（e-Stat Shapefile, 統計CSV）から Universal POSTING MAP 標準のマスターデータ（`data/`）を安全かつ再現可能に製造するためのプロビジョニング規格である。通常実行主体は `deployer`（District Provisioning AI）とする。

## 2. 正本仕様依存 (Canonical Sources)
- [district-data-transition-rule.md](../../../.agents/rules/district-data-transition-rule.md): 地区データ移行規則

## 3. 遵守すべき絶対規範
1. **Universal Engine 不可侵原則**:
   - 地区ごとの特殊事情（町名フォーマット、境界形状、世帯規模）を吸収するために共通エンジン（`active/**`）を変更してはならない。全ての地区差は `data/**` 内のマスターデータによって吸収する。
2. **飛び地 MultiPolygon の完全統合**:
   - 同一町丁目に複数の離れたポリゴン（飛び地・島嶼）が存在する場合、別レコードに分割せず、単一の MultiPolygon Feature として統合する。
3. **実績データの完全継承と新旧対応表**:
   - 既存地区のマスター改定時は、旧 `rowId` と新 `rowId` の全件対応表（マッピングテーブル）を構築し、過去の配布実績・ピン状態・在庫履歴が欠損・混同なく継承されることを担保する。
4. **Code Deployment 権限の非保有**:
   - 本 Pack を実行する District Provisioner は、コードのデプロイ権限を持たない。データ受入ゲートが 100% PASS した後、MASTER の承認を経てプロビジョニングを完了する。
