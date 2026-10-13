# 現行Hアプリ構造台帳 (Current H-App & System Inventory)
## Universal POSTING MAP Architecture Ledger — Gate 1

> 本書は、最高位設計契約（`docs/architecture/01_DESIGN_CONTRACT.md` §19, Gate 1 出口基準）に基づき、
> リポジトリ内の全既存資産（コード、データ、シート構造、設定、スクリプト）の実測・現物棚卸し結果および
> 4分類（🟢 継承 / 🔴 廃止 / 🟡 再構築 / 🔵 要検証）を記録した公式台帳である。

---

## 1. 現物計測サマリ（実測値）

リポジトリ内の全資産を実ファイルから直接再計測した結果は以下の通りである。

### (1) コード規模・ファイル数サマリ

| 領域 | ファイル数 | 実行テキスト行数 (wc -l) | バイト数 | 主な構成・言語 |
|---|---|---|---|---|
| **Hアプリ (配布員用モバイルUI)** | 23ファイル (22テキスト + 1画像) | **8,236行** (※1) | 379,000 bytes | HTML, JS, CSS, WebP/PNG |
| **Manager Dashboard (管理者UI)** | 2ファイル | **4,085行** | 169,797 bytes | HTML, JS (Leaflet, Tailwind) |
| **APIルーター・認証 (`active/api/`)** | 4ファイル | **1,879行** | 77,145 bytes | GAS / JS (V8) |
| **ドメイン業務ロジック (`active/business/`)** | 21ファイル | **4,099行** | 151,821 bytes | GAS / JS (9業務ドメイン) |
| **GASコア・運用基盤 (`active/gas/`)** | 6ファイル | **1,775行** | 60,955 bytes | GAS / JS (バッチ・展開・移行) |
| **インフラアダプター (`active/infrastructure/`)** | 4ファイル | **473行** | 16,600 bytes | GAS / JS (Spreadsheet, Drive等) |
| **GASマニフェスト (`active/appsscript.json`)** | 1ファイル | **16行** (※2) | 495 bytes | JSON (OAuth Scopes, V8) |
| **`active/` 配下 小計 (テキスト全60ファイル)** | **61ファイル** (60テキスト + 1画像) | **20,563行** (※3) | 852,000 bytes | 実行アプリケーション中核 |
| **マスターデータ・設定 (`data/`)** | 12ファイル (7ルート + 5e-Stat) | 428行 + 1MB GeoJSON | 1,028,843 bytes | CSV, GeoJSON, JSON |
| **リポジトリ全体 (Git追跡ファイル数)** | **238ファイル** (Wave 13 実測値) | — | — | 全体資産 (※4) |

> ※1: Hアプリは `active/h-app` 配下の22テキストファイルと1バイナリ画像の合計。旧ゾンビコード(`v2_ui.js`)は物理削除済みのため計上外。app.js は 1,461行、components/sync-status.js は 51行。Hアプリ全体は 8,236行（Wave 17 SyncStatusViewコンポーネント新設・app.js縮小により実測更新）。
> ※2: `active/appsscript.json` は末尾に改行コードが無いため、`wc -l`（改行数）では 16行となる。
> ※3: 内訳合計: 8,236 (Hアプリ) + 4,085 (Manager) + 8,242 (Backend 35ファイル小計) = **20,563行** となり、`wc -l $(find active -type f ! -name "*.png")` 実測値と完全に一致する。バイナリ画像 `icon180-v2.png` はテキスト行数に含まない。
> ※4: 現在のGit HEADにおける `git ls-files` 実測値 238ファイルである。

---

## 2. データベース現物構造（Spreadsheet Pure DB / ADR-024 Dual Lifecycle 準拠）

`active/business/system/district_provisioner.js`、`monthly_sheet_resolver.js`、`bulletin_service.js`、および ADR-024 に基づく実シート構成：

### (1) システム管理シート（1シート）
- **`SYSTEM_INFO`**: 2列（A〜B列: 項目・内容）＋ 14標準設定キー・バリュー（地区コード、地区名、HアプリURL、Dashboard URL、LIFFアプリ名、LIFF ID、LIFF URL、Endpoint URL、Manager認証パスワード、状態、契約終了日、**運用モード**、**Active Dataset Key**、**契約開始日時**）。

