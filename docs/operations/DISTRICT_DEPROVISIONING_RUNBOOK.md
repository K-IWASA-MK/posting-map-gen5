# District Deprovisioning Runbook (地区停止・廃止運用手順書)

- **Version**: 1.0.0
- **Status**: OFFICIAL STANDARD (SSOT)
- **Target**: Universal POSTING MAP Engine v1.0
- **Supreme Authority**: [AGENTS.md](../../AGENTS.md)
- **Security Baseline**: [SECURITY_BASELINE.md](../security/SECURITY_BASELINE.md)
- **Data Lifecycle**: [DATA_LIFECYCLE.md](../data/DATA_LIFECYCLE.md)

---

## 1. 目的と基本原則

本書は、契約満了、選挙終了、支部の統合・解散等に伴い、稼働中（ACTIVE）の地区を安全・確実にサービス停止（SUSPENDED）または完全廃止（DECOMMISSIONED）へ移行させるための **唯一の標準運用手順書（SSOT）** である。

### 最重要原則
1. **「停止（Suspension）」と「削除/廃止（Deprovisioning / Decommission）」の厳格な分離**:
   - 一時的な支払遅延、契約更新協議中、緊急インシデント等は「SUSPENDED（停止）」で対処し、データを消去してはならない。
   - 完全廃止（DECOMMISSIONED）は、所定の解約手続きおよびデータ保全・合意形成が完了した後にのみ執行する。
2. **テナント分離の維持（他地区不可侵）**:
   - 特定地区の廃止作業が、稼働中の他地区のデータ・設定・ルーティング・APIキーに一切影響を与えないことを保証する。
3. **個人情報の適切な処置と証跡保全**:
   - 配布員の氏名・連絡先・活動履歴等の個人情報を `DATA_LIFECYCLE.md` に基づき確実に削除・匿名化・アーカイブする。

---

## 2. ライフサイクル状態遷移と区分

```text
[ACTIVE]
   │
   ├─► (契約協議 / 緊急インシデント / 料金未納)
   │        │
   │        ▼
   │   [SUSPENDED] (一時停止: SYSTEM_INFO 状態=SUSPENDED / 1地区専用GAS一時停止, データ保全, 即時再開可)
   │        │
   │        ├─► (契約再開 / インシデント解消) ──► [ACTIVE]
   │        │
   │        ▼
   └─► (正式解約合意 / 契約満了)
            │
            ▼
       [DEPROVISIONING] (廃止処理中: 鍵Revoke, 外部連携遮断, データ消去/退避)
            │
            ▼
       [DECOMMISSIONED] (完全廃止: 1地区専用GAS Web App停止, アーカイブ保存)
```

---

## 3. Phase A: 地区一時停止手順 (Suspension Procedure)

サービスを暫定的に停止し、新規のアクセスおよびデータ書き込みを即座に遮断する。データや設定リソースは削除しない。

### 手順
1. **1地区専用GAS / SYSTEM_INFO 無効化 (主たる即時遮断)**:
   - 当該地区のスプレッドシート `SYSTEM_INFO` の `状態` を `SUSPENDED`（または契約一時停止）に更新、または当該Spreadsheetに付属する1地区専用GASの Web App デプロイを一時無効化する。
   - *効果*: 当該地区へのAPIリクエストが即座に遮断され、他地区には一切影響しない。
2. **アクティブセッションの即時失効**:
   - 当該地区専用GASの CacheService 上の Dashboard セッショントークンを全件削除（強制ログアウト）。
3. **外部公開停止**:
   - LINE LIFF の公開ステータスを非公開に変更するか、メンテナンス画面へ転送。

- **所要時間**: 約 5 分
- **復旧方法**: `SYSTEM_INFO` の `状態: ACTIVE` および Web App 有効化に戻すことで即時復旧可能。

---

## 4. Phase B: 地区完全廃止手順 (Deprovisioning Procedure)

正式解約または契約満了に基づき、当該地区のリソースを段階的に回収・破棄する。

