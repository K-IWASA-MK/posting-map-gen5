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
   │   [SUSPENDED] (一時停止: Registry enabled=false, データ保全, 即時再開可)
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
       [DECOMMISSIONED] (完全廃止: Registryエントリ抹消, アーカイブ保存)
```

---

## 3. Phase A: 地区一時停止手順 (Suspension Procedure)

サービスを暫定的に停止し、新規のアクセスおよびデータ書き込みを即座に遮断する。データや設定リソースは削除しない。

### 手順
1. **DISTRICT_REGISTRY 無効化 (主たる即時遮断)**:
   - 親GASの Script Properties から `DISTRICT_REGISTRY` を取得。
   - 対象地区の `enabled` を `false` に更新して保存。
   - *効果*: 親GAS Gateway レベルで全APIリクエストが即座に拒絶される（`HTTP 403 / DISTRICT_DISABLED`）。
2. **アクティブセッションの即時失効**:
   - CacheService 上の該当地区の Dashboard セッショントークンを全件削除（強制ログアウト）。
3. **外部公開停止**:
   - LINE LIFF の公開ステータスを非公開に変更するか、メンテナンス画面へ転送。

- **所要時間**: 約 5 分
- **復旧方法**: `enabled: true` および `active: TRUE` に戻すことで即時復旧可能。

---

## 4. Phase B: 地区完全廃止手順 (Deprovisioning Procedure)

正式解約または契約満了に基づき、リソースを段階的に回収・破棄する。

```text
[Step 1: 事前バックアップ & 証跡保全]
       ↓
[Step 2: 外部連携・認証情報の無効化 (LINE / LIFF)]
       ↓
[Step 3: Google Maps API Key の Revoke (GCP Console)]
       ↓
[Step 4: 親GAS Script Properties のクリーンアップ]
       ↓
[Step 5: 個人情報の削除・匿名化 & Pure DB アーカイブ]
       ↓
[Step 6: DISTRICT_REGISTRY からのエントリ抹消]
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
- GCP Console を開き、当該地区専用の API キー（`GOOGLE_MAPS_API_KEY_<DISTRICT_ID>`）を特定。
- 該当キーを **即時削除（Revoke）** する。
- *確認*: 削除されたキーを用いた Maps API 呼び出しが `REQUEST_DENIED` になること。

#### Step 4: 親GAS Script Properties のクリーンアップ
- 親GASの Script Properties から、当該地区専用のキーを削除：
  - `GOOGLE_MAPS_API_KEY_<DISTRICT_ID>`
  - （個別に存在する場合）地区専用シークレット
- *重要*: 他地区のキーおよび共通プロパティに触れないこと。

#### Step 5: 個人情報の削除・匿名化 & Pure DB アーカイブ
- `DATA_LIFECYCLE.md` のプライバシー規程に基づき、スプレッドシート内のスタッフ名簿（`STAFF` シート）の氏名・電話番号・メールアドレス等の個人識別情報を不可逆的に削除・上書き（マスク）。
- 匿名化処理後のスプレッドシートを組織のデータ保持ポリシー（**TBD / Decision Required**: 法定要件・組織合意に基づき決定）に従ってアーカイブフォルダへ移動し、共有権限を管理者のみに絞り込む。

#### Step 6: DISTRICT_REGISTRY からのエントリ抹消
- 親GAS Script Properties の `DISTRICT_REGISTRY` を取得。
- 対象地区のキー（`<DISTRICT_ID>`）を JSON オブジェクトから完全に削除。
- 変更後の `DISTRICT_REGISTRY` を保存。
- *重要*: JSON構文の妥当性、および他地区のエントリが1件も損なわれていないことを確認。

#### Step 7: 廃止完了検証 & DECOMMISSIONED 移行
- 当該地区IDを指定した API リクエストが `UNKNOWN_DISTRICT` または 404 となり、アクセス不可であることを確認。
- 地区ステータスを正式に `DECOMMISSIONED` として記録。
- 廃止完了報告書を MASTER へ提出。

---

## 5. チェックリストと受入基準 (Deprovisioning Verification)

| No | 検証項目 | 判定基準 | 証跡 |
|:---:|:---|:---|:---:|
| 1 | **最終データ退避** | 最終業務スプレッドシートがアーカイブ領域に保全されている | アーカイブURL |
| 2 | **個人情報消去** | スタッフ個人情報（氏名、TEL、メール）が完全に消去/マスクされている | スナップショット |
| 3 | **Maps API Key Revoke** | GCP Console 上で該当キーが削除され、無効化が確認されている | GCP監査ログ |
| 4 | **Script Properties 削除** | 親GASから `GOOGLE_MAPS_API_KEY_<ID>` が完全に消去されている | プロパティ一覧 |
| 5 | **Registry 抹消** | `DISTRICT_REGISTRY` から対象地区エントリが完全に削除されている | 比較差分ログ |
| 6 | **アクセス拒絶確認** | 旧地区IDによる H App / Dashboard / API 通信が完全遮断される | 通信エラーログ |
| 7 | **他地区影響ゼロ** | 稼働中の他地区のAPI通信および動作に一切の異常がない | Smoke Testログ |

> [!CAUTION]
> 廃止作業中に `active/` 配下のソースコードや共通スクリプトを変更することは絶対禁止とする。
