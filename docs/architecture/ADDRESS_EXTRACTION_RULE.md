# POSTING MAP 住所抽出規範 (ADDRESS_EXTRACTION_RULE.md)

Version: 4.0 (Phase 1 Area Skeleton 単一契約確定版)
Date: 2026-10-15
Author: 岩佐CEO
System: POSTING MAP / FIELD OPERATIONS OS / 289 DISTRICT EXPANSION ENGINE
関連規程: `docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md`

---

## ■ 最重要原則: Phase 1 Area Skeleton `town_name` 抽出原則

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. 地区生成の第1段階（Phase 1 Area Skeleton）は、             │
│    rowId,city_name,town_name の3列のみを確定する。           │
│ 2. 公式データに「丁目」が存在する場合は、丁目まで town_name に │
│    含める。                                                 │
│ 3. town_name より下位の小字・方角・通称・人工的括弧名称は、    │
│    全国共通の公式ソースから一意取得できない限り、              │
│    探索・推測・生成・地区固有辞書補完を行わない。              │
└─────────────────────────────────────────────────────────────┘
```

---

## ■ 判定フローチャート (Official Town & Chome Determination)

```text
                【Step 1: 公式区割りの確定・適用】
          （適用法令の施行版・経過措置 ➔ 対象町域を選別）
              ※ DISTRICT_DATA_ACQUISITION_RULE.md §4.1
                                  │
                                  ▼
          【Step 2: 住所の母集合（§3.1）から町字名を取得・正規化】
        （郡名除去・先頭の形式的な「大字」接頭辞を除去：§4.2）
                                  │
                                  ▼
                 【公式に「丁目」が存在するか？】
                                  │
         ┌────────────────────────┴────────────────────────┐
         │ YES                                             │ NO
         ▼                                                 ▼
【丁目まで含めて town_name 確定】                 【町字名そのもので town_name 確定】
(例: 〇〇市 └ △△町一丁目)                         (例: 〇〇市 └ □□町)
➔ town_name = 「△△町一丁目」                      ➔ town_name = 「□□町」
         │                                                 │
         └────────────────────────┬────────────────────────┘
                                  ▼
             【そこで確定終了（下位の小字・方角等は生成しない）】
                                  │
                                  ▼
   【Step 3: 名称衝突検査 ➔ 公式読み仮名で整列 ➔ rowId = 1..N を一意採番】
             （DISTRICT_DATA_ACQUISITION_RULE.md §4.3〜§4.5）
                   ➔ 成果物: rowId,city_name,town_name
```

---

## ■ 正確な判定テーブル

| 住所構造パターン | 公式データの構造例 | `city_name` | `town_name` 抽出結果 | 判定理由・終了条件 |
| :--- | :--- | :--- | :--- | :--- |
| **丁目ありパターン** | 〇〇市 ＋ △△町一丁目 | **〇〇市** | **△△町一丁目** | 公式に丁目が存在するため、丁目まで `town_name` に含めて確定終了 ✅ |
| **丁目なしパターン** | 〇〇市 ＋ □□町 | **〇〇市** | **□□町** | 公式に丁目が存在しないため、町字名で確定終了 ✅ |
| **大字接頭辞パターン** | 〇〇市 ＋ 大字◇◇ | **〇〇市** | **◇◇** | 先頭の形式的な「大字」接頭辞を除去し、町字名で確定終了 ✅ |

---

## ■ 絶対遵守境界（Phase 1 Area Skeleton の純粋性維持）

1. **下位階層の探索・推測・人工生成の禁止**:
   - `town_name` より下位の小字・方角（`北部`/`南部`/`北東部`等）・通称・地番範囲・人工的括弧名称（`〇〇（△△）` 等）を無理に探索・推測・合成したり、特定地区専用の辞書で補完してはならない。
2. **e-Stat 等の後段データの非混入**:
   - Phase 1 Area Skeleton（`rowId,city_name,town_name`）の決定に、e-Stat（小地域分割）、`households`、`population`、`latitude`、`longitude`、`boundaries`、投票率等を使用してはならない。これらはすべて Skeleton 確定後に付与する Phase 2（後段）の付属属性である。
3. **既存稼働地区データの保護（Non-Migration）**:
   - 既に確定・稼働している既存地区データの Migration や既存 `rowId` の再採番は行わない。
