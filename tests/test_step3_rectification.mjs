import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log("====================================================");
console.log("🧪 STEP 3 RECTIFICATION RIGOROUS VERIFICATION SUITE");
console.log("====================================================");

// 決定論的 Fixed Clock: 実カレンダーからテストを切り離し、基準Fixture月 2026-09 を保証
const baseOriginalDate = global.Date;
const mockSeptDate = new baseOriginalDate("2026-09-20T12:00:00+09:00");
class MockDate202609 extends baseOriginalDate {
  constructor(...args) {
    if (args.length === 0) {
      super(mockSeptDate.getTime());
    } else {
      super(...args);
    }
  }
  static now() {
    return mockSeptDate.getTime();
  }
}
global.Date = MockDate202609;

// モック環境の構築
class MockRange {
  constructor(values, sheet, row, col) {
    this.values = values;
    this.sheet = sheet;
    this.row = row;
    this.col = col;
  }
  getValues() {
    return this.values;
  }
  setValue(v) {
    this.values[0][0] = v;
    if (this.sheet && this.sheet.data) {
      if (!this.sheet.data[this.row - 1]) {
        this.sheet.data[this.row - 1] = [];
      }
      this.sheet.data[this.row - 1][this.col - 1] = v;
    }
  }
  setFontWeight() {}
}

class MockSheet {
  constructor(name, data = []) {
    this.name = name;
    this.data = data;
    this.frozenRows = 0;
  }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data[0] ? this.data[0].length : 0; }
  getRange(row, col, numRows = 1, numCols = 1) {
    const slice = [];
    for (let r = 0; r < numRows; r++) {
      const rowArr = [];
      for (let c = 0; c < numCols; c++) {
        const rIdx = (row - 1) + r;
        const cIdx = (col - 1) + c;
        rowArr.push(this.data[rIdx] ? this.data[rIdx][cIdx] : "");
      }
      slice.push(rowArr);
    }
    return new MockRange(slice, this, row, col);
  }
  setFrozenRows(n) { this.frozenRows = n; }
  appendRow(row) { this.data.push(row); }
}

class MockSpreadsheet {
  constructor(id, name, sheets = {}) {
    this.id = id;
    this.name = name;
    this.sheets = sheets;
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const s = new MockSheet(name, []);
    this.sheets[name] = s;
    return s;
  }
}

// Level 2 Mock CacheService
class MockCache {
  constructor() {
    this.store = new Map();
  }
  get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  put(key, value, ttl) {
    this.store.set(key, String(value));
  }
  remove(key) {
    this.store.delete(key);
  }
}

const mockCache = new MockCache();
const mockSpreadsheets = {};
let openByIdCallCount = 0;

global.SpreadsheetApp = {
  openById: (id) => {
    openByIdCallCount++;
    if (!mockSpreadsheets[id]) {
      throw new Error(`Spreadsheet with id ${id} not found`);
    }
    return mockSpreadsheets[id];
  },
  getActiveSpreadsheet: () => {
    return Object.values(mockSpreadsheets)[0];
  },
  flush: () => {}
};

global.CacheService = {
  getScriptCache: () => mockCache
};

const scriptPropertiesStore = {};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => scriptPropertiesStore[key] || null,
    setProperty: (key, val) => { scriptPropertiesStore[key] = String(val); }
  })
};

global.Utilities = {
  formatDate: (d, tz, fmt) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (fmt === "yyyy-MM") return `${year}-${month}`;
    return `${year}-${month}-${day}`;
  }
};

global.ContentService = {
  MimeType: { JSON: "application/json" },
  createTextOutput: (text) => ({
    text: text,
    mimeType: "application/json",
    setMimeType(m) { this.mimeType = m; return this; }
  })
};