### (2) 実運用データセット（5シート: ELECTION固定 または SUBSCRIPTION月次）
- **ELECTION モード**: 契約開始日時に確定した固定 Dataset Key（例: `2026-10`）を用い、契約終了日まで同一の 5 シートを継続使用する（月次リセット禁止）。
- **SUBSCRIPTION モード**: 現在年月（`YYYY-MM`）を用い、毎月新しい 5 シートを直接生成し過去月は履歴保持する。
- ※第1世代の原本5種（マスターテンプレート）は ADR-024 により完全撤廃され、新規プロビジョニングでは生成されない。
1. **`配布実績<Key>`**: 17列 `[ID, 市町村, 町域, 配布完了日時, 配布枚数, 担当者ID, 担当者名, GPS, 写真, 緯度, 経度, GPS日時, 写真ファイルID, 写真URL, 写真日時, lineUserId, requestId]`
2. **`名簿<Key>`**: 4列 `[ID, 名前, LINE_USER_ID, 登録日時]`
3. **`保有チラシ枚数<Key>`**: 7列 `[ID, 担当者ID, 担当者名, 保管場所, 保有枚数, 最終更新日時, lineUserId]`
4. **`受渡要請履歴<Key>`**: 14列 `[日時, 要請者, 要請者ID, 保管者, 保管者ID, 連絡方法, 連絡先, 状態, requestId, LINE送信状態, LINE HTTP status, LINE送信日時, requesterLineUserId, holderLineUserId]`
5. **`PinStatus<Key>`**: 2列 `[rowId, status]`

### (3) 現場コミュニケーション・履歴シート群（2シート: 任意）
1. **`掲示板`**: 配布員間のメッセージ投稿（`[ID, 投稿日時, LINE_USER_ID, 表示名, 本文, 削除フラグ]`）
2. **`掲示板連絡履歴`**: 掲示板経由での連絡履歴

---

## 3. 全資産の4分類台帳 (Classification Ledger)

`01_DESIGN_CONTRACT.md` §19 に基づき、現有全資産を以下の基準で分類する。
- 🟢 **継承**: 現行の優れたUI/UX、現場思想、確立されたコア機能。
- 🔴 **廃止**: 旧地区複製モデルの残骸、コンテナバウンドGASUI、ダミーモック、ゾンビコード。
- 🟡 **再構築**: Universal POSTING MAP（1地区 = 1完成アプリ = 1単独フォルダー = 1単独リポジトリ = 1単独ドメイン）に適合させるための構造再設計。
- 🔵 **要検証**: 現場での利用実態・非機能要件・負荷耐性の検証が必要な項目（推測での分類禁止）。

### (1) Frontend — Hアプリ (`active/h-app/`, `index.html`)

