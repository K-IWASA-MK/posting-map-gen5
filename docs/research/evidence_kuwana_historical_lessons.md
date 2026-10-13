# Historical Incident Evidence: Lessons from Initial Operations
## POSTING MAP Engineering Historical Archive

> 本書は、システム初期開発・運用（桑名地区等の先行展開）において実際に発生した障害、インシデント、およびその解決に至ったコミット履歴・生ログ証跡を記録した **Research / Historical Evidence** 資産である。
>
> **規程境界 (Inv-13, Inv-18)**:
> 本書は過去の事実証跡（Evidence Source）であり、現在有効な設計仕様・規格（Canonical Source）ではない。
> システムの機能要件・アーキテクチャ規範としては、昇格正本である `docs/architecture/UNIVERSAL_QUALITY_DOCTRINE.md` および `docs/architecture/01_DESIGN_CONTRACT.md` を参照すること。

---

## 1. 開発初期インシデントと実証跡一覧

### INC-01: Identity直列化による起動遅延
- **事象**: Hアプリ起動時に、LIFF SDK初期化 → プロファイル取得 → バックエンドAPI（`getStaffIdentity`）の完了を直列（ウォーターフォール）で待機したため、低速回線環境で画面が20〜30秒以上停止。
- **実証跡**: `scratch/measure_startup_timeline.mjs`（Playwright自動計測ログ）。
- **是正コミット**: Optimistic First Paint 実装（ローカルストレージ `staffId` による先行描画と並行非同期検証）。

### INC-02: Hidden ContainerでのGoogle Maps初期化
- **事象**: Google Maps の初期化（`initMainMap`）が、DOM要素が `display: none`（または `hidden`）の非表示状態で実行され、コンテナサイズ `0px × 0px` と認識されて地図がグレーアウト。
- **実証跡**: `scratch/test_map_race_condition.mjs` による非表示DOM初期化シミュレーションログ。
- **是正コミット**: 地図コンテナ可視化・サイズ確定後初期化ガードの追加。

### INC-03: 複数 Google Maps Loader 挿入競合
- **事象**: 画面遷移時および他モジュールで別々に `maps.googleapis.com/maps/api/js` の `<script>` タグを挿入したため、多重読み込み警告とコールバック多重発火が発生。
- **実証跡**: ブラウザコンソール警告ログ `You have included the Google Maps JavaScript API multiple times on this page`。
- **是正コミット**: `app.js` の `loadGoogleMapsApi` を唯一の実行窓口とし、`window.googleMapsApiLoaded` ガードを設置。

### INC-04: Dashboard 管理思想のモバイル H-App 混入
- **事象**: 配布員モバイルUIに全体進捗集計や名簿監視などの管理者向け機能が混入し、認知的負荷と複雑化が増大。
- **実証跡**: 初期画面モックおよび初期 `app.js` 内の管理者UIコード。
- **是正コミット**: Hアプリ（現場活動専任）と Manager Dashboard（全体観測専任）の完全物理分離。

### INC-05: オフライン環境での配布データ消失
- **事象**: 電波の弱い住宅地や山間部で配布登録・写真送信を行った際、通信切断によって入力データが消失。
- **実証跡**: コミット `ed9a036 fix(h-app): resolve identity gate scope and enforce verification before enqueueSync`。
- **是正コミット**: IndexedDB（`PostingMapDB` -> `syncQueue`）への先行永続保存（`enqueueSync`）および指数バックオフ自動再送。

### INC-06: モック成功・実機（LINE WebView）失敗
- **事象**: PCブラウザでテスト成功したコードが、実機スマートフォンの LINE WebView でレイアウト崩れ（セーフエリア）、タッチ無反応、GPSタイムアウトを起こした。
- **実証跡**: `scratch/verify_safe_area_modes.mjs`、`scratch/test_browser_h_app.mjs`。
- **是正コミット**: Playwright モバイル実機エミュレーション（iPhone viewport, Touch events, UA）の必須テスト化。

### INC-07: clasp push のみによる本番未反映誤認
- **事象**: `clasp push` 完了を「本番デプロイ完了」と誤認し、Web App の Deployment 更新を怠ったため、本番環境で旧コードが動き続けた。
- **実証跡**: `scripts/verify-gas-deployment.mjs` によるデプロイ済みバージョンとローカルコードの不整合検出ログ。
- **是正コミット**: Deployment ID へのバージョン再デプロイ（`scripts/safe-deploy.mjs`）の義務化と自動疎通確認。

### INC-08: Container-bound GAS の残存と競合
- **事象**: スプレッドシート側の古いコンテナバウンドスクリプトが残存し、`onEdit` 等でシートを破損。リポジトリ内に `active/h-app/v2_ui.js`（601行）が混入。
- **実証跡**: `SpreadsheetApp.getUi()` を含む `v2_ui.js` の現物発見。
- **是正コミット**: スプレッドシート完全 Pure DB 化（スクリプトゼロ）、Standalone GAS 単独運用化、`v2_ui.js` 物理削除。

### INC-09: 大量ポリゴン一括描画によるモバイルクラッシュ
- **事象**: 数百〜数千の町丁目ポリゴン（`boundaries.geojson` 1.0MB以上）を Google Maps に一括描画したため、端末がメモリ不足でクラッシュ。
- **実証跡**: モバイルブラウザでのメモリ解放クラッシュおよび著しい FPS 低下。
- **是正コミット**: ズームレベルに応じた遅延描画、ポリゴン簡略化（Simplify）、非表示エリアのアンロード。

### INC-10: 巨大長大ファイルによる AI 副作用
- **事象**: 2,000〜3,000行超の長大ファイルにおいて、AI がコンテキストを誤認し意図しないデグレ・副作用を発生させた。
- **実証跡**: 過去のバグ修正履歴および `app.js` 分割前の競合ログ。
- **是正コミット**: Target Architecture B' による Feature Module 分割（Wave 1〜16 の実施）。

### INC-11: AI による未依頼の勝手な仕様変更
- **事象**: AI が「改善」と称して指示範囲外の関数やコードを無断で書き換え、既存動作保証を破壊。
- **実証跡**: 過去のスコープ外コミットおよびリグレッション発生ログ。
- **是正コミット**: `AGENTS.md` の策定、事前宣言・No Silent Changes 義務化、Scope Guard（`scripts/check-scope.mjs`）の配備。

### INC-12: 新旧ロジック併存による Zombie Code
- **事象**: 新機能追加時に旧コードを「念のため」と残した結果、保守者がどちらを呼ぶべきか混乱。
- **実証跡**: 未使用のまま放置されていた旧 API エンドポイントや旧設定ファイル。
- **是正コミット**: 1-in-1-out 原則の確立、旧コード即時撤去、現物台帳（`03_CURRENT_H_APP_INVENTORY.md`）の厳格保守。
