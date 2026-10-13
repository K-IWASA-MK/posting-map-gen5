# ADR-024: Universal POSTING MAP Dual Lifecycle Mode 仕様 (ELECTION / SUBSCRIPTION)

## Status
ACCEPTED (2026-10-10 MASTER PROCEED)

## Context
POSTING MAP はこれまで月次ロールオーバー（`rolloverMonthlySheets`）により毎月新しい 5 シート（配布実績、名簿、保有チラシ枚数、受渡要請履歴、PinStatus）を原本からコピー複製して生成する運用（SUBSCRIPTION モデル）を前提としていた。
しかし、以下の二重の重大障害が発生した：
1. **月跨ぎスタッフ初期化障害**:
   原本 5 種が空のまま放置されていたため、翌月シート生成時に前月スタッフ情報が引き継がれず、さらに `active/h-app/modules/api.js` の `callApiPost` が `success: true, code: "NOT_REGISTERED"` を例外として誤認識してスローしたため、Hアプリの自動スタッフ登録フローへ進めず初期化エラーで停止した。
2. **選挙案件（ELECTION）への不適合**:
   市議選・町議選等の選挙案件では、契約開始（月初に限らない任意日）から契約終了日まで同一の業務 Dataset を継続使用する必要があり、月替わりによるシート生成・データリセット・スタッフID再発番は業務上許容されない。

## Decision

### 1. Dual Lifecycle 運用モードの確立 (SSOT: SYSTEM_INFO)
`SYSTEM_INFO` シートに「運用モード」行（`ELECTION` または `SUBSCRIPTION`）を新設し、明示的 SSOT とする。推論や自動判定は行わず、未設定時は Fail-Closed とする。

#### A. ELECTION モード
- **対象**: 市議選・町議選等の選挙案件。
- **契約期間**: 契約開始日時は任意（月初でなくてよい）。契約終了日は必須。
- **Dataset Key**: 開始時に確定した永続キー（例: `2026-10`）を `SYSTEM_INFO` の「Active Dataset Key」に記録。
- **月跨ぎ挙動**:
  - 月が替わってもシート切替・新規生成・データ消去は行わない（No-op、mutation 0）。
  - 同一の 5 シート（配布実績, 名簿, 保有チラシ, 受渡要請, PinStatus）を契約終了日まで継続使用。
  - 名簿登録・Staff ID 発行は契約期間中 1 回のみ。
  - GPS 配布実績送信における月跨ぎ `STALE_MONTH` 判定はバイパスする。ただし契約終了日（`CONTRACT_EXPIRED`）による安全側遮断は厳格に維持。

#### B. SUBSCRIPTION モード
- **対象**: 月次継続利用案件。
- **契約期間**: 月末で当月運用終了。
- **Dataset Key**: 現在年月（`YYYY-MM`）。
- **月跨ぎ挙動**:
  - 翌月は新しい 5 シートを直接生成する（前月 5 シートは削除せず履歴保持）。
  - GPS 送信時の `STALE_MONTH` 判定を維持。

### 2. 原本 5 種（マスターテンプレート）の完全撤廃
- 原本 5 種（配布実績の原本、名簿の原本、保有チラシ枚数の原本、受渡要請履歴の原本、PinStatusの原本）は第 1 世代の残骸であり、Runtime 業務データの SSOT/Backup ではない。
- 新規プロビジョニング（`provisionNewDistrict`）および SUBSCRIPTION 月次ロールオーバー（`rolloverMonthlySheets`）において、原本からの複製（`copyTo`）を完全撤廃する。
- 静的配信された `address_master.csv` およびコード内スキーマ定義から、実運用 5 シートを直接生成する。
- 空データベーステンプレート（`POSTING_MAP_EMPTY_TEMPLATE`）からは原本 5 種を完全削除し、`SYSTEM_INFO` と `端末管理` のみを保持する。テンプレート作成時の「状態」は空欄とする（ACTIVE にしない）。

### 3. All-or-Nothing 物理的補償削除（Compensating Rollback）
Spreadsheet には DB のトランザクション機能が存在しないため、`createOperationalDataset` において以下を保証する：
1. 0/5 を事前確認（1〜4/5 の場合は Fail-Closed）。
2. 生成中に例外が発生した場合、当実行で作成したシートのみを `ss.deleteSheet()` で削除して 0/5 へ巻き戻す（既存シートは不可侵）。

### 4. クライアント API 境界例外化の抑止 (`api.js`)
`active/h-app/modules/api.js` の `callApiPost` において、`targetResult.success === true` のレスポンスは `code`（`NOT_REGISTERED`, `STALE_MONTH` 等）が含まれていても例外化せず正常返却する。`success === false` または暗黙的失敗のみを例外スローとする。

## Consequences
- **Positive**:
  - 1地区 = 1完成アプリ の Universal Engine を維持したまま、選挙・サブスクの双方をデータ駆動で安全に切り替え可能。
  - 原本 5 種のデータ同期不良や空コピーによるスタッフ喪失事故を根絶。
  - 未登録スタッフの自動登録ハンドラが正常に動作し、ログイン不能事故を解消。
- **Negative / Operational Notice**:
  - 既存地区の `SYSTEM_INFO` に「運用モード」「Active Dataset Key」「契約開始日時」の記録が必要。