// スプレッドシートの準備
// 1. KUWANA (正常 ACTIVE, 契約終了日 2026-10-31)
const kuwanaSS = new MockSpreadsheet("ss-kuwana-id", "POSTING_MAP_KUWANA", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "設定値"],
    ["地区コード", "KUWANA"],
    ["運用モード", "SUBSCRIPTION"],
    ["契約終了日", "2026-10-31"],
    ["システム名", "POSTING MAP KUWANA"]
  ]),
  "名簿2026-09": new MockSheet("名簿2026-09", [
    ["STAFF_ID", "氏名", "LINE_USER_ID"],
    ["K001", "桑名 太郎", "U_KUWANA_001"]
  ])
});
mockSpreadsheets["ss-kuwana-id"] = kuwanaSS;

// 2. EXPIRED_DISTRICT (契約終了日 2020-01-01 満了)
const expiredSS = new MockSpreadsheet("ss-expired-id", "POSTING_MAP_EXPIRED", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "設定値"],
    ["地区コード", "EXPIRED_DISTRICT"],
    ["契約終了日", "2020-01-01"],
    ["システム名", "EXPIRED DB"]
  ])
});
mockSpreadsheets["ss-expired-id"] = expiredSS;

// 3. EMPTY_DATE_DISTRICT (契約終了日 空欄 ➔ 無期限ACTIVE)
const emptyDateSS = new MockSpreadsheet("ss-empty-date-id", "POSTING_MAP_EMPTY_DATE", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "設定値"],
    ["地区コード", "EMPTY_DATE_DISTRICT"],
    ["運用モード", "SUBSCRIPTION"],
    ["契約終了日", ""],
    ["システム名", "EMPTY DATE DB"]
  ])
});
mockSpreadsheets["ss-empty-date-id"] = emptyDateSS;

// 4. BROKEN_DISTRICT (SYSTEM_INFOシートなし)
const brokenSS = new MockSpreadsheet("ss-broken-id", "POSTING_MAP_BROKEN", {});
mockSpreadsheets["ss-broken-id"] = brokenSS;

// 5. MISMATCH_DISTRICT (地区コード不一致)
const mismatchSS = new MockSpreadsheet("ss-mismatch-id", "POSTING_MAP_MISMATCH", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "設定値"],
    ["地区コード", "CORRUPTED_CODE"]
  ])
});
mockSpreadsheets["ss-mismatch-id"] = mismatchSS;

// DISTRICT_REGISTRY 設定
scriptPropertiesStore["DISTRICT_REGISTRY"] = JSON.stringify({
  "KUWANA": "ss-kuwana-id",
  "EXPIRED_DISTRICT": "ss-expired-id",
  "EMPTY_DATE_DISTRICT": "ss-empty-date-id",
  "BROKEN_DISTRICT": "ss-broken-id",
  "MISMATCH_DISTRICT": "ss-mismatch-id"
});

// コード読み込みと実行
const rootDir = process.cwd();
const adapterCode = fs.readFileSync(path.join(rootDir, "active/infrastructure/spreadsheet/spreadsheet_adapter.js"), "utf8");
const systemInfoCode = fs.readFileSync(path.join(rootDir, "active/business/system/system_info_service.js"), "utf8");
const distRepoCode = fs.readFileSync(path.join(rootDir, "active/business/distribution/distribution_repository.js"), "utf8");
const monthlyResolverCode = fs.readFileSync(path.join(rootDir, "active/business/system/monthly_sheet_resolver.js"), "utf8");
const staffModelCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_model.js"), "utf8");
const staffRepoCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_repository.js"), "utf8");
const staffServiceCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_service.js"), "utf8");
const v2ApiCode = fs.readFileSync(path.join(rootDir, "active/api/v2_api.js"), "utf8");

vm.runInThisContext(adapterCode);
vm.runInThisContext(monthlyResolverCode);
vm.runInThisContext(staffModelCode);
vm.runInThisContext(staffRepoCode);
vm.runInThisContext(staffServiceCode);
vm.runInThisContext(systemInfoCode);
vm.runInThisContext(distRepoCode);

