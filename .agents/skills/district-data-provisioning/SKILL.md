---
name: district-data-provisioning
description: 地区プロビジョニング規範。Phase 1 Area Skeleton（rowId,city_name,town_name 3列）確定とPhase 2後段属性・MultiPolygon境界付与によるマスターデータ生成、および実ブラウザによるLINE資産・リッチメッセージ・あいさつメッセージ構築手順。
---

# District Data & LINE Provisioning Capability Pack

## 1. 概要と適用責務
本 Pack は、新地区の開設において、以下を安全かつ再現可能に遂行するための Universal プロビジョニング規格である：
1. **Phase 1（Area Skeleton 確定）**: 対象地区確定 ➔ 公式住所データからの `city_name` / `town_name`（公式に丁目が存在すれば丁目まで含め、それより下位の小字・方角・通称・人工的括弧名称は探索・推測・生成しない）の確定 ➔ 最終順序確定後の `rowId`（`1..N`）採番による **3列のみの Area Skeleton（`rowId,city_name,town_name`）** 生成（e-Stat 等の後段データ非依存）。
2. **Phase 2（後段属性・境界付与）**: 確定済み Area Skeleton に対して後段責務として e-Stat 等から代表座標・人口・世帯数・小地域コードおよび境界 GeoJSON を付与し、マスターデータ（`data/`）を完成させる。
3. 実ブラウザ（Chrome CDP）を使用した対象地区専用 LINE 資産一式（LINE Login、LINE公式アカウント、Messaging API、Linked Bot、LIFF、長期チャネルアクセストークン、公式ロゴ、2分割リッチメッセージ、あいさつメッセージ）の構築および READ ONLY 完全検証。

## 2. 正本仕様依存 (Canonical Sources)
- [district-data-transition-rule.md](../../../.agents/rules/district-data-transition-rule.md): 地区データ移行規則
- [DISTRICT_DATA_ACQUISITION_RULE.md](../../../docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md): 地区データ自律調達・2段階マスター生成規程
- [ADDRESS_EXTRACTION_RULE.md](../../../docs/architecture/ADDRESS_EXTRACTION_RULE.md): 住所抽出規範
- [DISTRICT_PROVISIONING_RUNBOOK.md](../../../docs/operations/DISTRICT_PROVISIONING_RUNBOOK.md): 新地区標準プロビジョニング手順書

## 3. マスターデータ構築の絶対規範
1. **Universal Engine 不可侵原則**:
   - 地区ごとの特殊事情（町名フォーマット、境界形状、世帯規模）を吸収するために共通エンジン（`active/**`）を変更してはならない。全ての地区差は `data/**` 内のマスターデータによって吸収する。
2. **Phase 1 Area Skeleton 純粋性と後段分離原則**:
   - 第1段階（Phase 1）の成果物は `rowId,city_name,town_name` の3列のみとし、e-Stat・`households`・`population`・`latitude`・`longitude`・`boundaries`・投票率等を Phase 1 の Skeleton 決定に一切使用してはならない。
   - `town_name` より下位の小字・方角・通称・人工的括弧名称を探索・推測・生成・地区固有辞書補完してはならない。
3. **飛び地 MultiPolygon の完全統合（Phase 2 後段責務）**:
   - Phase 2 の境界付与において、同一 `rowId`（町丁目）に複数の離れたポリゴン（飛び地・島嶼）が存在する場合、別レコードに分割せず、単一の MultiPolygon Feature として統合する。
4. **既存稼働地区データの非Migration原則と新旧対応表**:
   - 既存稼働地区の確定済み `data/**` および既存 `rowId` は遡及的に Migration・再採番しない（新規地区では `data/area_mapping.json` を空配列 `[]` に初期化する）。
5. **Code Deployment 権限の非保有**:
   - 本 Pack を実行する District Provisioner は、コードのデプロイ権限を持たない。データ受入ゲートが 100% PASS した後、MASTER の承認を経てプロビジョニングを完了する。

---

## 4. LINE Live-Browser Provisioning 規範（Universal Parameter Contract）

### 4.1 入力パラメータ契約 (District Parameters)
地区固有値をハードコードせず、必ず以下の入力パラメータを解決して実行する：

