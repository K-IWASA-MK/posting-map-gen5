---
name: knowledge-governance
description: AI社員知識ガバナンス規範。1-in-1-out 原則、Source Digest 知識鮮度同期、Universal 就業規則統制。
---

# Knowledge Governance Capability Pack

## 1. 概要と適用責務
本 Pack は、リポジトリ内の AI 社員基盤（`.agents/**`、`docs/`、`AGENTS.md`）において、陳腐化した知識、重複ルール、孤立スキル、ゾンビ設計を完全排除し、常に最新の正本仕様と一致させるための知識統制規格である。

## 2. 正本仕様依存 (Canonical Sources)
- [docs/ai-foundation.md](../../../docs/ai-foundation.md): AI社員基盤・正本仕様書 (Canonical SSOT)
- [AGENTS.md](../../../AGENTS.md): 最上位基本就業規則

## 3. 遵守すべき絶対規範
1. **1-in-1-out 原則とゾンビ知識の即時抹消**:
   - 新しいスキルやルールを導入した場合、重複または置き換えられた旧資産は「念のため」と残さず、必ず同一移行サイクル内で物理削除する。
   - `archive/`, `legacy/`, `reference/` ディレクトリの作成・残存を禁止する（Current Tree is Truth）。
2. **Knowledge Freshness（知識鮮度）の機械同期**:
   - 正本ファイル（Canonical Sources）が変更された場合、対応する Capability Pack の Digest を `.agents/os-registry.json` 内で必ず同期・再計算する。
   - 正本が更新されたにもかかわらず Digest が未更新の場合、K1 Gate は Fail-Closed 停止する。
3. **Stage 1 Knowledge Impact Analysis**:
   - コードまたは設計仕様の変更を計画する際、波及する Capability Pack を特定し、計画書内に更新手順を明記しなければならない。