| ファイル / コンポーネント | 行数 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `index.html` (ルート) | 43 | 🟡 再構築 | LIFF初期化とリダイレクトを担う。地区独立ドメインからUniversal共通APIへ接続する構造への最適化が必要。 |
| `active/h-app/index.html` | 372 | 🟢 継承 | HアプリのメインDOM。ブラック基調のプレミアムUI、下部ナビゲーション、モーダル構造を確立。Wave 17にてsync-status.jsスクリプト追加。 |
| `active/h-app/style.css` | 700 | 🟢 継承 | グラスモフィズム、ネオモルフィズム、タッチアニメーション等のデザインシステム。 |
| `active/h-app/tailwind-utils.css` | 321 | 🟢 継承 | オフライン稼働・高速レンダリングのためのTailwind事前生成CSS。 |
| `active/h-app/app.js` | 1,461 | 🟡 再構築 | 【Current Fact】Target B'へ向けたStorage分離(Wave 1)・Bulletin分離(Wave 2)・PinStatus分離(Wave 3)・Activity分離(Wave 4)・Transfer分離(Wave 5)・Numpad分離(Wave 6)・下書き開始フロー集約(Wave 7)・ID情報モーダル分離(Wave 8)・在庫登録一覧制御分離(Wave 9)・ランキング制御分離(Wave 10)・掲示板投稿連絡モーダル分離(Wave 11)・スタッフ初回登録フロー分離(Wave 12)・Auth Gate DI(Wave 13)・Queue Lifecycle Gate DI(Wave 14)・Auth/Identity State & Gate 所有権分離(Wave 15)・System Summary State & In-flight 所有権分離(Wave 16)・Sync Status Presentation Component分離(Wave 17)を実施。app.js内のsetSyncStatusをwindow.SyncStatusView.setStatusへ直接同期delegateする薄いComposition Root wrapperへ純化。 |
| `active/h-app/render.js` | 2,454 | 🟡 再構築 | Google Mapsピン・ポリゴン・モーダル描画。StorageView/BulletinView/ActivityDraft/TransferView/NumpadView/RankingView/StaffRegistrationViewのPresentation集約により2,454行へ。Wave 12でStorageView.updateStaffIdDisplayおよびStaffRegistrationViewを集約完備。 |
| `active/h-app/db.js` | 486 | 🟢 継承 | IndexedDBによるオフライン送信キュー（`PostingMapDB` -> `syncQueue`）。Activity分離(Wave 4)による4固定フック連携に加え、Wave 14でsetQueueLifecycleGatesによるDI受領を確立し、上位app.jsへの直接逆依存を解消。 |
| `active/h-app/components/navigation.js` | 50 | 🟢 継承 | 現場目線の2層（Tier1/Tier2）ボトムナビゲーションHTML生成。 |
| `active/h-app/components/ranking.js` | 72 | 🟢 継承 | 個人ランキングカード表示。引数 mySummary 優先参照化により window._myRankingSummary へのグローバル暗黙依存を完全排除し、純粋関数として純化。 |
| `active/h-app/components/staff.js` | 253 | 🟢 継承 | デジタル配布員証（ジャイロカード・公式配布員ID表示）およびID情報モーダル（StaffIdInfoView: Terms/Privacy/License）。Wave 8でapp.jsからID情報モーダル文面・開閉Presentationを純粋集約。 |
| `active/h-app/components/sync-status.js` | 51 | 🟢 継承 | Sync Status Presentation Component（ヘッダー通信状態 ONLINE / OFFLINE / SYNCING 表示制御、DOMクラス完全管理、自己完結IIFE）。Wave 17でapp.jsから分離新設。 |
| `active/h-app/modules/api.js` | 238 | 🟡 再構築 | `PMS_CLIENT_CONFIG.api.gasWebAppUrl` 経由のPOST通信。Wave 13でsetApiAuthGatesを通じたAuth/Identity GatesのDI受領を確立。 |
| `active/h-app/modules/device.js` | 122 | 🟢 継承 | 高精度GPS取得（`getGPSLocation`）および写真撮影・クライアント側画像圧縮（`compressImage`）。 |
| `active/h-app/modules/navigation.js` | 124 | 🟢 継承 | 画面遷移（`switchPage`）・スクロール位置保持・ナビ切り替え。 |
| `active/h-app/modules/storage.js` | 120 | 🟢 継承 | チラシ在庫・保管場所データアクセスおよびキャッシュ管理。Wave 1でapp.jsから分離。 |
| `active/h-app/modules/ranking.js` | 63 | 🟢 継承 | Ranking Feature Module（ランキングデータ・本人サマリ・取得状態・通信中Promiseの非公開カプセル化管理、In-flight多重呼出し防止、応答形式不正時のエラー送出、fetchRanking/getSnapshotのみ公開）。Wave 10で新設。 |
| `active/h-app/modules/bulletin.js` | 322 | 🟢 継承 | 掲示板Feature/Lifecycle Module（投稿取得・作成・連絡送信・検証・送信ロック管理・認可世代セッション確認）。Wave 2でapp.jsから分離、Wave 11で送信ロック・連絡送信拡充。 |
| `active/h-app/modules/pin-status.js` | 142 | 🟢 継承 | Pin Status Feature Module（作業中・完了ピンの排他制御・キャッシュ管理）。Wave 3でapp.jsから分離。 |
| `active/h-app/modules/activity.js` | 497 | 🟢 継承 | Activity Feature / Lifecycle Module（活動ログライフサイクル、Draft作成・破棄、提出調整、Queue調停、下書き開始非同期フロー調整）。Wave 4でapp.jsおよびdb.jsから純粋分離。Wave 7で下書き開始非同期フロー（startDraftWorkflow）を集約し、端末API/DOM/Storage非依存の純粋オーケストレータとして拡充。 |
| `active/h-app/modules/transfer.js` | 228 | 🟢 継承 | Flyer Transfer Request Feature / Lifecycle Module（受渡要請セッション世代管理、連絡先バリデーション、Pre-Auth送信前ロック、API送信調整）。Wave 5でapp.jsから純粋分離。 |
| `active/h-app/modules/staff-registration.js` | 78 | 🟢 継承 | Staff Registration Feature Module（スタッフ登録状態 isRegistering, registrationError, activeRegistrationPromise の単一SSOT管理、多重呼出し防止、hooks発火）。Wave 12で新設。 |
| `active/h-app/modules/auth.js` | 149 | 🟢 継承 | Auth / Identity Feature / Lifecycle Module（LIFF認証状態、本人確認State、同期Promise、Gate所有権、Atomic Setterをカプセル化管理）。Wave 15でapp.jsから分離。 |
| `active/h-app/modules/summary.js` | 40 | 🟢 継承 | System Summary Feature Module（lastSummaryData キャッシュ、_systemSummaryPromise インフライト/解決済みPromiseキャッシュの所有、原子的ゲッター・セッター管理）。Wave 16でapp.jsから分離。 |
| `active/h-app/assets/icon180-v2.png` | 31KB | 🟢 継承 | PWA / LIFF 用公式アプリアイコン。 |

