#!/usr/bin/env node
/**
 * scripts/parallel_guard.mjs
 *
 * Antigravity 2.0 PreToolUse Hook Guard for Parallel Worker Execution & Governance.
 *
 * Contract:
 * - Input: JSON on stdin (camelCase: toolCall, conversationId, transcriptPath, workspacePaths, etc.)
 * - Output: JSON on stdout ({"decision": "allow" | "deny" | "force_ask", "reason": "..."})
 * - Guard Responsibilities:
 *   1. Subject Identification FIRST (Fail-Closed for unregistered subjects).
 *   2. Emergency Kill Control (Parent only, kill/kill_all only).
 *   3. Safety Lock Check: Strict exact-match read-only audit allowed, force_ask for strict recovery.
 *   4. Re-delegation Prevention: Block invoke_subagent / define_subagent for workers.
 *   5. Exclusive File Assignment: Restrict worker file write/edit to assignedFile only.
 *   6. Fixed Test Command Execution: Restrict worker run_command to allowedTestCommand only.
 *   7. Independent Auditor: Policy-Level Zero Write & exact-match allowlist.
 */

import fs from 'fs';
import path from 'path';

const REGISTERED_PARENT_IDS = new Set([
  '2850e7b0-72a4-4a90-b5cb-d76ca42938c7',
  'eeba298e-dcf6-403d-b7e6-21e844321376',
  'parent-1234'
]);

// Exact-match read-only audit commands (no chaining, no redirects, no added arguments)
const ALLOWED_EXACT_READ_COMMANDS = new Set([
  'git status',
  'git status --porcelain=v1 -uall',
  'git diff',
  'git diff --check',
  'git diff --stat',
  'git rev-parse HEAD',
  'git for-each-ref --format="%(refname) %(objectname)"',
  'git for-each-ref',
  'node scripts/check-parallel-scope.mjs --check-only'
]);

