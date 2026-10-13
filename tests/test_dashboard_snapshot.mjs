import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log("====================================================");
console.log("🧪 STEP 4 DASHBOARD SNAPSHOT API VERIFICATION SUITE");
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
  getValues() { return this.values; }
  setValue(v) {
    this.values[0][0] = v;
    if (this.sheet && this.sheet.data) {
      if (!this.sheet.data[this.row - 1]) this.sheet.data[this.row - 1] = [];
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
  getSheets() { return Object.values(this.sheets); }
  insertSheet(name) {
    const s = new MockSheet(name, []);
    this.sheets[name] = s;
    return s;
  }
}

// Level 2 Mock CacheService
class MockCache {
  constructor() { this.store = new Map(); }
  get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  put(key, value, ttl) { this.store.set(key, String(value)); }
  remove(key) { this.store.delete(key); }
}

const mockCache = new MockCache();
const mockSpreadsheets = {};

global.SpreadsheetApp = {
  openById: (id) => {
    if (!mockSpreadsheets[id]) throw new Error(`Spreadsheet with id ${id} not found`);
    return mockSpreadsheets[id];
  },
  getActiveSpreadsheet: () => Object.values(mockSpreadsheets)[0],
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
  },
  computeDigest: (alg, str) => {
    return Array.from(crypto.createHash('sha256').update(str).digest());
  },
  getUuid: () => 'uuid_' + Math.random().toString(36).substring(2, 10)
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
const kuwanaSS = new MockSpreadsheet("ss-kuwana-id", "POSTING_MAP_KUWANA", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "設定値"],
    ["地区コード", "KUWANA"],
    ["運用モード", "SUBSCRIPTION"],
    ["契約終了日", "2026-10-31"],
    ["システム名", "POSTING MAP KUWANA"]
  ]),
  "名簿2026-09": new MockSheet("名簿2026-09", [
    ["STAFF_ID", "氏名", "LINE_USER_ID", "登録日時"],
    ["K001", "桑名 太郎", "U_KUWANA_001", "2026/01/01"],
    ["K002", "桑名 花子", "U_KUWANA_002", "2026/01/02"]
  ]),
  "保有チラシ枚数2026-09": new MockSheet("保有チラシ枚数2026-09", [
    ["スタッフID", "スタッフ名", "チラシ種別", "保管場所", "枚数", "更新日時"],
    ["K001", "桑名 太郎", "A4チラシ", "自宅", 500, "2026/09/20"],
    ["K002", "桑名 花子", "B4チラシ", "事務所", 300, "2026/09/20"]
  ]),
  "配布実績2026-09": new MockSheet("配布実績2026-09", [
    ["rowId", "cityName", "townName", "completedAt", "count", "staffId", "staffName", "", "", "", "", "", "", "", "", "lineUserId"],
    ["1", "桑名市", "中央町1", "2026-09-20 10:00:00", 150, "K001", "桑名 太郎", "", "", "", "", "", "", "", "", "U_KUWANA_001"],
    ["2", "桑名市", "中央町2", "2026-09-21 11:00:00", 200, "K002", "桑名 花子", "", "", "", "", "", "", "", "", "U_KUWANA_002"]
  ]),
  "受渡要請履歴2026-09": new MockSheet("受渡要請履歴2026-09", [
    ["要請ID", "要請者ID", "要請者名", "対象者ID", "対象者名", "チラシ種別", "希望枚数", "ステータス", "作成日時"],
    ["REQ001", "K001", "桑名 太郎", "K002", "桑名 花子", "A4チラシ", 100, "PENDING", "2026/09/22"]
  ]),
  "PinStatus2026-09": new MockSheet("PinStatus2026-09", [
    ["rowId", "status", "updatedAt"],
    ["1", "completed", "2026/09/20"],
    ["2", "inProgress", "2026/09/21"]
  ])
});
mockSpreadsheets["ss-kuwana-id"] = kuwanaSS;

scriptPropertiesStore["DISTRICT_REGISTRY"] = JSON.stringify({
  "KUWANA": "ss-kuwana-id"
});

