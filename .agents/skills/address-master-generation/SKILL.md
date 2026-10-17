---
name: address-master-generation
description: 自治体コードを入力とし、国交省位置参照情報・ABR・e-Statから8列アドレスマスターCSV（rowId,city_name,town_name,latitude,longitude,households,population,e_stat_code）および追跡Provenanceを生成・監査する13工程の自律実行手順。
---

# Address Master Generation Capability Pack (13-Step Production Pipeline)

## 1. 概要と入出力契約 (Input & Output Contract)

本Skillは、任意の対象自治体について、公式オープンデータ（国交省位置参照情報、デジタル庁ABR、総務省統計局e-Stat小地域データ）から **8列マスターCSV** および **完全追跡可能な構造化Provenance** を完全自律かつ決定論的に生成・監査するための13工程実行規格である。

### 【入力契約】
- `city_code`: 5桁全国地方公共団体コード（単一または対象自治体コード群のリスト）
- 必要に応じて:
  - 選挙区等で自治体内の一部区域に絞り込む場合は、公式区割り対応ファイル（`--electoral-mapping`）
  - 表記乖離・読み欠落解決用の公式外部根拠JSON（`--reading-reconciliation`）
  - 1:0 空小地域の公的根拠JSON（`--estat-reconciliation`）

### 【最終成果物契約】
1. **8列マスターCSV (`address_master.csv`)**:
   ```csv
   rowId,city_name,town_name,latitude,longitude,households,population,e_stat_code
   ```
   - `rowId`: 1から始まる連続整数（`1..N`、欠番・重複なし）
   - `city_name`: 自治体名（郡名除去済み、市・区・町・村）
   - `town_name`: 公式大字・町丁目名（丁目を含む、小字・人工括弧なし）
   - `latitude`, `longitude`: 決定論的代表座標（小数点以下6桁、Point-in-Polygon内部点検証済み）
   - `households`, `population`: 国勢調査確定世帯数・人口（単独小地域なし町域のみ空欄可）
   - `e_stat_code`: 11桁e-Stat小地域コード（単独小地域なし町域のみ空欄可）
2. **完全追跡Provenance (`provenance.json`)**:
   - 出力CSVパス、総レコード数、総世帯数、総人口、および各レコードの調達メタデータ（出典、座標検証結果、照合根拠、および1:0空小地域の全8属性Evidenceオブジェクト）を完全保持。

### 【明確な対象外責務】
以下は本Skillの責務に含まれない（1文字たりとも混入させてはならない）：
- LINE公式アカウント・Messaging API・LINEログイン・LIFF・Rich Message・あいさつメッセージ等のLINE資産構築
- Google Spreadsheet Pure DBの構築・シート構造設計
- アプリケーションコード・共通Runtime（`active/**`）のデプロイ
- Phase 3（境界GeoJSONコンパイル）および Phase 4（クライアント資産構築）
- POSTING MAP全体の統合プロビジョニング
- 自然言語による対象地区判定（Target Resolver）
- 別地区での受入試験（Acceptance Test）

---

## 2. 8列マスターCSV作成 13工程標準実行手順

以下の **Step 1 〜 Step 13** を不可逆かつ厳格に順番通り執行する。

### Step 1: 自治体コードを入力
- **入力**: 5桁自治体コード（例: `24202`, `24205`, `24214`...）
- **使用スクリプト/データ**: 呼び出し元パラメータ / 引数
- **判定**: 5桁数字（先頭ゼロ保持）の妥当性検証。
- **HARD STOP条件**:
  - 自治体コードが未指定、不正な文字、または5桁未満の場合。
- **次工程への成立条件**:
  - 有効な対象自治体コード群のリストが確定していること。

---

### Step 2: 国土交通省の位置参照情報「大字・町丁目レベル」データ取得
- **入力**: Step 1 の自治体コード群
- **使用スクリプト/データ**:
  - スクリプト: `scripts/fetch-district-raw-data.py`
  - 通信先: 国土交通省 位置参照情報ダウンロードサイト（HTTP POST / フォーム属性 `data_kind=1`）
- **判定**:
  - `data_kind=1`（大字・町丁目レベル）のZIPアーカイブを自律ダウンロード・解凍。
  - 同梱メタデータXML（JMP 2.0 / ISO 19115）の `citation` 内から `dateType=001`（creation: 原資料作成日）を厳格抽出し、SHA-256ハッシュとともに記録。
- **HARD STOP条件**:
  - `data_kind=0`（街区レベル）が返却された場合。
  - 既存ファイルの上書き検知。
  - XML内の作成日抽出失敗、または更新日（`dateType=002`）のみで作成日が存在しない場合。