function main() {
  let rawInput = '';
  try {
    rawInput = fs.readFileSync(0, 'utf8');
  } catch (err) {
    console.log(JSON.stringify({
      decision: 'deny',
      reason: `🛑 [GUARD CRITICAL] Failed to read stdin: ${err.message}`
    }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch (err) {
    console.log(JSON.stringify({
      decision: 'deny',
      reason: `🛑 [GUARD CRITICAL] Invalid JSON payload on stdin: ${err.message}`
    }));
    return;
  }

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || '';
  const toolArgs = toolCall.args || {};
  const conversationId = payload.conversationId || '';
  const transcriptPath = payload.transcriptPath || '';

  // Determine repository root
  let rootDir = process.cwd();
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    rootDir = payload.workspacePaths[0];
  } else if (rootDir.endsWith('.agents')) {
    rootDir = path.resolve(rootDir, '..');
  }

  const lockFile = path.resolve(rootDir, '.agents', '.safety-lock');
  const registryFile = path.resolve(rootDir, 'scratch', 'parallel_test', 'worker_registry.json');

  // Load Registry
  let registry = { parentConversationIds: Array.from(REGISTERED_PARENT_IDS), workers: {}, auditors: {} };
  if (fs.existsSync(registryFile)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    } catch (e) {
      // corrupt registry
    }
  }

  // Auto-detect and register worker from transcript prompt if not already registered
  if (conversationId && !REGISTERED_PARENT_IDS.has(conversationId) && (!registry.workers || !registry.workers[conversationId])) {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      try {
        const firstLine = fs.readFileSync(transcriptPath, 'utf8').split('\n')[0];
        const matchFile = firstLine.match(/\[ASSIGNED_FILE:\s*([^\]]+)\]/);
        const matchTest = firstLine.match(/\[ALLOWED_TEST:\s*([^\]]+)\]/);
        const matchRole = firstLine.match(/\[ROLE:\s*([^\]]+)\]/);

        if (matchFile) {
          if (!registry.workers) registry.workers = {};
          registry.workers[conversationId] = {
            role: matchRole ? matchRole[1].trim() : 'worker',
            assignedFile: path.resolve(rootDir, matchFile[1].trim()),
            allowedTestCommand: matchTest ? matchTest[1].trim() : ''
          };
          const regDir = path.dirname(registryFile);
          if (!fs.existsSync(regDir)) fs.mkdirSync(regDir, { recursive: true });
          fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf8');
        }
      } catch (err) {
        // ignore transcript read error
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Subject Identification FIRST (Fail-Closed)
  // ─────────────────────────────────────────────────────────────
  const isParent = REGISTERED_PARENT_IDS.has(conversationId) ||
                   (registry.parentConversationIds && registry.parentConversationIds.includes(conversationId)) ||
                   (registry.parentConversationId === conversationId);

  const isWorker = registry.workers && !!registry.workers[conversationId];

  const isAuditor = (registry.auditors && !!registry.auditors[conversationId]) ||
                    (payload.role === 'Independent Auditor' && conversationId.startsWith('auditor-')) ||
                    (conversationId.startsWith('auditor-'));

  if (!isParent && !isWorker && !isAuditor) {
    console.log(JSON.stringify({
      decision: 'deny',
      reason: `🛑 [GUARD VIOLATION] Unregistered subject [${conversationId || 'empty'}]. Not authorized to perform [${toolName}].`
    }));
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Emergency Subagent Management (Parent Only)
  // ─────────────────────────────────────────────────────────────
  if (toolName === 'manage_subagents') {
    if (!isParent) {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: `🛑 [GUARD VIOLATION] Subject [${conversationId}] is not authorized to manage subagents.`
      }));
      return;
    }
    const action = toolArgs.Action || '';
    if (action === 'kill' || action === 'kill_all') {
      console.log(JSON.stringify({
        decision: 'allow',
        reason: 'Registered parent emergency subagent kill permitted.'
      }));
      return;
    }
    console.log(JSON.stringify({
      decision: 'deny',
      reason: `🛑 [GUARD] Parent manage_subagents action [${action}] is not permitted under emergency guard.`
    }));
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Safety Lock Check (.agents/.safety-lock)
  // ─────────────────────────────────────────────────────────────
  if (fs.existsSync(lockFile)) {
    // 3.1 Allow safe read-only audit commands (Exact match only)
    if (toolName === 'run_command') {
      const commandLine = (toolArgs.CommandLine || '').trim();

      // Check working directory
      if (toolArgs.Cwd && path.resolve(toolArgs.Cwd) !== path.resolve(rootDir)) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD] Working directory [${toolArgs.Cwd}] outside root directory during safety lock.`
        }));
        return;
      }

      // Block chaining, redirection, or background execution
      if (/(&&|;|\|\||\||>|<|>>|&|`|\$\()/.test(commandLine)) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD] Shell chaining, redirection, or subshell not permitted in audit commands: [${commandLine}]`
        }));
        return;
      }

      if (ALLOWED_EXACT_READ_COMMANDS.has(commandLine)) {
        console.log(JSON.stringify({
          decision: 'allow',
          reason: `Safe read-only audit command [${commandLine}] allowed during safety lock.`
        }));
        return;
      }

      // 3.2 Recovery Command Evaluation (Registered Parent Only)
      if (isParent) {
        // Strict recovery command pattern: mv [-n] <rootDir>/.agents/.safety-lock <rootDir>/.agents/.safety-lock.evidence-<timestamp>
        const mvMatch = commandLine.match(/^mv(?:\s+-n)?\s+(\S+)\s+(\S+)$/);
        if (mvMatch) {
          const srcPath = path.resolve(rootDir, mvMatch[1]);
          const destPath = path.resolve(rootDir, mvMatch[2]);
          const expectedSrc = path.resolve(rootDir, '.agents', '.safety-lock');
          const destBase = path.basename(destPath);

          if (srcPath === expectedSrc && destBase.startsWith('.safety-lock.evidence-')) {
            // Check overwrite prevention: destination MUST NOT exist
            if (fs.existsSync(destPath)) {
              console.log(JSON.stringify({
                decision: 'deny',
                reason: `🛑 [GUARD CRITICAL] Recovery target evidence file already exists [${destPath}]. Overwriting evidence is strictly forbidden.`
              }));
              return;
            }

            console.log(JSON.stringify({
              decision: 'force_ask',
              reason: `⚠️ [RECOVERY APPROVAL REQUIRED] Master approval needed to execute recovery command: [${commandLine}]`
            }));
            return;
          }
        }
      }
    }

    // Block all other tools under safety lock
    console.log(JSON.stringify({
      decision: 'deny',
      reason: `🛑 [SAFETY LOCK ACTIVE] Tool [${toolName}] blocked under safety lock. Lock exists at ${lockFile}`
    }));
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Worker Enforcement (Subject: Worker)
  // ─────────────────────────────────────────────────────────────
  if (isWorker) {
    const workerConfig = registry.workers[conversationId];

    // Rule 4.1: Re-delegation strictly prohibited
    if (toolName === 'invoke_subagent' || toolName === 'define_subagent') {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: `🛑 [GUARD] Worker [${conversationId}] is strictly forbidden from invoking or defining subagents (Re-delegation prohibited).`
      }));
      return;
    }

    // Rule 4.2: Exclusive file assignment enforcement
    if (toolName === 'write_to_file' || toolName === 'replace_file_content') {
      const rawTarget = toolArgs.TargetFile || '';
      const targetFile = rawTarget ? path.resolve(rawTarget) : '';
      const assignedFile = workerConfig.assignedFile ? path.resolve(workerConfig.assignedFile) : '';

      if (!targetFile || targetFile !== assignedFile) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD VIOLATION] Worker [${conversationId}] attempted to modify [${targetFile}], but is strictly restricted to assigned file [${assignedFile}].`
        }));
        return;
      }

      console.log(JSON.stringify({
        decision: 'allow',
        reason: `Worker [${conversationId}] write to assigned file [${assignedFile}] approved.`
      }));
      return;
    }

    // Rule 4.3: Fixed test command enforcement
    if (toolName === 'run_command') {
      const commandLine = (toolArgs.CommandLine || '').trim();
      const allowedCommand = (workerConfig.allowedTestCommand || '').trim();

      if (!commandLine || commandLine !== allowedCommand) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD VIOLATION] Worker [${conversationId}] command [${commandLine}] does not match authorized test command [${allowedCommand}].`
        }));
        return;
      }

      console.log(JSON.stringify({
        decision: 'allow',
        reason: `Worker [${conversationId}] fixed test command approved.`
      }));
      return;
    }

    // Rule 4.4: Any other intercepted tool not authorized for worker
    console.log(JSON.stringify({
      decision: 'deny',
      reason: `🛑 [GUARD] Tool [${toolName}] is not authorized for Worker [${conversationId}].`
    }));
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 5. Auditor Enforcement (Subject: Independent Auditor)
  // ─────────────────────────────────────────────────────────────
  if (isAuditor) {
    if (['write_to_file', 'replace_file_content', 'invoke_subagent', 'define_subagent', 'manage_subagents'].includes(toolName)) {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: `🛑 [GUARD] Auditor [${conversationId}] is strictly forbidden from modifying files or managing agents (Policy-Level Zero Write).`
      }));
      return;
    }

    if (toolName === 'run_command') {
      const commandLine = (toolArgs.CommandLine || '').trim();

      // Check working directory
      if (toolArgs.Cwd && path.resolve(toolArgs.Cwd) !== path.resolve(rootDir)) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD] Working directory [${toolArgs.Cwd}] outside root directory for Auditor.`
        }));
        return;
      }

      // Block chaining, redirection, or background execution
      if (/(&&|;|\|\||\||>|<|>>|&|`|\$\()/.test(commandLine)) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD] Shell chaining, redirection, or subshell not permitted in Auditor commands: [${commandLine}]`
        }));
        return;
      }

      if (!ALLOWED_EXACT_READ_COMMANDS.has(commandLine)) {
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `🛑 [GUARD] Command [${commandLine}] is not in Auditor exact-match allowlist.`
        }));
        return;
      }

      console.log(JSON.stringify({
        decision: 'allow',
        reason: `Auditor [${conversationId}] exact-match read command [${commandLine}] approved.`
      }));
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 6. Registered Parent Flow
  // ─────────────────────────────────────────────────────────────
  if (isParent) {
    console.log(JSON.stringify({
      decision: 'allow',
      reason: `Tool [${toolName}] allowed for registered parent [${conversationId}].`
    }));
    return;
  }
}

main();