### (2) Frontend — Manager Dashboard (`active/manager/`)

| ファイル / コンポーネント | 行数 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `active/manager/index.html` | 720 | 🟢 継承 | 管理者向けダッシュボードDOM。Leaflet地図、進捗、在庫、名簿、受渡要請の5大タブ構成。 |
| `active/manager/manager.js` | 3,365 | 🟡 再構築 | 管理者業務ロジック。Leaflet連携、パスワード認証、CSV解析。地区独立ドメインからUniversal共通APIへの接続統合が必要。 |

### (3) Backend API & 認証 (`active/api/`)

| ファイル / コンポーネント | 行数 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `active/api/v2_api.js` | 856 | 🟡 再構築 | `doGet`/`doPost` エントリポイント。全アクションのルーティングを司るが、旧複製モデル用APIやモックが混在。Universal正規API契約へ再構築。 |
| `active/api/AssetRegistry.js` | 73 | 🟢 継承 | 静的アセット・設定レジストリ。 |
| `active/api/auth/auth.js` | 83 | 🟡 再構築 | LINE LIFF ID Token 認証。Universal認可チェーン（LINE User ID → Staff Identity → Branch → Target Region）へ統合。 |
| `active/api/auth/session.js` | 71 | 🟢 継承 | セッション検証・トークン処理。 |

### (4) Backend ドメイン業務ロジック (`active/business/`)

| ドメイン / ファイル | 行数 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `area/address_master_service.js` | 146 | 🟢 継承 | 住所マスターCSVの読込・パース・町丁目クエリSSOT（ブラウザ/GAS両対応）。 |
| `area/area_repository.js` | 88 | 🟢 継承 | エリアデータの検索・取得リポジトリ。 |
| `area/area_service.js` | 36 | 🟢 継承 | エリア詳細情報提供サービス。 |
| `area/tier1_service.js` | 92 | 🟢 継承 | 自治体別集計（Tier 1）提供サービス。 |
| `bulletin/bulletin_service.js` | 358 | 🔵 要検証 | 掲示板投稿・連絡履歴管理。現場での利用頻度、スパム対策、通知負荷の検証が必要。 |
| `distribution/distribution_model.js` | 57 | 🟢 継承 | 配布実績データモデル。 |
| `distribution/distribution_repository.js` | 284 | 🟢 継承 | 配布実績の集計・ランキング計算・履歴取得リポジトリ。 |
| `distribution/distribution_service.js` | 103 | 🟢 継承 | 配布実績登録・更新サービス。 |
| `flyer/flyer_repository.js` | 131 | 🟢 継承 | チラシ在庫データアクセス。 |
| `flyer/flyer_service.js` | 31 | 🟢 継承 | チラシ在庫取得・更新サービス。 |
| `gps/gps_repository.js` | 179 | 🟢 継承 | GPSログおよびDrive写真ファイル連携。 |
| `gps/gps_service.js` | 88 | 🟢 継承 | GPS座標検証および写真メタデータ更新。 |
| `pin/pin_status_service.js` | 99 | 🟢 継承 | ピンのリアルタイム作業中（inProgress）状態管理。 |
| `staff/staff_model.js` | 56 | 🟢 継承 | 配布員データモデル。 |
| `staff/staff_repository.js` | 198 | 🟢 継承 | 名簿シートへの読み書きリポジトリ。 |
| `staff/staff_service.js` | 145 | 🟢 継承 | 配布員登録、LINE User IDからのIdentity解決（`resolveStaffIdentity`）。 |
| `system/district_provisioner.js` | 670 | 🟢 継承 | 月替わりシート自動生成（`rolloverMonthlySheets`）、原本5種および当月5種シートの初期作成・同期、SYSTEM_INFO初期生成・同期を担う現行のプロビジョニング・月次シート生成実装。現行API（`active/api/v2_api.js`: `provisionNewDistrict`, `createDistrictDatabase` 等）および月次バッチ（`active/gas/v2_batch.js`）から直接参照・実行されている（Schema Authority は引き続き `DATA_DICTIONARY.md` 唯一）。 |
| `system/monthly_sheet_resolver.js` | 77 | 🟢 継承 | 当月シート名（YYYY-MM）の厳格な参照解決SSOT。 |
| `system/system_info_service.js` | 329 | 🟢 継承 | `SYSTEM_INFO` シートの管理、契約期間チェック、管理者認証。 |
| `system/system_summary_service.js` | 115 | 🟢 継承 | システム全体の進捗・統計サマリ提供。 |
| `transfer/transfer_service.js` | 358 | 🔵 要検証 | チラシ受渡要請サービス。LINE Push通知連携のコスト・クォータ・代替手段の検証が必要。 |

