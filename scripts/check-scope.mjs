import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, normalize } from 'path';

const rootDir = process.cwd();

function exitFail(message) {
  console.error(`\n🛑 [Hard Stop] Scope Guard Failed: ${message}`);
  process.exit(1);
}

// 1. Parse arguments (--scope-only or --base <BASE> --target <TARGET>)
const args = process.argv.slice(2);
const isScopeOnlyMode = args.includes('--scope-only');
let baseCommit = null;
let targetCommit = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base' && args[i + 1]) {
    baseCommit = args[++i];
  } else if (args[i] === '--target' && args[i + 1]) {
    targetCommit = args[++i];
  }
}
const isCommitRangeMode = !!(baseCommit && targetCommit);

const changedFiles = [];

if (isCommitRangeMode) {
  console.log(`[Scope Guard] Checking commit range ${baseCommit}..${targetCommit}...`);
  try {
    const diffOutput = execSync(`git diff --name-only "${baseCommit}".."${targetCommit}"`, { cwd: rootDir }).toString('utf8');
    diffOutput.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => changedFiles.push(normalize(f)));
  } catch (e) {
    exitFail(`Failed to execute git diff for range ${baseCommit}..${targetCommit}: ${e.message}`);
  }
} else {
  // Fetch Git Changed Files via `git status --porcelain=v1 -z` (Default Working Tree Mode)
  let gitStatusOutput;
  try {
    gitStatusOutput = execSync('git status --porcelain=v1 -z', { cwd: rootDir });
  } catch (e) {
    exitFail(`Failed to execute git status: ${e.message}`);
  }

  const tokens = gitStatusOutput.toString('utf8').split('\0').filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const status = token.substring(0, 2);
    const filePath = normalize(token.substring(3).trim());

    changedFiles.push(filePath);

    // If status is rename/copy, next token is original path
    if (status.includes('R') || status.includes('C')) {
      i++;
    }
  }
}

console.log(`[Scope Guard] Checking ${changedFiles.length} changed file(s)...`);

const scopeFilePath = normalize('.agents/current-scope.json');
const hasScopeJsonChanged = changedFiles.includes(scopeFilePath);

