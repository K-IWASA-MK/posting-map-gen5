import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log("====================================================");
console.log("🧪 STEP 2 & STEP 3 RIGOROUS VERIFICATION SUITE");
console.log("====================================================");

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

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => null
  })
};

global.Utilities = {
  formatDate: (d, tz, fmt) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
};

// スプレッドシートの準備
const defaultSS = new MockSpreadsheet("default-ss-id", "DEFAULT_DISTRICT", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "設定値"],
    ["契約終了日", "2026-10-31"],
    ["システム名", "POSTING MAP"]
  ])
});
mockSpreadsheets["default-ss-id"] = defaultSS;

// コード読み込みと実行
const rootDir = process.cwd();
const adapterCode = fs.readFileSync(path.join(rootDir, "active/infrastructure/spreadsheet/spreadsheet_adapter.js"), "utf8");
const systemInfoCode = fs.readFileSync(path.join(rootDir, "active/business/system/system_info_service.js"), "utf8");
const distRepoCode = fs.readFileSync(path.join(rootDir, "active/business/distribution/distribution_repository.js"), "utf8");

vm.runInThisContext(adapterCode);
vm.runInThisContext(systemInfoCode);
vm.runInThisContext(distRepoCode);

// -------------------------------------------------------------
// [TEST 1] SpreadsheetResolver: __DEFAULT__ キャッシュと重複排除
// -------------------------------------------------------------
console.log("▶ [TEST 1] SpreadsheetResolver: __DEFAULT__ 重複 openById 排除検証");
const resolver = new SpreadsheetResolver();
resolver.getSpreadsheetId = () => "default-ss-id";

openByIdCallCount = 0;
const ss1 = resolver.getSpreadsheet("");
const ss2 = resolver.getSpreadsheet("");
const ss3 = resolver.getSpreadsheet();

assert.equal(openByIdCallCount, 1, `openById should be called exactly once, but got ${openByIdCallCount}`);
assert.equal(ss1, ss2, "ss1 and ss2 must be the same reference");
assert.equal(ss2, ss3, "ss2 and ss3 must be the same reference");
assert.ok(resolver.spreadsheetCacheByDistrict["__DEFAULT__"], "__DEFAULT__ cache key must exist");
console.log("  ✅ TEST 1 PASS: __DEFAULT__ キャッシュにより同一実行内の openById 呼出が 3回 ➔ 1回 に削減された");

// -------------------------------------------------------------
// [TEST 2] Contract Cache: Cache MISS ➔ HIT ➔ Invalidation サイクル
// -------------------------------------------------------------
console.log("▶ [TEST 2] Contract Cache: MISS ➔ HIT ➔ Invalidation サイクル検証");
const sysInfoService = new SystemInfoService();
sysInfoService.getSS = () => defaultSS;

// 初期状態: キャッシュ空
mockCache.store.clear();
const status1 = sysInfoService.getContractStatus(null, new Date("2026-10-01"), "");
assert.equal(status1.status, 'ACTIVE');
assert.equal(status1.fromCache, undefined, "First call must be Cache MISS");
assert.ok(mockCache.get("CONTRACT_STATUS___DEFAULT__"), "Cache must be populated after MISS");

// 2回目: Cache HIT
const status2 = sysInfoService.getContractStatus(null, new Date("2026-10-01"), "");
assert.equal(status2.status, 'ACTIVE');
assert.equal(status2.fromCache, true, "Second call must be Cache HIT");
assert.equal(status2.endDate, '2026-10-31');

// 契約終了日変更 ➔ Invalidation
sysInfoService.setContractEndDate("2026-11-15");
assert.equal(mockCache.get("CONTRACT_STATUS___DEFAULT__"), null, "Cache must be cleared after setContractEndDate");

