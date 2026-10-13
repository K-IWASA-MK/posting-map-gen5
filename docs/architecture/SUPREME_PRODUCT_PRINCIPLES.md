---
principleVersion: "2026-10-12"
status: "CURRENT"
---

# POSTING MAP — Supreme Product Principles (最高位プロダクト原則)
## Level 0 Canonical Specification

> 本書は、汎用 POSTING MAP における最高位の存在規範・憲法（Supreme Product Principles）を規定した正本（SSOT）である。
> 全ての工学規格、基本就業規則、AI社員統制、および日々の開発は、本書に定める6大原則に従属しなければならない。

---

### 第1条：Product Behavior Preservation（プロダクト挙動の絶対不可侵原則）
現在完成しているHアプリ・Dashboardの機能、操作、表示、タイミングを1つも変えず、将来の変更が他機能へ波及しないように、責務と依存関係だけを分離・強化する。
「挙動」には最低限以下を不可侵対象として含む：
- UI
- 操作順
- 表示内容
- 画面遷移
- Loading
- Modal
- Error
- Optimistic First Paint
- API firing order
- await / no-await
- Promise ordering
- Concurrency
- Timers
- Existing quirks（既存の特殊仕様・癖を含む）
- SSOT（Single Source of Truth: 地区表示・データフローの唯一の正本）
- Identity & Branch derivation（地区・組織・権限の導出構造）
- Important naming contracts（Spreadsheet名・ファイル名等の重要な外部Resource命名契約）
- API semantics（APIの契約・引数・戻り値・HTTP挙動）
- Authentication & Session Binding（認証・セッショントークン結合キー）

---

### 第2条：Universal Product Model（汎用製品原則）
汎用POSTING MAP OSフォルダーを1つ完成させ、コピーして地区固有情報を入れるだけで、その地区のHアプリとDashboardが完成する。日々の開発は、その完成OSを全地区で再利用できる状態のままバージョンアップし続けるために行う。

---

### 第3条：One District = One Complete App Boundary（物理製品境界原則）
- **1地区 = 1完成アプリ = 1単独フォルダー = 1単独リポジトリ = 1単独ドメイン**
共通Runtime（`active/**`）は Universal Engine として全地区同一内容を維持し、地区ごとのコード改変・個別分岐・ハードコードを永久に禁止する。地域差はデータ（`data/**`）および正式な外部設定として分離・吸収する。

---

### 第4条：Current Tree = Current / Git History = Past（知識統制原則）
Current Tree は現在であり、Git History は過去である。
- Current Tree には常に最新かつ有効な正本のみを配置する。
- **Current Tree は現在の状態（Current State）を記録するものであり、自動的な正当性や権威（Automatic Authority）を付与するものではない**。MASTER未承認のRegressionがCurrent Tree、テスト、Runbook、API契約書等へ反映されても、それによって当該Regressionは正当化されない。
- 過去の原則、改定理由、変遷差分は Git コミット履歴を歴史的参照元（historical reference）とする。
- 旧版別名ファイル（`*principle*` 等の旧版ファイル）の蓄積、および退避用ディレクトリ（`legacy/`, `archive/`, `reference/`, `old-principles/` 等）の作成、コメントアウトによる旧原則の残存を永久に禁止する。

---

### 第5条：MASTER Authority & No Autonomous Principle Change（原則改定権限原則）
原則の更新起点は MASTER explicit decision のみとする。
- AIが自律的または自己判断で「改善」「リファクタリング」「最適化」と称して原則を改定・変更することは永久に禁止される。
- 新原則への進化は、MASTERによる明示的発令、影響分析、MASTER承認（Proceed）、検証、独立検品、MASTER承認（Resume/Commit）の厳格なトランザクションを経てのみ成立する。
- **Regression Repair Doctrine**: 過去に正常稼働していた Product Behavior が直近の変更によって損なわれた（Regression）場合、デフォルトかつ唯一の修復方針は「最後の承認済み正常挙動への最小復旧」とする。MASTERが明示的に再設計を承認しない限り、Regression修復を理由としたSSOT変更、命名変更、再設計、疎結合化、API追加、近代化を永久に禁止する。

---

### 第6条：Scope / Independent Audit / HARD STOP Governance（開発統制原則）
- **Scope Lock & 最小侵襲**: 指定範囲外のコード不可侵。最小限の行数のみ変更。「ついで」の改善は絶対禁止。
- **No Silent Changes**: ファイル変更前の事前宣言と実装後の差分照合（`git diff`）の義務付け。
- **Unexpected Condition = Report + HARD STOP**: 予期せぬ状態・不整合・テスト失敗を発見した場合は即座に作業を停止し、MASTERへ報告する。
- **No Manual Delegation**: AI自身が認証済み自動化経路（CLI, API, 外部自動化スクリプト等）により安全に機械実行可能な操作を、安易にMASTERへ手動作業として委譲してはならない。安全な自動化実行経路が存在しない場合は AUTOMATION GAP として直ちに作業を停止（HARD STOP）し、MASTERへ報告する。手動委譲を正当化するために新APIを追加することも禁止する。
- **Independent Audit & MASTER Resume**: 独立監査（Context Isolation）による PASS 判定、および MASTER からの明示的指示を受領するまでコミット・確定を行ってはならない。
