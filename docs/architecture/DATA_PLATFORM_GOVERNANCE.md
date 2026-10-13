# POSTING MAP Data Platform 基本原則 & ガバナンス規範書 (DATA_PLATFORM_GOVERNANCE.md)

Version: 11.0 (全国289選挙区展開用・Spatial Verification Engine v3.1 Pro 統合版)  
Author: 岩佐CEO  
System: POSTING MAP / FIELD OPERATIONS OS / AREA GENERATION ENGINE  

---

## ■ 最重要原則: エリア生成 & 空間精度検証 第一原則 (Area Generation & Spatial Prerequisite)
```
┌─────────────────────────────────────────────────────────────┐
│ ❌ 水域ピンを西岸固定陸地へスナップする                       │
│ ❌ 住所検索失敗や座標データ欠落を隠蔽する                     │
│                                                             │
│ ✅ 水域検出 ➔ INVALID_COORDINATE ➔ 再取得要求 ➔ 解決不可ならFAIL │
│ ✅ Spatial Accuracy Gate:                                   │
│    GENERATED ➔ COORDINATE_CHECKED ➔ SPATIAL_VERIFIED ➔ CEO_REVIEW │
└─────────────────────────────────────────────────────────────┘
```

---

## ■ 正式な 10 段階 不可逆プラットフォーム フロー

```
[STEP 1] 全国最新 Raw データ取得 (KEN_ALL.CSV ＋ 行政マスター)
   │
[STEP 2] Raw Data Audit (raw_audit_manifest.json SHA-256)
   │
[STEP 3] 全国住所階層解析 (Rule v3 Engine / 自治体を階層から除外)
   │
[STEP 4] ADDRESS_MASTER.csv & SHA-256 マニフェスト生成
   │
[STEP 5] 全国 ADDRESS_MASTER 品質検証層 (欠損0件証明・安全表記揺れ統一)
   │
[STEP 6] Address Master Release Gate ➔ 【RELEASED】承認
   │
[STEP 7] Boundary Master Foundation (RELEASED ADDRESS_MASTER ＋ 行政区割り)
   │
[STEP 8] Boundary Master Accuracy Verification Foundation (4大境界検証 PASS)
   │
[STEP 9-1] Area Generation Engine (FINAL_AREA.csv ＋ area_id 発番)
   │
[STEP 9-2] Area Accuracy Verification Engine (重複 0 件・郵便番号昇順検証)
   │
   ▼ (エリア検証 PASS 後、最終的な「空間座標の証明」を行う)
[STEP 10] Spatial Verification Engine v3.1 Pro ★新規追加
         ├─ 住所完全一致 ➔ 町丁目 ➔ 大字 ➔ 自治体中心点 の厳格な階層解決
         ├─ 厳密な水域検出 (Ibi, Nagara, Kiso Rivers) と境界封じ込め検証 (Yokkaichi Leakage 防止)
         ├─ CSVへ空間証明フィールドを追加 (latitude, longitude, coordinate_source, spatial_status等)
         └─ 成果物: 検証済みGeoJSON (MIE-03_AREA_MAP.geojson) & spatial evidence.json
   │
   ▼ (Spatial Accuracy Gate: CEO_REVIEW 承認後)
[SPREADSHEET] Google Spreadsheet 表示レイヤー化 (`MIE-03_DATA_ACCEPTANCE_REVIEW`)
```

---

## ■ モジュール構造 (`src/platform/`)

### address-data-platform
1. **`raw/RawDataIngestor.ts`**: KEN_ALL.CSV & 行政マスター取得
2. **`parser/NationalAddressHierarchyParser.ts`**: 表記揺れ対応 Rule v3 解析器
3. **`generator/AddressMasterGenerator.ts`**: `ADDRESS_MASTER.csv` 出力
4. **`verifier/AddressMasterVerifier.ts`**: STEP 5 住所精度検証エンジン
5. **`gate/AddressMasterReleaseGate.ts`**: STEP 6 リリースゲート
6. **`boundary/BoundaryMasterFoundation.ts`**: STEP 7 選挙区境界統合
7. **`verifier/BoundaryMasterVerifier.ts`**: STEP 8 選挙区境界精度検証
8. **`area/AreaGenerator.ts`**: STEP 9-1 エリア生成エンジン
9. **`area/AreaAccuracyVerifier.ts`**: STEP 9-2 エリア精度検証エンジン
10. **`pipeline/NationalAddressDataPipeline.ts`**: 統制パイプライン

### spatial-verification-v3
1. **`resolver/AddressCoordinateResolver.ts`**: STEP 10 住所階層に基づく座標解決＆確定的微小分散 (Jitter)
2. **`validator/WaterAreaDetector.ts`**: STEP 10 水域排除 (川の中へのピン配置を ERROR として検出)
3. **`validator/BoundaryContainmentValidator.ts`**: STEP 10 厳格な境界封じ込め (MIE-02漏れ防止)
4. **`validator/CoordinateValidator.ts`**: STEP 10 上記 Validator を束ねるファサード
5. **`generator/GeoJSONGenerator.ts` / `MapDataGenerator.ts`**: 空間証明データ統合・GeoJSON出力