| パラメータ名 | 定義 / 既定値規則 |
| :--- | :--- |
| `DISTRICT_ID` | Source of Truth は対象地区の **Spreadsheet名** に固定（正規化地区ID: 英大文字・数字・ハイフン）。caller supplied `DISTRICT_ID` と不一致の場合は即座に **HARD STOP** |
| `CHANNEL_NAME` | `POSTING MAP <DISTRICT_ID>` |
| `CHANNEL_DESCRIPTION` | `POSTING MAP <DISTRICT_ID> 配布員認証アプリ` |
| `CONTACT_EMAIL` | `postingareamap@gmail.com` |
| `OFFICIAL_ACCOUNT_NAME` | `POSTING MAP <DISTRICT_ID>` |
| `DOMAIN` | `<district-id-lower>.postingmap.jp` |
| `LIFF_ENDPOINT` | `https://<DOMAIN>/` |
| `PROVIDER_ID` | 既定値 `2005181930`（※実操作前に必ず実画面で再確認） |
| `PROVIDER_NAME` | 既定値 `Civic Tech Inc.`（※実操作前に必ず実画面で再確認） |
| `LOGO_ASSET_PATH` | `active/h-app/assets/icon180-v2.png` |
| `RICH_MESSAGE_IMAGE_PATH` | `assets/richmenu_default.png` |
| `OA_CATEGORY_MAIN` | `ウェブサービス` |
| `OA_CATEGORY_SUB` | `ウェブサービス(ビジネス)` |

### 4.2 Branding 画像正本契約
1. **LINE Login 公式ロゴ正本**: [icon180-v2.png](../../../active/h-app/assets/icon180-v2.png) (`active/h-app/assets/icon180-v2.png`, 180×180 PNG)
2. **Rich Message 画像正本**: `assets/richmenu_default.png` (`assets/richmenu_default.png`)
   - ファイル名に `richmenu` が含まれていても、LINE機能上は **Rich Message（リッチメッセージ）画像正本** として扱う。
   - **LINE Rich Menu (`/richmenu`) は作成対象ではない**。
   - 新規画像生成・再デザイン・類似画像代用は禁止。

### 4.3 Live Browser 実行ポリシー・不可逆ゲート・既存地区保護
1. **ブラウザ基盤**:
   - Chrome CDP (`127.0.0.1:9223`) を使用し、LINE Developers Console および LINE Official Account Manager の両方へログイン済みの状態で実行する。
   - SPA 描画待ち・モーダル構造差・軽微な Selector 差異は実DOMを直接読んでその場で適応する。
2. **Irreversible Gate（不可逆操作直前再読取ゲート）**:
   - 作成・公開・保存・Token発行等の確定ボタンを押す直前には、必ず毎回実DOMから `Provider`、`District`、`Channel/OA Name`、`Target ID`、`Destination URL` を再読取し、パラメータ契約と完全一致することを確認する。推測値だけで確定ボタンを押してはならない。
3. **HARD STOP 条件**:
   - 未承認の必須業務値の出現、対象地区 / OA / Provider の不一致、既存資産との衝突、Token再発行が必要になる状態、不可逆操作対象の曖昧さ、他地区資産を変更する可能性が1つでも検知された場合は直ちに **HARD STOP** する。
4. **Existing District Protection（既存地区資産の絶対不可侵）**:
   - 参照元地区および他地区の既存チャネル・OA・LIFF・Token・Rich Message・Welcome Message は完全 READ ONLY とし、**Target District の資産のみ** を変更対象（`target district only mutation`）とする。
5. **Token 保全・非露出ポリシー**:
   - 未発行 ➔ 初回1回のみ発行可。
   - 発行済み・読取可 ➔ **REUSE**（再利用）。
   - 発行済み・読取不可 ➔ **HARD STOP**（再発行禁止）。
   - 生Tokenを Git、Console、Transcript、Screenshot、Test fixture、Audit report、Skill本文へ出力することを絶対禁止する（外部出力は先頭4文字＋末尾4文字＋文字数のマスク情報のみ）。

---

## 5. LINE Live-Browser Provisioning 11ステップ標準手順

1地区について、以下の **Step 1 〜 Step 11** を順番に完了させる。