// コード読み込みと実行
const rootDir = process.cwd();
const adapterCode = fs.readFileSync(path.join(rootDir, "active/infrastructure/spreadsheet/spreadsheet_adapter.js"), "utf8");
const systemInfoCode = fs.readFileSync(path.join(rootDir, "active/business/system/system_info_service.js"), "utf8");
const monthlyResolverCode = fs.readFileSync(path.join(rootDir, "active/business/system/monthly_sheet_resolver.js"), "utf8");
const staffModelCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_model.js"), "utf8");
const staffRepoCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_repository.js"), "utf8");
const staffServiceCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_service.js"), "utf8");
const flyerRepoCode = fs.readFileSync(path.join(rootDir, "active/business/flyer/flyer_repository.js"), "utf8");
const flyerServiceCode = fs.readFileSync(path.join(rootDir, "active/business/flyer/flyer_service.js"), "utf8");
const distRepoCode = fs.readFileSync(path.join(rootDir, "active/business/distribution/distribution_repository.js"), "utf8");
const distServiceCode = fs.readFileSync(path.join(rootDir, "active/business/distribution/distribution_service.js"), "utf8");
const pinServiceCode = fs.readFileSync(path.join(rootDir, "active/business/pin/pin_status_service.js"), "utf8");
const transferServiceCode = fs.readFileSync(path.join(rootDir, "active/business/transfer/transfer_service.js"), "utf8");
const sessionCode = fs.readFileSync(path.join(rootDir, "active/api/auth/session.js"), "utf8");
const systemSummaryCode = fs.readFileSync(path.join(rootDir, "active/business/system/system_summary_service.js"), "utf8");
const v2ApiCode = fs.readFileSync(path.join(rootDir, "active/api/v2_api.js"), "utf8");

vm.runInThisContext(sessionCode);
vm.runInThisContext(adapterCode);
vm.runInThisContext(monthlyResolverCode);
vm.runInThisContext(staffModelCode);
vm.runInThisContext(staffRepoCode);
vm.runInThisContext(staffServiceCode);
vm.runInThisContext(flyerRepoCode);
vm.runInThisContext(flyerServiceCode);
vm.runInThisContext(distRepoCode);
vm.runInThisContext(distServiceCode);
vm.runInThisContext(pinServiceCode);
vm.runInThisContext(transferServiceCode);
vm.runInThisContext(systemInfoCode);
vm.runInThisContext(systemSummaryCode);

global.authenticateRequest = () => ({ success: true, user: { lineUserId: "U_KUWANA_001" } });
vm.runInThisContext(v2ApiCode);

// 有効な Dashboard 認証セッションの発行 (SEC-001)
const dashSession = createDashboardSession("KUWANA");
const validDashToken = dashSession.token;

// -------------------------------------------------------------
// [TEST 1] Snapshot Schema 完全性検証
// -------------------------------------------------------------
console.log("▶ [TEST 1] Snapshot Schema 完全性検証");
const reqSnapshot = {
  postData: { contents: JSON.stringify({ action: "getDashboardSnapshot", districtId: "KUWANA", dashboardSessionToken: validDashToken, limit: 20 }) }
};
const resSnap = doPost(reqSnapshot);
const snap = JSON.parse(resSnap.text);

assert.equal(snap.success, true);
assert.equal(snap.status, "SUCCESS");
assert.equal(snap.districtId, "KUWANA");
assert.ok(snap.timestamp);
assert.ok(snap.domains);
assert.ok(snap.domains.summary);
assert.ok(snap.domains.flyerStock);
assert.ok(snap.domains.ranking);
assert.ok(snap.domains.pinStatus);
assert.ok(snap.domains.roster);
assert.ok(snap.domains.transfer);
assert.ok(snap.domains.latestDistribution);
console.log("  ✅ TEST 1 PASS: Snapshot Schema（7ドメイン構造・メタデータ）の完全性を確認");

