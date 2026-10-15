import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, normalize } from 'path';

const rootDir = process.cwd();

function exitFail(message) {
  console.error(`\n🛑 [Hard Stop] Scope Guard Failed: ${message}`);
  process.exit(1);
}

/**
 * Parse .agents/current-scope.json supporting both:
 * - Canonical structured object: { mission: string, files: string[] }
 * - Legacy backward-compatible array: string[]
 */
function parseScopePayload(rawText, label = 'current-scope.json') {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    exitFail(`Invalid JSON in ${label}: ${e.message}`);
  }

  let format = null;
  let mission = null;
  let files = null;

  if (Array.isArray(parsed)) {
    format = 'legacy-array';
    files = parsed;
  } else if (typeof parsed === 'object' && parsed !== null) {
    if (typeof parsed.mission !== 'string' || !parsed.mission.trim()) {
      exitFail(`${label} structured object must contain a non-empty string "mission".`);
    }
    if (!Array.isArray(parsed.files)) {
      exitFail(`${label} structured object must contain an array "files".`);
    }
    format = 'structured-object';
    mission = parsed.mission.trim();
    files = parsed.files;
  } else {
    exitFail(`${label} must be a structured object { mission, files } or a legacy string[] array.`);
  }

  for (const item of files) {
    if (typeof item !== 'string' || !item.trim()) {
      exitFail(`${label} files list must contain only non-empty strings.`);
    }
    if (item.trim().startsWith('@mission:')) {
      exitFail(`${label} contains prohibited pseudo-path "${item}". Use structured object { mission, files }.`);
    }
  }

  return { format, mission, files };
}

function isPureSchemaMigration(priorPayload, nextPayload) {
  if (!priorPayload || !nextPayload) return false;
  if (priorPayload.format !== 'legacy-array' || nextPayload.format !== 'structured-object') {
    return false;
  }
  const priorSet = new Set(priorPayload.files.map(p => normalize(p)));
  const nextSet = new Set(nextPayload.files.map(p => normalize(p)));
  if (priorSet.size !== nextSet.size) return false;
  for (const f of priorSet) {
    if (!nextSet.has(f)) return false;
  }
  return true;
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
  const workingScopeText = readFileSync(resolve(rootDir, scopeFilePath), 'utf8');
  parseScopePayload(workingScopeText, 'Working Tree current-scope.json');
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
        let migrationAllowed = false;
        try {
          const parentScopeRaw = execSync(`git show "${commitHash}~1":.agents/current-scope.json`, { cwd: rootDir }).toString('utf8');
          const curScopeRaw = execSync(`git show "${commitHash}":.agents/current-scope.json`, { cwd: rootDir }).toString('utf8');
          const parentScope = parseScopePayload(parentScopeRaw, `${commitHash.substring(0, 7)}~1:current-scope.json`);
          const curScope = parseScopePayload(curScopeRaw, `${commitHash.substring(0, 7)}:current-scope.json`);
          migrationAllowed = isPureSchemaMigration(parentScope, curScope);
        } catch (_) {
          migrationAllowed = false;
        }
        if (!migrationAllowed) {
          exitFail(`Unauthorized Scope Tampering in commit ${commitHash.substring(0, 7)}: .agents/current-scope.json cannot be modified alongside code changes in the same commit. Use 2-phase scope commit.`);
        }
      }
    }
  } catch (e) {
    exitFail(`Failed to verify commit history for range ${baseCommit}..${targetCommit}: ${e.message}`);
  }

  // targetCommit 上の current-scope.json を読み込み
  try {
    const targetScopeJson = execSync(`git show "${targetCommit}":.agents/current-scope.json`, { cwd: rootDir }).toString('utf8');
    const parsedTargetScope = parseScopePayload(targetScopeJson, `current-scope.json at ${targetCommit}`);
    allowedScope = parsedTargetScope.files;
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
  // Git HEAD 上の current-scope.json を読み込み、実装変更がすべてその範囲内か検証
  let headScopePayload;
  try {
    const headScopeJson = execSync('git show HEAD:.agents/current-scope.json', { cwd: rootDir }).toString('utf8');
    headScopePayload = parseScopePayload(headScopeJson, 'Git HEAD current-scope.json');
    allowedScope = headScopePayload.files;
  } catch (e) {
    exitFail(`Failed to load approved Scope from Git HEAD: ${e.message}`);
  }

  // Working Tree モード: コード変更と同時に Scope 定義を変更することは禁止 (自己承認の遮断)
  if (hasScopeJsonChanged) {
    let migrationAllowed = false;
    try {
      const workingScopeRaw = readFileSync(resolve(rootDir, scopeFilePath), 'utf8');
      const workingScopePayload = parseScopePayload(workingScopeRaw, 'Working Tree current-scope.json');
      migrationAllowed = isPureSchemaMigration(headScopePayload, workingScopePayload);
    } catch (_) {
      migrationAllowed = false;
    }
    if (!migrationAllowed) {
      exitFail('Unauthorized Scope Tampering: .agents/current-scope.json cannot be modified alongside code changes. Use 2-phase scope commit.');
    }
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
  normalize('scripts/check-entrance-gate.mjs'),
  normalize('scripts/check-auditor-gate.mjs'),
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

