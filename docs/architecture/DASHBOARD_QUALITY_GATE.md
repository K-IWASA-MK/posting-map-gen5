# DASHBOARD QUALITY GATE SPECIFICATION

## 🏛️ 概要
POSTING MAP Dashboard における District-Agnostic（地区非依存）アーキテクチャ、部分劣化耐性、SSOT整合性、および現場アプリ（Hアプリ）非干渉を自動検証するための恒久品質ゲート規格。

---

## 🎯 実行コマンド
```bash
npm run test:dashboard:gate
```

---

## 🔍 6つの品質ゲート仕様 (Phases)

### Phase 1: 実機Dashboard通常動作 (District-Agnostic)
- **目的**: 実機ブラウザでダッシュボードが正常起動し、動的マスターピン数・エリア総数・連動ラベルが正確に描画されることを確認する。
- **検証項目**:
  - `masterLoadStatus === 'LOADED'`
  - `masterPins.length === expectedCsvPinsCount` (config.js の CSV 行数と完全一致)
  - `fact-total-areas` が実データ件数と一致
  - アプリケーションエラー（JS例外・HTTP400+）が 0件

### Phase 2: 連続リロード安定性
- **目的**: 初期起動時の非同期データ取得・地図初期化において、デッドロックやタイミング競合が存在しないことを確認する。
- **検証項目**:
  - 連続 7 回のリロード実行
  - 7回すべてで `masterLoadStatus === 'LOADED'` に安定遷移（成功率 100%）

### Phase 3: Master ERROR 障害・部分劣化試験
- **目的**: 地理マスター CSV の取得に障害が発生した場合でも、管理コンソール全体がクラッシュせず、Backend 由来の業務機能が継続稼働する部分劣化耐性を確認する。
- **検証項目**:
  - CSV 通信遮断時に `masterLoadStatus === 'ERROR'`
  - マップ・エリア総数表示が `ERR` に遷移
  - Backend SSOT 由来の在庫（`stocks`）、ランキング（`ranking`）、名簿（`roster`）、LIVEフィードが停止せず正常描画を継続

### Phase 4: cities SSOT & ノイズ除外確認
- **目的**: 自治体一覧が Backend `getTier1` のみを唯一の SSOT として取得され、シート原本等のノイズエントリが完全に除外されていることを確認する。
- **検証項目**:
  - 自治体一覧（`cities`）に `原本`・`テンプレート` などの管理外エントリが含まれないこと
  - 自治体セレクターに `ALL` および有効な自治体名が動的生成されること

### Phase 5: fitBounds & 異常座標防御試験
- **目的**: マスターピンの座標から地図表示範囲が動的に自動算出され、異常座標混入時も堅牢に動作することを確認する。
- **検証項目**:
  - 有効座標から `fitBounds` が正常計算されること
  - 座標データに `NaN` / `null` / `0` などの異常値が混入してもクラッシュせず防御されること

### Phase 6: Hアプリ非干渉 & アーキテクチャ分離監査
- **目的**: Dashboard 側の改修が現場アプリ（Hアプリ: `active/h-app/`）に一切波及していないことを静的・動的に確認する。
- **検証項目**:
  - Hアプリ（`active/h-app/index.html`）がブラウザで正常起動し、例外が発生しないこと
  - Hアプリのロジック（`app.js`, `render.js` 等）が `staticMaster` を参照していないこと（`config.js` 定義のみに隔離）

---

## 🚦 開発・リリースポリシー
Dashboard への改修、機能追加、または他地区へのレプリケーション実施時は、必ず本品質ゲート（`npm run test:dashboard:gate`）を実行し、**ALL PASS** を確認することを必須とする。