- **次工程への成立条件**:
  - 対象自治体の国交省大字・町丁目CSVおよびProvenanceが一時領域に取得・保存されていること。

---

### Step 3: デジタル庁 アドレス・ベース・レジストリ（ABR）照合
- **入力**: Step 1 の自治体コード群、およびデジタル庁 ABR 町字マスター（`mt_town_fullset_pref*.csv`）
- **使用スクリプト/データ**:
  - スクリプト: `scripts/fetch-district-raw-data.py`（ABR取得）および `scripts/build-district-master.py`（照合）
- **判定**:
  - ABR原本の構造健全性（ヘッダー列、6桁 `lg_code` の先頭5桁と自治体コードの一致）を検証。
  - `machiaza_type`（1: 大字, 2: 丁目, 3: 小字）の公式階層に従い、名称と読み仮名を同階層から取得。
  - 原文完全一致を最優先とし、正規化名称（大字除去等）による対応は読みの一意性が保証される場合のみ採用。
- **HARD STOP条件**:
  - ABR原本に必須列（`city_name`, `city_kana`, `oaza_cho`, `oaza_cho_kana`, `lg_code`）が欠損している場合。
  - 同一正規化名称に対して複数の異なる読みが存在する曖昧衝突（Ambiguous Collision）が検知された場合。
- **次工程への成立条件**:
  - 対象自治体コードに属するABR町字レコードが正常にロードされ、読み辞書がメモリ上に構築されていること。

---

### Step 4: 案A衝突回避正規化・ABR五十音順整列 ➔ 3列Skeleton生成
- **入力**: 国交省大字・町丁目母集合、ABR読み辞書、および公式区割り資料
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py --phase1-only`
- **判定**:
  - 郡名除去（例: `桑名郡木曽岬町` ➔ `木曽岬町`）。
  - **案A大字衝突回避**: 先頭「大字」の除去によって異なる公式町丁目コードと衝突する場合は原文名称（「大字〇〇」）を保持。原文保持でも区別できない場合（同名異コード）は即時停止。
  - 区割り適用（除外地区のフィルタリング）。
  - 同一自治体内において、町域読み五十音順＋丁目数値順（1, 2, 3...）で整列。
  - 順序確定後に先頭から `rowId = 1..N`（1始まり連続整数）を採番。
- **HARD STOP条件**:
  - 母集合内にコード欠損・空欄行が存在する場合。
  - 区割り判定不能行の残存。
  - 読み仮名未解決行の残存（外部根拠JSONなしでの推測補完禁止）。
  - 既存出力ファイルの上書き検知。
- **次工程への成立条件**:
  - `rowId,city_name,town_name` の3列Area Skeleton CSVおよび骨格Provenance（原本緯度経度・コード保持）が出力されていること。

---

### Step 5: 最新国勢調査年度を動的確認
- **入力**: Step 1 の自治体コード群
- **使用スクリプト/データ**:
  - スクリプト: `scripts/fetch-district-raw-data.py`
  - 通信先: 総務省統計局 e-Stat API / カタログAPI
- **判定**:
  - 候補年配列をハードコードせず、API/カタログから動的に調査候補年を発見・降順評価。
  - 対象自治体群の**全自治体において町丁・字等小地域境界データ（境界ポリゴンおよび人口・世帯数集計）が揃う「最新完全共通年度」**を自律決定。
- **HARD STOP条件**:
  - 対象自治体間で小地域データの提供年が揃わない場合（混合年の禁止）。
  - いずれの年においても全対象自治体の小地域データが揃わない場合。
- **次工程への成立条件**:
  - 全対象自治体で共通採用する国勢調査年度（例: 2020年版）が動的決定され、Provenanceに記録されていること。

---

### Step 6: e-Stat小地域境界データ（DBF/SHP）取得
- **入力**: Step 1 の自治体コード群、および Step 5 で決定された国勢調査年度
- **使用スクリプト/データ**:
  - スクリプト: `scripts/fetch-district-raw-data.py`
  - 提供元: 総務省統計局 e-Stat GIS
- **判定**:
  - 各自治体の小地域境界Shapefile（`.shp`, `.dbf`, `.shx`, `.prj`）を自律ダウンロード・解凍。
  - SHA-256ハッシュ、取得日時、調査年度をProvenanceに記録。
- **HARD STOP条件**:
  - 必須構成ファイル（特に `.dbf` および `.shp`）の破損・欠損。
  - 既存ファイルの上書き検知。
- **次工程への成立条件**:
  - 全対象自治体の `.dbf` および `.shp` がローカル一時領域に検証済みで配置されていること。

---

### Step 7: 空間結合カーディナリティ監査（1:1 / 1:N / 1:0 / N:1 判定）
- **入力**: Step 4 の 3列Skeleton、および Step 6 の e-Stat DBFレコード群
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py`
- **判定**:
  - `0:1`: 対象選挙区・自治体外のe-Statレコードは除外。
  - `1:1`: 骨格町域とe-Stat小地域が1対1一致。属性付与へ進行。
  - `1:N`: 1つの骨格町域が複数のe-Stat小地域（枝番・街区等）に分かれる場合、各小地域を行として展開（後続のStep 9へ）。
  - `N:1`: 複数の骨格町域が同一の `e_stat_code` を主張した場合（多重割当）。
  - `1:0`: 骨格町域に対応するe-Stat小地域が存在しない場合。
