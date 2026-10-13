#!/usr/bin/env node
/**
 * SEC-005: getSystemInfo Information Disclosure / Manager PIN Exposure
 * 専用攻撃・回帰検証スイート
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

console.log('================================================================');
console.log('SEC-005 GETSYSTEMINFO DISCLOSURE VERIFICATION SUITE');
console.log('================================================================\n');

const rootDir = process.cwd();
const cacheStore = new Map();
const properties = { DISTRICT_REGISTRY: '', GOOGLE_MAPS_API_KEY: 'test-maps-key' };

class MockCache {
  get(key) { return cacheStore.has(key) ? cacheStore.get(key) : null; }
  put(key, value) { cacheStore.set(key, String(value)); }
  remove(key) { cacheStore.delete(key); }
}
class MockSheet {
  constructor(name, data) { this.name = name; this.data = data; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows, numCols) {
    const values = [];
    for (let r = 0; r < numRows; r++) {
      const src = this.data[row - 1 + r] || [];
      values.push(Array.from({ length: numCols }, (_, c) => src[col - 1 + c] ?? ''));
    }
    return { getValues: () => values };
  }
}
class MockSpreadsheet {
  constructor(id, name, sheets) { this.id = id; this.name = name; this.sheets = sheets; }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(name) { return this.sheets[name] || null; }
  getSheets() { return Object.values(this.sheets); }
}

const kuwana = new MockSpreadsheet('ss-kuwana-id', 'KUWANA', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'KUWANA'],
    ['地区名', 'KUWANA'],
    ['Manager認証パスワード', '123456'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ]),
  '名簿2026-09': new MockSheet('名簿2026-09', [
    ['ID', '氏名', 'LINE_USER_ID', '登録日時'],
    ['S001', 'テスト 太郎', 'U_TEST_001', '2026-09-01 10:00:00']
  ])
});
const okayama = new MockSpreadsheet('ss-okayama-id', 'OKAYAMA', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'OKAYAMA'],
    ['Manager認証パスワード', '654321'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ])
});
const spreadsheets = { KUWANA: kuwana, OKAYAMA: okayama };

const cache = new MockCache();
global.CacheService = { getScriptCache: () => cache };
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: key => properties[key] || null,
    setProperty: (key, value) => { properties[key] = String(value); },
    setProperties: obj => Object.assign(properties, obj)
  })
};
global.ContentService = {
  createTextOutput: text => ({ text, setMimeType() { return this; } }),
  MimeType: { JSON: 'JSON' }
};
global.Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_alg, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
  getUuid: () => '00000000-0000-0000-0000-000000000001'
};
global.SpreadsheetApp = {
  openById: id => spreadsheets.KUWANA.id === id ? kuwana : spreadsheets.OKAYAMA.id === id ? okayama : (() => { throw new Error('Spreadsheet not found'); })(),
  getActiveSpreadsheet: () => kuwana
};
global.SpreadsheetResolver = {
  getInstance: () => ({
    getSpreadsheet: districtId => {
      if (!spreadsheets[districtId]) throw new Error('not found in DISTRICT_REGISTRY');
      return spreadsheets[districtId];
    }
  })
};
global.getSS = districtId => spreadsheets[districtId];
global.SystemInfoService = {
  getInstance: () => ({
    getContractStatus: () => ({ isExpired: false }),
    verifyManagerPassword: (password, districtId) => {
      if (String(password) !== '123456' || districtId !== 'KUWANA') {
        return { success: false, code: 'UNAUTHORIZED' };
      }
      const session = createDashboardSession(districtId);
      return { success: true, districtCode: districtId, ...session, dashboardSessionToken: session.token };
    }
  })
};
global.SystemSummaryService = {
  getInstance: () => ({ getSystemSummary: districtId => ({ success: true, districtId, summary: {} }) })
};
global.StaffService = { getInstance: () => ({ getRoster: () => [{ id: 'S001', name: 'テスト 太郎', registeredAt: '2026-09-01' }] }) };
global.FlyerRepository = { getInstance: () => ({ findAllStocks: () => [] }) };
global.DistributionRepository = { getInstance: () => ({ fetchRankingData: () => [], fetchLatestRecords: () => [] }) };
global.DistributionService = { getInstance: () => ({ getRankingPayload: () => ({ mySummary: {}, ranking: [] }) }) };
global.PinStatusService = { getInstance: () => ({ getStatus: () => ({ success: true, inProgress: [], completed: [] }) }) };
global.TransferService = { getInstance: () => ({ getTransferRequests: () => [] }) };
global.FlyerService = { getInstance: () => ({ getFlyerStock: () => ({ myStock: 0, stocks: [] }) }) };
global.AreaService = { getInstance: () => ({ getAreaDetails: () => ({ success: true }) }) };
global.setupRosterSheet = () => 'ok';
global.authenticateRequest = () => ({ success: false, code: 'UNAUTHORIZED' });

vm.runInThisContext(fs.readFileSync(path.join(rootDir, 'active/api/auth/session.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(rootDir, 'active/api/v2_api.js'), 'utf8'));

const body = res => JSON.parse(res.text);
let failures = 0;
function run(name, fn) {
  try { fn(); console.log('  PASS:', name); }
  catch (err) { failures++; console.error('  FAIL:', name, '-', err.message); }
}

let sessionToken = '';

run('ATTACK-1: unauthenticated GET getSystemInfo is UNAUTHORIZED', () => {
  const data = body(doGet({ parameter: { action: 'getSystemInfo', districtId: 'KUWANA' } }));
  assert.equal(data.success, false);
  assert.equal(data.code, 'UNAUTHORIZED');
  assert.equal(data.systemInfoRows, undefined);
  assert.equal(JSON.stringify(data).includes('123456'), false);
});

run('ATTACK-2: unauthenticated POST getSystemInfo is UNAUTHORIZED', () => {
  const data = body(doPost({ postData: { contents: JSON.stringify({ action: 'getSystemInfo', districtId: 'KUWANA' }) } }));
  assert.equal(data.success, false);
  assert.equal(data.code, 'UNAUTHORIZED');
  assert.equal(data.systemInfoRows, undefined);
});

run('ATTACK-3: unauthenticated external spreadsheetId is blocked', () => {
  const data = body(doGet({ parameter: {
    action: 'getSystemInfo',
    districtId: 'KUWANA',
    spreadsheetId: 'ss-okayama-id'
  }}));
  assert.equal(data.success, false);
  assert.equal(data.code, 'UNAUTHORIZED');
  assert.equal(data.systemInfoRows, undefined);
});

run('AUTH-4: authenticated GET is rejected by token method boundary', () => {
  sessionToken = createDashboardSession('KUWANA').token;
  const data = body(doGet({ parameter: {
    action: 'getSystemInfo',
    districtId: 'KUWANA',
    dashboardSessionToken: sessionToken
  }}));
  assert.equal(data.success, false);
  assert.equal(data.error, "Token transmission via GET is prohibited.");
  assert.equal(data.systemInfoRows, undefined);
  assert.equal(JSON.stringify(data).includes('123456'), false);
});

run('AUTH-5: authenticated POST redacts Manager PIN', () => {
  const data = body(doPost({ postData: {
    contents: JSON.stringify({
      action: 'getSystemInfo',
      districtId: 'KUWANA',
      dashboardSessionToken: sessionToken
    })
  }}));
  assert.equal(data.success, true);
  const rows = data.systemInfoRows.filter(row => Array.isArray(row) && String(row[0]).trim() === 'Manager認証パスワード');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], '[REDACTED]');
  assert.equal(JSON.stringify(data).includes('123456'), false);
});

run('TENANT-6: cross-district session is DISTRICT_MISMATCH', () => {
  const other = createDashboardSession('OKAYAMA').token;
  const data = body(doPost({ postData: {
    contents: JSON.stringify({
      action: 'getSystemInfo',
      districtId: 'KUWANA',
      dashboardSessionToken: other
    })
  }}));
  assert.equal(data.success, false);
  assert.equal(data.code, 'DISTRICT_MISMATCH');
});

run('REGRESSION-7: correct PIN issues session and Dashboard snapshot works', () => {
  const login = body(doPost({ postData: {
    contents: JSON.stringify({ action: 'verifyManagerPassword', password: '123456', districtId: 'KUWANA' })
  }}));
  assert.equal(login.success, true);
  assert.ok(login.dashboardSessionToken);
  const snapshot = body(doPost({ postData: {
    contents: JSON.stringify({
      action: 'getDashboardSnapshot',
      districtId: 'KUWANA',
      dashboardSessionToken: login.dashboardSessionToken
    })
  }}));
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.districtId, 'KUWANA');
  assert.ok(snapshot.domains);
});

run('REGRESSION-8a: registerOrValidateDevice remains public', () => {
  const data = body(doPost({ postData: { contents: JSON.stringify({ action: 'registerOrValidateDevice' }) } }));
  assert.equal(data.success, true);
});
run('REGRESSION-8b: getDeviceStatus remains public', () => {
  const data = body(doGet({ parameter: { action: 'getDeviceStatus' } }));
  assert.equal(data.success, true);
});
run('REGRESSION-8c: getMapsApiKey remains public', () => {
  const data = body(doGet({ parameter: { action: 'getMapsApiKey' } }));
  assert.equal(data.success, true);
  assert.equal(data.mapsApiKey, 'test-maps-key');
});

if (failures) {
  console.error('\nSEC-005 FAILED:', failures);
  process.exit(1);
}
console.log('\nSEC-005 ALL ATTACK / REGRESSION CASES PASSED');
