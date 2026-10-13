#!/usr/bin/env node
/**
 * SEC-007: Google Maps API Key 地区別運用移行検証スイート
 *
 * 16大セキュリティ・機能分離テスト：
 * Test-01: KUWANA指定 → KUWANA Key (isFallback: false)
 * Test-02: districtId正規化 (kuwana /  KUWANA  / Kuwana) → KUWANA
 * Test-03: A地区Session + B地区districtId → UNAUTHORIZED (Session Binding)
 * Test-04: 未知districtId → DISTRICT_NOT_FOUND
 * Test-05: 契約終了地区 → CONTRACT_EXPIRED
 * Test-06: 地区別Keyなし + legacy Keyあり → legacy Key + isFallback: true
 * Test-07: 地区別Keyあり → legacy Keyではなく地区別Key + isFallback: false
 * Test-08: 地区別Keyなし + legacy Keyなし → MAPS_KEY_NOT_CONFIGURED
 * Test-09: 地区別Keyが存在しない新地区のProvisioning → Provisioning Gate FAIL
 * Test-10: 旧Keyへの意図しない別地区フォールバックが発生しないこと
 * Test-11: DISTRICT_REGISTRYとSYSTEM_INFO地区コード不一致 → DISTRICT_MISMATCH
 * Test-12: Public GET → 契約通り動作
 * Test-13: Public POST → 契約通り動作
 * Test-14: Dashboard Session正常 → 自地区Key取得成功
 * Test-15: Dashboard Session他地区 → UNAUTHORIZED (POST経由)
 * Test-16: 返却JSONに不要なSecret情報が混入していないこと
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

console.log('================================================================');
console.log('🛡️  SEC-007 DISTRICT-SCOPED MAPS API KEY VERIFICATION SUITE');
console.log('================================================================\n');

const rootDir = process.cwd();
const cacheStore = new Map();
const propertiesStore = {
  DISTRICT_REGISTRY: JSON.stringify({
    KUWANA: 'ss-kuwana-id',
    KURASHIKI: 'ss-kurashiki-id',
    KAMEYAMA: 'ss-kameyama-id',
    EXPIRED_DIST: 'ss-expired-id',
    NOKEY_DIST: 'ss-nokey-id',
    MISMATCH_DIST: 'ss-mismatch-id'
  }),
  GOOGLE_MAPS_API_KEY: 'AIza-legacy-shared-fallback-key',
  GOOGLE_MAPS_API_KEY_KUWANA: 'AIza-kuwana-dedicated-key',
  GOOGLE_MAPS_API_KEY_KURASHIKI: 'AIza-kurashiki-dedicated-key',
  MANAGER_PIN_KUWANA: '123456',
  LINE_CHANNEL_ACCESS_TOKEN: 'secret_token_never_leak',
  PROVISIONING_TOKEN_HASH: 'cdbbd0eedf4ea2c25de8a03fda87017740261bd64b898e98de687906a5d4cc90'
};

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
    return {
      getValues: () => values,
      setBackground() { return this; },
      setFontColor() { return this; },
      setFontWeight() { return this; }
    };
  }
}

class MockSpreadsheet {
  constructor(id, name, sheets) { this.id = id; this.name = name; this.sheets = sheets; }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(name) { return this.sheets[name] || null; }
  getSheets() { return Object.values(this.sheets); }
}

const kuwanaSS = new MockSpreadsheet('ss-kuwana-id', 'POSTING_MAP_KUWANA', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'KUWANA'],
    ['地区名', '桑名支部'],
    ['Manager認証パスワード', '123456'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ])
});

const kurashikiSS = new MockSpreadsheet('ss-kurashiki-id', 'POSTING_MAP_KURASHIKI', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'KURASHIKI'],
    ['地区名', '倉敷支部'],
    ['Manager認証パスワード', '234567'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ])
});

const kameyamaSS = new MockSpreadsheet('ss-kameyama-id', 'POSTING_MAP_KAMEYAMA', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'KAMEYAMA'],
    ['地区名', '亀山支部'],
    ['Manager認証パスワード', '345678'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ])
});

const expiredSS = new MockSpreadsheet('ss-expired-id', 'POSTING_MAP_EXPIRED', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'EXPIRED_DIST'],
    ['地区名', '満了地区'],
    ['状態', 'EXPIRED'],
    ['契約終了日', '2020-01-01']
  ])
});

const nokeySS = new MockSpreadsheet('ss-nokey-id', 'POSTING_MAP_NOKEY', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'NOKEY_DIST'],
    ['地区名', 'Key未設定地区'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ])
});

const mismatchSS = new MockSpreadsheet('ss-mismatch-id', 'POSTING_MAP_MISMATCH', {
  SYSTEM_INFO: new MockSheet('SYSTEM_INFO', [
    ['項目', '内容'],
    ['地区コード', 'DIFFERENT_CODE_WRONG'],
    ['地区名', '不一致地区'],
    ['状態', 'ACTIVE'],
    ['契約終了日', '2099-12-31']
  ])
});

const spreadsheets = {
  'ss-kuwana-id': kuwanaSS,
  'ss-kurashiki-id': kurashikiSS,
  'ss-kameyama-id': kameyamaSS,
  'ss-expired-id': expiredSS,
  'ss-nokey-id': nokeySS,
  'ss-mismatch-id': mismatchSS
};

const cache = new MockCache();

const mockGlobal = {
  console,
  Date,
  JSON,
  String,
  Object,
  Array,
  Math,
  parseInt,
  CacheService: { getScriptCache: () => cache },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => propertiesStore[key] || null,
      setProperty: (key, value) => { propertiesStore[key] = String(value); },
      deleteProperty: key => { delete propertiesStore[key]; },
      setProperties: obj => Object.assign(propertiesStore, obj)
    })
  },
  ContentService: {
    createTextOutput: text => ({
      text,
      getContent() { return this.text; },
      setMimeType() { return this; }
    }),
    MimeType: { JSON: 'JSON' }
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_alg, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
    formatDate: (date, tz, fmt) => '2026-09-25'
  },
  SpreadsheetApp: {
    openById: id => {
      if (spreadsheets[id]) return spreadsheets[id];
      throw new Error(`Spreadsheet not found for ID: ${id}`);
    },
    getActiveSpreadsheet: () => kuwanaSS,
    flush: () => {}
  },
  LockService: {
    getScriptLock: () => ({
      tryLock: () => true,
      waitLock: () => true,
      releaseLock: () => {}
    })
  }
};
mockGlobal.global = mockGlobal;
const sandbox = vm.createContext(mockGlobal);

// Load required scripts into VM
const sessionCode = fs.readFileSync(path.join(rootDir, 'active/api/auth/session.js'), 'utf8');
vm.runInContext(sessionCode, sandbox);

const adapterCode = fs.readFileSync(path.join(rootDir, 'active/infrastructure/spreadsheet/spreadsheet_adapter.js'), 'utf8');
vm.runInContext(adapterCode, sandbox);

const sysInfoCode = fs.readFileSync(path.join(rootDir, 'active/business/system/system_info_service.js'), 'utf8');
vm.runInContext(sysInfoCode, sandbox);

const v2ApiCode = fs.readFileSync(path.join(rootDir, 'active/api/v2_api.js'), 'utf8');
vm.runInContext(v2ApiCode, sandbox);

// Helper to extract JSON from response
function parseRes(res) {
  if (typeof res === 'object' && res !== null && res.text) {
    return JSON.parse(res.text);
  }
  return res;
}

let testCount = 0;
let passCount = 0;

function runTest(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✅ [Test-${String(testCount).padStart(2, '0')}] PASS: ${name}`);
  } catch (err) {
    console.error(`❌ [Test-${String(testCount).padStart(2, '0')}] FAIL: ${name}`);
    console.error(`   ${err.message}`);
    throw err;
  }
}

// ─── Test Execution ─────────────────────────────────────────────────────────

// Test-01: KUWANA指定 → KUWANA Key
runTest('KUWANA指定 → KUWANA専用Key (isFallback: false)', () => {
  const res = parseRes(sandbox.handleGetMapsApiKey('KUWANA'));
  assert.equal(res.success, true);
  assert.equal(res.districtId, 'KUWANA');
  assert.equal(res.mapsApiKey, 'AIza-kuwana-dedicated-key');
  assert.equal(res.isFallback, false);
});

// Test-02: districtId正規化
runTest('districtId正規化 (kuwana /  KUWANA  / Kuwana) → KUWANA', () => {
  const r1 = parseRes(sandbox.handleGetMapsApiKey('kuwana'));
  const r2 = parseRes(sandbox.handleGetMapsApiKey('  KUWANA  '));
  const r3 = parseRes(sandbox.handleGetMapsApiKey('Kuwana'));
  assert.equal(r1.districtId, 'KUWANA');
  assert.equal(r1.mapsApiKey, 'AIza-kuwana-dedicated-key');
  assert.equal(r2.districtId, 'KUWANA');
  assert.equal(r3.districtId, 'KUWANA');
});

// Test-03: A地区Session + B地区districtId → UNAUTHORIZED
runTest('A地区Session + B地区districtId → UNAUTHORIZED (Session Binding)', () => {
  // KUWANA用のセッショントークンを発行
  const sessionRes = sandbox.createDashboardSession('KUWANA');
  assert.ok(sessionRes.token);
  const token = sessionRes.token;

  // KURASHIKI を要求
  const res = parseRes(sandbox.handleGetMapsApiKey('KURASHIKI', token));
  assert.equal(res.success, false);
  assert.equal(res.code, 'UNAUTHORIZED');
  assert.match(res.message, /Session district mismatch/);
});

// Test-04: 未知districtId → DISTRICT_NOT_FOUND
runTest('未知districtId → DISTRICT_NOT_FOUND', () => {
  const res = parseRes(sandbox.handleGetMapsApiKey('UNKNOWN_DISTRICT'));
  assert.equal(res.success, false);
  assert.equal(res.code, 'DISTRICT_NOT_FOUND');
  assert.match(res.message, /not registered in DISTRICT_REGISTRY/);
});

// Test-05: 契約終了地区 → CONTRACT_EXPIRED
runTest('契約終了地区 → CONTRACT_EXPIRED (Key返却なし)', () => {
  const res = parseRes(sandbox.handleGetMapsApiKey('EXPIRED_DIST'));
  assert.equal(res.success, false);
  assert.equal(res.code, 'CONTRACT_EXPIRED');
  assert.equal(res.mapsApiKey, undefined);
});

// Test-06: 地区別Keyなし + legacy Keyあり → legacy Key + isFallback: true
runTest('地区別Keyなし + legacy Keyあり → legacy Key + isFallback: true', () => {
  // KAMEYAMA は専用Key未設定、legacy Keyあり
  const res = parseRes(sandbox.handleGetMapsApiKey('KAMEYAMA'));
  assert.equal(res.success, true);
  assert.equal(res.districtId, 'KAMEYAMA');
  assert.equal(res.mapsApiKey, 'AIza-legacy-shared-fallback-key');
  assert.equal(res.isFallback, true);
});

// Test-07: 地区別Keyあり → legacy Keyではなく地区別Key + isFallback: false
runTest('地区別Keyあり → legacy Keyではなく地区別Key + isFallback: false', () => {
  // KUWANA は両方あるが、専用Keyが優先されること
  const res = parseRes(sandbox.handleGetMapsApiKey('KUWANA'));
  assert.equal(res.success, true);
  assert.equal(res.mapsApiKey, 'AIza-kuwana-dedicated-key');
  assert.notEqual(res.mapsApiKey, propertiesStore.GOOGLE_MAPS_API_KEY);
  assert.equal(res.isFallback, false);
});

// Test-08: 地区別Keyなし + legacy Keyなし → MAPS_KEY_NOT_CONFIGURED
runTest('地区別Keyなし + legacy Keyなし → MAPS_KEY_NOT_CONFIGURED', () => {
  const savedLegacy = propertiesStore.GOOGLE_MAPS_API_KEY;
  delete propertiesStore.GOOGLE_MAPS_API_KEY;
  try {
    const res = parseRes(sandbox.handleGetMapsApiKey('NOKEY_DIST'));
    assert.equal(res.success, false);
    assert.equal(res.code, 'MAPS_KEY_NOT_CONFIGURED');
    assert.match(res.message, /not configured/);
  } finally {
    propertiesStore.GOOGLE_MAPS_API_KEY = savedLegacy;
  }
});

// Test-09: 地区別Keyが存在しない新地区のProvisioning → Provisioning Gate FAIL
runTest('新地区Provisioning時、地区別Key未設定 → Provisioning Gate FAIL', () => {
  const svc = sandbox.SystemInfoService.getInstance();
  // NEW_DISTRICT は Script Properties に GOOGLE_MAPS_API_KEY_NEW_DISTRICT がない
  const checkFail = svc.verifyProvisioningMapsKey('NEW_DISTRICT');
  assert.equal(checkFail.success, false);
  assert.equal(checkFail.code, 'PROVISIONING_MAPS_KEY_MISSING');

  // Key設定後は PASS
  propertiesStore.GOOGLE_MAPS_API_KEY_NEW_DISTRICT = 'AIza-new-district-key';
  try {
    const checkPass = svc.verifyProvisioningMapsKey('NEW_DISTRICT');
    assert.equal(checkPass.success, true);
    assert.equal(checkPass.districtId, 'NEW_DISTRICT');
    assert.equal(checkPass.mapsApiKey, 'AIza-new-district-key');
  } finally {
    delete propertiesStore.GOOGLE_MAPS_API_KEY_NEW_DISTRICT;
  }
});

// Test-10: 旧Keyへの意図しない別地区フォールバックが発生しないこと
runTest('旧Keyへの意図しない別地区フォールバックが発生しないこと (B地区にA地区Keyが漏れない)', () => {
  // KURASHIKI を要求
  const res = parseRes(sandbox.handleGetMapsApiKey('KURASHIKI'));
  assert.equal(res.success, true);
  assert.equal(res.districtId, 'KURASHIKI');
  assert.equal(res.mapsApiKey, 'AIza-kurashiki-dedicated-key');
  assert.notEqual(res.mapsApiKey, propertiesStore.GOOGLE_MAPS_API_KEY_KUWANA);
});

// Test-11: DISTRICT_REGISTRYとSYSTEM_INFO地区コード不一致 → DISTRICT_MISMATCH
runTest('DISTRICT_REGISTRYとSYSTEM_INFO地区コード不一致 → DISTRICT_MISMATCH', () => {
  const res = parseRes(sandbox.handleGetMapsApiKey('MISMATCH_DIST'));
  assert.equal(res.success, false);
  assert.equal(res.code, 'DISTRICT_MISMATCH');
});

// Test-12: Public GET → 契約通り動作
runTest('Public GET → 契約通り動作 (doGet経由)', () => {
  const res = parseRes(sandbox.doGet({
    parameter: {
      action: 'getMapsApiKey',
      districtId: 'KUWANA'
    }
  }));
  assert.equal(res.success, true);
  assert.equal(res.districtId, 'KUWANA');
  assert.equal(res.mapsApiKey, 'AIza-kuwana-dedicated-key');
  assert.equal(res.isFallback, false);
});

// Test-13: Public POST → 契約通り動作
runTest('Public POST → 契約通り動作 (doPost経由)', () => {
  const res = parseRes(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'getMapsApiKey',
        districtId: 'KUWANA'
      })
    }
  }));
  assert.equal(res.success, true);
  assert.equal(res.districtId, 'KUWANA');
  assert.equal(res.mapsApiKey, 'AIza-kuwana-dedicated-key');
  assert.equal(res.isFallback, false);
});

// Test-14: Dashboard Session正常 → 自地区Key取得成功
runTest('Dashboard Session正常 → 自地区Key取得成功', () => {
  const sessionRes = sandbox.createDashboardSession('KUWANA');
  const token = sessionRes.token;

  const res = parseRes(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'getMapsApiKey',
        districtId: 'KUWANA',
        dashboardSessionToken: token
      })
    }
  }));
  assert.equal(res.success, true);
  assert.equal(res.districtId, 'KUWANA');
  assert.equal(res.mapsApiKey, 'AIza-kuwana-dedicated-key');
  assert.equal(res.isFallback, false);
});

// Test-15: Dashboard Session他地区 → UNAUTHORIZED (POST経由)
runTest('Dashboard Session他地区 → UNAUTHORIZED (POST経由)', () => {
  const sessionRes = sandbox.createDashboardSession('KUWANA');
  const token = sessionRes.token;

  const res = parseRes(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'getMapsApiKey',
        districtId: 'KURASHIKI',
        dashboardSessionToken: token
      })
    }
  }));
  assert.equal(res.success, false);
  assert.equal(res.code, 'UNAUTHORIZED');
});

// Test-16: 返却JSONに不要なSecret情報が混入していないこと
runTest('返却JSONに不要なSecret情報が混入していないこと (機密情報完全防護)', () => {
  const resSuccess = parseRes(sandbox.handleGetMapsApiKey('KUWANA'));
  const resFail = parseRes(sandbox.handleGetMapsApiKey('UNKNOWN_DIST'));

  const jsonStrSuccess = JSON.stringify(resSuccess);
  const jsonStrFail = JSON.stringify(resFail);

  // パスワード、LINE Secret、Hash等の機密キーワードがレスポンスに含まれないこと
  assert.ok(!jsonStrSuccess.includes('secret_token_never_leak'), 'LINE token must not leak');
  assert.ok(!jsonStrSuccess.includes('123456'), 'PIN must not leak');
  assert.ok(!jsonStrSuccess.includes('PROVISIONING_TOKEN'), 'Provisioning token must not leak');

  assert.ok(!jsonStrFail.includes('secret_token_never_leak'));
  assert.ok(!jsonStrFail.includes('123456'));
});

console.log('\n================================================================');
console.log(`🎉 ALL 16 SEC-007 TESTS PASSED SUCCESSFULLY (${passCount}/${testCount})`);
console.log('================================================================\n');