- **HARD STOP条件**:
  - `N:1`（同一e-Statコードへの多重結合）が検知された場合。
  - `1:0` であり、かつ後述のStep 8の公式根拠が提示されていない場合。
- **次工程への成立条件**:
  - すべてのSkeleton町域について結合関係が一意に分類・確定されていること。

---

### Step 8: 必要時だけ外部Reconciliation（1:0 空小地域 8属性Evidence検証）
- **入力**: Step 7 で 1:0 と判定された町域、および外部根拠JSON（`--estat-reconciliation`）
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py`
  - 入力ファイル: `--estat-reconciliation <path>`
- **判定**:
  - キー `"<city_code>:<skeleton_town_name>"` で登録されたエントリが存在し、以下の **8必須項目すべてが非空文字列** であることを機械検証：
    1. `city_code`: 自治体コード
    2. `skeleton_town_name`: 骨格町域名
    3. `reconciled_status`: `"no_independent_estat_small_area"`
    4. `source_provider`: 発行元・調査元機関
    5. `source_document_title`: 公定資料名
    6. `source_url`: 公定URL
    7. `source_section_or_page`: 当該事由・該当頁
    8. `verified_date`: 確認日付（YYYY-MM-DD）
- **HARD STOP条件**:
  - 1:0 町域についてエントリが存在しない場合。
  - 8必須項目のうち1項目でも欠損または空文字列がある場合。
  - キーと内部フィールド（`city_code:skeleton_town_name`）の不一致。
- **次工程への成立条件**:
  - 1:0 町域の全件について客観的公的根拠が機械検証され、属性空欄（`households=""`, `population=""`, `e_stat_code=""`）かつMLIT骨格座標保持の例外適用が承認されること。

---

### Step 9: 座標・人口・世帯数・e_stat_code付与
- **入力**: 結合確定小地域レコード、および対応するジオメトリ（Shapefile）
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py`
- **判定**:
  - 統計属性（`households`, `population`, `e_stat_code`）を数値文字列として付与（1:0例外町域は空欄）。
  - 代表座標: e-Stat公定代表点（`X_CODE`, `Y_CODE`）が存在する場合は優先採用し、ジオメトリ内包含を検証。存在しない、または1:N展開行の場合は後述Step 10の多重トポロジー階層Even-Odd判定に基づき、決定論的内部点（point-on-surface）をグリッドサンプリングから導出。
  - 1:0 例外町域は Phase 1 骨格Provenanceに保持されたMLIT基準点座標（`latitude`, `longitude`）を保持。
- **HARD STOP条件**:
  - 人口・世帯数列に数値以外の文字列・秘匿記号（Reconciliationなし）が出現した場合。
  - 単純な頂点平均（centroid）による代表点算出（禁止）。
  - 導出された座標が当該ポリゴンの実領域外にある場合。
- **次工程への成立条件**:
  - 全展開行について妥当な座標・統計・コード属性が付与されていること。

---

### Step 10: Polygon / MultiPolygon / hole 多重包含トポロジー検証
- **入力**: e-Stat Shapefileの全リング座標列
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py`（`classify_polygon_parts`, `point_in_polygon_geometry`）
- **判定**:
  - **Ring Containment Hierarchy**: 各リングの包含深度（depth 0 = 最外周, depth 1 = 穴, depth 2 = 穴内の島, depth 3 = 島内の池...）を算出。
  - **深度偶奇と回転方向の整合性**:
    - 偶数深度（depth 0, 2...）: Solid実領域 ➔ CW（符号付き面積 < 0）
    - 奇数深度（depth 1, 3...）: Void空間 ➔ CCW（符号付き面積 > 0）
  - **Even-Odd 包含判定**: 点 $P$ を包含するリング数が奇数の場合のみ実領域内部（INSIDE）と判定。
- **HARD STOP条件**:
  - リングの回転方向と包含深度の偶奇が矛盾する場合。
  - 穴を介さず外周の中に直接別の外周が存在する不正トポロジー。
  - 代表点が穴（depth 1）または湖（depth 3）の内部に包含された場合。
- **次工程への成立条件**:
  - 全小地域のジオメトリが幾何学的に正しく検証され、代表座標が実領域内部にあることが確認されていること。

---

### Step 11: 8列マスターCSV生成
- **入力**: 全属性が付与された展開行集合
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py`
  - 出力ファイル: `--out-csv <path>`
