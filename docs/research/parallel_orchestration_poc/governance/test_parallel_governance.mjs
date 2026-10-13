/**
 * tests/test_parallel_governance.mjs
 *
 * Unit Test Suite for Parallel Governance Guard and Scope Auditor.
 *
 * Isolated Test Design:
 * - Does NOT modify production worker_registry.json or .agents/.safety-lock.
 * - Uses isolated scratch directory scratch/test_governance_isolated for all test artifacts.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

const rootDir = process.cwd();
const guardScript = path.resolve(rootDir, 'scripts', 'parallel_guard.mjs');
const scopeScript = path.resolve(rootDir, 'scripts', 'check-parallel-scope.mjs');
const isolatedDir = path.resolve(rootDir, 'scratch', 'test_governance_isolated');
const isolatedLock = path.resolve(isolatedDir, '.agents', '.safety-lock');
const isolatedRegistry = path.resolve(isolatedDir, 'scratch', 'parallel_test', 'worker_registry.json');

// Ensure isolated directory exists
if (!fs.existsSync(path.dirname(isolatedLock))) {
  fs.mkdirSync(path.dirname(isolatedLock), { recursive: true });
}
if (!fs.existsSync(path.dirname(isolatedRegistry))) {
  fs.mkdirSync(path.dirname(isolatedRegistry), { recursive: true });
}

function runGuard(payload, targetWorkspace = rootDir) {
  const result = spawnSync('node', [guardScript], {
    input: JSON.stringify({
      workspacePaths: [targetWorkspace],
      ...payload
    }),
    encoding: 'utf8',
    cwd: rootDir
  });
  assert.strictEqual(result.status, 0, `Guard failed to execute: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

console.log('=== [Running Isolated Parallel Governance Unit Tests] ===');

try {
  // Test 1: Subject Identification First (Fail-Closed)
  console.log('Test 1: Unregistered subject is immediately DENIED (Fail-Closed)');
  const t1 = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
    conversationId: 'unregistered-agent-999'
  });
  assert.strictEqual(t1.decision, 'deny');
  assert.ok(t1.reason.includes('Unregistered subject'));
  console.log('  ✔ PASS');

  // Test 2: Emergency Subagent Management (Parent only)
  console.log('Test 2: Emergency kill allowed for parent, denied for worker');
  const t2a = runGuard({
    toolCall: { name: 'manage_subagents', args: { Action: 'kill', ConversationIds: ['worker-1'] } },
    conversationId: 'parent-1234'
  });
  assert.strictEqual(t2a.decision, 'allow');

  const t2b = runGuard({
    toolCall: { name: 'manage_subagents', args: { Action: 'kill', ConversationIds: ['worker-2'] } },
    conversationId: 'unregistered-agent-999'
  });
  assert.strictEqual(t2b.decision, 'deny');
  console.log('  ✔ PASS');

  // Setup mock registry in isolated workspace
  const mockRegistry = {
    parentConversationIds: ['parent-1234'],
    workers: {
      'worker-A': {
        role: 'worker',
        assignedFile: path.resolve(isolatedDir, 'worker_a.txt'),
        allowedTestCommand: 'node verify_a.mjs'
      }
    },
    auditors: {
      'auditor-1': { role: 'Independent Auditor' }
    }
  };
  fs.writeFileSync(isolatedRegistry, JSON.stringify(mockRegistry, null, 2), 'utf8');

  // Test 3: Worker Exclusive File Assignment
  console.log('Test 3: Worker exclusive file assignment (Isolated)');
  const t3a = runGuard({
    toolCall: { name: 'write_to_file', args: { TargetFile: path.resolve(isolatedDir, 'worker_a.txt') } },
    conversationId: 'worker-A'
  }, isolatedDir);
  assert.strictEqual(t3a.decision, 'allow');

  const t3b = runGuard({
    toolCall: { name: 'write_to_file', args: { TargetFile: path.resolve(isolatedDir, 'worker_b.txt') } },
    conversationId: 'worker-A'
  }, isolatedDir);
  assert.strictEqual(t3b.decision, 'deny');
  console.log('  ✔ PASS');

  // Test 4: Worker Fixed Test Command
  console.log('Test 4: Worker fixed test command (Exact match)');
  const t4a = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'node verify_a.mjs' } },
    conversationId: 'worker-A'
  }, isolatedDir);
  assert.strictEqual(t4a.decision, 'allow');

  const t4b = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    conversationId: 'worker-A'
  }, isolatedDir);
  assert.strictEqual(t4b.decision, 'deny');
  console.log('  ✔ PASS');

  // Test 5: Auditor Policy-Level Zero Write & Exact Match Read
  console.log('Test 5: Auditor Policy-Level Zero Write & Exact Match Read');
  const t5a = runGuard({
    toolCall: { name: 'write_to_file', args: { TargetFile: path.resolve(isolatedDir, 'verdict.txt') } },
    conversationId: 'auditor-1'
  }, isolatedDir);
  assert.strictEqual(t5a.decision, 'deny');
  assert.ok(t5a.reason.includes('Policy-Level Zero Write'));

  const t5b = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
    conversationId: 'auditor-1'
  }, isolatedDir);
  assert.strictEqual(t5b.decision, 'allow');

  // Chained command must be denied
  const t5c = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'git status && ls' } },
    conversationId: 'auditor-1'
  }, isolatedDir);
  assert.strictEqual(t5c.decision, 'deny');
  assert.ok(t5c.reason.includes('chaining'));
  console.log('  ✔ PASS');

  // Test 6: Safety Lock Exact Match Read & Recovery Rejection
  console.log('Test 6: Safety lock enforcement, exact read, and recovery strictness');
  fs.writeFileSync(isolatedLock, 'LOCKED', 'utf8');

  // 6a: Read-only exact match under lock
  const t6a = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'git diff' } },
    conversationId: 'parent-1234'
  }, isolatedDir);
  assert.strictEqual(t6a.decision, 'allow');

  // 6b: Chained or unapproved command under lock is DENIED
  const t6b = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    conversationId: 'parent-1234'
  }, isolatedDir);
  assert.strictEqual(t6b.decision, 'deny');

  // 6c: Strict recovery command prompts force_ask
  const t6c = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: `mv -n ${isolatedLock} ${isolatedLock}.evidence-test` } },
    conversationId: 'parent-1234'
  }, isolatedDir);
  assert.strictEqual(t6c.decision, 'force_ask');

  // 6d: Overwrite attempt (destination exists) is DENIED
  fs.writeFileSync(`${isolatedLock}.evidence-test`, 'EXISTING_EVIDENCE', 'utf8');
  const t6d = runGuard({
    toolCall: { name: 'run_command', args: { CommandLine: `mv -n ${isolatedLock} ${isolatedLock}.evidence-test` } },
    conversationId: 'parent-1234'
  }, isolatedDir);
  assert.strictEqual(t6d.decision, 'deny');
  assert.ok(t6d.reason.includes('already exists'));
  console.log('  ✔ PASS');

  // Test 7: Scope Auditor --check-only does NOT create safety lock on failure
  console.log('Test 7: check-parallel-scope.mjs --check-only is strictly non-writing');
  const realLock = path.resolve(rootDir, '.agents', '.safety-lock');
  assert.strictEqual(fs.existsSync(realLock), false, 'Real lock must not exist before test');

  // Run --check-only on repository containing fault injection file
  const checkOnlyRes = spawnSync('node', [scopeScript, '--check-only'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  // Must exit with code 1 due to preserved fault injection file
  assert.strictEqual(checkOnlyRes.status, 1, 'Check-only must fail when fault injection file exists');
  assert.ok(checkOnlyRes.stderr.includes('CHECK-ONLY AUDIT FAILED'));
  assert.strictEqual(fs.existsSync(realLock), false, 'Check-only MUST NOT create .safety-lock');
  console.log('  ✔ PASS');

} finally {
  // Clean up isolated directory
  if (fs.existsSync(isolatedDir)) {
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
}

console.log('🟢 All 7 Parallel Governance Unit Tests PASSED cleanly in isolation!');