// 変更後の次回読込: 最新値取得 & Cache 再構築
const status3 = sysInfoService.getContractStatus(null, new Date("2026-10-01"), "");
assert.equal(status3.status, 'ACTIVE');
assert.equal(status3.fromCache, undefined, "First call after invalidation must be MISS");
assert.equal(status3.endDate, '2026-11-15', "Must reflect updated end date");
console.log("  ✅ TEST 2 PASS: MISS ➔ HIT ➔ Invalidation ➔ 最新値再構築が完全機能");

// -------------------------------------------------------------
// [TEST 3] FAIL-CLOSED: SYSTEM_INFO読込失敗時の安全側遮断
// -------------------------------------------------------------
console.log("▶ [TEST 3] Contract Cache: Fail-Closed (読込失敗時にACTIVE推定禁止) 検証");
mockCache.store.clear();

// SYSTEM_INFO が破損・取得不能なスプレッドシート
const brokenSS = new MockSpreadsheet("broken-ss-id", "BROKEN_DISTRICT", {});
sysInfoService.getSS = () => brokenSS;

const failClosedStatus = sysInfoService.getContractStatus(null, new Date("2026-10-01"), "");
assert.equal(failClosedStatus.status, 'EXPIRED', "Must be EXPIRED on failure");
assert.equal(failClosedStatus.isExpired, true, "isExpired must be true");
assert.equal(failClosedStatus.code, 'CONTRACT_CHECK_FAILED', "Error code must indicate failure");
console.log("  ✅ TEST 3 PASS: SYSTEM_INFO消失時、ACTIVE扱いにせず安全側 (EXPIRED / CONTRACT_CHECK_FAILED) に遮断");

// -------------------------------------------------------------
// [TEST 4] 等価性検証: getRoster / fetchRankingData
// -------------------------------------------------------------
console.log("▶ [TEST 4] getRoster / fetchRankingData: cachedRoster 受け渡しと計算等価性");
const distSheet = new MockSheet("distribution", [
  ["rowId", "cityName", "townName", "completedAt", "count", "staffId", "staffName", "", "", "", "", "", "", "", "", "lineUserId"],
  ["1", "桑名市", "町丁A", "2026-09-01 10:00:00", 100, "S001", "山田太郎", "", "", "", "", "", "", "", "", "U_ALICE"],
  ["2", "桑名市", "町丁B", "2026-09-02 11:00:00", 250, "S002", "佐藤花子", "", "", "", "", "", "", "", "", "U_BOB"],
  ["3", "桑名市", "町丁C", "2026-09-03 12:00:00", 150, "S001", "山田太郎", "", "", "", "", "", "", "", "", "U_ALICE"]
]);
defaultSS.sheets["distribution"] = distSheet;

const distRepo = new DistributionRepository();
distRepo.getDistributionSheet = () => distSheet;

const dummyRoster = [
  { id: "S001", name: "山田太郎" },
  { id: "S002", name: "佐藤花子" }
];

// cachedRoster なし (従来)
const rankingWithoutCache = distRepo.fetchRankingData("U_ALICE", "", null);
// cachedRoster あり (STEP 2 最適化)
const rankingWithCache = distRepo.fetchRankingData("U_ALICE", "", dummyRoster);

assert.deepEqual(rankingWithCache, rankingWithoutCache, "Ranking results must be strictly identical");
assert.equal(rankingWithCache.length, 2);
assert.equal(rankingWithCache[0].staffId, "S001");
assert.equal(rankingWithCache[0].count, 250);
assert.equal(rankingWithCache[0].isMe, true);
assert.equal(rankingWithCache[1].staffId, "S002");
assert.equal(rankingWithCache[1].count, 250);
assert.equal(rankingWithCache[1].isMe, false);
console.log("  ✅ TEST 4 PASS: cachedRoster 有無で返却JSON・集計アルゴリズム・順序が100%等価であることを確認");

console.log("====================================================");
console.log("🎉 ALL STEP 2 & STEP 3 TESTS PASSED PERFECTLY!");
console.log("====================================================");
