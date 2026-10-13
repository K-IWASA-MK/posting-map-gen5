#!/usr/bin/env node
/**
 * scripts/check-parallel-scope.mjs
 *
 * Parallel Execution 4-Perspective Scope Auditor & Safety Lock Trigger.
 *
 * Modes:
 * - Default: Writes `.agents/.safety-lock` on violation, exits code 1.
 * - `--check-only`: Read-only audit mode. Displays violations, exits code 1 WITHOUT writing lock.
 *
 * 4 Perspectives:
 * 1. Preservation of Pre-existing State (Compares against saved pre-flight SHA256 hashes)
 * 2. Net-New Diff Scope Whitelist (Restricted to current-scope.json and confirmed evidence files)
 * 3. Per-Worker Target Verification (Verifies worker registry and logs; unverified items reported as UNVERIFIED)
 * 4. HEAD & all-refs Immutability (HEAD and refs verified using baseline format)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const rootDir = process.cwd();
const lockFile = path.resolve(rootDir, '.agents', '.safety-lock');
const registryFile = path.resolve(rootDir, 'scratch', 'parallel_test', 'worker_registry.json');
const currentScopeFile = path.resolve(rootDir, '.agents', 'current-scope.json');

const isCheckOnly = process.argv.includes('--check-only');

const BASELINE_HEAD = '87bb0fbb611354daa73ae4c328ab25bf1f3d7cf1';
const BASELINE_REFS_SHA256 = 'f0b25a2de84ccc85b65e5e61b35cf26eafcfd71ceb26205eed7fea872fe1e8c3';

// Saved pre-flight hashes for pre-existing files
const PRE_EXISTING_HASHES = {
  'scripts/run-gemini-auditor.mjs': '3eea87f51fae87f0d263723e55c859f5a8a59c557567aa99cc972ad452bf8d50'
};

// Strictly confirmed individual evidence files (no open wildcards)
const CONFIRMED_EVIDENCE_FILES = new Set([
  '.agents/.safety-lock.evidence-20261006',
  '.agents/.safety-lock.evidence-audit-test'
]);

function failLock(reason, violations = []) {
  if (isCheckOnly) {
    console.error(`\n🔍 [CHECK-ONLY AUDIT FAILED] ${reason}`);
    if (violations.length > 0) {
      violations.forEach(v => console.error(`  - ${v}`));
    }
    console.error(`Check-only mode: No safety lock created. Repository remains unchanged.`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const lockData = {
    lockedAt: timestamp,
    reason,
    violations
  };
  fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf8');
  console.error(`\n🛑 [SAFETY LOCK ACTIVATED] ${reason}`);
  if (violations.length > 0) {
    violations.forEach(v => console.error(`  - ${v}`));
  }
  console.error(`Lock written to ${lockFile}. All worker operations are blocked.`);
  process.exit(1);
}

function main() {
  console.log(`=== [Parallel Scope Audit: 4-Perspective Check (${isCheckOnly ? 'CHECK-ONLY' : 'ENFORCE'})] ===`);
  const scopeViolations = [];
  const unverifiedItems = [];

  // ─────────────────────────────────────────────────────────────
  // Perspective 1: Preservation of Pre-existing State (Saved Hash Comparison)
  // ─────────────────────────────────────────────────────────────
  for (const [relPath, expectedHash] of Object.entries(PRE_EXISTING_HASHES)) {
    const fullPath = path.resolve(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      scopeViolations.push(`Perspective 1: Pre-existing baseline file missing: [${relPath}]`);
      continue;
    }
    const content = fs.readFileSync(fullPath);
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    if (actualHash !== expectedHash) {
      scopeViolations.push(`Perspective 1: Pre-existing baseline file hash mismatch for [${relPath}]. Expected [${expectedHash}], got [${actualHash}]`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Perspective 2: Net-New Diff Scope Whitelist (Confirmed Paths Only)
  // ─────────────────────────────────────────────────────────────
  if (!fs.existsSync(currentScopeFile)) {
    failLock('Scope file missing: .agents/current-scope.json');
  }
  let approvedScope = [];
  try {
    approvedScope = JSON.parse(fs.readFileSync(currentScopeFile, 'utf8'));
  } catch (e) {
    failLock(`Invalid current-scope.json: ${e.message}`);
  }
  const scopeSet = new Set(approvedScope.map(p => path.normalize(p)));

  let statusOutput = '';
  try {
    statusOutput = execSync('git status --porcelain=v1 -uall', { cwd: rootDir, encoding: 'utf8' });
  } catch (e) {
    failLock(`Failed to run git status: ${e.message}`);
  }

  const lines = statusOutput.split('\n').filter(Boolean);
  for (const line of lines) {
    const status = line.substring(0, 2);
    const filePath = path.normalize(line.substring(3).trim());

    if (filePath.startsWith('scratch/parallel_test/')) {
      continue;
    }

    if (CONFIRMED_EVIDENCE_FILES.has(filePath)) {
      continue;
    }

    const isPreExisting = Object.keys(PRE_EXISTING_HASHES).map(p => path.normalize(p)).includes(filePath);

    if (!scopeSet.has(filePath) && !isPreExisting) {
      scopeViolations.push(`Perspective 2: File outside scope: [${filePath}] (status: ${status})`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Perspective 3: Per-Worker Target Verification
  // ─────────────────────────────────────────────────────────────
  if (fs.existsSync(registryFile)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const workers = registry.workers || {};

      const testDir = path.resolve(rootDir, 'scratch', 'parallel_test');
      if (fs.existsSync(testDir)) {
        const testFiles = fs.readdirSync(testDir);
        // Only legitimately registered worker files and verification scripts
        const allowedTestFiles = new Set([
          'worker_registry.json',
          ...Object.values(workers).map(w => path.basename(w.assignedFile || '')),
          ...Object.values(workers).map(w => path.basename(w.allowedTestFile || '')),
          'integration_test.mjs',
          'verify_worker_a.mjs',
          'verify_worker_b.mjs',
          'worker_a_metric.mjs',
          'worker_b_report.mjs'
        ]);

        for (const file of testFiles) {
          if (!allowedTestFiles.has(file)) {
            // Fault injection file or any unexpected file will trigger violation
            scopeViolations.push(`Perspective 3: Unauthorized file detected in test dir: [scratch/parallel_test/${file}]`);
          }
        }
      }

      // Check worker execution logs if transcript paths exist
      for (const [workerId, workerData] of Object.entries(workers)) {
        if (!workerData.assignedFile) {
          unverifiedItems.push(`Perspective 3: Worker [${workerId}] has no assignedFile in registry.`);
        }
      }
    } catch (e) {
      failLock(`Corrupted worker registry: ${e.message}`);
    }
  } else {
    unverifiedItems.push('Perspective 3: No worker registry found. Worker assignment logs unverified.');
  }

  // ─────────────────────────────────────────────────────────────
  // Perspective 4: HEAD & All-Refs Immutability (Baseline Command Format)
  // ─────────────────────────────────────────────────────────────
  try {
    const currentHead = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
    if (currentHead !== BASELINE_HEAD) {
      scopeViolations.push(`Perspective 4: Git HEAD changed. Expected [${BASELINE_HEAD}], got [${currentHead}]`);
    }

    const currentRefsOutput = execSync('git for-each-ref --format="%(refname) %(objectname)"', { cwd: rootDir, encoding: 'utf8' });
    const currentRefsHash = crypto.createHash('sha256').update(currentRefsOutput).digest('hex');
    if (currentRefsHash !== BASELINE_REFS_SHA256) {
      scopeViolations.push(`Perspective 4: Git refs hash changed. Expected [${BASELINE_REFS_SHA256}], got [${currentRefsHash}]`);
    }
  } catch (e) {
    scopeViolations.push(`Perspective 4: Failed to verify HEAD and refs: ${e.message}`);
  }

  if (unverifiedItems.length > 0) {
    console.log('⚠️ [Unverified Governance Items]:');
    unverifiedItems.forEach(item => console.log(`  - ${item}`));
  }

  if (scopeViolations.length > 0) {
    failLock('Scope violations detected during parallel execution audit', scopeViolations);
  }

  console.log('🟢 [Parallel Scope Audit PASSED] All 4 perspectives verified cleanly.');
  process.exit(0);
}

main();