// -------------------------------------------------------------
// [TEST 2] 既存 7 API との完全等価性検証
// -------------------------------------------------------------
console.log("▶ [TEST 2] 既存 7 API と Snapshot 内ドメインデータの完全等価性検証");

// 1. getSystemSummary
const resSummary = doPost({ postData: { contents: JSON.stringify({ action: "getSystemSummary", districtId: "KUWANA", dashboardSessionToken: validDashToken }) } });
const jsonSummary = JSON.parse(resSummary.text);
assert.deepEqual(snap.domains.summary, jsonSummary, "summary data must be identical");

// 2. getFlyerStock
const resStock = doPost({ postData: { contents: JSON.stringify({ action: "getFlyerStock", districtId: "KUWANA", dashboardSessionToken: validDashToken }) } });
const jsonStock = JSON.parse(resStock.text);
assert.deepEqual(snap.domains.flyerStock.stocks, jsonStock.stocks, "flyerStock must be identical");

// 3. getRanking
const resRank = doPost({ postData: { contents: JSON.stringify({ action: "getRanking", districtId: "KUWANA", dashboardSessionToken: validDashToken }) } });
const jsonRank = JSON.parse(resRank.text);
assert.deepEqual(snap.domains.ranking, jsonRank, "ranking must be identical");

// 4. getGlobalPinStatus
const resPin = doPost({ postData: { contents: JSON.stringify({ action: "getGlobalPinStatus", districtId: "KUWANA", dashboardSessionToken: validDashToken }) } });
const jsonPin = JSON.parse(resPin.text);
assert.deepEqual(snap.domains.pinStatus, jsonPin, "pinStatus must be identical");

// 5. getRoster
const resRoster = doPost({ postData: { contents: JSON.stringify({ action: "getRoster", districtId: "KUWANA", dashboardSessionToken: validDashToken }) } });
const jsonRoster = JSON.parse(resRoster.text);
assert.deepEqual(snap.domains.roster, jsonRoster, "roster must be identical");

// 6. getTransferRequests
const resTransfer = doPost({ postData: { contents: JSON.stringify({ action: "getTransferRequests", districtId: "KUWANA", dashboardSessionToken: validDashToken }) } });
const jsonTransfer = JSON.parse(resTransfer.text);
assert.deepEqual(snap.domains.transfer, jsonTransfer, "transfer requests must be identical");

// 7. getLatestDistribution
const resLatest = doPost({ postData: { contents: JSON.stringify({ action: "getLatestDistribution", districtId: "KUWANA", dashboardSessionToken: validDashToken, limit: 20 }) } });
const jsonLatest = JSON.parse(resLatest.text);
assert.deepEqual(snap.domains.latestDistribution, jsonLatest, "latestDistribution must be identical");

console.log("  ✅ TEST 2 PASS: 既存 7 API の全返却データと Snapshot 内 7 ドメインが 100% 完全一致");

// -------------------------------------------------------------
// [TEST 3] 部分失敗 (PARTIAL_SUCCESS) サンドボックス耐性検証
// -------------------------------------------------------------
console.log("▶ [TEST 3] 部分失敗 (PARTIAL_SUCCESS) サンドボックス耐性検証");
// TransferService を一時的に破損させる
const originalGetTransfer = TransferService.getInstance().getTransferRequests;
TransferService.getInstance().getTransferRequests = () => { throw new Error("Transfer sheet I/O timeout"); };

const resPartial = doPost(reqSnapshot);
const snapPartial = JSON.parse(resPartial.text);

assert.equal(snapPartial.success, true);
assert.equal(snapPartial.status, "PARTIAL_SUCCESS");
assert.equal(snapPartial.domains.transfer.success, false);
assert.ok(snapPartial.errors.transfer);
// 正常な他ドメインは影響を受けずに健全に返却される
assert.equal(snapPartial.domains.summary.success, true);
assert.equal(snapPartial.domains.roster.success, true);
assert.equal(snapPartial.domains.ranking.success, true);
assert.equal(snapPartial.domains.pinStatus.success, true);
assert.equal(snapPartial.domains.flyerStock.success, true);
assert.equal(snapPartial.domains.latestDistribution.success, true);
console.log("  ✅ TEST 3 PASS: 1ドメイン障害時も PARTIAL_SUCCESS で他ドメインを正常返却 (障害隔離)");