### (5) Backend GAS運用・移行基盤 (`active/gas/`)

| ファイル | 行数 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `active/gas/sheet_guard.js` | 106 | 🟢 継承 | スプレッドシート保護・競合防止。 |
| `active/gas/v2_batch.js` | 217 | 🟢 継承 | 定期バッチ・集計トリガー処理。 |
| `active/gas/v2_config.js` | 128 | 🟡 再構築 | スクリプトプロパティ取得・設定。Universal環境変数体系へ整理。 |
| `active/gas/v2_core.js` | 22 | 🟢 継承 | コア共通ユーティリティ。 |
| `active/gas/v2_deployment_foundation.js` | 1,036 | 🔴 廃止 | **【旧複製モデル】** 地区別デプロイ基盤スクリプト。Universalでは不要。 |
| `active/gas/v2_extract.js` | 149 | 🟢 継承 | データ抽出ユーティリティ。 |
| `active/gas/v2_map.js` | 187 | 🟢 継承 | 座標計算・マップデータ補助。 |
| `active/gas/v2_migration.js` | 228 | 🟡 再構築 | カラムマイグレーションスクリプト。Universalデータスキーマへの移行用に改定。 |
| `active/gas/v2_stats.js` | 94 | 🟢 継承 | 統計集計ユーティリティ。 |

### (6) インフラアダプター (`active/infrastructure/`)

| ファイル | 行数 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `active/infrastructure/cache/cache_adapter.js` | 41 | 🟢 継承 | GAS `CacheService` ラッパー。 |
| `active/infrastructure/drive/drive_adapter.js` | 25 | 🟢 継承 | GAS `DriveApp` ラッパー。 |
| `active/infrastructure/lock/lock_adapter.js` | 36 | 🟢 継承 | GAS `LockService` 排他制御ラッパー。 |
| `active/infrastructure/spreadsheet/spreadsheet_adapter.js` | 219 | 🟢 継承 | GAS `SpreadsheetApp` 安全アクセスラッパー。 |

### (7) マスターデータ・設定 (`data/`)