// ─────────────────────────────────────────────────────────────
// 【モード 1: Scope 更新専用検証モード (--scope-only)】
// ─────────────────────────────────────────────────────────────
if (isScopeOnlyMode) {
  const nonScopeFiles = changedFiles.filter(f => f !== scopeFilePath);
  if (nonScopeFiles.length > 0) {
    exitFail(`Scope Transaction Violation: Code changes detected during scope-only update: ${nonScopeFiles.join(', ')}`);
  }
  if (!hasScopeJsonChanged) {
    exitFail('Scope Transaction Warning: No changes detected in .agents/current-scope.json.');
  }
  console.log('🟢 [Scope-Only Mode] PASSED: Scope definition update isolated with zero code changes.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// 【モード 2: 実装コミット検証モード (デフォルト)】
// ─────────────────────────────────────────────────────────────

// [防衛 1 & 2] Scope 境界および改ざん検証
let allowedScope = [];

if (isCommitRangeMode) {
  // コミット範囲モード: 各コミットで scope.json と他ファイルの同一コミット混在がないか検証
  try {
    const commitListOutput = execSync(`git rev-list "${baseCommit}".."${targetCommit}"`, { cwd: rootDir }).toString('utf8').trim();
    const commits = commitListOutput.split('\n').map(c => c.trim()).filter(Boolean);
    for (const commitHash of commits) {
      const commitFiles = execSync(`git diff-tree --no-commit-id --name-only -r "${commitHash}"`, { cwd: rootDir })
        .toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => normalize(l));
      const commitHasScope = commitFiles.includes(scopeFilePath);
      const commitHasOther = commitFiles.some(f => f !== scopeFilePath);
      if (commitHasScope && commitHasOther) {
        exitFail(`Unauthorized Scope Tampering in commit ${commitHash.substring(0, 7)}: .agents/current-scope.json cannot be modified alongside code changes in the same commit. Use 2-phase scope commit.`);
      }
    }
  } catch (e) {
    exitFail(`Failed to verify commit history for range ${baseCommit}..${targetCommit}: ${e.message}`);
  }

  // targetCommit 上の current-scope.json を読み込み
  try {
    const targetScopeJson = execSync(`git show "${targetCommit}":.agents/current-scope.json`, { cwd: rootDir }).toString('utf8');
    allowedScope = JSON.parse(targetScopeJson);
    if (!Array.isArray(allowedScope)) {
      exitFail(`current-scope.json at ${targetCommit} must be an array.`);
    }
  } catch (e) {
    exitFail(`Failed to load approved Scope from ${targetCommit}: ${e.message}`);
  }

  const normalizedAllowed = new Set(allowedScope.map(p => normalize(p)));
  const violations = changedFiles.filter(f => f !== scopeFilePath && !normalizedAllowed.has(f));

  if (violations.length > 0) {
    console.error('❌ Scope Violations Detected in commit range:');
    violations.forEach(f => console.error(`  - ${f}`));
    exitFail(`${violations.length} file(s) outside allowed scope in range ${baseCommit}..${targetCommit}.`);
  }
} else {
  // Working Tree モード: コード変更と同時に Scope 定義を変更することは禁止 (自己承認の遮断)
  if (hasScopeJsonChanged) {
    exitFail('Unauthorized Scope Tampering: .agents/current-scope.json cannot be modified alongside code changes. Use 2-phase scope commit.');
  }

  // Git HEAD 上の current-scope.json を読み込み、実装変更がすべてその範囲内か検証
  try {
    const headScopeJson = execSync('git show HEAD:.agents/current-scope.json', { cwd: rootDir }).toString('utf8');
    allowedScope = JSON.parse(headScopeJson);
    if (!Array.isArray(allowedScope)) {
      exitFail('Git HEAD current-scope.json must be an array.');
    }
  } catch (e) {
    exitFail(`Failed to load approved Scope from Git HEAD: ${e.message}`);
  }

  const normalizedAllowed = new Set(allowedScope.map(p => normalize(p)));
  const violations = changedFiles.filter(f => !normalizedAllowed.has(f));

  if (violations.length > 0) {
    console.error('❌ Scope Violations Detected:');
    violations.forEach(f => console.error(`  - ${f}`));
    exitFail(`${violations.length} file(s) outside allowed Git-HEAD scope.`);
  }
}

console.log('🟢 Scope Validation PASSED: All code changes are within the approved scope.');

// [防衛 3] Governance & Protected Test Separation Control (改ざん耐性)
const governanceFiles = new Set([
  normalize('scripts/check-scope.mjs'),
  normalize('scripts/check-architecture-gate.mjs'),
  normalize('scripts/check-knowledge-gate.mjs'),
  normalize('.agents/os-registry.schema.json'),
  normalize('package.json'),
  normalize('AGENTS.md'),
  normalize('docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md'),
  normalize('tests/test_registry_provisioning_gate.mjs'),
  normalize('tests/test_sec001_dashboard_auth_fix.mjs')
]);

const hasGovernanceChanges = changedFiles.some(f => governanceFiles.has(f));
const hasProductCodeChanges = changedFiles.some(f => f.startsWith(normalize('active/')));

if (hasGovernanceChanges && hasProductCodeChanges) {
  exitFail('Governance Separation Violation: Cannot modify Architecture Governance/Protected Test Files and active/** in the same transaction.');
}

// ─────────────────────────────────────────────────────────────
// 【モード 3: Architecture Guard (実装コミット時のみ実行)】
// ─────────────────────────────────────────────────────────────
console.log('\n[Architecture Guard] Executing Mechanical Architecture Guard...');
try {
  execFileSync(
    process.execPath,
    [resolve(rootDir, 'scripts/check-architecture-gate.mjs')],
    { cwd: rootDir, stdio: 'inherit' }
  );
} catch (e) {
  exitFail('Architecture Guard Failed. See details above.');
}

// ─────────────────────────────────────────────────────────────
// 【モード 4: K1 Knowledge Sync Gate (実装コミット時のみ実行)】
// ─────────────────────────────────────────────────────────────
const knowledgeGateScript = resolve(rootDir, 'scripts/check-knowledge-gate.mjs');
const registryFile = resolve(rootDir, '.agents/os-registry.json');

if (existsSync(knowledgeGateScript) && existsSync(registryFile)) {
  console.log('\n[Knowledge Gate] Executing K1 Knowledge Sync Gate...');
  try {
    execFileSync(
      process.execPath,
      [knowledgeGateScript],
      { cwd: rootDir, stdio: 'inherit' }
    );
  } catch (e) {
    exitFail('K1 Knowledge Sync Gate Failed. See details above.');
  }
}

// 5. Scope Guard Complete
console.log('\n✅ [Scope Guard Complete] Scope Validation Succeeded.');
process.exit(0);