- **判定**:
  - ABR町字読み五十音順＋丁目数値順で最終整列。
  - 先頭から `rowId = 1..N`（1始まり連続整数、欠番・重複なし）を一意に採番。
  - 厳格に以下の8列のみで構成されるCSVを一時ファイル経由で原子的（Atomic）に出力：
    ```csv
    rowId,city_name,town_name,latitude,longitude,households,population,e_stat_code
    ```
- **HARD STOP条件**:
  - 出力列数が8列以外、列名不一致、またはカンマ区切り不正。
  - 既存出力ファイルが存在し、上書き防止に抵触した場合。
  - `rowId` に欠番・重複・0以下の値が存在する場合。
- **次工程への成立条件**:
  - 8列マスターCSVが指定パスに正常出力されていること。

---

### Step 12: 構造化Provenance生成（全件8属性Evidence完全永続化）
- **入力**: Step 11 の確定行、骨格Provenance、および Reconciliation 根拠データ
- **使用スクリプト/データ**:
  - スクリプト: `scripts/build-district-master.py`
  - 出力ファイル: `--provenance-out <path>`
- **判定**:
  - 出力CSVパス、総レコード数、総世帯数、総人口を出力。
  - 全レコードについて `rowId`, `skeleton_rowId`, `city_code`, `town_code`, `raw_town_name`, `matching_evidence`, `coordinate_source`, `coordinate_validation` を記録。
  - **Full Evidence Persistence**: Step 8 で検証された 1:0 空小地域の全レコードに、以下の構造化オブジェクトを完全保存：
    ```json
    "estat_reconciliation_evidence": {
      "city_code": "...",
      "skeleton_town_name": "...",
      "reconciled_status": "no_independent_estat_small_area",
      "source_provider": "...",
      "source_document_title": "...",
      "source_url": "...",
      "source_section_or_page": "...",
      "verified_date": "YYYY-MM-DD"
    }
    ```
- **HARD STOP条件**:
  - 1:0 空小地域レコードにおいて `estat_reconciliation_evidence` が欠損、または8項目のいずれかが欠けている場合。
  - 既存Provenanceファイルの上書き検知。
- **次工程への成立条件**:
  - 一時Reconciliationファイルを削除しても完成地区のProvenance単体で完全追跡可能な JSON が出力されていること。

---

### Step 13: 再整列・全件監査（diff -u == 0）
- **入力**: Step 11 の 8列マスターCSV、Step 12 の Provenance、および ABRマスター
- **使用スクリプト/データ**:
  - スクリプト: `scripts/sort-address-master.py`
  - 検証コマンド: `diff -u <step11_csv> <sorted_csv>`
- **判定**:
  - 既存ソーターに8列CSVとProvenanceを通し、ABR読みキーに基づき再整列を実行。
  - 生成直後CSVと再整列CSVの間で `diff -u` を実行し、**差分 0 行（完全一致）** であることを検証。
  - 人口合計および世帯数合計が Expected e-Stat Set と **差分 0（完全一致）** であることを検算。
- **HARD STOP条件**:
  - `diff -u` で1行でも差分が出現した場合（順序・全列値・ID集合の変質）。
  - 人口または世帯数に Expected e-Stat Set との差分が存在する場合。
- **次工程への成立条件**:
  - 8列マスターCSVおよび追跡Provenanceの決定論的完全性が客観証明され、作成工程が完全完了すること。

---

## 3. 品質保証チェックリスト (Final Verification Checklist)

生成完了時、以下のチェックリストをすべて満たすこと：
- [ ] 13工程が途中の手作業なく完全自動で完走したか
- [ ] 成果物は厳格に「8列マスターCSV」と「追跡Provenance」の2点のみか
- [ ] 人口・世帯数の合計が公定e-Stat原本と完全一致（差分0）しているか
- [ ] 1:0 空小地域の全レコードについて、8属性Evidenceが最終Provenanceに完全保存されているか
- [ ] 代表座標が多重入れ子トポロジー（Even-Odd）検証済みの内部点か
- [ ] `sort-address-master.py` による再整列結果と `diff -u == 0` を満たしているか
- [ ] LINE・Spreadsheet・デプロイ・Phase 3/4 等の対象外責務が1文字も混入していないか