### Step 1: LINE Login Channel 作成・公開
1. `https://developers.line.biz/console/provider/<PROVIDER_ID>` を開き、見出しが `<PROVIDER_NAME>` と完全一致することを確認。
2. 対象 `<CHANNEL_NAME>` の LINEログイン チャネルが未作成であることを確認の上、`div.channel-card-list-create`（テキスト `"新規チャネル作成"`）をクリック。
3. モーダル内の `ul.selector a.item-link[href*="/console/channel/new"][href*="type=line-login"]` の `href` を検証（`pathname === "/console/channel/new"`, `provider === <PROVIDER_ID>`, `type === "line-login"`）して遷移（既存 `a.channel-item` は不触）。
4. 遷移後 URL を再検証した上で以下を入力：
   - **サービスを提供する地域**: `日本`
   - **会社・事業者の所在国・地域**: `日本`（`<select>` の option text Exact Match）
   - **チャネル名**: `<CHANNEL_NAME>`（`.new-channel textarea.user-input[placeholder="チャネル名を入力してください"]`）
   - **チャネル説明**:
     `配りたい人とチラシをつなぐ。POSTING MAPは、誰が、どの市町村で、何枚のチラシを持っているかを確認し、申請して受け取れるポスティング活動支援アプリです。チラシの所在を見える化することで、活動を始めたい人がすぐに動ける環境を提供します。そして、あなたも地域のチラシ保有拠点として活動に参加しませんか。チラシを預かることが、地域のポスティング活動を支える新たな力になります。`
   - **アプリタイプ**: `ウェブアプリ` チェックON（`ネイティブアプリ` はOFF維持）
   - **2要素認証の必須化 (`force2fa`)**: 未変更（OFF維持）
   - **メールアドレス**: 既存値があれば維持、空欄時のみ `postingareamap@gmail.com`
   - **LINE開発者契約**: 同意チェックON
5. 全11項目＋ボタン文言 `"作成"` を実DOMで再読取確認後、`.new-channel .operations button.kv-button[type="submit"]` を1回押下。
6. 作成された `<LOGIN_CHANNEL_ID>` を取得し、チャネルヘッダーの `開発中` ボタン ➔ モーダル内 `公開` を押下してステータスを **`公開済み`** にする。

### Step 2: LINE Official Account 作成
1. `https://manager.line.biz/` の「作成」リンクから `https://entry.line.biz/form/entry/unverified` へ遷移（URL Exact Gate）。
2. 以下を入力：
   - **アカウント名**: `<OFFICIAL_ACCOUNT_NAME>`
   - **業種**: 大業種 `select[name="category_group"]` = `"ウェブサービス"`、小業種 `select[name="category"]` = `"ウェブサービス(ビジネス)"`（option text Exact Match、`legalCountryCode` は変更しない）
3. 選択ラベル再読取および `form.checkValidity() === true` を確認後、`確認` ➔ `完了` で作成し、発行された `<OA_BASIC_ID>` (`@xxxx`) を取得。

### Step 3: Messaging API 有効化
1. `https://manager.line.biz/account/<OA_BASIC_ID>/setting/messaging-api` を開き、「Messaging APIを利用する」をクリック。
2. 開発者情報アンケートが表示された場合は用途に `OTHER` / `MESSAGING` を選択し、プロバイダー選択画面で **`<PROVIDER_NAME>` (`<PROVIDER_ID>`)** を選択（新規プロバイダー作成は禁止）。
3. プライバシーポリシー・利用規約は空欄のまま進め、最終確認モーダルで Provider = `<PROVIDER_NAME>`・Account = `<OFFICIAL_ACCOUNT_NAME>` を再読取確認して `OK` を押下。
4. `https://developers.line.biz/console/provider/<PROVIDER_ID>` 上で生成された `<MESSAGING_CHANNEL_ID>` を取得し、Provider が `<PROVIDER_NAME>` であることを確認。

### Step 4: Linked Official Account（ボットリンク）設定
1. `https://developers.line.biz/console/channel/<LOGIN_CHANNEL_ID>/basics` の「友だち追加オプション ＞ リンクされたLINE公式アカウント」にて `編集` をクリック。
2. `<select>` から `<OA_BASIC_ID>/<OFFICIAL_ACCOUNT_NAME>`（当該地区の `<OA_BASIC_ID>`）を選択して `更新` を押下。
3. 再読取により `<OA_BASIC_ID>` がリンクされていることを確認。