```text
[Step 1: 事前バックアップ & 証跡保全]
       ↓
[Step 2: 外部連携・認証情報の無効化 (LINE / LIFF)]
       ↓
[Step 3: Google Maps API Key の Revoke (GCP Console)]
       ↓
[Step 4: 当該1地区専用GAS Script Properties のクリーンアップ]
       ↓
[Step 5: 個人情報の削除・匿名化 & 1地区DB アーカイブ]
       ↓
[Step 6: 当該1地区専用GAS Web App デプロイの廃止 (Undeploy)]
       ↓
[Step 7: 廃止完了検証 & DECOMMISSIONED 移行]
```

### ステップ詳細

#### Step 1: 事前バックアップ & 証跡保全
- 最終状態のスプレッドシートをコールドストレージ（アーカイブ用Drive / GCS）へ完全エクスポート。
- 配布実績合計、最終残高、活動サマリーの監査レポートを出力・保存。

#### Step 2: 外部連携・認証情報の無効化
- LINE Developers コンソールにて、当該地区専用の LIFF アプリおよび Messaging API チャネルを削除または連携解除。

#### Step 3: Google Maps API Key の Revoke (GCP Console)
- GCP Console を開き、当該地区専用の API キー（`GOOGLE_MAPS_API_KEY_<DISTRICT_ID>` または地区専用キー）を特定。
- 該当キーを **即時削除（Revoke）** する。
- *確認*: 削除されたキーを用いた Maps API 呼び出しが `REQUEST_DENIED` になること。

#### Step 4: 当該1地区専用GAS Script Properties のクリーンアップ
- 当該Spreadsheetに付属する1地区専用GASの Script Properties から、機密キーを削除：
  - `GOOGLE_MAPS_API_KEY_<DISTRICT_ID>` / `MAPS_API_KEY`
  - `LINE_CHANNEL_ACCESS_TOKEN` / `PROVISIONING_TOKEN_HASH` 等の地区専用シークレット
- *重要*: 1地区自己完結構造のため、他地区のGAS環境には一切接触しない。

#### Step 5: 個人情報の削除・匿名化 & 1地区DB アーカイブ
- `DATA_LIFECYCLE.md` のプライバシー規程に基づき、スプレッドシート内のスタッフ名簿シートの氏名・LINE User ID 等の個人識別情報を不可逆的に削除・上書き（マスク）。
- 匿名化処理後のスプレッドシートを組織のデータ保持ポリシー（**TBD / Decision Required**: 法定要件・組織合意に基づき決定）に従ってアーカイブフォルダへ移動し、共有権限を管理者のみに絞り込む。

#### Step 6: 当該1地区専用GAS Web App デプロイの廃止
- 当該地区専用GASの Web App デプロイメントをアーカイブ（無効化）し、`TARGET_SPREADSHEET_ID` バインディングを解除する。
- 当該地区の GitHub Pages / 独自ドメイン配信を停止する。

#### Step 7: 廃止完了検証 & DECOMMISSIONED 移行
- 当該地区のエンドポイントへのリクエストが遮断され、アクセス不可であることを確認。
- 地区ステータスを正式に `DECOMMISSIONED` として記録。
- 廃止完了報告書を MASTER へ提出。

---

## 5. チェックリストと受入基準 (Deprovisioning Verification)

| No | 検証項目 | 判定基準 | 証跡 |
|:---:|:---|:---|:---:|
| 1 | **最終データ退避** | 最終業務スプレッドシートがアーカイブ領域に保全されている | アーカイブURL |
| 2 | **個人情報消去** | スタッフ個人情報（氏名、LINE ID、連絡先）が完全に消去/マスクされている | スナップショット |
| 3 | **Maps API Key Revoke** | GCP Console 上で該当キーが削除され、無効化が確認されている | GCP監査ログ |
| 4 | **Script Properties 削除** | 当該1地区専用GASから機密プロパティが完全に消去されている | プロパティ一覧 |
| 5 | **Web App 廃止** | 当該1地区専用GASの Web App デプロイが無効化されている | デプロイ状態ログ |
| 6 | **アクセス拒絶確認** | 旧地区エンドポイントによる H App / Dashboard / API 通信が完全遮断される | 通信エラーログ |
| 7 | **他地区影響ゼロ** | 稼働中の他地区（別リポジトリ・別GAS・別DB）に一切の接触・影響がない | 境界確認ログ |

> [!CAUTION]
> 廃止作業中に `active/` 配下のソースコードや共通スクリプトを変更することは絶対禁止とする。
