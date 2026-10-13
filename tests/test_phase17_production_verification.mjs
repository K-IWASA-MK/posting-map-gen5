import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

console.log("====================================================");
console.log("🚀 PHASE 17: PRODUCTION DEPLOYMENT & VERIFICATION SUITE");
console.log("====================================================");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TARGET_DEPLOYMENT_ID = 'AKfycbyjeoNc8CeTT6AyNdTSBTqLFGHs23vUaQiavSlsPKjVmMBZ5hE_KlJqN8RI12cgb7S-';
const TARGET_WEBAPP_URL = `https://script.google.com/macros/s/${TARGET_DEPLOYMENT_ID}/exec`;

// ─── Gate 1: SSOT & Deployment Configuration Integrity ─────────────
console.log("\n▶ [GATE 1] SSOT & Deployment Configuration Integrity");
const deploymentJsonPath = path.join(REPO_ROOT, 'deployment.json');
assert.ok(fs.existsSync(deploymentJsonPath), "deployment.json must exist in root");

const deploymentData = JSON.parse(fs.readFileSync(deploymentJsonPath, 'utf8'));
const confDepId = deploymentData?.resources?.deploymentId || deploymentData?.deploymentId;
const confUrl = deploymentData?.resources?.webAppUrl || deploymentData?.webAppUrl;

assert.equal(confDepId, TARGET_DEPLOYMENT_ID, "deployment.json must match TARGET_DEPLOYMENT_ID");
assert.equal(confUrl, TARGET_WEBAPP_URL, "deployment.json must match TARGET_WEBAPP_URL");

const regContent = fs.readFileSync(path.join(REPO_ROOT, 'DEPLOYMENT_REGISTRY.md'), 'utf8');
assert.ok(regContent.includes(TARGET_DEPLOYMENT_ID), "DEPLOYMENT_REGISTRY.md must contain TARGET_DEPLOYMENT_ID");
assert.ok(regContent.includes(TARGET_WEBAPP_URL), "DEPLOYMENT_REGISTRY.md must contain TARGET_WEBAPP_URL");

console.log("  ✅ GATE 1 PASS: deployment.json 及び DEPLOYMENT_REGISTRY.md のSSOT構成が完全整合");

// ─── Gate 2: Active Deployment Version Gate ─────────────────────────
console.log("\n▶ [GATE 2] Active Deployment Version Gate");
let deploymentsOutput = '';
try {
  deploymentsOutput = execSync('npx clasp deployments', { cwd: REPO_ROOT, encoding: 'utf8' });
} catch (e) {
  console.warn("  ⚠️ Warning: clasp deployments via execSync encountered issue, reading stdout:", e.message);
  deploymentsOutput = e.stdout || '';
}

assert.ok(deploymentsOutput.includes(TARGET_DEPLOYMENT_ID), "Target deployment ID must be listed in clasp deployments");

// バージョン番号の抽出 (例: AKfycby... @7)
const depRegex = new RegExp(`${TARGET_DEPLOYMENT_ID}\\s+@(\\d+)`);
const match = deploymentsOutput.match(depRegex);
assert.ok(match, "Active version must be detected in clasp deployments output");
const activeVersion = parseInt(match[1], 10);
console.log(`  - Detected Active Deployment Version: @${activeVersion}`);
assert.ok(activeVersion >= 7, `Active version must be >= 7 (Actual: @${activeVersion})`);

console.log(`  ✅ GATE 2 PASS: 本番 Deployment が新バージョン @${activeVersion} に正しく紐付けられている`);

// ─── Gate 3: Production WebApp Public API Reachability & Health ─────
console.log("\n▶ [GATE 3] Production WebApp Public API Reachability & Health");
const resDevice = await fetch(`${TARGET_WEBAPP_URL}?action=registerOrValidateDevice`);
assert.equal(resDevice.status, 200, "registerOrValidateDevice must return HTTP 200");
const jsonDevice = await resDevice.json();
assert.equal(jsonDevice.success, true, "registerOrValidateDevice must return success: true");
assert.equal(jsonDevice.authorized, true, "registerOrValidateDevice must return authorized: true");

