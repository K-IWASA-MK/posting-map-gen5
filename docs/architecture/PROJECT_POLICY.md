# Project Policy

## Project Purpose
- POSTING MAP Version 1.0 を完成させること
- POSTING MAP は独立製品リポジトリとして運用すること
- 外部連携は必要時に個別検討すること

## Mandatory Workflow
すべての実装開始前に以下を必須とします。

1. **Read** `POSTING_MAP_FULL_AUDIT_REPORT.md` (Master Audit Document)
2. Identify current implementation scope.
3. Verify current priority.
4. Implement only inside current scope.
5. Never implement features outside Version 1.0.

## Development Priority

**P0: Working Product**
・Hアプリ
・GAS
・Spreadsheet
・Dashboard
・Mock撤去

**P1: Asset Cleanup**
・legacy
・dead code
・duplicate directories

**P2: Refactoring**
・God Class
・API整理
・Module化

**P3: Platform Extensions（将来検討）**
・Monitoring 強化
・Event Ledger
・外部サービス連携
*Only when actually required.*

## Governance Rules
- Implement only current priority.
- Never skip priorities.
- Never redesign architecture unless requested.
- 外部ランタイムはVersion1.0完成後に必要性を個別評価する。
- POSTING MAP is always the primary product.

## Constitution
- Project Policy governs implementation.
- Audit governs priorities.
- POSTING MAP は独立した製品である。
- 外部連携は製品の補助として位置づける。
