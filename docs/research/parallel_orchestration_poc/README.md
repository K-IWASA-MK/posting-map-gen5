# Parallel Orchestration & Governance PoC — 実証資産記録

本ドキュメントは、POSTING MAP プロジェクトにおける **並列Worker実行オーケストレーション** および **ガバナンス機構（Hookインターセプト、安全ロック、排他スコープ検査）** の概念実証（PoC: Proof of Concept）で得られた実証資産、検証結果、および技術的境界を記録・保全するものである。

---

## 1. ディレクトリ構成

```text
docs/research/parallel_orchestration_poc/
├── README.md                      # 本ドキュメント（実証結果・境界・注記）
├── artifacts/                     # PoC実施時のWorker成果物および検証スクリプト
│   ├── evidence_hashes.json       # 実証完了時の全資産・Gitハッシュ記録
│   ├── integration_test.mjs       # Worker成果物の結合テストスクリプト
│   ├── unauthorized_fault_injection.txt # 障害注入テスト用未承認ファイル
│   ├── verify_worker_a.mjs        # Worker A単体検証スクリプト
│   ├── verify_worker_b.mjs        # Worker B単体検証スクリプト
│   ├── worker_a_metric.mjs        # Worker A作成成果物（メトリクス計算モジュール）
│   ├── worker_b_report.mjs        # Worker B作成成果物（レポート生成モジュール）
│   └── worker_registry.json       # Worker割当レジストリ（ID・排他パス定義）
├── governance/                    # PoCで開発・実証されたガバナンス機構コード
│   ├── check-parallel-scope.mjs   # 4観点検査・非書込み監査スクリプト
│   ├── hooks.json.archive         # Antigravity PreToolUse Hook設定（アーカイブ）
│   ├── parallel_guard.mjs         # ガバナンス判定スクリプト（主体識別・統制）
│   └── test_parallel_governance.mjs # ガバナンス隔離実機テスト（全7項目）
└── evidence/                      # 実際の安全ロック発生および復旧の証跡ファイル
    ├── .safety-lock.evidence-20261006   # MASTER手動改名による一次復旧証跡
    └── .safety-lock.evidence-audit-test # ガード force_ask 実機承認による復旧証跡
```