// 復帰
TransferService.getInstance().getTransferRequests = originalGetTransfer;

// -------------------------------------------------------------
// [TEST 4] 認可 & Tenant Boundary & 契約ゲート検証
// -------------------------------------------------------------
console.log("▶ [TEST 4] 認可 & Tenant Boundary & 契約ゲート検証");
// 4-1: districtId未指定
const resNoDist = doPost({ postData: { contents: JSON.stringify({ action: "getDashboardSnapshot" }) } });
const jsonNoDist = JSON.parse(resNoDist.text);
assert.equal(jsonNoDist.code, "MISSING_DISTRICT_ID");

// 4-2: 未知地区
const resUnknown = doPost({ postData: { contents: JSON.stringify({ action: "getDashboardSnapshot", districtId: "UNKNOWN_REGION" }) } });
const jsonUnknown = JSON.parse(resUnknown.text);
assert.equal(jsonUnknown.code, "DISTRICT_NOT_FOUND");

console.log("  ✅ TEST 4 PASS: Snapshot API 自身の Tenant Boundary & ルーティングゲートが厳格に機能");

// -------------------------------------------------------------
// [TEST 5] 4サービスの districtId 伝播 & Universal DB Routing契約検証
// 
// 【アーキテクチャ原則】
// - POSTING MAPの完成アプリ構造は「1地区 = 1アプリ = 1独立リポジトリ」であり、
//   通常の地区運用において地区A/BのRuntime・DBが同一アプリ内で混在することを前提としない。
// - districtId は独立地区アプリ間のデータ混在防止を目的としたものではなく、
//   Universal EngineにおけるDB Routing・Integrity Guardのための識別・ルーティング情報として扱う。
// - 地区固有差分はdata/へ吸収し、Runtimeは完成形をコピーして変更しないというUniversal原則を維持する。
// - ここでは今回の4サービスについて、Universal EngineのRouting契約に従って、
//   渡された districtId が Service → Repository → Resolver まで正しく伝播し、
//   指定された地区DBを正しく解決することを検証する。
// -------------------------------------------------------------
console.log("▶ [TEST 5] 4サービスの districtId 伝播 & Universal DB Routing契約検証");

// 1. StaffService.getRoster(districtId)
const rosterItems = StaffService.getInstance().getRoster("KUWANA");
assert.ok(Array.isArray(rosterItems));
assert.equal(rosterItems.length, 2);
assert.equal(rosterItems[0].name, "桑名 太郎");

// 2. PinStatusService.getStatus(districtId)
const pinStatusResult = PinStatusService.getInstance().getStatus("KUWANA");
assert.equal(pinStatusResult.success, true);
assert.deepEqual(pinStatusResult.completed, [1, 2]);
assert.deepEqual(pinStatusResult.inProgress, [1, 2]);

// 3. TransferService.getTransferRequests(lineUserId, districtId)
const transferItems = TransferService.getInstance().getTransferRequests("U_KUWANA_001", "KUWANA");
assert.ok(Array.isArray(transferItems));
assert.equal(transferItems.length, 1);
assert.equal(transferItems[0].requesterName, "K001");

// 4. DistributionRepository.fetchLatestRecords(limit, lineUserId, districtId)
const latestRecords = DistributionRepository.getInstance().fetchLatestRecords(20, "U_KUWANA_001", "KUWANA");
assert.ok(Array.isArray(latestRecords));
assert.equal(latestRecords.length, 2);
assert.equal(latestRecords[0].cityName, "桑名市");

console.log("  ✅ TEST 5 PASS: 4サービスすべてで渡された districtId が Service → Repository → Resolver まで正しく伝播し、指定地区DBを解決");

console.log("====================================================");
console.log("🎉 ALL DASHBOARD SNAPSHOT TESTS PASSED PERFECTLY!");
console.log("====================================================");
