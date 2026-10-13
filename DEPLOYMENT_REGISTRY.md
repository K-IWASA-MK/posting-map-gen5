# POSTING MAP Deployment Registry
Version: 1.1
Status: SSOT

## Fundamental Rule

**Production の Web App URL はシステム資産である。**

更新対象は URL ではなく、Deployment のコードのみとする。
URL を変更してはならない。

---

## Purpose

本番環境の Script ID・Deployment ID・Web App URL を一元管理する。
本ファイルを唯一の正しい情報源（SSOT）として参照すること。

---

## Environment List

| Environment | Status | Script ID | Deployment ID | Web App URL | Notes |
|---|---|---|---|---|---|
| UNIVERSAL_BASE | Production Active | `1qDMhog2befTWrq_5Sct3N28712wdh-f72VYLBA_bqNSuvUNHTaoeXTac` | `AKfycbyjeoNc8CeTT6AyNdTSBTqLFGHs23vUaQiavSlsPKjVmMBZ5hE_KlJqN8RI12cgb7S-` | https://script.google.com/macros/s/AKfycbyjeoNc8CeTT6AyNdTSBTqLFGHs23vUaQiavSlsPKjVmMBZ5hE_KlJqN8RI12cgb7S-/exec | Universal Engine Standalone Production Deployment (SSOT) |

---

## District Spreadsheet Registry

| District | Role | Spreadsheet ID | Spreadsheet Name | Status |
|---|---|---|---|---|
| KUWANA | 本番稼働DB | `18_f0ijZBPJBICK-YhG1F5D5Xiswjm4L0-bTOkU4_Hp4` | `KUWANA` | 本番稼働中 (ACTIVE) |

---

## Master Database Template Registry (SSOT)

| Template Name | Role | Spreadsheet ID | Target Folder | Status |
|---|---|---|---|---|
| `POSTING_MAP_EMPTY_TEMPLATE` | 公式空データベースマスター（全原本0件・7シート構成） | `1_fvgpNsK2fmz6hYgraDUnvyn69JnphmbgnXcOvzLYeY` | `01_MASTER/Templates` (`1Zt-AC153J0ByAwP9TkaUjimsgGVwDImF`) | 公式マスター自動配備完了 |

---

## Standard Deployment Procedure (SOP)

「知っている」ではなく「手順通り実行する」こと。

1. Script ID を確認
2. `clasp login` 状態を確認
3. `clasp status`
4. `clasp push`
5. `clasp deploy -i <Deployment ID>`
6. Web App の動作確認
7. TraceLog / API の動作確認
8. 完了報告（指定テンプレートを使用）

---

## Emergency Prohibitions

以下を禁止する。

- Deployment ID を新規作成しない（`clasp deploy` のみの実行禁止）
- Web App URL を変更しない
- `config.js` を変更しない
- Script ID を変更しない
- CEO承認なしに Production を変更しない

---

## Deployment Report Template

デプロイ完了後、必ず以下のフォーマットを用いて完了報告を行うこと。

```text
## Deployment Report

Environment:
[環境名]

Script ID:
[確認済み]

Deployment ID:
[確認済み]

Push:
✅

Deploy:
✅

URL変更:
なし

config.js変更:
なし

実機確認:
☐ 未実施
☑ 実施

TraceLog:
☐ 未確認
☑ 停止確認

CEO確認:
☐ 未
☑ 完了
```