※ なお、着手前基準ファイル [`scripts/run-gemini-auditor.mjs`](file:///Volumes/SSD_DATA/posting-map-kuwana/scripts/run-gemini-auditor.mjs)（SHA-256: `3eea87f51fae87f0d263723e55c859f5a8a59c557567aa99cc972ad452bf8d50`）は、現位置・現内容を絶対維持している。

---

## 2. 技術的境界の区分（実証済み・未実装・未検証）

### A. 実証済み事項 (Verified)
1. **主体識別先行化（Fail-Closed）**:
   - `conversationId` に基づき、登録済み親ID・Worker・Auditorを識別。未登録者は親扱いせず即時拒否（deny）。
   - 自己申告の `payload.role` 単体では権限を昇格させない厳格な主体判定を確認。
2. **Worker排他ファイル割当**:
   - Workerごとに許可された単一排他パス以外のファイル編集（`write_to_file`, `replace_file_content`）を Hook で即時 deny。
   - 事後検査スクリプト（`check-parallel-scope.mjs`）により、担当外ファイル変更や障害注入ファイルの混入を 100% 検出。
3. **緊急停止統制（Kill Switch）**:
   - `manage_subagents` を監視し、登録済み親（Orchestrator）のみ `kill` / `kill_all` を許可。
   - Workerからの再委任（`invoke_subagent`, `define_subagent`）や他Worker停止を確実に拒否。
4. **安全ロック・復旧プロトコル**:
   - 固定された改名コマンド（`mv -n .agents/.safety-lock .agents/.safety-lock.evidence-<timestamp>`）のみ `force_ask` でMASTER承認を要求。
   - 改名先が既に存在する場合は deny し、既存証跡の上書き防止を強制。
5. **非書込み監査モード**:
   - `check-parallel-scope.mjs --check-only` により、違反検知時に新たな `.safety-lock` を生成せず、exit 1 で終了する読取り専用監査の実装・動作を確認。
6. **成果物統合・結合検証**:
   - 並列実装された Worker A モジュールと Worker B モジュールの依存を結合し、`integration_test.mjs` で全機能の整合性を実証。

### B. 未実装事項 (Unimplemented)
1. **動的Worker登録・ライフサイクル管理API**:
   - 本PoCでは固定の `worker_registry.json` およびコード内IDセットを使用した。動的なWorker生成・破棄に伴うレジストリ自動更新機構は未実装。
2. **通常開発運用とHookの自動調停**:
   - PreToolUse Hookが常時有効な場合、通常運用の読取りコマンドや開発ツールの自由度が過剰に制限されるため、常時稼働Hookはアーカイブ退避（`.agents/hooks.json.archive`）とした。安全かつシームレスにHookを活性化・非活性化する環境調停機構は未実装。
3. **分散環境・複数ホスト間のロック共有**:
   - 単一ローカルファイルシステム上の `.safety-lock` を前提としており、分散環境での分散ロック機構は未実装。
4. **Worker実行ログ（transcript）動的照合の未実装**:
   - `check-parallel-scope.mjs` の観点③（Worker排他照合）において、各Workerの transcript.jsonl から実際のツール実行引数を動的パースして排他的パスと照合する機構は未実装であり、固定の許可ファイル名および障害注入ファイル（`unauthorized_fault_injection.txt`）の静的検知にとどまっている。
5. **保持検査対象の網羅的判定機構の未実装**:
   - `check-parallel-scope.mjs` の観点②（新規差分のScope適合性）において、許可される保持証跡ファイルがハードコードされた一部（`.evidence-20261006`, `.evidence-audit-test`）のみに限定されており、他の保持ファイルや未追跡証跡の網羅的な検査・判定ロジックが不足している。

### C. 未検証事項 (Unverified)
1. **Workerプロセスの異常終了・タイムアウト耐障害性**:
   - Workerが途中でクラッシュ、メモリ枯渇（OOM）、またはタイムアウトした場合の親プロセスのフェイルセーフな復旧手順・残骸回収の耐障害性。
2. **大規模並列ファイルI/O競合**:
   - 3つ以上の多数のWorkerが同時に大量のファイル操作を行った際のファイルシステムI/O競合、競合状態（Race Condition）の挙動。
3. **外部リソース連携時のロールバック**:
   - Gitリポジトリ外部（Google Drive、Spreadsheet API等）への書き込みを伴う並列処理における、片系失敗時の整合性保持とロールバック。
4. **正常系エンドツーエンド自動テストの不足**:
   - `test_parallel_governance.mjs` は異常系・遮断系（deny, force_ask, fail）の検証に特化しており、許可された正当なWorkerが割り当てられた単一ファイルを正常に編集・検証・報告して完了する一連の正常系フロー（Happy Path）の自動テストが不足している。

### D. 文脈分離能力（Context Isolation）の確認範囲と技術的限界
1. **実機確認された能力（客観的根拠あり）**:
   - サブエージェント（Worker または Auditor）起動時、親の思考ログ・試行錯誤プロンプト・会話履歴を直接引き継がず、独立したプロンプトで起動されること。
   - 呼び出し側から明示的に渡された要件・差分・証跡のみを入力として独立に推論・検証を実行できること。
2. **技術的限界・未確認事項（断定不可）**:
   - 同一マシン・同一OS・同一UID（ユーザー権限）環境で稼働しているため、ファイルシステム、ローカル環境変数、Nodeランタイムを共有している。
   - カーネルレベルの完全なプロセス隔離（OS-level hard isolation）、メモリ空間の暗号的遮断、物理的ネットワーク遮断等のハードウェア的Security Boundaryは実証されておらず、これを能力として断定してはならない。
   - あくまで「AI役職上の規程拘束（Policy-Level Zero Write / Allowlist）」および「会話コンテキストのプロンプト分離」として厳格に運用される。

---

## 3. 実証資産ハッシュ照合表

`scratch/parallel_test/evidence_hashes.json` に記録されたハッシュと、保存先ファイル（`docs/research/parallel_orchestration_poc/`）の SHA-256 ハッシュは完全に一致している。

| 区分 | ファイル名 | 保存先相対パス | SHA-256 ハッシュ | 照合結果 |
| :--- | :--- | :--- | :--- | :---: |
| 成果物 | `evidence_hashes.json` | `artifacts/evidence_hashes.json` | `1eeec93ca2a74dd0f02cb4389951fcb5419958401164f211d3ccae8f9a3058ba` | **一致** |
| 成果物 | `integration_test.mjs` | `artifacts/integration_test.mjs` | `ff47f3f9209e6de0e7ccc081d671c46e1d4fd2ea582d4a45b320740a89af8190` | **一致** |
| 障害証跡 | `unauthorized_fault_injection.txt` | `artifacts/unauthorized_fault_injection.txt` | `09872e6ad695f09fb56cd5a95301fa97e6238b5535719f2cdda5ee81c15288e5` | **一致** |
| 成果物 | `verify_worker_a.mjs` | `artifacts/verify_worker_a.mjs` | `6add83b70c5fe04290f926aae2b29b997618ee4fff64529566bd9d185240fbda` | **一致** |
| 成果物 | `verify_worker_b.mjs` | `artifacts/verify_worker_b.mjs` | `0a0d3db1c0e4550262114cd511e0a3b45ab50d75dbaa2d25d5725e2762c955b2` | **一致** |
| 成果物 | `worker_a_metric.mjs` | `artifacts/worker_a_metric.mjs` | `9ab5affc642ae50035ce755364fd2e9f1a8faf537133dee707f3a733a56a9c6e` | **一致** |
| 成果物 | `worker_b_report.mjs` | `artifacts/worker_b_report.mjs` | `918ca23e55502aae3a25cab05f6d2edfeeac5fad2359e5baf14d3c4366ee301e` | **一致** |
| 成果物 | `worker_registry.json` | `artifacts/worker_registry.json` | `59e1188f509c981c2f6d8bfbf45bcfd58a9ecae50f549b82f7a956268e7893a7` | **一致** |
| ガバナンス | `parallel_guard.mjs` | `governance/parallel_guard.mjs` | `385184600a5f8237eedcd241d84dcaddcedc25ea27f58a8583b8148f0829e45a` | **一致** |
| ガバナンス | `check-parallel-scope.mjs` | `governance/check-parallel-scope.mjs` | `a54c1ef7d2033772d9c372d1c81eabaa0545d4c483a89260e84209ed87d10f4b` | **一致** |
| ガバナンス | `test_parallel_governance.mjs` | `governance/test_parallel_governance.mjs` | `f849f11f0aa4320dd2e2b03bc89a73b51565d336c4164fb4f50c773e8379d626` | **一致** |
| ガバナンス | `hooks.json.archive` | `governance/hooks.json.archive` | `65b3523132392bcc80cc9f4a2b70bb9fb2edc366908e641a18a526d7f0fd7ad8` | **一致** |
| 証跡 | `.safety-lock.evidence-20261006` | `evidence/.safety-lock.evidence-20261006` | `bf4f6b52c829fbf4d6ff477e8fbf9e2c4781856ccb09c9615e434a782609ab7e` | **一致** |
| 証跡 | `.safety-lock.evidence-audit-test` | `evidence/.safety-lock.evidence-audit-test` | `0d6d1778b7eace96b10ce1b6b7037597cdc68862ff416181ad62928b82ebeb2c` | **一致** |

---

## 4. `evidence_hashes.json` のタイムゾーン・記録時刻に関する注記

`evidence_hashes.json` 内の `recordedAt` フィールドには以下の文字列が記録されている：
```json
"recordedAt": "2026-10-06T07:26:00.000Z"
```

### 事実関係および客観的証跡
1. **元記録保持**:
   - `evidence_hashes.json` は確定証跡ファイルであるため、元ファイルを推測で改ざん・書き換えせず、そのまま保持している。
2. **実ログ上の時刻との差異**:
   - 実機トランスクリプトログ（`transcript.jsonl`）のステップ実行時刻は、以下の通りである：
     - UTC: `2026-10-05T22:25:53Z`
     - ローカル時刻（JST, UTC+9）: `2026-10-06T07:25:53+09:00`
   - `evidence_hashes.json` の記録文字列 `"2026-10-06T07:26:00.000Z"` は、ローカル時刻の数値（`07:26:00`）に対して末尾に `Z`（UTC識別子）が付与されており、UTCの実時刻（`2026-10-05T22:26:00Z`）と乖離している。
   - したがって、この記録日時は「日本標準時（JST）の `2026-10-06 07:26:00` に採取されたもの」と解釈するのが実態と整合する。
