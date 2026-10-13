#!/usr/bin/env node
/**
 * scripts/run-gemini-auditor.mjs
 * 
 * Google Gemini 外部プロセス型 Independent Auditor AI (PoC)
 * 
 * 責務:
 * 1. Layer 1: Mechanical Evidence Collector (ローカル客観的証跡の直接採取)
 * 2. Layer 2: External Semantic Auditor AI (Approved Baseline HEAD 監査憲法に基づく意味論的推論監査)
 * 
 * 終了コード:
 * 0: PASS (合格)
 * 1: REJECT (不合格)
 * 2: INFRA_FAILURE (APIエラー、認証未設定、スキーマ異常等のインフラ障害)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();
const scratchAuditDir = path.join(rootDir, 'scratch', 'audit');

// ─────────────────────────────────────────────────────────────
// 1. API キー・環境設定の安全な取得 (Secrets Protection)
// ─────────────────────────────────────────────────────────────
let apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  // .env ファイルからのフォールバック読み込み
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/^GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) {
        apiKey = match[1].trim();
      }
    } catch {
      // 読み込みエラーは無視
    }
  }
}

if (!apiKey) {
  console.error('❌ [INFRA_FAILURE] GEMINI_API_KEY is not set in environment or .env');
  console.error('   Please set GEMINI_API_KEY to execute External Semantic Auditor AI.');
  process.exit(2);
}

console.log('🔑 [Auth] GEMINI_API_KEY: [CONFIGURED / SECURED]');

// ─────────────────────────────────────────────────────────────
// 2. モデル選定 & Data Policy 検証
// ─────────────────────────────────────────────────────────────
const FORBIDDEN_MODELS = new Set(['gemini-2.0-flash']);
const requestedModel = process.env.GEMINI_AUDIT_MODEL || 'gemini-2.5-flash';

if (FORBIDDEN_MODELS.has(requestedModel)) {
  console.error(`❌ [INFRA_FAILURE] Forbidden/Deprecated model requested: "${requestedModel}".`);
  console.error('   gemini-2.0-flash is shut down. Use current models such as gemini-2.5-flash or gemini-3.8-flash.');
  process.exit(2);
}

const dataTier = (process.env.GEMINI_DATA_TIER || 'free').toLowerCase();
if (dataTier === 'paid') {
  console.log(`🛡️  [Data Policy] Paid Tier (Data is not used for Google product improvement). Model: ${requestedModel}`);
} else {
  console.log(`⚠️  [Data Policy] Free Tier Notice: Per Google terms, data may be used to improve Google products.`);
  console.log(`    (Set GEMINI_DATA_TIER=paid to assert Paid Tier terms). Model: ${requestedModel}`);
}

// ─────────────────────────────────────────────────────────────
// 3. Trust Anchor: Approved Baseline HEAD 監査憲法の取得
// ─────────────────────────────────────────────────────────────
let baselineAuditorPolicy = '';
try {
  baselineAuditorPolicy = execSync('git show HEAD:.agents/agents/auditor/agent.md', {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore']
  });
} catch (e) {
  console.error('❌ [INFRA_FAILURE] Failed to load approved Auditor Policy from Git HEAD:');
  console.error('   Working Tree .agents/agents/auditor/agent.md cannot be used as Trust Anchor.');
  console.error(`   ${e.message}`);
  process.exit(2);
}

if (!baselineAuditorPolicy || baselineAuditorPolicy.trim().length === 0) {
  console.error('❌ [INFRA_FAILURE] Approved Auditor Policy in Git HEAD is empty.');
  process.exit(2);
}
console.log('📜 [Trust Anchor] Approved Auditor Policy loaded from Git HEAD.');

// ─────────────────────────────────────────────────────────────
// 4. Layer 1: Mechanical Evidence Collector (ローカル自律採取)
// ─────────────────────────────────────────────────────────────
console.log('\n🔍 [Layer 1] Mechanical Evidence Collector executing...');

let headCommit = '';
let gitStatus = '';
let gitDiff = '';
let changedFiles = [];

try {
  headCommit = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
  gitStatus = execSync('git status --porcelain', { cwd: rootDir, encoding: 'utf8' });
  gitDiff = execSync('git diff HEAD', { cwd: rootDir, encoding: 'utf8' });

  changedFiles = gitStatus
    .split('\n')
    .filter(Boolean)
    .map(line => line.substring(3).trim());
} catch (e) {
  console.error(`❌ [INFRA_FAILURE] Failed to collect git evidence: ${e.message}`);
  process.exit(2);
}

// [機密保護ガード] 機密・Credential ファイルの混入を物理遮断
const secretPatterns = [/\.env/, /\.secrets\//, /\.pem$/, /\.key$/, /credentials\.json$/];
const leakedSecrets = changedFiles.filter(f => secretPatterns.some(p => p.test(f)));
if (leakedSecrets.length > 0) {
  console.error('🛑 [REJECT] Critical Security Violation: Secret files detected in working tree:');
  leakedSecrets.forEach(f => console.error(`  - ${f}`));
  console.error('   Transmission to external AI aborted for confidentiality protection.');
  process.exit(1);
}

// Scope Guard 実行
let scopeGuardPass = false;
let scopeGuardOutput = '';
try {
  scopeGuardOutput = execSync('node scripts/check-scope.mjs', { cwd: rootDir, encoding: 'utf8' });
  scopeGuardPass = true;
  console.log('  ✅ Layer 1 Scope Guard: PASS');
} catch (e) {
  scopeGuardOutput = e.stdout ? e.stdout.toString() : e.message;
  console.warn('  ⚠️ Layer 1 Scope Guard: FAIL (Capturing output for Auditor)');
}

// テスト実行 (Layer 1 回帰検証)
let testPass = false;
let testOutput = '';
try {
  testOutput = execSync('npm test', { cwd: rootDir, encoding: 'utf8' });
  testPass = true;
  console.log('  ✅ Layer 1 Test Suite: PASS');
} catch (e) {
  testOutput = e.stdout ? e.stdout.toString() : e.message;
  console.warn('  ⚠️ Layer 1 Test Suite: FAIL (Capturing output for Auditor)');
}

// diff が長すぎる場合のサマリートリミング (100KB超のみ先頭+末尾)
let sanitizedDiff = gitDiff;
if (sanitizedDiff.length > 80000) {
  sanitizedDiff = sanitizedDiff.substring(0, 40000) + '\n\n... [DIFF TRUNCATED FOR TOKEN LIMIT] ...\n\n' + sanitizedDiff.substring(sanitizedDiff.length - 20000);
}

// ─────────────────────────────────────────────────────────────
// 5. Layer 2: External Semantic Auditor AI (Gemini Structured Output)
// ─────────────────────────────────────────────────────────────
console.log(`\n🤖 [Layer 2] External Semantic Auditor AI (${requestedModel}) evaluating...`);

const auditPayloadPrompt = `
You are the Independent Auditor AI for POSTING MAP.
Evaluate the current working tree based strictly on your system instruction (Approved Auditor Policy from Git HEAD).

[EVIDENCE DOSSIER]
- Audited Baseline HEAD: ${headCommit}
- Changed Files: ${JSON.stringify(changedFiles)}
- Layer 1 Scope Guard Status: ${scopeGuardPass ? 'PASS' : 'FAIL'}
- Layer 1 Test Suite Status: ${testPass ? 'PASS' : 'FAIL'}

[SCOPE GUARD LOG]
${scopeGuardOutput.substring(0, 3000)}

[TEST SUITE LOG]
${testOutput.substring(0, 3000)}

[WORKING TREE DIFF]
${sanitizedDiff || '(No diff detected)'}

[INSTRUCTION]
Perform semantic audit on the 5 core perspectives:
1. Universal Engine Non-Invasive (Perspective: non_interference)
2. Scope Guard & Diff Minimality (Perspective: scope)
3. Regression & Test Integrity (Perspective: regression)
4. Zero Avoidable Manual (Perspective: manual_elimination)
5. Official Data Confirmation Gate (Perspective: data_gate)

Output MUST follow the enforced JSON schema.
If any mandatory condition fails, verdict MUST be "REJECT".
Only when all perspectives are fully satisfied or justified N/A, verdict MAY be "PASS".
`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['PASS', 'REJECT'] },
    blocking_findings: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    },
    audited_head: { type: 'STRING' },
    audited_files: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    },
    perspectives: {
      type: 'OBJECT',
      properties: {
        scope: { type: 'STRING', enum: ['PASS', 'REJECT', 'N/A'] },
        architecture: { type: 'STRING', enum: ['PASS', 'REJECT', 'N/A'] },
        regression: { type: 'STRING', enum: ['PASS', 'REJECT', 'N/A'] },
        non_interference: { type: 'STRING', enum: ['PASS', 'REJECT', 'N/A'] },
        data_gate: { type: 'STRING', enum: ['PASS', 'REJECT', 'N/A'] }
      },
      required: ['scope', 'architecture', 'regression', 'non_interference', 'data_gate']
    },
    summary: { type: 'STRING' }
  },
  required: ['verdict', 'blocking_findings', 'audited_head', 'audited_files', 'perspectives', 'summary']
};

const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent?key=${apiKey}`;

const requestBody = {
  systemInstruction: {
    parts: [{ text: baselineAuditorPolicy }]
  },
  contents: [
    {
      role: 'user',
      parts: [{ text: auditPayloadPrompt }]
    }
  ],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: responseSchema,
    temperature: 0.1
  }
};

let rawResponseText = '';
let auditVerdict;

try {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ [INFRA_FAILURE] Gemini API returned HTTP ${response.status}:`);
    console.error(`   ${errorText.substring(0, 500)}`);
    process.exit(2);
  }

  const jsonResponse = await response.json();
  const candidate = jsonResponse.candidates?.[0];
  rawResponseText = candidate?.content?.parts?.[0]?.text;

  if (!rawResponseText) {
    console.error('❌ [INFRA_FAILURE] Gemini API returned empty candidate or invalid format:');
    console.error(JSON.stringify(jsonResponse, null, 2));
    process.exit(2);
  }

  auditVerdict = JSON.parse(rawResponseText);
} catch (e) {
  console.error(`❌ [INFRA_FAILURE] Network or JSON parse error during Gemini Auditor call: ${e.message}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────
// 6. 出力・証跡輸送・終了コード判定
// ─────────────────────────────────────────────────────────────
if (!fs.existsSync(scratchAuditDir)) {
  fs.mkdirSync(scratchAuditDir, { recursive: true });
}

const verdictPayload = {
  timestamp: new Date().toISOString(),
  model: requestedModel,
  dataTier: dataTier,
  audited_head: auditVerdict.audited_head || headCommit,
  verdict: auditVerdict.verdict,
  blocking_findings: auditVerdict.blocking_findings || [],
  perspectives: auditVerdict.perspectives || {},
  summary: auditVerdict.summary || '',
  audited_files: auditVerdict.audited_files || changedFiles
};

const verdictFilePath = path.join(scratchAuditDir, 'audit_verdict.json');
fs.writeFileSync(verdictFilePath, JSON.stringify(verdictPayload, null, 2), 'utf8');

console.log('\n===============================================================');
console.log('🏛️  [AUDITOR VERDICT]');
console.log('===============================================================');
console.log(`Task Baseline:        ${headCommit.substring(0, 10)}`);
console.log(`Audited Changed Files: ${verdictPayload.audited_files.length} file(s)`);
console.log(`Data Tier:            ${dataTier.toUpperCase()}`);
console.log(`External AI Engine:   ${requestedModel}`);
console.log('---------------------------------------------------------------');
console.log(`Perspective 1 (Non-Interference): ${verdictPayload.perspectives.non_interference}`);
console.log(`Perspective 2 (Scope Guard):     ${verdictPayload.perspectives.scope}`);
console.log(`Perspective 3 (Regression Test): ${verdictPayload.perspectives.regression}`);
console.log(`Perspective 4 (Architecture):   ${verdictPayload.perspectives.architecture}`);
console.log(`Perspective 5 (Official Data):   ${verdictPayload.perspectives.data_gate}`);
console.log('---------------------------------------------------------------');

if (verdictPayload.blocking_findings.length > 0) {
  console.log('Blocking Findings:');
  verdictPayload.blocking_findings.forEach(f => console.log(`  - ❌ ${f}`));
} else {
  console.log('Blocking Findings: None');
}

console.log('---------------------------------------------------------------');
console.log(`Summary: ${verdictPayload.summary}`);
console.log(`Evidence Log Transport: ${verdictFilePath}`);
console.log(`Final Verdict: [ ${verdictPayload.verdict} ]`);
console.log('===============================================================\n');

if (verdictPayload.verdict === 'PASS') {
  console.log('🟢 Auditor Status: PASS. Awaiting MASTER Resume / Commit Proceed.');
  process.exit(0);
} else {
  console.error('🔴 Auditor Status: REJECT. HARD STOP. Self-healing loop disabled.');
  process.exit(1);
}