global.authenticateRequest = (p) => ({ success: true, user: { lineUserId: "U_KUWANA_001" } });
vm.runInThisContext(v2ApiCode);

// -------------------------------------------------------------
// [TEST 1] districtId未指定 ➔ MISSING_DISTRICT_ID (契約エラーにしない)
// -------------------------------------------------------------
console.log("▶ [TEST 1] districtId未指定時の MISSING_DISTRICT_ID 判定");
const resNoDistrict = doPost({
  postData: { contents: JSON.stringify({ action: "getStaffIdentity" }) }
});
const jsonNoDistrict = JSON.parse(resNoDistrict.text);
assert.equal(jsonNoDistrict.success, false);
assert.equal(jsonNoDistrict.code, "MISSING_DISTRICT_ID");
console.log("  ✅ TEST 1 PASS: districtId未指定時は契約エラーではなく MISSING_DISTRICT_ID を返却");

// -------------------------------------------------------------
// [TEST 2] 未登録districtId ➔ DISTRICT_NOT_FOUND (Registryエラー)
// -------------------------------------------------------------
console.log("▶ [TEST 2] 未知地区ID時の DISTRICT_NOT_FOUND 判定");
const resUnknownDistrict = doPost({
  postData: { contents: JSON.stringify({ action: "getStaffIdentity", districtId: "UNKNOWN_REGION" }) }
});
const jsonUnknownDistrict = JSON.parse(resUnknownDistrict.text);
assert.equal(jsonUnknownDistrict.success, false);
assert.equal(jsonUnknownDistrict.code, "DISTRICT_NOT_FOUND");
console.log("  ✅ TEST 2 PASS: 未登録districtIdは契約エラーではなく DISTRICT_NOT_FOUND を返却");

// -------------------------------------------------------------
// [TEST 3] Integrity Guard ➔ DISTRICT_MISMATCH
// -------------------------------------------------------------
console.log("▶ [TEST 3] 地区コード不一致時の DISTRICT_MISMATCH 判定");
const resMismatch = doPost({
  postData: { contents: JSON.stringify({ action: "getStaffIdentity", districtId: "MISMATCH_DISTRICT" }) }
});
const jsonMismatch = JSON.parse(resMismatch.text);
assert.equal(jsonMismatch.success, false);
assert.equal(jsonMismatch.code, "DISTRICT_MISMATCH");
console.log("  ✅ TEST 3 PASS: SYSTEM_INFO地区コード不一致時は DISTRICT_MISMATCH で遮断");

// -------------------------------------------------------------
// [TEST 4] 契約期限満了 ➔ CONTRACT_EXPIRED
// -------------------------------------------------------------
console.log("▶ [TEST 4] 契約満了時の CONTRACT_EXPIRED 判定");
const resExpired = doPost({
  postData: { contents: JSON.stringify({ action: "getStaffIdentity", districtId: "EXPIRED_DISTRICT" }) }
});
const jsonExpired = JSON.parse(resExpired.text);
assert.equal(jsonExpired.success, false);
assert.equal(jsonExpired.code, "CONTRACT_EXPIRED");
assert.match(jsonExpired.message, /契約期間が終了/);
console.log("  ✅ TEST 4 PASS: 契約終了日超過時は明確に CONTRACT_EXPIRED を返却");

// -------------------------------------------------------------
// [TEST 5] SYSTEM_INFO取得不能 ➔ CONTRACT_CHECK_FAILED (Fail-Closed)
// -------------------------------------------------------------
console.log("▶ [TEST 5] SYSTEM_INFO破損/消失時の CONTRACT_CHECK_FAILED 判定");
const resBroken = doPost({
  postData: { contents: JSON.stringify({ action: "getStaffIdentity", districtId: "BROKEN_DISTRICT" }) }
});
const jsonBroken = JSON.parse(resBroken.text);
assert.equal(jsonBroken.success, false);
assert.equal(jsonBroken.code, "CONTRACT_CHECK_FAILED");
assert.match(jsonBroken.message, /契約情報の検証に失敗/);
console.log("  ✅ TEST 5 PASS: SYSTEM_INFO取得不能時は CONTRACT_EXPIRED ではなく CONTRACT_CHECK_FAILED で安全側遮断");

