#!/usr/bin/env node
/**
 * POSTING MAP - Gate -1 Verification Gate (Environment Isolation & Connection Severance)
 *
 * 目的:
 * KUWANA本番環境からの完全隔離・接続遮断を客観的エビデンスで機械判定する。
 * 1件でもKUWANA接続または本番シグネチャが残存していればFAIL (exit 1) とする。
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();

console.log('===============================================================');
console.log('🛡️  [GATE -1 AUDIT: ENVIRONMENT ISOLATION & CONNECTION SEVERANCE]');
console.log('===============================================================\n');

const auditResults = {
  gate: 'Gate -1: Environment Isolation & Connection Severance',
  timestamp: new Date().toISOString(),
  checks: [],
  summary: { total: 0, passed: 0, failed: 0, status: 'PENDING' }
};

function recordCheck(id, name, pass, detail) {
  auditResults.summary.total++;
  if (pass) {
    auditResults.summary.passed++;
    console.log(`✅ [${id}] PASS: ${name}`);
    console.log(`   Evidence: ${detail}\n`);
  } else {
    auditResults.summary.failed++;
    console.error(`❌ [${id}] FAIL: ${name}`);
    console.error(`   Evidence: ${detail}\n`);
  }
  auditResults.checks.push({ id, name, pass, detail });
}

// ----------------------------------------------------------------------------
// Check 1: Git Remote KUWANA 切断 & posting-map-universal 専用リポジトリ確認
// ----------------------------------------------------------------------------
{
  let remoteOutput = '';
  try {
    remoteOutput = execSync('git remote -v', { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch (e) {
    remoteOutput = e.message;
  }

  const hasKuwana = remoteOutput.toLowerCase().includes('kuwana');
  const isPureUniversalOrEmpty = remoteOutput === '' || (
    remoteOutput.includes('posting-map-universal') && !hasKuwana
  );

  const pass = !hasKuwana && isPureUniversalOrEmpty;
  const detail = pass
    ? (remoteOutput === ''
        ? 'git remote -v is completely empty. No push destination configured.'
        : `Verified dedicated universal remote:\n${remoteOutput}`)
    : `VIOLATION: Forbidden or invalid remote detected:\n${remoteOutput}`;
  recordCheck('Gate-1-01', 'Git Remote KUWANA Severed & Dedicated Universal Confirmed', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 2: clasp / GAS 紐付け切断確認
// ----------------------------------------------------------------------------
{
  const claspJsonPath = path.join(rootDir, '.clasp.json');
  const claspTemplatePath = path.join(rootDir, '.clasp.json.template');

  const claspJsonExists = fs.existsSync(claspJsonPath);
  const templateExists = fs.existsSync(claspTemplatePath);

  let templatePure = false;
  if (templateExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claspTemplatePath, 'utf8'));
      templatePure = parsed.scriptId === '';
    } catch (e) {}
  }

  const pass = !claspJsonExists && templateExists && templatePure;
  const detail = pass
    ? '.clasp.json removed from root. .clasp.json.template has empty scriptId.'
    : `claspJsonExists=${claspJsonExists}, templateExists=${templateExists}, templatePure=${templatePure}`;
  recordCheck('Gate-1-02', 'GAS / clasp Project Association Severed', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 3: GAS Deployment 切断 & テンプレート確認
// ----------------------------------------------------------------------------
{
  const depJsonPath = path.join(rootDir, 'deployment.json');
  const depTemplatePath = path.join(rootDir, 'deployment.template.json');

  const depJsonExists = fs.existsSync(depJsonPath);
  const templateExists = fs.existsSync(depTemplatePath);

  let templatePure = false;
  if (templateExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(depTemplatePath, 'utf8'));
      templatePure = !parsed.districtId && !parsed.resources.scriptId && !parsed.resources.deploymentId;
    } catch (e) {}
  }

  const pass = !depJsonExists && templateExists && templatePure;
  const detail = pass
    ? 'deployment.json removed from root. deployment.template.json is completely unconfigured.'
    : `depJsonExists=${depJsonExists}, templateExists=${templateExists}, templatePure=${templatePure}`;
  recordCheck('Gate-1-03', 'GAS Deployment Instance Removed & Pure Template Confirmed', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 4: Runtime Config (data/config.js) 純度確認
// ----------------------------------------------------------------------------
{
  const configPath = path.join(rootDir, 'data', 'config.js');
  let pass = false;
  let detail = '';

  if (!fs.existsSync(configPath)) {
    detail = 'data/config.js not found';
  } else {
    const content = fs.readFileSync(configPath, 'utf8');
    const hasEmptyGasUrl = content.includes('gasWebAppUrl: ""') || content.includes("gasWebAppUrl: ''");
    const hasEmptyLiffId = content.includes('liffId: ""') || content.includes("liffId: ''");
    const hasNoScriptGoogle = !content.includes('script.google.com');
    const hasNoLiveLiff = !content.includes('2010941735-x29F8IQ3');

    pass = hasEmptyGasUrl && hasEmptyLiffId && hasNoScriptGoogle && hasNoLiveLiff;
    detail = pass
      ? 'data/config.js gasWebAppUrl and liffId are empty. No script.google.com present.'
      : `gasEmpty=${hasEmptyGasUrl}, liffEmpty=${hasEmptyLiffId}, noScriptGoogle=${hasNoScriptGoogle}, noLiveLiff=${hasNoLiveLiff}`;
  }
  recordCheck('Gate-1-04', 'Runtime Config Severance (data/config.js)', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 5: 認証・環境変数切断確認 (.env / .env.backup)
// ----------------------------------------------------------------------------
{
  const envPath = path.join(rootDir, '.env');
  const envBackupPath = path.join(rootDir, '.env.backup');
  const envExamplePath = path.join(rootDir, '.env.example');

  const envExists = fs.existsSync(envPath);
  const envBackupExists = fs.existsSync(envBackupPath);
  const envExampleExists = fs.existsSync(envExamplePath);

  const pass = !envExists && !envBackupExists && envExampleExists;
  const detail = pass
    ? '.env and .env.backup removed from workspace root. .env.example present.'
    : `envExists=${envExists}, envBackupExists=${envBackupExists}, envExampleExists=${envExampleExists}`;
  recordCheck('Gate-1-05', 'Secrets & Environment Variables Severed from Workspace', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 6: CNAME ドメイン設定解除確認
// ----------------------------------------------------------------------------
{
  const cnamePath = path.join(rootDir, 'CNAME');
  const cnameExists = fs.existsSync(cnamePath);

  const pass = !cnameExists;
  const detail = pass
    ? 'CNAME file removed. No production domain binding.'
    : 'VIOLATION: CNAME file still exists in workspace root.';
  recordCheck('Gate-1-06', 'Domain Binding (CNAME) Severed', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 7: KUWANA 本番シグネチャの完全走査（実行コード・設定ファイル群）
// ----------------------------------------------------------------------------
{
  const forbiddenSignatures = [
    { label: 'KUWANA GAS Script ID', pattern: '15Nr43ftSF2vKgq-aX-NbkQrPijKaUIG-y1QwrVvEQfqwXcovT6Qg9mdx' },
    { label: 'KUWANA GAS Deployment ID', pattern: 'AKfycbw69CcF7Ktb711lIYhmHSgR0iqTOuoGF_gElWsWcxJzZU3uR595me62t6lAgcUZAnFyOA' },
    { label: 'KUWANA Spreadsheet ID', pattern: '1mk346cjH6JhrYeVKye6ZyfmHXaXpRFO-FJ1BGa0WQIw' },
    { label: 'KUWANA Drive Folder ID', pattern: '1gd4JFqyiUQ5PAASUSY4Vx9fXeJeiBFwL' },
    { label: 'KUWANA LIFF ID', pattern: '2010941735-x29F8IQ3' },
    { label: 'KUWANA CNAME Domain', pattern: 'kuwana.postingmap.jp' },
    { label: 'Google Maps API Key', regex: new RegExp('AIza' + 'Sy[A-Za-z0-9_-]{33}') }
  ];

  // 走査対象ディレクトリ（.quarantine_kuwana_snapshot, .git, node_modules は除外）
  const targetDirs = ['active', 'data', 'scripts', 'tests', 'docs'];
  const targetRootFiles = ['package.json', 'index.html', 'DEPLOYMENT_REGISTRY.md', '.env.example'];

  let foundViolations = [];

  function scanFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    if (filePath.endsWith('verify-gate-minus-1.mjs')) return;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const sig of forbiddenSignatures) {
      if (sig.pattern && content.includes(sig.pattern)) {
        foundViolations.push(`${filePath} contains ${sig.label} (${sig.pattern})`);
      } else if (sig.regex && sig.regex.test(content)) {
        foundViolations.push(`${filePath} contains ${sig.label} (pattern match)`);
      }
    }
  }

  function scanDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== '.quarantine_kuwana_snapshot' && entry.name !== 'node_modules') {
          scanDir(fullPath);
        }
      } else if (entry.isFile()) {
        // 画像やバイナリ以外
        if (!entry.name.endsWith('.png') && !entry.name.endsWith('.jpg') && !entry.name.endsWith('.ico')) {
          scanFile(fullPath);
        }
      }
    }
  }

  for (const rootFile of targetRootFiles) {
    scanFile(path.join(rootDir, rootFile));
  }
  for (const dir of targetDirs) {
    scanDir(path.join(rootDir, dir));
  }

  const pass = foundViolations.length === 0;
  const detail = pass
    ? 'Zero KUWANA production signatures detected across all active runtime files, scripts, and documentation.'
    : `Detected signatures:\n     - ${foundViolations.join('\n     - ')}`;
  recordCheck('Gate-1-07', 'Zero Production Signatures in Active Codebase', pass, detail);
}

// ----------------------------------------------------------------------------
// Check 8: 隔離退避スナップショット保全 & .gitignore 確認
// ----------------------------------------------------------------------------
{
  const snapshotDir = path.join(rootDir, '.quarantine_kuwana_snapshot');
  const gitignorePath = path.join(rootDir, '.gitignore');

  const snapshotExists = fs.existsSync(snapshotDir);
  const gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const isGitIgnored = gitignoreContent.includes('.quarantine_kuwana_snapshot');

  const requiredFiles = ['.clasp.json', '.env', 'deployment.json', 'git_remote_snapshot.txt'];
  let preservedCount = 0;
  if (snapshotExists) {
    for (const file of requiredFiles) {
      if (fs.existsSync(path.join(snapshotDir, file))) preservedCount++;
    }
  }

  const pass = snapshotExists && isGitIgnored && preservedCount === requiredFiles.length;
  const detail = pass
    ? `.quarantine_kuwana_snapshot preserved (${preservedCount}/${requiredFiles.length} key files) and strictly gitignored.`
    : `snapshotExists=${snapshotExists}, isGitIgnored=${isGitIgnored}, preservedCount=${preservedCount}/${requiredFiles.length}`;
  recordCheck('Gate-1-08', 'Quarantine Snapshot Preserved & Git-Ignored', pass, detail);
}

// ----------------------------------------------------------------------------
// Final Gate Summary
// ----------------------------------------------------------------------------
auditResults.summary.status = auditResults.summary.failed === 0 ? 'PASS' : 'FAIL';
console.log('===============================================================');
console.log(`GATE -1 AUDIT RESULT: ${auditResults.summary.status} (${auditResults.summary.passed}/${auditResults.summary.total} checks passed)`);
console.log('===============================================================\n');

if (auditResults.summary.status !== 'PASS') {
  process.exit(1);
} else {
  process.exit(0);
}
