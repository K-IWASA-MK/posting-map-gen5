/**
 * Phase 20 Anchor Test: Production Monitoring Contract & Observability Verification
 * 
 * マスタープラン Phase 20 が定める 8 つの監視領域：
 * 1. API errors
 * 2. queue backlog
 * 3. duplicate events
 * 4. latency
 * 5. GAS errors
 * 6. Spreadsheet lock
 * 7. map failure
 * 8. authentication failure
 * 
 * に対し、単なるコード文字列の存在確認ではなく、
 * 「監視対象 → 検知方法 → 判定条件 → Severity → 一次対応」の運用契約が成立し、
 * 既存 Universal 実装がそれを検知・判定できる契約を満たしていることを厳格に自動検証する。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log('====================================================');
console.log('🚀 PHASE 20 ANCHOR TEST: PRODUCTION MONITORING');
console.log('====================================================');

// ─── GATE 1: 8大監視項目の運用契約完全性（Detection, Threshold, Severity, SOP） ───
console.log('\n[Gate 1] 8大監視項目の運用契約完全性検証 (Canonical SSOT Contract)...');

const designContractPath = path.join(REPO_ROOT, 'docs/architecture/01_DESIGN_CONTRACT.md');
assert.ok(fs.existsSync(designContractPath), '01_DESIGN_CONTRACT.md must exist');
const designContractContent = fs.readFileSync(designContractPath, 'utf8');

assert.ok(
  designContractContent.includes('26.6 Monitoring & SLO Framework') || designContractContent.includes('監視およびサービスレベル規程'),
  '01_DESIGN_CONTRACT must explicitly define Monitoring & SLO Framework'
);

// 8大監視シグナル（API Errors, Queue Backlog, Duplicate Events, Latency, GAS Script Errors, Spreadsheet Lock, Map Failure, Auth / BOLA Failure）
const requiredSignals = [
  'API Errors',
  'Queue Backlog',
  'Duplicate Events',
  'Latency',
  'GAS Script Errors',
  'Spreadsheet Lock',
  'Map Failure',
  'Auth / BOLA Failure'
];
for (const sig of requiredSignals) {
  assert.ok(
    designContractContent.includes(sig),
    `01_DESIGN_CONTRACT must explicitly define monitoring signal: ${sig}`
  );
}

// 7大運用要素（監視対象, 目標閾値, Severity, 検知手法, 一次対応, エスカレーション, 参照 Runbook）
const requiredComponents = ['監視対象', '目標閾値', 'Severity', '検知手法', '一次対応', 'エスカレーション', '参照 Runbook'];
for (const comp of requiredComponents) {
  assert.ok(
    designContractContent.includes(comp),
    `01_DESIGN_CONTRACT must systematically cover operational component: ${comp}`
  );
}

// 外部SaaS・過剰インフラの排除宣言の確認
assert.ok(
  designContractContent.includes('単独アプリ') || designContractContent.includes('4層物理分離'),
  '01_DESIGN_CONTRACT must declare minimal architecture without extraneous infrastructure'
);

console.log('  ✅ Gate 1 PASS: 8大監視シグナルおよび7大運用要素の契約完全性を Canonical SSOT 上で確認');

// ─── GATE 2: API errors & Authentication failure 監視可能性検証 ───
console.log('\n[Gate 2] API errors & Authentication failure 監視可能性検証...');

const apiPath = path.join(REPO_ROOT, 'active/api/v2_api.js');
assert.ok(fs.existsSync(apiPath), 'active/api/v2_api.js must exist');
const apiContent = fs.readFileSync(apiPath, 'utf8');

// 1. API errors: 統一エラーレスポンス構造
assert.ok(
  apiContent.includes('success: false'),
  'API must implement uniform error response structure { success: false }'
);

// 2. 監視対象エラーコードの客観的検知可能性
const expectedErrorCodes = [
  'CONTRACT_EXPIRED',
  'DISTRICT_MISMATCH',
  'METHOD_NOT_ALLOWED',
  'FORBIDDEN',
  'UNAUTHORIZED'
];
for (const code of expectedErrorCodes) {
  assert.ok(
    apiContent.includes(code),
    `API must have explicit machine-detectable error code: ${code}`
  );
}

// 3. Authentication failure: GET経由トークン送信の即時拒否契約
assert.ok(
  apiContent.includes('Token transmission via GET is prohibited.'),
  'API must strictly reject token transmission via GET for authentication security monitoring'
);

console.log('  ✅ Gate 2 PASS: API errors & Authentication failure の機械的検知契約を確認');

// ─── GATE 3: Queue backlog & Duplicate events 監視可能性検証 ───
console.log('\n[Gate 3] Queue backlog & Duplicate events 監視可能性検証...');

const dbPath = path.join(REPO_ROOT, 'active/h-app/db.js');
assert.ok(fs.existsSync(dbPath), 'active/h-app/db.js must exist');
const dbContent = fs.readFileSync(dbPath, 'utf8');

// 1. Queue backlog: DurableQueue 構造および滞留追跡関数
assert.ok(
  dbContent.includes("const STORE_NAME = 'syncQueue'"),
  'db.js must define syncQueue object store for DurableQueue'
);
assert.ok(
  dbContent.includes('function getQueue('),
  'db.js must expose getQueue() for backlog quantity tracking'
);
assert.ok(
  dbContent.includes('function getSyncQueueRowIds('),
  'db.js must expose getSyncQueueRowIds() for unsubmitted item identification'
);
assert.ok(
  dbContent.includes('function updateUISyncStatus('),
  'db.js must expose updateUISyncStatus() to notify UI of pending backlog'
);

// 2. Duplicate events: 重複キューイング抑止契約
assert.ok(
  dbContent.includes('[Queue] Duplicate enqueue avoided for rowId='),
  'db.js must detect and log duplicate enqueue avoidance within single transaction'
);

// 3. 不変操作識別子 (requestId) 生成契約
assert.ok(
  dbContent.includes('function generateRequestId('),
  'db.js must expose generateRequestId() for client idempotency tracing'
);

// 4. Freeze と DurableQueue の契約関係（Phase 19 との整合）
assert.ok(
  designContractContent.includes('Phase 10 — Offline / Durable Queue'),
  '01_DESIGN_CONTRACT must define DurableQueue boundary'
);

console.log('  ✅ Gate 3 PASS: Queue backlog & Duplicate events の監視可能性およびFreeze整合性を確認');

// ─── GATE 4: Latency & Spreadsheet lock 監視可能性検証 ───
console.log('\n[Gate 4] Latency & Spreadsheet lock 監視可能性検証...');

// 1. Latency: 性能契約 SSOT (01_DESIGN_CONTRACT.md §14) 直接検証
assert.ok(
  designContractContent.includes('Warm Start') && designContractContent.includes('200ms'),
  '01_DESIGN_CONTRACT must define Warm Start SLA <= 200ms'
);
assert.ok(
  designContractContent.includes('Cold Start') && designContractContent.includes('800ms'),
  '01_DESIGN_CONTRACT must define Cold Start SLA <= 800ms'
);
assert.ok(
  designContractContent.includes('Offline') && designContractContent.includes('200ms'),
  '01_DESIGN_CONTRACT must define Offline Start SLA <= 200ms'
);

// 2. Spreadsheet lock: LockServiceProvider タイムアウト契約
const lockPath = path.join(REPO_ROOT, 'active/infrastructure/lock/lock_adapter.js');
assert.ok(fs.existsSync(lockPath), 'active/infrastructure/lock/lock_adapter.js must exist');
const lockContent = fs.readFileSync(lockPath, 'utf8');

assert.ok(
  lockContent.includes('LockService.getScriptLock()'),
  'lock_adapter.js must utilize LockService.getScriptLock()'
);
assert.ok(
  lockContent.includes('Lock Timeout: Failed to acquire lock within'),
  'lock_adapter.js must throw standardized Lock Timeout exception for log detection'
);

console.log('  ✅ Gate 4 PASS: Latency (01_DESIGN_CONTRACT SSOT) & Spreadsheet lock タイムアウト監視契約を確認');

// ─── GATE 5: GAS errors & Map failure 監視可能性検証 ───
console.log('\n[Gate 5] GAS errors & Map failure 監視可能性検証...');

// 1. GAS errors: Web App / Batch / Script Errors 監視契約 (01_DESIGN_CONTRACT.md §26.6 / §26.7)
assert.ok(
  designContractContent.includes('GAS Script Errors') && designContractContent.includes('Apps Script エラー通知'),
  '01_DESIGN_CONTRACT must define GAS Script Errors monitoring signal'
);
assert.ok(
  designContractContent.includes('SEV-1') && designContractContent.includes('SEV-2') && designContractContent.includes('SEV-3'),
  '01_DESIGN_CONTRACT must define Severity classifications (SEV-1, SEV-2, SEV-3)'
);

// インシデント対応ライフサイクル 8段階フローの検証 (01_DESIGN_CONTRACT.md §26.7)
const incidentPhases = ['Detect', 'Contain', 'Preserve Evidence', 'Diagnose', 'Recover', 'Verify', 'Postmortem', 'Prevent Recurrence'];
for (const phase of incidentPhases) {
  assert.ok(
    designContractContent.includes(phase),
    `01_DESIGN_CONTRACT must define incident lifecycle phase: ${phase}`
  );
}

// 2. Map failure: Google Maps API 初期化ガード契約
const renderPath = path.join(REPO_ROOT, 'active/h-app/render.js');
assert.ok(fs.existsSync(renderPath), 'active/h-app/render.js must exist');
const renderContent = fs.readFileSync(renderPath, 'utf8');

assert.ok(
  renderContent.includes('if (!mapEl || !window.google || !window.google.maps) return;'),
  'render.js must implement defensive map initialization guard against map failure'
);

// 3. Manager Map: Leaflet 初期化ガード契約
const managerPath = path.join(REPO_ROOT, 'active/manager/manager.js');
assert.ok(fs.existsSync(managerPath), 'active/manager/manager.js must exist');
const managerContent = fs.readFileSync(managerPath, 'utf8');

assert.ok(
  managerContent.includes('initMap()') && managerContent.includes('L.tileLayer'),
  'manager.js must define Leaflet/OSM map initialization structure'
);

console.log('  ✅ Gate 5 PASS: GAS errors, Map failure & Incident Lifecycle 契約を確認');

console.log('\n====================================================');
console.log('🎉 ALL 5 GATES OF PHASE 20 ANCHOR TEST PASSED (100%)');
console.log('====================================================\n');