### Step 5: LIFF アプリケーション作成
1. `https://developers.line.biz/console/channel/<LOGIN_CHANNEL_ID>/liff` を開き、`追加` をクリック。
2. 以下を設定：
   - **LIFFアプリ名**: `<CHANNEL_NAME>`
   - **サイズ**: `Full` (`value="full"`)
   - **エンドポイントURL**: `<LIFF_ENDPOINT>` (`https://<DOMAIN>/`)
   - **Scope**: `openid`（初期ON維持）＋ `profile`（チェックON）
   - **友だち追加オプション (Bot Prompt)**: `On (aggressive)` (`value="aggressive"`)
   - **Scan QR**: `Off`（初期維持）
   - **モジュールモード (Module Mode)**: `Off`（初期維持）
3. 全項目を実DOM再読取後、`追加` を押下し、発行された `<LIFF_ID>` (`<LOGIN_CHANNEL_ID>-xxxxxxxx`) を取得。対象地区の LIFF URL を `https://liff.line.me/<LIFF_ID>` として確定する（他地区の LIFF URL は絶対にコピーしない）。

### Step 6: Long-lived Channel Access Token 発行・検証
1. `https://developers.line.biz/console/channel/<MESSAGING_CHANNEL_ID>/messaging-api` の「チャネルアクセストークン（長期）」セクションを確認。
2. 未発行（`発行` ボタン表示）の場合のみ初回1回だけ `発行` を押下。既に発行済みの場合は表示されている長期トークンをメモリ上で読取（REUSE）し、`再発行` は絶対に押さない。

### Step 7: LINE Login 公式ロゴ設定
1. `https://developers.line.biz/console/channel/<LOGIN_CHANNEL_ID>/basics` の「チャネルアイコン」にて `編集` をクリック。
2. `input[type="file"]` に正本 [icon180-v2.png](../../../active/h-app/assets/icon180-v2.png) を指定し、`更新` を押下。
3. リロード後、`.channel-header img.img` および `.cover` 背景画像URLが反映されていることを再読取確認。

### Step 8: LINE Login 基本設定最終確認 (READ ONLY)
`https://developers.line.biz/console/channel/<LOGIN_CHANNEL_ID>/basics` および `/liff/<LIFF_ID>` を READ ONLY で再読取し、以下を確認：
- Provider = `<PROVIDER_NAME>` (`<PROVIDER_ID>`)
- Channel ID = `<LOGIN_CHANNEL_ID>`
- Channel Name = `<CHANNEL_NAME>`
- Channel Description = Step 1 の正本説明文と完全一致（地区名書き換え・短縮なし）
- Email = `postingareamap@gmail.com`
- App Type = `ウェブアプリ`
- Status = `公開済み`
- Service Region = `日本`
- Company Country = `日本`
- Linked Official Account = `<OA_BASIC_ID> / <OFFICIAL_ACCOUNT_NAME>`
- LIFF = `<LIFF_ID>`, Name `<CHANNEL_NAME>`, Endpoint `<LIFF_ENDPOINT>`, Size `Full`, Scope `openid, profile`, Bot Prompt `On (aggressive)`, Module Mode `Off`

### Step 9: 2分割 Rich Message 作成 (`contentsType = 26`)
1. `https://manager.line.biz/account/<OA_BASIC_ID>/richmessage/create` を開く。
2. 操作前に URL が `/account/<OA_BASIC_ID>/` であり、ヘッダー表示名が `<OFFICIAL_ACCOUNT_NAME>` であることを再読取確認（不一致時は HARD STOP）。
3. 以下を設定（Canonical Contract）：
   - **アイテム名 (`input[name="title"]`)**: `posting area map`
   - **テンプレート**: `変更` ➔ `縦長` ➔ `figure[data-type="26"]`（縦長上下2分割 A/B、`1040 × 1850`）を選択。
   - **背景画像 (`input[type="file"][name="image"]`)**: `1040 × 1850` キャンバス（上段 Area A `1040 × 925` = 白背景、下段 Area B `1040 × 925` = 正本 `assets/richmenu_default.png` 配置）をアップロード。
   - **Area A アクション**:
     - `select[name="linkTypeA"]` = `テキスト` (`TEXT`)
     - `textarea[name="textA"]`:
       ```text
       📍 POSTING MAPへようこそ！

       下の「📱 H-Appを開く」からご利用ください。
       ```
   - **Area B アクション**:
     - `select[name="linkTypeB"]` = `リンク` (`URL`)
     - `input[name="urlB"]` = `https://liff.line.me/<LIFF_ID>`（※Step 5 で確定した当該地区の実 `<LIFF_ID>` から構築）
     - `textarea[name="labelB"]` = `リンクに移動`