// -------------------------------------------------------------
// [TEST 6] 契約終了日空欄 ➔ ACTIVE (無期限利用可能)
// -------------------------------------------------------------
console.log("▶ [TEST 6] 契約終了日空欄時の ACTIVE (無期限) 判定");
const emptyStatus = SystemInfoService.getInstance().getContractStatus(emptyDateSS.getSheetByName("SYSTEM_INFO"), new Date(), "EMPTY_DATE_DISTRICT");
assert.equal(emptyStatus.status, "ACTIVE");
assert.equal(emptyStatus.isExpired, false);
assert.equal(emptyStatus.code, "ACTIVE");
console.log("  ✅ TEST 6 PASS: 契約終了日空欄は仕様通り ACTIVE (期限なし通常利用)");

// -------------------------------------------------------------
// [TEST 7] 正常ACTIVE ➔ 従来どおり正常応答
// -------------------------------------------------------------
console.log("▶ [TEST 7] 正常ACTIVE地区の正常応答");
const resKuwana = doPost({
  postData: { contents: JSON.stringify({ action: "getStaffIdentity", districtId: "KUWANA", liffToken: "token_user1" }) }
});
const jsonKuwana = JSON.parse(resKuwana.text);
console.log("DEBUG jsonKuwana:", jsonKuwana);
assert.equal(jsonKuwana.success, true);
assert.equal(jsonKuwana.registered, true);
assert.equal(jsonKuwana.staffId, "K001");
assert.equal(jsonKuwana.staffName, "桑名 太郎");
console.log("  ✅ TEST 7 PASS: 有効なKUWANA地区は従来どおり正常応答 (200 OK, staffId=K001)");

// -------------------------------------------------------------
// [TEST 8] GETリクエストにおけるゲート順序の整流化
// -------------------------------------------------------------
console.log("▶ [TEST 8] GETリクエストにおけるゲート整流化検証");
// 8-1: districtId未指定
const resGetNoDistrict = doGet({ parameter: { action: "getSystemSummary" } });
const jsonGetNoDistrict = JSON.parse(resGetNoDistrict.text);
assert.equal(jsonGetNoDistrict.code, "MISSING_DISTRICT_ID");

// 8-2: 未知地区
const resGetUnknown = doGet({ parameter: { action: "getSystemSummary", districtId: "UNKNOWN_REGION" } });
const jsonGetUnknown = JSON.parse(resGetUnknown.text);
assert.equal(jsonGetUnknown.code, "DISTRICT_NOT_FOUND");

// 8-3: 契約満了
const resGetExpired = doGet({ parameter: { action: "getSystemSummary", districtId: "EXPIRED_DISTRICT" } });
const jsonGetExpired = JSON.parse(resGetExpired.text);
assert.equal(jsonGetExpired.code, "CONTRACT_EXPIRED");

// 8-4: 取得不能
const resGetBroken = doGet({ parameter: { action: "getSystemSummary", districtId: "BROKEN_DISTRICT" } });
const jsonGetBroken = JSON.parse(resGetBroken.text);
assert.equal(jsonGetBroken.code, "CONTRACT_CHECK_FAILED");

console.log("  ✅ TEST 8 PASS: GETリクエストでも MISSING_DISTRICT_ID ➔ DISTRICT_NOT_FOUND ➔ CONTRACT_EXPIRED ➔ CONTRACT_CHECK_FAILED の完全整流化を確認");

console.log("====================================================");
console.log("🎉 ALL 8 RECTIFICATION TESTS PASSED PERFECTLY!");
console.log("====================================================");