| ファイル | 規模 | 分類 | 分類理由・現物根拠 |
|---|---|---|---|
| `data/address_master.csv` | 338行 | 🟢 継承 | 国勢調査小地域に基づく町丁目・座標・世帯数SSOT。 |
| `data/boundaries.geojson` | 1.0MB | 🔵 要検証 | 町丁目境界ポリゴンデータ。モバイルでの描画パフォーマンスの検証が必要。 |
| `data/municipality_master.csv` | 2行 | 🟢 継承 | 構成自治体一覧（桑名市: 24205, 337町丁目）。 |
| `data/config.js` | 20行 | 🟡 再構築 | クライアント接続設定。Universal本番環境用設定へ再定義。 |
| `data/storage_locations.json` | 10行 | 🟢 継承 | チラシ保管場所の自治体候補リスト。 |
| `data/election_history.json` | 58行 | 🔵 要検証 | 過去の選挙実績データ。現場UIでの活用状況の確認が必要。 |
| `data/area_mapping.json` | 2 bytes | 🔴 廃止 | 空のJSONオブジェクト（`{}`）。未使用ファイル。 |
| `data/raw_estat_r2/24205/` | 5ファイル | 🟢 継承 | 国勢調査一次データ（Shapefile・DBF・ZIPアーカイブ）。生成元エビデンスとして保持。 |

### (8) 開発・運用スクリプト (`scripts/`)

| スクリプト | 分類 | 分類理由・現物根拠 |
|---|---|---|
| `scripts/verify-gate-minus-1.mjs` | 🟢 継承 | Gate -1 環境分離・接続遮断の恒久自動検証スクリプト。 |
| `scripts/serve.mjs` | 🟢 継承 | ローカル開発・検証用HTTPサーバー。 |
| `scripts/certify-universal-engine.mjs` | 🟢 継承 | Universal Engine 認証テスト。 |
| `scripts/safe-deploy.mjs` | 🟡 再構築 | 安全デプロイスクリプト。Universal専用デプロイへ改定。 |
| `scripts/generate-boundaries-geojson.py` | 🟢 継承 | e-Stat ShapefileからGeoJSONを生成するパイプライン。 |
| `scripts/sort-address-master.py` | 🟢 継承 | 住所マスターの正規化・ソートツール。 |
| `scripts/test_browser_h_app*.mjs` (3種) | 🟢 継承 | Hアプリ実機ブラウザ動作検証スクリプト。 |
| `scripts/provision-district.mjs` | 🔴 廃止 | **【旧コード複製モデル】** 旧コードコピー改変方式のプロビジョニングスクリプト。共通Runtime（`active/`）改変禁止および `data/` 交換・正規プロビジョニング手順への移行により廃止。 |
| `scripts/sync-deployment-config.mjs` | 🔴 廃止 | 旧地区別デプロイ同期スクリプト。廃止。 |
| `scripts/check-pre-copy-purity.mjs` | 🔴 廃止 | 旧地区複製前の純度検証スクリプト。廃止。 |
| `scripts/check-provisioning-gate.mjs` | 🔴 廃止 | 旧プロビジョニング検証スクリプト。廃止。 |
| `scripts/test-copy-simulation.mjs` | 🔴 廃止 | 旧地区コピーシミュレーションスクリプト。廃止。 |
| `scripts/validate-district-data-gate.mjs` | 🟢 継承 | Universal Master Triad & Election 閉包整合性検証ゲート（Safe Deploy Preflight）。 |

---

## 4. 🔵 要検証項目（Pending Verification Items）

推測による独断判定を排除し、Gate 2以降の設計・検証フェーズで実機検証・運用確認を行う項目は以下の **4点** である。

1. **掲示板（Bulletin）機能の現場運用性**:
   - `active/business/bulletin/bulletin_service.js`（358行）および `page-bulletin`。
   - 検証項目: 配布員間のメッセージ交換が実際の活動で有効に機能しているか、不適切な投稿や個人情報露出のリスクはないか、通知インフラの負荷。
2. **チラシ受渡要請（Transfer）機能とLINE Push通知**:
   - `active/business/transfer/transfer_service.js`（358行）および `page-storage-list`。
   - 検証項目: LINE Messaging API によるプッシュ通知送信の月間クォータ消費、送信失敗時のリトライ・フォールバック仕様、当事者間連絡の成立実態。
3. **境界GeoJSON描画パフォーマンス（モバイル低スペック端末耐性）**:
   - `data/boundaries.geojson`（1.0MB）および `active/h-app/render.js`。
   - 検証項目: スマートフォン（特に低スペック機や通信制限下）において、Google Maps 上でのポリゴン描画負荷、ズーム操作時のFPS低下、メモリ消費量の限界値。
4. **過去選挙実績データ（`election_history.json`）の機能的有用性**:
   - `data/election_history.json`（58行）。
   - 検証項目: HアプリまたはDashboardでの参照実態、今後の選挙戦略機能としての必要性。