const resStatus = await fetch(`${TARGET_WEBAPP_URL}?action=getDeviceStatus`);
assert.equal(resStatus.status, 200, "getDeviceStatus must return HTTP 200");
const jsonStatus = await resStatus.json();
assert.equal(jsonStatus.success, true, "getDeviceStatus must return success: true");
assert.equal(jsonStatus.exists, false, "getDeviceStatus must return exists: false");

console.log("  ✅ GATE 3 PASS: 本番 Web App 公開 API (registerOrValidateDevice, getDeviceStatus) が 200 OK 正常稼働");

// ─── Gate 4: Protocol & Routing Safety Gates (Live Verification) ────
console.log("\n▶ [GATE 4] Protocol & Routing Safety Gates (Live Verification)");

// 1. POST専用APIへのGET拒絶
const resMethod = await fetch(`${TARGET_WEBAPP_URL}?action=bootstrapEnvironment`);
const jsonMethod = await resMethod.json();
assert.equal(jsonMethod.success, false, "bootstrapEnvironment via GET must fail");
assert.equal(jsonMethod.code, "METHOD_NOT_ALLOWED", "Must return METHOD_NOT_ALLOWED");

// 2. 未登録地区の遮断 (Generation 2: DISTRICT_REGISTRY Routing Rejection)
const resUnknown = await fetch(`${TARGET_WEBAPP_URL}?districtId=TEST_DISTRICT`);
const jsonUnknown = await resUnknown.json();
assert.equal(jsonUnknown.success, false, "Unknown district must fail");
assert.equal(jsonUnknown.code, "DISTRICT_NOT_FOUND", "Must return DISTRICT_NOT_FOUND");

// 3. 登録済み地区への未認証アクセス遮断 (Authentication Boundary Smoke)
const resUnauth = await fetch(`${TARGET_WEBAPP_URL}?districtId=KUWANA`);
const jsonUnauth = await resUnauth.json();
assert.equal(jsonUnauth.success, false, "Unauthenticated access to registered district must fail");
assert.equal(jsonUnauth.code, "UNAUTHORIZED", "Must return UNAUTHORIZED");

console.log("  ✅ GATE 4 PASS: 本番環境のプロトコル制限・未登録地区Registry遮断・業務認可境界が完全機能");

// ─── Gate 5: 本番デプロイ資産契約直接検証 (Production Deployment Contract) ───────
console.log("\n▶ [GATE 5] Production Deployment Architecture Compliance");
const provisioningRunbookPath = path.join(REPO_ROOT, 'docs/operations/DISTRICT_PROVISIONING_RUNBOOK.md');
const designContractPath = path.join(REPO_ROOT, 'docs/architecture/01_DESIGN_CONTRACT.md');
assert.ok(fs.existsSync(provisioningRunbookPath), "DISTRICT_PROVISIONING_RUNBOOK.md must exist");
assert.ok(fs.existsSync(designContractPath), "01_DESIGN_CONTRACT.md must exist");

const runbookContent = fs.readFileSync(provisioningRunbookPath, 'utf8');
const designContent = fs.readFileSync(designContractPath, 'utf8');

// 単一親GAS・単一Web App URL固定運用の契約検証
assert.ok(runbookContent.includes('単一親GAS') && runbookContent.includes('Web App'), "Runbook must enforce single parent GAS and Web App architecture");
assert.ok(designContent.includes('Phase 17 — Production Deploy'), "01_DESIGN_CONTRACT must define Phase 17");
assert.ok(designContent.includes('単一 Web App URL') || designContent.includes('単一親 Standalone GAS'), "01_DESIGN_CONTRACT must define single Web App URL invariant");
assert.ok(TARGET_DEPLOYMENT_ID.length > 20, "TARGET_DEPLOYMENT_ID must be a valid fixed deployment ID");

console.log("  ✅ GATE 5 PASS: 本番デプロイ資産契約と Canonical SSOT が完全整合");

console.log("\n====================================================");
console.log("🎉 ALL PHASE 17 PRODUCTION VERIFICATION GATES PASSED PERFECTLY!");
console.log("====================================================");