4. 保存前に全入力値を実DOM再読取して完全一致を確認後、`保存` を押下し、生成された `<RICH_MESSAGE_ID>` を取得。

### Step 10: Welcome Message（あいさつメッセージ）への Rich Message Binding
1. `https://manager.line.biz/account/<OA_BASIC_ID>/autoresponse/welcome` を開く。
2. 送信設定 (`input[name="sendOnlyFirstTime"]`) は `false`（未チェック）を維持。
3. **2吹き出し構成 (Welcome Message Canonical Contract)** を設定：
   - **Bubble 1 (`div[name="editor-0"]`, `contentType = TEXT`)**:
     `<rich-textarea>` 内の `<textarea>` をクリアし、以下を入力：
     ```text
     下の「📱 H-Appを開く」から
     ご利用ください。
     ```
   - **Bubble 2 (`div[name="editor-1"]`, `contentType = RICH`)**:
     `追加` ボタン ➔ `div[name="editor-1"] button[aria-label="リッチメッセージ"]` ➔ `リッチメッセージを選択` モーダルから Step 9 で作成した `<RICH_MESSAGE_ID>` (`posting area map`, `contentsType = 26`) を選択。
4. **Mutation-before Gate**: 保存直前に実画面/APIを再読取し、`Target OA === <OA_BASIC_ID>`、`Target Name === <OFFICIAL_ACCOUNT_NAME>`、`Rich Message ID === <RICH_MESSAGE_ID>`、Bubble 1 テキスト完全一致を確認（不一致なら保存せず HARD STOP）。
5. `変更を保存` ➔ 確認モーダルの `保存` を押下。

### Step 11: Final READ ONLY Verification
1. リロード後、実DOMおよび READ ONLY API (`GET /api/bots/<OA_BASIC_ID>/richImage/<RICH_MESSAGE_ID>`, `GET /api/bots/<OA_BASIC_ID>/welcomeMessage`) を再読取し、以下を全件検証する：
   - **LINE Login**: 公開済み、公式ロゴ反映、チャネル名 `<CHANNEL_NAME>`、正本説明文、所在国・提供地域 `日本`、`ウェブアプリ`
   - **Official Account & Messaging API**: `<OA_BASIC_ID>` / `<OFFICIAL_ACCOUNT_NAME>`、`<PROVIDER_NAME>` 配下 `<MESSAGING_CHANNEL_ID>`
   - **Linked OA**: `<OA_BASIC_ID>` が `<LOGIN_CHANNEL_ID>` にリンク済み
   - **LIFF**: `<LIFF_ID>`、`Full`、`<LIFF_ENDPOINT>`、`openid, profile`、`On (aggressive)`、Module Mode `Off`
   - **Token Existence**: 長期トークン存在確認（マスク値のみ記録、再発行 `0`）
   - **Rich Message**: `<RICH_MESSAGE_ID>`, `contentsType === 26`, Area A = `TEXT`（正本文言完全一致）, Area B = `URL` (`https://liff.line.me/<LIFF_ID>`, ラベル `"リンクに移動"`)
   - **Welcome Message**: `balloons.length === 2`、Bubble 1 = `TEXT` (`"下の「📱 H-Appを開く」から\nご利用ください。"`), Bubble 2 = `RICH` (`originalId === <RICH_MESSAGE_ID>`), `sendOnlyFirstTime === false`、プレビュー表示順序 `TEXT → Rich Message`
2. 対象地区向けに `scripts/provision-line-assets.mjs` `--verify-only` が実行可能な状態では、追加の READ ONLY 検証として実行し、`status === "ASSETS_VERIFIED"`, `downstreamAllowed === true`, `writeCount === 0` を確認する（Verify処理から External Mutation を一切発生させない）。
