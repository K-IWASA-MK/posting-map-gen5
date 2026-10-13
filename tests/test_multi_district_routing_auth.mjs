/**
 * test_multi_district_routing_auth.mjs
 * 親Standalone GAS 1本化・動的地区ルーティング & 認可境界 厳格検証テストスイート
 *
 * MASTER確定仕様:
 * 1. currentDistrictId のSingleton状態保持を排除（リクエストスコープ伝播）。
 * 2. districtId なしの本番マルチ地区APIはデフォルトSpreadsheetへ無条件fallbackさせない (MISSING_DISTRICT_ID)。
 * 3. SYSTEM_INFO の機械的照合値は「地区コード（B2）」とし、不一致時は DISTRICT_MISMATCH で遮断。
 * 4. DISTRICT_REGISTRY は「地区DB接続情報」のSSOT。
 * 5. SYSTEM_INFO は接続先DB自身の地区情報・契約状態等のSSOT。
 * 6. 5大認可シナリオ（正当、越境、未登録、無効トークン、未知地区ID）の全数実証。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

console.log('================================================================');
console.log('🧪 MULTI-DISTRICT DYNAMIC ROUTING & AUTH BOUNDARY VERIFICATION');
console.log('================================================================\n');

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

// 1. スプレッドシートモック
class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows.length > 0 ? this.rows[0].length : 0;
  }
  createTextFinder(text) {
    const sheet = this;
    return {
      matchEntireCell() { return this; },
      findNext() {
        const strText = String(text);
        for (let r = 0; r < sheet.rows.length; r++) {
          const cellVal = String((sheet.rows[r] && sheet.rows[r][0]) !== undefined ? sheet.rows[r][0] : "");
          if (cellVal === strText) {
            return {
              getRow() { return r + 1; },
              getColumn() { return 1; }
            };
          }
        }
        return null;
      }
    };
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    if (typeof row === 'string' && row.includes(':')) {
      return {
        createTextFinder(text) {
          return sheet.createTextFinder(text);
        },
        setBackground() { return this; },
        setFontColor() { return this; },
        setFontWeight() { return this; },
        setValue() { return this; },
        setValues() { return this; },
        clearContent() { return this; }
      };
    }
    return {
      createTextFinder(text) {
        return sheet.createTextFinder(text);
      },
      getValues() {
        const res = [];
        for (let r = 0; r < numRows; r++) {
          const rowIdx = row - 1 + r;
          const rowData = sheet.rows[rowIdx] || [];
          const rowVals = [];
          for (let c = 0; c < numCols; c++) {
            const colIdx = col - 1 + c;
            rowVals.push(rowData[colIdx] !== undefined ? rowData[colIdx] : "");
          }
          res.push(rowVals);
        }
        return res;
      },
      setValues(vals) {
        for (let r = 0; r < vals.length; r++) {
          const rowIdx = row - 1 + r;
          if (!sheet.rows[rowIdx]) {
            sheet.rows[rowIdx] = [];
          }
          for (let c = 0; c < vals[r].length; c++) {
            const colIdx = col - 1 + c;
            sheet.rows[rowIdx][colIdx] = vals[r][c];
          }
        }
      },
      setValue(val) {
        const rowIdx = row - 1;
        const colIdx = col - 1;
        if (!sheet.rows[rowIdx]) {
          sheet.rows[rowIdx] = [];
        }
        sheet.rows[rowIdx][colIdx] = val;
      },
      clearContent() {
        for (let r = 0; r < numRows; r++) {
          const rowIdx = row - 1 + r;
          if (sheet.rows[rowIdx]) {
            for (let c = 0; c < numCols; c++) {
              const colIdx = col - 1 + c;
              sheet.rows[rowIdx][colIdx] = "";
            }
          }
        }
        return this;
      },
      setBackground() { return this; },
      setFontColor() { return this; },
      setFontWeight() { return this; }
    };
  }
  appendRow(row) {
    this.rows.push([...row]);
  }
  deleteRows(startRow, numRows) {
    this.rows.splice(startRow - 1, numRows);
  }
  setName(name) {
    this.name = name;
  }
  getMaxColumns() {
    return this.rows.length > 0 ? this.rows[0].length : 20;
  }
  insertColumnsAfter(afterIndex, numCols) {
    for (let r = 0; r < this.rows.length; r++) {
      for (let c = 0; c < numCols; c++) {
        this.rows[r].splice(afterIndex + c, 0, "");
      }
    }
  }
  setFrozenRows() {}
  clear() {
    this.rows = [];
  }
  copyTo(targetSS) {
    const copySheet = new MockSheet(this.name + "_copy");
    copySheet.rows = this.rows.map(r => [...r]);
    targetSS.sheets[copySheet.name] = copySheet;
    return copySheet;
  }
}

class MockSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = {};
  }
  getId() {
    return this.id;
  }
  getName() {
    return this.name;
  }
  getSheetByName(name) {
    return this.sheets[name] || null;
  }
  getSheets() {
    return Object.values(this.sheets);
  }
  addSheet(name) {
    const sheet = new MockSheet(name);
    this.sheets[name] = sheet;
    return sheet;
  }
  insertSheet(name) {
    return this.addSheet(name);
  }
}

// 2. モック環境の構築
const mockSpreadsheets = {};
const mockScriptProperties = {};

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

global.CacheService = {
  getScriptCache() {
    return mockCache;
  }
};

global.PropertiesService = {
  getScriptProperties() {
    return {
      getProperty(key) {
        return mockScriptProperties[key] !== undefined ? mockScriptProperties[key] : null;
      },
      setProperty(key, val) {
        mockScriptProperties[key] = String(val);
      },
      setProperties(obj) {
        for (const [k, v] of Object.entries(obj)) {
          mockScriptProperties[k] = String(v);
        }
      }
    };
  }
};

function createMockDriveFolderObj(id, name = "") {
  const folder = {
    id: id,
    name: name,
    files: [],
    subFolders: {},
    getId() { return this.id; },
    getName() { return this.name; },
    createFile(blob) {
      const file = {
        id: `file_${id}_${this.files.length + 1}`,
        name: blob && blob.getName ? blob.getName() : "test.jpg",
        created: new Date(),
        trashed: false,
        getDateCreated() { return this.created; },
        isTrashed() { return this.trashed; },
        setTrashed(b) { this.trashed = b; },
        moveTo(targetFolder) {
          const idx = folder.files.indexOf(this);
          if (idx >= 0) folder.files.splice(idx, 1);
          targetFolder.files.push(this);
        },
        getId() { return this.id; },
        getUrl() { return `https://drive.google.com/file/d/${this.id}/view`; },
        setSharing() {}
      };
      this.files.push(file);
      return file;
    },
    getFiles() {
      let idx = 0;
      return {
        hasNext() {
          while (idx < folder.files.length && folder.files[idx].isTrashed()) {
            idx++;
          }
          return idx < folder.files.length;
        },
        next() {
          return folder.files[idx++];
        }
      };
    },
    getFilesByName(fileName) {
      const matched = folder.files.filter(f => {
        const isTr = typeof f.isTrashed === 'function' ? f.isTrashed() : f.trashed;
        const fName = typeof f.getName === 'function' ? f.getName() : f.name;
        return !isTr && fName === fileName;
      });
      let idx = 0;
      return {
        hasNext() { return idx < matched.length; },
        next() { return matched[idx++]; }
      };
    },
    getFoldersByName(subName) {
      const sub = this.subFolders[subName];
      let yielded = false;
      return {
        hasNext() { return !!sub && !yielded; },
        next() { yielded = true; return sub; }
      };
    },
    createFolder(subName) {
      const sub = createMockDriveFolderObj(`${id}_${subName}`, subName);
      this.subFolders[subName] = sub;
      mockDriveFolders[sub.id] = sub;
      return sub;
    }
  };
  return folder;
}

const mockDriveFolders = {};
global.mockDriveFolders = mockDriveFolders;
global.DriveApp = {
  getFolderById(id) {
    if (!mockDriveFolders[id]) {
      mockDriveFolders[id] = createMockDriveFolderObj(id);
    }
    return mockDriveFolders[id];
  }
};

global.LockService = {
  getScriptLock: () => ({
    waitLock: () => {},
    releaseLock: () => {},
    tryLock: () => true
  })
};

const mockTriggers = [];
global.ScriptApp = {
  newTrigger(name) {
    return {
      timeBased() { return this; },
      everyDays() { return this; },
      atHour() { return this; },
      create() {
        const trg = {
          name: name,
          getHandlerFunction() { return name; }
        };
        mockTriggers.push(trg);
        return trg;
      }
    };
  },
  getProjectTriggers() {
    return [...mockTriggers];
  },
  deleteTrigger(t) {
    const idx = mockTriggers.indexOf(t);
    if (idx >= 0) mockTriggers.splice(idx, 1);
  }
};

global.Utilities = {
  base64Decode(str) {
    return Buffer.from(str || "", 'base64');
  },
  newBlob(data, contentType, name) {
    return {
      getData() { return data; },
      getContentType() { return contentType; },
      getName() { return name; }
    };
  },
  computeDigest(algo, str) {
    return Array.from(crypto.createHash('sha256').update(str).digest());
  },
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  formatDate(d, tz, fmt) {
    let resolvedTz = tz || 'Asia/Tokyo';
    if (resolvedTz === 'JST') resolvedTz = 'Asia/Tokyo';
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: resolvedTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = formatter.formatToParts(d);
      const partMap = {};
      for (const p of parts) {
        partMap[p.type] = p.value;
      }
      const year = partMap.year;
      const month = partMap.month;
      const day = partMap.day;
      const hour = partMap.hour;
      const minute = partMap.minute;
      const second = partMap.second;

      if (fmt === 'yyyy-MM') return `${year}-${month}`;
      if (fmt === 'yyyy-MM-dd') return `${year}-${month}-${day}`;
      if (fmt === 'yyyy/MM/dd HH:mm:ss') return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
      if (fmt && fmt.includes('HH:mm:ss')) {
        const sep = fmt.includes('/') ? '/' : '-';
        return `${year}${sep}${month}${sep}${day} ${hour}:${minute}:${second}`;
      }
      if (fmt === 'yyyy/MM/dd HH:mm') return `${year}/${month}/${day} ${hour}:${minute}`;
      if (fmt === 'MM/dd HH:mm') return `${month}/${day} ${hour}:${minute}`;
      if (fmt === 'yyyyMMdd') return `${year}${month}${day}`;
      if (fmt === 'HHmmss') return `${hour}${minute}${second}`;
      return `${year}-${month}-${day}`;
    } catch (e) {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
};

let openByIdCallCount = 0;

global.SpreadsheetApp = {
  openById(id) {
    openByIdCallCount++;
    if (mockSpreadsheets[id]) {
      return mockSpreadsheets[id];
    }
    throw new Error(`Spreadsheet not found for ID: ${id}`);
  },
  getActiveSpreadsheet() {
    return null;
  },
  flush() {}
};

global.ContentService = {
  MimeType: { JSON: "application/json" },
  createTextOutput(text) {
    return {
      text: text,
      mimeType: "application/json",
      setMimeType(m) { this.mimeType = m; return this; }
    };
  }
};

// 3. スプレッドシート作成
const currentMonth = "2026-09";
const staffSheetName = "名簿" + currentMonth;
const distSheetName = "配布実績" + currentMonth;

// (1) KUWANA DB
const kuwanaSS = new MockSpreadsheet("ss-kuwana-id", "POSTING_MAP_KUWANA");
const kuwanaSysInfo = kuwanaSS.addSheet("SYSTEM_INFO");
kuwanaSysInfo.rows = [
  ["項目", "設定値"],
  ["地区コード", "KUWANA"],
  ["地区名", "桑名地区"],
  ["HアプリURL", "https://kuwana.postingmap.jp/"],
  ["運用モード", "SUBSCRIPTION"],
  ["管理パスワード", "pwd_kuwana"],
  ["契約終了日", "2026-10-31"]
];
const kuwanaStaff = kuwanaSS.addSheet(staffSheetName);
kuwanaStaff.rows = [
  ["STAFF_ID", "氏名", "LINE_USER_ID", "登録日時"],
  ["K001", "桑名 太郎", "U_KUWANA_001", "2026/01/01"],
  ["K002", "桑名 花子", "U_KUWANA_002", "2026/01/01"]
];
const kuwanaDist = kuwanaSS.addSheet(distSheetName);
kuwanaDist.rows = [
  ["rowId", "cityName", "townName", "completedAt", "count", "staffId", "staffName", "", "", "", "", "", "", "", "", "lineUserId"],
  ["1", "桑名市", "中央町1", "2026/09/20", 100, "K001", "桑名 太郎", "", "", "", "", "", "", "", "", "U_KUWANA_001"]
];
mockSpreadsheets["ss-kuwana-id"] = kuwanaSS;

// (2) OKAYAMA DB
const okayamaSS = new MockSpreadsheet("ss-okayama-id", "POSTING_MAP_OKAYAMA");
const okayamaSysInfo = okayamaSS.addSheet("SYSTEM_INFO");
okayamaSysInfo.rows = [
  ["項目", "設定値"],
  ["地区コード", "OKAYAMA"],
  ["地区名", "岡山地区"],
  ["運用モード", "SUBSCRIPTION"],
  ["管理パスワード", "pwd_okayama"],
  ["契約終了日", "2026-10-31"]
];
const okayamaStaff = okayamaSS.addSheet(staffSheetName);
okayamaStaff.rows = [
  ["STAFF_ID", "氏名", "LINE_USER_ID", "登録日時"],
  ["O001", "岡山 次郎", "U_OKAYAMA_001", "2026/01/01"]
];
const okayamaDist = okayamaSS.addSheet(distSheetName);
okayamaDist.rows = [
  ["rowId", "cityName", "townName", "completedAt", "count", "staffId", "staffName", "", "", "", "", "", "", "", "", "lineUserId"],
  ["1", "岡山市", "北区1", "2026/09/20", 250, "O001", "岡山 次郎", "", "", "", "", "", "", "", "", "U_OKAYAMA_001"]
];
mockSpreadsheets["ss-okayama-id"] = okayamaSS;

// (3) 不整合スプレッドシート（B2が不正な値）
const mismatchSS = new MockSpreadsheet("ss-mismatch-id", "POSTING_MAP_MISMATCH");
const mismatchSysInfo = mismatchSS.addSheet("SYSTEM_INFO");
mismatchSysInfo.rows = [
  ["項目", "設定値"],
  ["地区コード", "CORRUPTED_CODE"],
  ["地区名", "桑名地区"]
];
mockSpreadsheets["ss-mismatch-id"] = mismatchSS;

// 4. DISTRICT_REGISTRY の設定
PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", JSON.stringify({
  "KUWANA": "ss-kuwana-id",
  "OKAYAMA": "ss-okayama-id",
  "MISMATCH_DISTRICT": "ss-mismatch-id"
}));

// 5. ソースコードの読み込みと評価
const rootDir = process.cwd();
const adapterCode = fs.readFileSync(path.join(rootDir, 'active/infrastructure/spreadsheet/spreadsheet_adapter.js'), 'utf-8');
const monthlyResolverCode = fs.readFileSync(path.join(rootDir, 'active/business/system/monthly_sheet_resolver.js'), 'utf-8');
import vm from 'node:vm';

const staffModelCode = fs.readFileSync(path.join(rootDir, 'active/business/staff/staff_model.js'), 'utf-8');
const staffRepoCode = fs.readFileSync(path.join(rootDir, 'active/business/staff/staff_repository.js'), 'utf-8');
const staffServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/staff/staff_service.js'), 'utf-8');
const systemInfoCode = fs.readFileSync(path.join(rootDir, 'active/business/system/system_info_service.js'), 'utf-8');
const systemSummaryCode = fs.readFileSync(path.join(rootDir, 'active/business/system/system_summary_service.js'), 'utf-8');
const distRepoCode = fs.readFileSync(path.join(rootDir, 'active/business/distribution/distribution_repository.js'), 'utf-8');
const distServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/distribution/distribution_service.js'), 'utf-8');
const flyerRepoCode = fs.readFileSync(path.join(rootDir, 'active/business/flyer/flyer_repository.js'), 'utf-8');
const flyerServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/flyer/flyer_service.js'), 'utf-8');
const driveAdapterCode = fs.readFileSync(path.join(rootDir, 'active/infrastructure/drive/drive_adapter.js'), 'utf-8');
const gpsRepoCode = fs.readFileSync(path.join(rootDir, 'active/business/gps/gps_repository.js'), 'utf-8');
const gpsServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/gps/gps_service.js'), 'utf-8');
const pinServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/pin/pin_status_service.js'), 'utf-8');
const transferServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/transfer/transfer_service.js'), 'utf-8');
const bulletinServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/bulletin/bulletin_service.js'), 'utf-8');
const areaRepoCode = fs.readFileSync(path.join(rootDir, 'active/business/area/area_repository.js'), 'utf-8');
const areaServiceCode = fs.readFileSync(path.join(rootDir, 'active/business/area/area_service.js'), 'utf-8');
const districtProvisionerCode = fs.readFileSync(path.join(rootDir, 'active/business/system/district_provisioner.js'), 'utf-8');
const v2BatchCode = fs.readFileSync(path.join(rootDir, 'active/gas/v2_batch.js'), 'utf-8');
const v2MigrationCode = fs.readFileSync(path.join(rootDir, 'active/gas/v2_migration.js'), 'utf-8');
const v2ApiCode = fs.readFileSync(path.join(rootDir, 'active/api/v2_api.js'), 'utf-8');

// 依存モジュールロード
vm.runInThisContext(adapterCode);
vm.runInThisContext(monthlyResolverCode);
vm.runInThisContext(systemInfoCode);
vm.runInThisContext(staffModelCode);
vm.runInThisContext(staffRepoCode);
vm.runInThisContext(staffServiceCode);
vm.runInThisContext(systemSummaryCode);
vm.runInThisContext(distRepoCode);
vm.runInThisContext(distServiceCode);
vm.runInThisContext(flyerRepoCode);
vm.runInThisContext(flyerServiceCode);
vm.runInThisContext(driveAdapterCode);
vm.runInThisContext(gpsRepoCode);
vm.runInThisContext(gpsServiceCode);
vm.runInThisContext(pinServiceCode);
vm.runInThisContext(transferServiceCode);
vm.runInThisContext(bulletinServiceCode);
vm.runInThisContext(areaRepoCode);
vm.runInThisContext(areaServiceCode);
vm.runInThisContext(districtProvisionerCode);
vm.runInThisContext(v2BatchCode);
vm.runInThisContext(v2MigrationCode);

const validToken = "super-secret-provisioning-token-123456";
mockScriptProperties["PROVISIONING_TOKEN_HASH"] = crypto.createHash('sha256').update(validToken).digest('hex');

// LINE 認証検証のモック（テスト用）
global.authenticateRequest = function(payload) {
  if (!payload || !payload.liffToken) {
    return { success: false, message: "Unauthorized: Missing liffToken" };
  }
  const token = payload.liffToken;
  if (token === "token_kuwana_user1") {
    return { success: true, user: { lineUserId: "U_KUWANA_001", displayName: "桑名 太郎" } };
  }
  if (token === "token_kuwana_user2") {
    return { success: true, user: { lineUserId: "U_KUWANA_002", displayName: "桑名 花子" } };
  }
  if (token === "token_okayama_user1") {
    return { success: true, user: { lineUserId: "U_OKAYAMA_001", displayName: "岡山 次郎" } };
  }
  if (token === "token_unknown_user") {
    return { success: true, user: { lineUserId: "U_STRANGER_999", displayName: "見知らぬ人" } };
  }
  if (typeof token === 'string' && token.startsWith("token_custom_")) {
    const suffix = token.replace("token_custom_", "");
    return { success: true, user: { lineUserId: `U_CUSTOM_${suffix}`, displayName: `カスタム_${suffix}` } };
  }
  return { success: false, message: "Unauthorized: Invalid or expired liffToken" };
};

global.verifyLineToken = function(token) {
  if (token === "token_kuwana_user1") return { success: true, lineUserId: "U_KUWANA_001" };
  if (token === "token_kuwana_user2") return { success: true, lineUserId: "U_KUWANA_002" };
  if (token === "token_okayama_user1") return { success: true, lineUserId: "U_OKAYAMA_001" };
  if (token === "token_unknown_user") return { success: true, lineUserId: "U_STRANGER_999" };
  if (typeof token === 'string' && token.startsWith("token_custom_")) {
    const suffix = token.replace("token_custom_", "");
    return { success: true, lineUserId: `U_CUSTOM_${suffix}` };
  }
  return { success: false, code: "INVALID_TOKEN", message: "Token verification failed" };
};

vm.runInThisContext(v2ApiCode);

// =============================================================================
// テスト実行
// =============================================================================

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    failCount++;
  }
}

// -----------------------------------------------------------------------------
// TEST 1: 正当アクセス (User A in KUWANA -> KUWANA DB)
// -----------------------------------------------------------------------------
runTest("Scenario 1: 正当アクセス (KUWANA所属スタッフがKUWANAを指定)", () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "token_kuwana_user1",
        districtId: "KUWANA"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true);
  assert.equal(data.registered, true);
  assert.equal(data.staffId, "K001");
  assert.equal(data.staffName, "桑名 太郎");
});

// -----------------------------------------------------------------------------
// TEST 2: 越境アクセス拒否 (User A in KUWANA -> OKAYAMA DB 指定)
// -----------------------------------------------------------------------------
runTest("Scenario 2: 越境アクセス拒否 (KUWANA所属スタッフがOKAYAMA DBへアクセス)", () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "token_kuwana_user1",
        districtId: "OKAYAMA"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true);
  assert.equal(data.registered, false);
  assert.equal(data.code, "NOT_REGISTERED");
});

// -----------------------------------------------------------------------------
// TEST 3: 未登録ユーザー拒否 (Unknown User -> KUWANA DB)
// -----------------------------------------------------------------------------
runTest("Scenario 3: 未登録ユーザー拒否 (どの地区名簿にも存在しないLINEユーザー)", () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "token_unknown_user",
        districtId: "KUWANA"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true);
  assert.equal(data.registered, false);
  assert.equal(data.code, "NOT_REGISTERED");
});

// -----------------------------------------------------------------------------
// TEST 4: 無効トークン拒否 (Invalid Token)
// -----------------------------------------------------------------------------
runTest("Scenario 4: 無効トークン拒否 (期限切れまたは偽装トークン)", () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "fake_expired_token",
        districtId: "KUWANA"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.match(data.message, /Unauthorized/);
});

// -----------------------------------------------------------------------------
// TEST 5: 未知地区ID拒否 (Unknown districtId)
// -----------------------------------------------------------------------------
runTest("Scenario 5: 未知地区ID拒否 (DISTRICT_REGISTRYに存在しない地区ID)", () => {
  assert.throws(() => {
    SpreadsheetResolver.getInstance().getSpreadsheet("UNKNOWN_DISTRICT");
  }, /not found in DISTRICT_REGISTRY/);
});

// -----------------------------------------------------------------------------
// TEST 6: マルチ地区環境での districtId 欠落拒否 (無条件fallback遮断)
// -----------------------------------------------------------------------------
runTest("Scenario 6: districtId欠落遮断 (マルチ地区環境でdistrictId未指定の業務API)", () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "token_kuwana_user1"
        // districtId 未指定
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "MISSING_DISTRICT_ID");
});

// -----------------------------------------------------------------------------
// TEST 7: 二段階SSOT・Integrity Guard 検証 (B2 地区コード完全一致 & DISTRICT_MISMATCH)
// -----------------------------------------------------------------------------
runTest("Scenario 7: Integrity Guard (SYSTEM_INFO の地区コードが不一致の場合に即時遮断)", () => {
  assert.throws(() => {
    // MISMATCH_DISTRICT は registry にあるが、SYSTEM_INFO の B2 は "CORRUPTED_CODE"
    SpreadsheetResolver.getInstance().getSpreadsheet("MISMATCH_DISTRICT");
  }, /DISTRICT_MISMATCH/);
});

// -----------------------------------------------------------------------------
// TEST 8: Singleton 状態保持の完全排除検証 (リクエスト間での独立性)
// -----------------------------------------------------------------------------
runTest("Scenario 8: Singleton状態保持の排除 (KUWANAとOKAYAMAを交互に呼び出しても汚染されない)", () => {
  const resolver = SpreadsheetResolver.getInstance();

  // 1回目: KUWANA
  const ssKuwana = resolver.getSpreadsheet("KUWANA");
  assert.equal(ssKuwana.getId(), "ss-kuwana-id");
  assert.equal(ssKuwana.getName(), "POSTING_MAP_KUWANA");

  // 2回目: OKAYAMA
  const ssOkayama = resolver.getSpreadsheet("OKAYAMA");
  assert.equal(ssOkayama.getId(), "ss-okayama-id");
  assert.equal(ssOkayama.getName(), "POSTING_MAP_OKAYAMA");

  // 3回目: 再び KUWANA (状態が OKAYAMA に上書きされていないこと)
  const ssKuwana2 = resolver.getSpreadsheet("KUWANA");
  assert.equal(ssKuwana2.getId(), "ss-kuwana-id");
  assert.equal(ssKuwana2.getName(), "POSTING_MAP_KUWANA");
});

// -----------------------------------------------------------------------------
// TEST 9: ランキング集計の地区別分離
// -----------------------------------------------------------------------------
runTest("Scenario 9: 配布ランキングの地区別分離", () => {
  const reqKuwana = {
    postData: {
      contents: JSON.stringify({
        action: "getRanking",
        liffToken: "token_kuwana_user1",
        districtId: "KUWANA"
      })
    }
  };
  const resKuwana = doPost(reqKuwana);
  const dataKuwana = JSON.parse(resKuwana.text);
  assert.equal(dataKuwana.success, true);
  assert.equal(dataKuwana.ranking.length, 1);
  assert.equal(dataKuwana.ranking[0].staffId, "K001");
  assert.equal(dataKuwana.ranking[0].count, 100);

  const reqOkayama = {
    postData: {
      contents: JSON.stringify({
        action: "getRanking",
        liffToken: "token_okayama_user1",
        districtId: "OKAYAMA"
      })
    }
  };
  const resOkayama = doPost(reqOkayama);
  const dataOkayama = JSON.parse(resOkayama.text);
  assert.equal(dataOkayama.success, true);
  assert.equal(dataOkayama.ranking.length, 1);
  assert.equal(dataOkayama.ranking[0].staffId, "O001");
  assert.equal(dataOkayama.ranking[0].count, 250);
});

// -----------------------------------------------------------------------------
// TEST 10: Generation 2 オブジェクト形式 Registry の解決
// -----------------------------------------------------------------------------
runTest("Scenario 10: Generation 2 オブジェクト形式 Registry の動的解決", () => {
  const currentReg = JSON.parse(PropertiesService.getScriptProperties().getProperty("DISTRICT_REGISTRY"));
  currentReg["GEN2_DISTRICT"] = {
    spreadsheetId: "ss-kuwana-id",
    name: "GEN2_DISTRICT",
    enabled: true
  };
  PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", JSON.stringify(currentReg));
  SpreadsheetResolver.getInstance().clearCache();

  const resolvedId = SpreadsheetResolver.getInstance().getSpreadsheetId("GEN2_DISTRICT");
  assert.equal(resolvedId, "ss-kuwana-id");
});

// -----------------------------------------------------------------------------
// TEST 11: enabled: false 地区のアクセス遮断
// -----------------------------------------------------------------------------
runTest("Scenario 11: enabled: false 地区のアクセス遮断", () => {
  const currentReg = JSON.parse(PropertiesService.getScriptProperties().getProperty("DISTRICT_REGISTRY"));
  currentReg["DISABLED_DISTRICT"] = {
    spreadsheetId: "ss-kuwana-id",
    name: "DISABLED_DISTRICT",
    enabled: false
  };
  PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", JSON.stringify(currentReg));
  SpreadsheetResolver.getInstance().clearCache();

  assert.throws(() => {
    SpreadsheetResolver.getInstance().getSpreadsheetId("DISABLED_DISTRICT");
  }, /not found in DISTRICT_REGISTRY/);
});

// -----------------------------------------------------------------------------
// TEST 12: bootstrapEnvironment による新地区追加時の既存地区保護
// -----------------------------------------------------------------------------
runTest("Scenario 12: bootstrapEnvironment による既存地区の保護と新地区追加", () => {
  const initialReg = {
    "EXISTING_A": { spreadsheetId: "ss-a-id", enabled: true }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(initialReg);
  mockScriptProperties["TARGET_SPREADSHEET_ID"] = "legacy-ss-id";
  mockScriptProperties["BRANCH_ROOT_FOLDER_ID"] = "branch-root-folder-id";
  const validToken = "super-secret-provisioning-token-123456";
  mockScriptProperties["PROVISIONING_TOKEN_HASH"] = crypto.createHash('sha256').update(validToken).digest('hex');
  SpreadsheetResolver.getInstance().clearCache();

  try {
    // 03_BRANCH 階層モックの準備
    const rootBranch = createMockDriveFolderObj("branch-root-folder-id", "03_BRANCH");
    mockDriveFolders["branch-root-folder-id"] = rootBranch;
    const distFolderB = rootBranch.createFolder("NEW_DISTRICT_B");
    const storageFolderB = distFolderB.createFolder("NEW_DISTRICT_B 支部_STORAGE");
    const ssFileB = {
      getId: () => "ss-b-id",
      getName: () => "NEW_DISTRICT_B",
      getMimeType: () => "application/vnd.google-apps.spreadsheet",
      isTrashed: () => false
    };
    distFolderB.files.push(ssFileB);

    // 新規地区スプレッドシートのモック（名前は Canonical DB Name: NEW_DISTRICT_B）
    const ssNewB = new MockSpreadsheet("ss-b-id", "NEW_DISTRICT_B");
    mockSpreadsheets["ss-b-id"] = ssNewB;

    // 1. 正常系: districtId のみ（Caller 指定なしでサーバー側解決）
    const reqMinimal = {
      postData: {
        contents: JSON.stringify({
          action: "bootstrapEnvironment",
          districtId: "NEW_DISTRICT_B",
          provisioningToken: validToken
        })
      }
    };
    const resMin = doPost(reqMinimal);
    const dataMin = JSON.parse(resMin.text);
    assert.equal(dataMin.success, true, "bootstrapEnvironment must succeed with districtId only: " + resMin.text);
    assert.equal(dataMin.targetSpreadsheetId, "ss-b-id");
    assert.equal(dataMin.storageParentId, storageFolderB.id);
    assert.equal(dataMin.districtRegistryUpdated, true);

    // 2. 正常系: 一致する Legacy 引数（Assertion 通過）
    const reqAssertionOk = {
      postData: {
        contents: JSON.stringify({
          action: "bootstrapEnvironment",
          districtId: "NEW_DISTRICT_B",
          targetSpreadsheetId: "ss-b-id",
          storageParentId: storageFolderB.id,
          provisioningToken: validToken
        })
      }
    };
    const resAssertOk = doPost(reqAssertionOk);
    const dataAssertOk = JSON.parse(resAssertOk.text);
    assert.equal(dataAssertOk.success, true, "bootstrapEnvironment must pass when legacy args match canonical values");

    // 3. 異常系: 不一致な targetSpreadsheetId ➔ SPREADSHEET_ID_MISMATCH
    const reqBadSs = {
      postData: {
        contents: JSON.stringify({
          action: "bootstrapEnvironment",
          districtId: "NEW_DISTRICT_B",
          targetSpreadsheetId: "wrong-ss-id",
          provisioningToken: validToken
        })
      }
    };
    const resBadSs = doPost(reqBadSs);
    const dataBadSs = JSON.parse(resBadSs.text);
    assert.equal(dataBadSs.success, false);
    assert.equal(dataBadSs.code, "SPREADSHEET_ID_MISMATCH");

    // 4. 異常系: 不一致な storageParentId ➔ STORAGE_FOLDER_MISMATCH
    const reqBadStorage = {
      postData: {
        contents: JSON.stringify({
          action: "bootstrapEnvironment",
          districtId: "NEW_DISTRICT_B",
          storageParentId: "wrong-storage-id",
          provisioningToken: validToken
        })
      }
    };
    const resBadStorage = doPost(reqBadStorage);
    const dataBadStorage = JSON.parse(resBadStorage.text);
    assert.equal(dataBadStorage.success, false);
    assert.equal(dataBadStorage.code, "STORAGE_FOLDER_MISMATCH");

    const updatedReg = JSON.parse(mockScriptProperties["DISTRICT_REGISTRY"]);
    assert.ok(updatedReg["EXISTING_A"], "EXISTING_A must be preserved");
    assert.equal(updatedReg["EXISTING_A"].spreadsheetId, "ss-a-id");
    assert.ok(updatedReg["NEW_DISTRICT_B"], "NEW_DISTRICT_B must be added");
    assert.equal(updatedReg["NEW_DISTRICT_B"].spreadsheetId, "ss-b-id");
    assert.equal(updatedReg["NEW_DISTRICT_B"].enabled, false, "New district must be registered as enabled: false (pre-acceptance)");

    // TARGET_SPREADSHEET_ID が上書きされていないこと（既存値保護）
    assert.equal(mockScriptProperties["TARGET_SPREADSHEET_ID"], "legacy-ss-id");

    // 破損Registry下でのbootstrapEnvironment実行 ➔ Fail-Closed (mutation 0)
    mockScriptProperties["DISTRICT_REGISTRY"] = "{invalid_json";
    const corruptReq = {
      postData: {
        contents: JSON.stringify({
          action: "bootstrapEnvironment",
          districtId: "NEW_DISTRICT_B",
          targetSpreadsheetId: "ss-b-id",
          storageParentId: storageFolderB.id,
          provisioningToken: validToken
        })
      }
    };
    const corruptRes = doPost(corruptReq);
    const corruptData = JSON.parse(corruptRes.text);
    assert.equal(corruptData.success, false, "bootstrapEnvironment must fail on corrupted registry");
    assert.equal(corruptData.code, "CORRUPTED_REGISTRY");
    assert.equal(mockScriptProperties["DISTRICT_REGISTRY"], "{invalid_json", "DISTRICT_REGISTRY must not be mutated on failure");
    assert.equal(mockScriptProperties["TARGET_SPREADSHEET_ID"], "legacy-ss-id", "TARGET_SPREADSHEET_ID must not be mutated on failure");

    // 空文字Registry下でのbootstrapEnvironment実行 ➔ Fail-Closed (mutation 0)
    mockScriptProperties["DISTRICT_REGISTRY"] = "   ";
    const emptyRes = doPost(corruptReq);
    const emptyData = JSON.parse(emptyRes.text);
    assert.equal(emptyData.success, false, "bootstrapEnvironment must fail on empty/whitespace registry");
    assert.equal(emptyData.code, "CORRUPTED_REGISTRY");
    assert.equal(mockScriptProperties["DISTRICT_REGISTRY"], "   ", "DISTRICT_REGISTRY must not be mutated on empty registry failure");
    assert.equal(mockScriptProperties["TARGET_SPREADSHEET_ID"], "legacy-ss-id", "TARGET_SPREADSHEET_ID must not be mutated on empty registry failure");
  } finally {
    // 後続シナリオ（Scenario 13〜36）のために DISTRICT_REGISTRY に KUWANA, OKAYAMA, NEW_DISTRICT_B を復元設定
    const fullReg = {
      "KUWANA": "ss-kuwana-id",
      "OKAYAMA": "ss-okayama-id",
      "NEW_DISTRICT_B": { spreadsheetId: "ss-b-id", enabled: true }
    };
    mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(fullReg);
    SpreadsheetResolver.getInstance().clearCache();
  }
});

// -----------------------------------------------------------------------------
// TEST 13: SpreadsheetResolver: 重複 openById 排除検証 (同一実行内キャッシュ & clearCache)
// -----------------------------------------------------------------------------
runTest("Scenario 13: SpreadsheetResolver による重複 openById 呼出の排除とキャッシュ完全性", () => {
  const resolver = SpreadsheetResolver.getInstance();
  resolver.clearCache();

  openByIdCallCount = 0;
  const ss1 = resolver.getSpreadsheet("KUWANA");
  const ss2 = resolver.getSpreadsheet("KUWANA");
  const ss3 = resolver.getSpreadsheet("KUWANA");

  assert.equal(openByIdCallCount, 1, `openById should be called exactly once for KUWANA, but got ${openByIdCallCount}`);
  assert.equal(ss1, ss2, "ss1 and ss2 must be the exact same reference");
  assert.equal(ss2, ss3, "ss2 and ss3 must be the exact same reference");
  assert.ok(resolver.spreadsheetCacheByDistrict["KUWANA"], "KUWANA cache key must exist in resolver");

  // 直接取得したモックインスタンスとの等価性
  assert.equal(ss1.getId(), kuwanaSS.getId(), "Resolved spreadsheet ID must match kuwanaSS ID");
  assert.equal(ss1.getName(), kuwanaSS.getName(), "Resolved spreadsheet Name must match kuwanaSS Name");

  // clearCache でキャッシュが破棄され、次回再取得時に openById が再度1回だけ呼ばれること
  resolver.clearCache();
  assert.equal(Object.keys(resolver.spreadsheetCacheByDistrict).length, 0, "Resolver cache must be empty after clearCache");
  const ss4 = resolver.getSpreadsheet("KUWANA");
  assert.equal(openByIdCallCount, 2, "openById must be invoked once more after clearCache");
  assert.equal(ss4.getId(), kuwanaSS.getId());
});

// -----------------------------------------------------------------------------
// TEST 14: Contract Cache: ScriptCache MISS ➔ HIT ➔ Invalidation & Direct-Read 等価性 & Fail-Closed
// -----------------------------------------------------------------------------
runTest("Scenario 14: Contract Cache (MISS ➔ HIT ➔ Invalidation サイクル、Direct-Read等価性、Fail-Closed)", () => {
  const sysInfoService = SystemInfoService.getInstance();
  const testNow = new Date("2026-10-01T00:00:00Z");

  // NEW_DISTRICT_B (Scenario 12 で作成済) に SYSTEM_INFO をセットアップ
  const ssNewB = mockSpreadsheets["ss-b-id"];
  ssNewB.name = "NEW_DISTRICT_B";
  let newBSysInfo = ssNewB.getSheetByName("SYSTEM_INFO");
  if (!newBSysInfo) newBSysInfo = ssNewB.addSheet("SYSTEM_INFO");
  newBSysInfo.rows = [
    ["項目", "設定値"],
    ["地区コード", "NEW_DISTRICT_B"],
    ["地区名", "新地区B"],
    ["運用モード", "SUBSCRIPTION"],
    ["契約終了日", "2026-10-31"]
  ];

  // 1. 初期状態: キャッシュ空 (MISS)
  mockCache.store.clear();
  const status1 = sysInfoService.getContractStatus(null, testNow, "NEW_DISTRICT_B");
  assert.equal(status1.status, 'ACTIVE');
  assert.equal(status1.fromCache, undefined, "First call must be Cache MISS");
  assert.equal(status1.endDate, '2026-10-31');
  assert.ok(mockCache.get("CONTRACT_STATUS_NEW_DISTRICT_B"), "Cache must be populated after MISS");

  // 2. 2回目: Cache HIT
  const status2 = sysInfoService.getContractStatus(null, testNow, "NEW_DISTRICT_B");
  assert.equal(status2.status, 'ACTIVE');
  assert.equal(status2.fromCache, true, "Second call must be Cache HIT");
  assert.equal(status2.endDate, '2026-10-31');

  // 3. Direct-Read パスとの結果完全等価性検証 (fromCache 以外のプロパティが完全一致)
  const directStatus = sysInfoService.getContractStatus(newBSysInfo, testNow, "NEW_DISTRICT_B");
  assert.equal(status2.status, directStatus.status, "Cache path and direct-read status must match");
  assert.equal(status2.isExpired, directStatus.isExpired, "Cache path and direct-read isExpired must match");
  assert.equal(status2.endDate, directStatus.endDate, "Cache path and direct-read endDate must match");
  assert.equal(status2.code, directStatus.code, "Cache path and direct-read code must match");
  assert.equal(status2.today, directStatus.today, "Cache path and direct-read today must match");

  // 4. 契約終了日変更 ➔ Invalidation (ssNewB.getName() === "NEW_DISTRICT_B" のため完全無効化)
  sysInfoService.setContractEndDate("2026-11-15", "NEW_DISTRICT_B");
  assert.equal(mockCache.get("CONTRACT_STATUS_NEW_DISTRICT_B"), null, "Cache must be invalidated after setContractEndDate");

  // 5. 変更後の次回呼出: 最新値取得 & Cache 再構築
  const status3 = sysInfoService.getContractStatus(null, testNow, "NEW_DISTRICT_B");
  assert.equal(status3.status, 'ACTIVE');
  assert.equal(status3.fromCache, undefined, "First call after invalidation must be MISS");
  assert.equal(status3.endDate, '2026-11-15', "Must reflect updated end date");

  // 6. Fail-Closed: 取得不能・破損時の安全側遮断
  mockCache.store.clear();
  const corruptedSS = new MockSpreadsheet("ss-broken-contract-id", "BROKEN_CONTRACT");
  mockSpreadsheets["ss-broken-contract-id"] = corruptedSS;
  const currentReg = JSON.parse(mockScriptProperties["DISTRICT_REGISTRY"]);
  currentReg["BROKEN_CONTRACT"] = "ss-broken-contract-id";
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(currentReg);
  SpreadsheetResolver.getInstance().clearCache();

  const failClosedStatus = sysInfoService.getContractStatus(null, testNow, "BROKEN_CONTRACT");
  assert.equal(failClosedStatus.status, 'EXPIRED', "Must fail-closed to EXPIRED on error");
  assert.equal(failClosedStatus.isExpired, true, "isExpired must be true on fail-closed");
  assert.equal(failClosedStatus.code, 'CONTRACT_CHECK_FAILED', "Error code must indicate failure");
});

// -----------------------------------------------------------------------------
// TEST 15: getRoster / fetchRankingData 等価性検証 (cachedRoster 有無の完全等価)
// -----------------------------------------------------------------------------
runTest("Scenario 15: getRoster / fetchRankingData による cachedRoster 最適化と計算完全等価性", () => {
  const distRepo = DistributionRepository.getInstance();
  const staffService = StaffService.getInstance();

  // KUWANA 地区の名簿を取得
  const roster = staffService.getRoster("KUWANA");
  assert.ok(Array.isArray(roster), "getRoster must return an array");
  assert.equal(roster.length, 2, "KUWANA roster must have 2 staff members");
  assert.equal(roster[0].id, "K001");
  assert.equal(roster[1].id, "K002");

  // cachedRoster なし (直接参照パス)
  const rankingWithoutCache = distRepo.fetchRankingData("U_KUWANA_001", "KUWANA", null);

  // cachedRoster あり (STEP 2 最適化パス)
  const rankingWithCache = distRepo.fetchRankingData("U_KUWANA_001", "KUWANA", roster);

  // 厳格な結果等価性の検証
  assert.deepEqual(rankingWithCache, rankingWithoutCache, "Ranking results with/without cachedRoster must be strictly identical");
  assert.equal(rankingWithCache.length, 1);
  assert.equal(rankingWithCache[0].staffId, "K001");
  assert.equal(rankingWithCache[0].count, 100);
  assert.equal(rankingWithCache[0].isMe, true);
});

// =============================================================================
// PRODUCTION REGRESSION SUITE: LINE User ID Identity & staffId Lifecycle
// =============================================================================

// テスト用独立地区セットアップ
const identityTestSS = new MockSpreadsheet("ss-id-test-id", "POSTING_MAP_IDENTITY_TEST");
const idTestSysInfo = identityTestSS.addSheet("SYSTEM_INFO");
idTestSysInfo.rows = [
  ["項目", "設定値"],
  ["地区コード", "IDENTITY_TEST"],
  ["地区名", "認証テスト地区"],
  ["運用モード", "SUBSCRIPTION"],
  ["管理パスワード", "pwd_id_test"],
  ["契約終了日", "2026-10-31"]
];
const idTestStaff = identityTestSS.addSheet("名簿2026-09");
idTestStaff.rows = [
  ["STAFF_ID", "氏名", "LINE_USER_ID", "登録日時"]
];
mockSpreadsheets["ss-id-test-id"] = identityTestSS;

const regBeforeTest = JSON.parse(PropertiesService.getScriptProperties().getProperty("DISTRICT_REGISTRY"));
regBeforeTest["IDENTITY_TEST"] = "ss-id-test-id";
PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", JSON.stringify(regBeforeTest));
SpreadsheetResolver.getInstance().clearCache();

// -----------------------------------------------------------------------------
// TEST 16: 当月最初の LINE User ID ➔ S001 新規採番
// -----------------------------------------------------------------------------
runTest("Scenario 16: 当月最初の LINE User ID ➔ S001 新規採番 (Production経路)", () => {
  const initialRowCount = idTestStaff.rows.length;
  assert.equal(initialRowCount, 1, "Initial roster must contain only header row");

  const req = {
    postData: {
      contents: JSON.stringify({
        action: "registerStaff",
        liffToken: "token_custom_user_1",
        districtId: "IDENTITY_TEST",
        lastName: "テスト太郎",
        firstName: "(LINE)"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);

  assert.equal(data.success, true, "registerStaff must succeed");
  assert.equal(data.id, "S001", "First staff in month must be assigned S001");
  assert.equal(data.message, "new", "Must be marked as new registration");
  assert.equal(idTestStaff.rows.length, 2, "One row must be appended");

  const row = idTestStaff.rows[1];
  assert.equal(row[0], "S001");
  assert.equal(row[1], "テスト太郎");
  assert.equal(row[2], "U_CUSTOM_user_1");
  assert.ok(row[3], "registeredAt must be populated");
});

// -----------------------------------------------------------------------------
// TEST 17: 次の別 LINE User ID ➔ S002 採番
// -----------------------------------------------------------------------------
runTest("Scenario 17: 次の別 LINE User ID ➔ S002 採番 (Production経路)", () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "registerStaff",
        liffToken: "token_custom_user_2",
        districtId: "IDENTITY_TEST",
        lastName: "テスト花子",
        firstName: "(LINE)"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);

  assert.equal(data.success, true, "registerStaff must succeed");
  assert.equal(data.id, "S002", "Second staff must be assigned S002");
  assert.equal(data.message, "new", "Must be marked as new registration");
  assert.equal(idTestStaff.rows.length, 3, "Total rows must now be 3");

  const row = idTestStaff.rows[2];
  assert.equal(row[0], "S002");
  assert.equal(row[1], "テスト花子");
  assert.equal(row[2], "U_CUSTOM_user_2");
});

// -----------------------------------------------------------------------------
// TEST 18: S001本人がキャッシュ削除後に再ログイン ➔ 既存S001復元 & 新規行不作成
// -----------------------------------------------------------------------------
runTest("Scenario 18: S001本人がキャッシュ削除後に再ログイン ➔ LINE User ID照合で既存S001復元 & 新規行不作成", () => {
  const rowCountBefore = idTestStaff.rows.length;

  // H-App の端末キャッシュ空での初回起動シーケンス (getStaffIdentity)
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "token_custom_user_1",
        districtId: "IDENTITY_TEST"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);

  assert.equal(data.success, true, "getStaffIdentity must succeed");
  assert.equal(data.registered, true, "Staff must be recognized as registered");
  assert.equal(data.staffId, "S001", "Must restore original staffId S001");
  assert.equal(data.staffName, "テスト太郎", "Must restore original staffName");
  assert.equal(idTestStaff.rows.length, rowCountBefore, "Roster row count must NOT increase on re-login");
});

// -----------------------------------------------------------------------------
// TEST 19: 同一 LINE User ID の再 registerStaff ➔ 二重登録防止 & 既存S001復元
// -----------------------------------------------------------------------------
runTest("Scenario 19: 同一 LINE User ID の再 registerStaff ➔ 二重登録防止 & 既存S001復元", () => {
  const rowCountBefore = idTestStaff.rows.length;

  const req = {
    postData: {
      contents: JSON.stringify({
        action: "registerStaff",
        liffToken: "token_custom_user_1",
        districtId: "IDENTITY_TEST",
        lastName: "テスト太郎（再入力）",
        firstName: "(LINE)"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);

  assert.equal(data.success, true, "registerStaff must succeed");
  assert.equal(data.id, "S001", "Must return existing S001");
  assert.equal(data.message, "existing", "Must indicate existing staff");
  assert.equal(idTestStaff.rows.length, rowCountBefore, "No duplicate row must be added");
});

// -----------------------------------------------------------------------------
// TEST 20: districtId 指定地区以外の名簿を変更しない (全行Snapshot & deepEqual完全不変)
// -----------------------------------------------------------------------------
runTest("Scenario 20: districtId 指定地区以外の名簿を変更しない (全行Snapshot & deepEqual完全不変)", () => {
  // 実行前の全対象地区名簿の全行Snapshotを取得
  const kuwanaSnapshot = JSON.parse(JSON.stringify(kuwanaStaff.rows));
  const okayamaSnapshot = JSON.parse(JSON.stringify(okayamaStaff.rows));
  const idTestSnapshot = JSON.parse(JSON.stringify(idTestStaff.rows));

  // OKAYAMA 地区宛てに新スタッフを登録
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "registerStaff",
        liffToken: "token_custom_okayama_user",
        districtId: "OKAYAMA",
        lastName: "岡山 新規",
        firstName: "(LINE)"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);

  assert.equal(data.success, true);
  assert.equal(data.message, "new");

  // OKAYAMA だけが +1
  assert.equal(okayamaStaff.rows.length, okayamaSnapshot.length + 1, "OKAYAMA roster must increment by 1");
  assert.equal(okayamaStaff.rows[okayamaStaff.rows.length - 1][2], "U_CUSTOM_okayama_user");

  // 他地区はセル値・行数を含め厳格に完全不変 (deepEqual)
  assert.deepEqual(kuwanaStaff.rows, kuwanaSnapshot, "KUWANA roster must remain strictly unmodified (deepEqual)");
  assert.deepEqual(idTestStaff.rows, idTestSnapshot, "IDENTITY_TEST roster must remain strictly unmodified (deepEqual)");
});

// -----------------------------------------------------------------------------
// TEST 21: districtId 欠落時は Fail-Closed ＆ 全地区名簿完全不変 (mutation 0)
// -----------------------------------------------------------------------------
runTest("Scenario 21: districtId 欠落時は Fail-Closed ＆ 全地区名簿完全不変 (mutation 0)", () => {
  // 実行前の全対象地区名簿の全行Snapshotを取得
  const kuwanaSnapshot = JSON.parse(JSON.stringify(kuwanaStaff.rows));
  const okayamaSnapshot = JSON.parse(JSON.stringify(okayamaStaff.rows));
  const idTestSnapshot = JSON.parse(JSON.stringify(idTestStaff.rows));

  const req = {
    postData: {
      contents: JSON.stringify({
        action: "registerStaff",
        liffToken: "token_custom_no_district",
        lastName: "欠落 太郎",
        firstName: "(LINE)"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);

  // MISSING_DISTRICT_ID の検証
  assert.equal(data.success, false, "Missing districtId must fail");
  assert.equal(data.code, "MISSING_DISTRICT_ID", "Must return MISSING_DISTRICT_ID code");

  // 全地区名簿が完全不変（mutation 0）であることを deepEqual で確認
  assert.deepEqual(kuwanaStaff.rows, kuwanaSnapshot, "KUWANA roster must have ZERO mutations on missing districtId");
  assert.deepEqual(okayamaStaff.rows, okayamaSnapshot, "OKAYAMA roster must have ZERO mutations on missing districtId");
  assert.deepEqual(idTestStaff.rows, idTestSnapshot, "IDENTITY_TEST roster must have ZERO mutations on missing districtId");
});

// -----------------------------------------------------------------------------
// TEST 22: 翌月は前月 staffId を引き継がず S001 から新規採番 (Productionコード実経路 & 9月不変検証)
// -----------------------------------------------------------------------------
runTest("Scenario 22: 翌月は前月 staffId を引き継がず S001 から新規採番 (Productionコード実経路 & 9月不変検証)", () => {
  // 1. 翌月 2026-10 の空名簿シートを IDENTITY_TEST に用意
  const octStaff = identityTestSS.addSheet("名簿2026-10");
  octStaff.rows = [
    ["STAFF_ID", "氏名", "LINE_USER_ID", "登録日時"]
  ];

  // 9月名簿のSnapshotを取得（実行前の完全状態）
  const septStaff = identityTestSS.getSheetByName("名簿2026-09");
  const septSnapshot = JSON.parse(JSON.stringify(septStaff.rows));

  // 2. 時刻モックを 2026-10 に設定
  const originalDate = global.Date;
  const mockOctDate = new originalDate("2026-10-05T10:00:00+09:00");
  class MockDate202610 extends originalDate {
    constructor(...args) {
      if (args.length === 0) {
        super(mockOctDate.getTime());
      } else {
        super(...args);
      }
    }
    static now() {
      return mockOctDate.getTime();
    }
  }

  global.Date = MockDate202610;

  try {
    // 3. 9月に S001 だった同じ LINE User ID (token_custom_user_1 / U_CUSTOM_user_1) を 10月に登録
    // doPost ➔ processPostAction ➔ StaffService ➔ StaffRepository ➔ MonthlySheetResolver の Production 経路を通過
    const req = {
      postData: {
        contents: JSON.stringify({
          action: "registerStaff",
          liffToken: "token_custom_user_1",
          districtId: "IDENTITY_TEST",
          lastName: "テスト太郎（10月新任）",
          firstName: "(LINE)"
        })
      }
    };
    const res = doPost(req);
    const data = JSON.parse(res.text);

    // 4. 検証: 10月 = S001, message = new, 10月名簿に1行追加, 9月名簿は完全不変
    assert.equal(data.success, true, "registerStaff in October must succeed");
    assert.equal(data.id, "S001", "10月名簿では前月staffIdを引き継がずS001から新規採番されること");
    assert.equal(data.message, "new", "Must be marked as new registration for October");

    // 10月名簿に 1行追加されていること (ヘッダー1行 + データ1行 = 2行)
    assert.equal(octStaff.rows.length, 2, "October roster must have exactly 1 new row appended");
    assert.equal(octStaff.rows[1][0], "S001");
    assert.equal(octStaff.rows[1][1], "テスト太郎（10月新任）");
    assert.equal(octStaff.rows[1][2], "U_CUSTOM_user_1");

    // 9月名簿は完全不変であること
    assert.deepEqual(septStaff.rows, septSnapshot, "September roster must remain strictly unmodified (deepEqual)");
  } finally {
    // 5. テスト終了後は時刻モック等を必ず復元
    global.Date = originalDate;
  }
});

// -----------------------------------------------------------------------------
// TEST 23: Principal Override 防御 (認証A + Client偽装user B ➔ 最終操作主体はAに固定)
// -----------------------------------------------------------------------------
runTest("Scenario 23: Principal Override 防御 (認証A + Client偽装user B ➔ 最終操作主体はAに固定)", () => {
  // 1. getStaffIdentity: 認証A (token_custom_user_1 / U_CUSTOM_user_1 / S001 テスト太郎)
  //    Client入力 parameter.json.user = B (U_CUSTOM_user_2 / S002 テスト花子) を偽装送信
  const req1 = {
    parameter: {
      json: JSON.stringify({
        user: { lineUserId: "U_CUSTOM_user_2" }
      })
    },
    postData: {
      contents: JSON.stringify({
        action: "getStaffIdentity",
        liffToken: "token_custom_user_1",
        districtId: "IDENTITY_TEST"
      })
    }
  };
  const res1 = doPost(req1);
  const data1 = JSON.parse(res1.text);

  assert.equal(data1.success, true, "getStaffIdentity must succeed");
  assert.equal(data1.registered, true, "Staff must be recognized as registered");
  assert.equal(data1.staffId, "S001", "Client偽装 user B が送られても、認証A (S001) の Identity が返されること");
  assert.equal(data1.staffName, "テスト太郎", "Client偽装 user B が送られても、認証A (テスト太郎) の 名前が返されること");

  // 2. updateFlyerStock: 認証A + parameter.json / contents にて user/staffId/staffName=B 偽装
  //    MockSheet「保有チラシ枚数2026-09」への永続化結果が A であることを検証
  const flyerSheet = identityTestSS.addSheet("保有チラシ枚数2026-09");
  flyerSheet.rows = [
    ["ID", "配布員ID", "配布員名", "保管場所", "枚数", "更新日時", "LINE_USER_ID"]
  ];

  const req2 = {
    parameter: {
      json: JSON.stringify({
        user: { lineUserId: "U_CUSTOM_user_2" },
        staffId: "S002",
        staffName: "テスト花子"
      })
    },
    postData: {
      contents: JSON.stringify({
        action: "updateFlyerStock",
        liffToken: "token_custom_user_1",
        districtId: "IDENTITY_TEST",
        location: "テスト保管所A",
        count: 500,
        staffId: "S002",
        staffName: "テスト花子"
      })
    }
  };
  const res2 = doPost(req2);
  const data2 = JSON.parse(res2.text);

  assert.equal(data2.success, true, "updateFlyerStock must succeed");
  assert.equal(flyerSheet.rows.length, 2, "保有チラシ枚数シートに1行追加されていること");

  const savedRow = flyerSheet.rows[1];
  assert.equal(savedRow[1], "S001", "永続化された配布員IDは認証A (S001) であること");
  assert.equal(savedRow[2], "テスト太郎", "永続化された配布員名は認証A (テスト太郎) であること");
  assert.equal(savedRow[3], "テスト保管所A", "保管場所が一致すること");
  assert.equal(savedRow[4], 500, "枚数が一致すること");
  assert.equal(savedRow[6], "U_CUSTOM_user_1", "永続化されたLINE_USER_IDは認証A (U_CUSTOM_user_1) であること");
});

// -----------------------------------------------------------------------------
// TEST 24: District Context Propagation & Drive Isolation / Fail-Closed
// -----------------------------------------------------------------------------
runTest("Scenario 24: District Context Propagation & Drive Isolation / Fail-Closed (KUWANA写真→KUWANA folderのみ、OKAYAMA mutation 0、欠損Fail-Closed)", () => {
  // 1. getStorageFolderId(districtId) 契約の全数検証
  // 1-1. districtIdあり + DISTRICT_REGISTRYあり → 地区別 storageFolderId を厳格解決
  PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", JSON.stringify({
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true },
    "DISABLED_DIST": { spreadsheetId: "ss-disabled-id", storageFolderId: "folder_disabled_id", enabled: false },
    "NO_FOLDER_DIST": { spreadsheetId: "ss-no-folder-id", storageFolderId: "", enabled: true },
    "IDENTITY_TEST": { spreadsheetId: "ss-id-test-id", storageFolderId: "folder_id_test_id", enabled: true }
  }));
  PropertiesService.getScriptProperties().setProperty("STORAGE_PARENT_ID", "legacy_global_folder_id");

  // 正常解決
  assert.equal(getStorageFolderId("KUWANA"), "folder_kuwana_id", "KUWANA folder must resolve strictly to folder_kuwana_id");
  assert.equal(getStorageFolderId("OKAYAMA"), "folder_okayama_id", "OKAYAMA folder must resolve strictly to folder_okayama_id");

  // Fail-Closed 検証 (global fallback 禁止)
  assert.throws(() => getStorageFolderId("UNKNOWN_DIST"), /not found in DISTRICT_REGISTRY/, "Unknown district must throw (no fallback)");
  assert.throws(() => getStorageFolderId("DISABLED_DIST"), /disabled in DISTRICT_REGISTRY/, "Disabled district must throw (no fallback)");
  assert.throws(() => getStorageFolderId("NO_FOLDER_DIST"), /storageFolderId is missing/, "Missing folderId must throw (no fallback)");

  // Registry JSON 破損時の Fail-Closed
  PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", "{ corrupted json");
  assert.throws(() => getStorageFolderId("KUWANA"), /DISTRICT_REGISTRY is corrupted/, "Corrupted registry must throw (no fallback)");

  // 1-2. districtIdあり + DISTRICT_REGISTRYなし (null) → 旧単一地区互換として STORAGE_PARENT_ID fallback
  delete mockScriptProperties["DISTRICT_REGISTRY"];
  assert.equal(getStorageFolderId("KUWANA"), "legacy_global_folder_id", "Legacy single district must fallback to STORAGE_PARENT_ID when registry missing");

  // 1-3. districtIdなし + DISTRICT_REGISTRYなし (null) → 既存Scheduler互換として STORAGE_PARENT_ID を維持
  assert.equal(getStorageFolderId(""), "legacy_global_folder_id", "District-less call must resolve to STORAGE_PARENT_ID in legacy mode");
  assert.equal(getStorageFolderId(null), "legacy_global_folder_id", "Null district call must resolve to STORAGE_PARENT_ID in legacy mode");

  // 2. 実経路検証: updateRecordWithGPSPhoto 経由の Drive Isolation & DB Isolation
  // レジストリを正常状態に再設定
  PropertiesService.getScriptProperties().setProperty("DISTRICT_REGISTRY", JSON.stringify({
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true },
    "NO_FOLDER_DIST": { spreadsheetId: "ss-no-folder-id", storageFolderId: "", enabled: true },
    "IDENTITY_TEST": { spreadsheetId: "ss-id-test-id", storageFolderId: "folder_id_test_id", enabled: true }
  }));
  SpreadsheetResolver.getInstance().clearCache();

  // NO_FOLDER_DIST 用のモックスプレッドシート作成
  const noFolderSS = new MockSpreadsheet("ss-no-folder-id", "POSTING_MAP_NO_FOLDER");
  const noFolderSysInfo = noFolderSS.addSheet("SYSTEM_INFO");
  noFolderSysInfo.rows = [
    ["項目", "設定値"],
    ["地区コード", "NO_FOLDER_DIST"],
    ["地区名", "フォルダなし地区"],
    ["運用モード", "SUBSCRIPTION"],
    ["契約終了日", "2026-10-31"]
  ];
  const noFolderStaff = noFolderSS.addSheet(distSheetName ? staffSheetName : "名簿2026-09");
  noFolderStaff.rows = [
    ["STAFF_ID", "氏名", "LINE_USER_ID", "登録日時"],
    ["N001", "試験 花子", "U_CUSTOM_nofolder_user", "2026/09/01"]
  ];
  const noFolderDist = noFolderSS.addSheet(distSheetName);
  noFolderDist.rows = [
    ["rowId", "cityName", "townName", "completedAt", "count", "staffId", "staffName", "", "", "", "", "", "", "", "", "lineUserId"],
    ["1", "試験市", "町域1", "", 0, "", "", "", "", "", "", "", "", "", "", ""]
  ];
  mockSpreadsheets["ss-no-folder-id"] = noFolderSS;

  // 各フォルダの初期化
  mockDriveFolders["folder_kuwana_id"] = createMockDriveFolderObj("folder_kuwana_id");
  mockDriveFolders["folder_okayama_id"] = createMockDriveFolderObj("folder_okayama_id");
  mockDriveFolders["legacy_global_folder_id"] = createMockDriveFolderObj("legacy_global_folder_id");
  if (!mockDriveFolders["folder_disabled_id"]) {
    mockDriveFolders["folder_disabled_id"] = createMockDriveFolderObj("folder_disabled_id");
  }

  // 全Snapshot取得
  const okayamaDistSnapshot = JSON.parse(JSON.stringify(okayamaDist.rows));
  const okayamaStaffSnapshot = JSON.parse(JSON.stringify(okayamaStaff.rows));

  // 桑名に未完了行 rowId 2 を追加
  kuwanaDist.rows.push(["2", "桑名市", "中央町2", "", 0, "", "", "", "", "", "", "", "", "", "", ""]);

  // 2-1. KUWANA 写真アップロードの実行
  const kuwanaGpsReq = {
    postData: {
      contents: JSON.stringify({
        action: "updateRecordWithGPSPhoto",
        liffToken: "token_kuwana_user1",
        districtId: "KUWANA",
        rowId: 2,
        lat: 35.06,
        lng: 136.68,
        gpsStatus: "OK",
        count: 120,
        isDone: true,
        photoData: "data:image/jpeg;base64," + Buffer.from("fake_kuwana_photo_bytes").toString("base64")
      })
    }
  };

  const kuwanaRes = doPost(kuwanaGpsReq);
  const kuwanaData = JSON.parse(kuwanaRes.text);

  assert.equal(kuwanaData.success, true, "KUWANA updateRecordWithGPSPhoto must succeed");
  assert.equal(kuwanaData.photoStatus, "OK", "Photo upload must succeed for KUWANA");

  // Drive 隔離検証:
  assert.equal(mockDriveFolders["folder_kuwana_id"].files.length, 1, "KUWANA folder must receive exactly 1 file");
  assert.equal(mockDriveFolders["folder_okayama_id"].files.length, 0, "OKAYAMA folder mutation must be ZERO (Drive isolation)");
  assert.equal(mockDriveFolders["legacy_global_folder_id"].files.length, 0, "Global legacy folder mutation must be ZERO");

  // DB 隔離検証:
  assert.deepEqual(okayamaDist.rows, okayamaDistSnapshot, "OKAYAMA distribution sheet must have ZERO mutations");
  assert.deepEqual(okayamaStaff.rows, okayamaStaffSnapshot, "OKAYAMA staff sheet must have ZERO mutations");

  // 桑名の実績行が更新されていること
  assert.equal(kuwanaDist.rows[2][3], "2026/09/20 12:00:00", "completedAt updated");
  assert.equal(kuwanaDist.rows[2][4], 120, "count updated to 120");
  assert.equal(kuwanaDist.rows[2][5], "K001", "staffId is K001");
  assert.equal(kuwanaDist.rows[2][6], "桑名 太郎", "staffName is 桑名 太郎");
  assert.equal(kuwanaDist.rows[2][8], "OK", "photoStatus is OK");
  assert.equal(kuwanaDist.rows[2][15], "U_KUWANA_001", "lineUserId is U_KUWANA_001");

  // 2-2. storageFolderId 欠損地区の写真アップロード (Drive Fail-Closed & 業務継続実証)
  const noFolderFilesBefore = {
    kuwana: mockDriveFolders["folder_kuwana_id"].files.length,
    okayama: mockDriveFolders["folder_okayama_id"].files.length,
    global: mockDriveFolders["legacy_global_folder_id"].files.length
  };

  const noFolderReq = {
    postData: {
      contents: JSON.stringify({
        action: "updateRecordWithGPSPhoto",
        liffToken: "token_custom_nofolder_user",
        districtId: "NO_FOLDER_DIST",
        rowId: 1,
        lat: 35.10,
        lng: 136.70,
        gpsStatus: "OK",
        count: 80,
        isDone: true,
        photoData: "data:image/jpeg;base64," + Buffer.from("fake_no_folder_photo").toString("base64")
      })
    }
  };

  const noFolderRes = doPost(noFolderReq);
  const noFolderData = JSON.parse(noFolderRes.text);

  // 業務継続仕様: 写真保存失敗時もスプレッドシート実績行は保存される
  assert.equal(noFolderData.success, true, "Spreadsheet update must succeed despite Drive fail-closed (business continuity)");
  assert.equal(noFolderData.photoStatus, "NO", "photoStatus must be NO when storageFolderId missing (fail-closed)");

  // 全フォルダに対する mutation 0 (wrong-folder write 0)
  assert.equal(mockDriveFolders["folder_kuwana_id"].files.length, noFolderFilesBefore.kuwana, "KUWANA folder must have ZERO mutation on missing folder");
  assert.equal(mockDriveFolders["folder_okayama_id"].files.length, noFolderFilesBefore.okayama, "OKAYAMA folder must have ZERO mutation on missing folder");
  assert.equal(mockDriveFolders["legacy_global_folder_id"].files.length, noFolderFilesBefore.global, "Global folder must have ZERO mutation on missing folder (no fallback)");

  // NO_FOLDER_DIST の実績行は正常に保存されていること
  assert.equal(noFolderDist.rows[1][4], 80, "count updated to 80");
  assert.equal(noFolderDist.rows[1][8], "NO", "photoStatus in sheet must be NO");
});

// -----------------------------------------------------------------------------
// TEST 25: Provisioning Blast Radius 固定 ＆ 月次 rollover 全有効地区実行・片肺障害隔離
// -----------------------------------------------------------------------------
runTest("Scenario 25: Provisioning Blast Radius 固定 ＆ 月次 rollover 全有効地区実行・片肺障害隔離", () => {
  const resolver = SpreadsheetResolver.getInstance();
  resolver.clearCache();

  // 1. テスト用スプレッドシート初期化
  const ssKuwana = mockSpreadsheets["ss-kuwana-id"];
  const ssOkayama = mockSpreadsheets["ss-okayama-id"];

  // 原本5種を準備
  const masterNames = ["配布実績の原本", "名簿の原本", "保有チラシ枚数の原本", "受渡要請履歴の原本", "PinStatusの原本"];
  masterNames.forEach(mName => {
    if (!ssKuwana.getSheetByName(mName)) {
      const s = ssKuwana.addSheet(mName);
      s.appendRow(["header1", "header2"]);
      s.appendRow(["data1", "data2"]);
    }
    if (!ssOkayama.getSheetByName(mName)) {
      const s = ssOkayama.addSheet(mName);
      s.appendRow(["header1", "header2"]);
      s.appendRow(["data1", "data2"]);
    }
  });

  // 当月 5 シートを準備 (5/5 整合状態)
  const currentMonthSheets = ["配布実績2026-09", "名簿2026-09", "保有チラシ枚数2026-09", "受渡要請履歴2026-09", "PinStatus2026-09"];
  currentMonthSheets.forEach(name => {
    if (!ssKuwana.getSheetByName(name)) ssKuwana.addSheet(name);
    if (!ssOkayama.getSheetByName(name)) ssOkayama.addSheet(name);
  });

  // 当月 PinStatus に IN_PROGRESS データをセット
  const kuwanaPin = ssKuwana.getSheetByName("PinStatus2026-09");
  kuwanaPin.rows = [["rowId", "status"], ["row1", "IN_PROGRESS"], ["row2", "IN_PROGRESS"]];

  const okayamaPin = ssOkayama.getSheetByName("PinStatus2026-09");
  okayamaPin.rows = [["rowId", "status"], ["rowA", "IN_PROGRESS"], ["rowB", "IN_PROGRESS"]];
  const okayamaPinSnapshot = JSON.parse(JSON.stringify(okayamaPin.rows));

  // 1-1. KUWANA のみ Provision 実行 ➔ OKAYAMA の PinStatus は完全不変 (mutation 0) を実証
  const sampleAddresses = [{ rowId: 1, cityName: "桑名市", townName: "大山田" }];
  const provResult = DistrictProvisioner.getInstance().provisionNewDistrict(
    sampleAddresses,
    { provisioningToken: validToken, targetSpreadsheetId: "ss-kuwana-id", operationMode: "SUBSCRIPTION", targetMonth: "2026-09" },
    "KUWANA"
  );
  assert.equal(provResult.success, true, "provisionNewDistrict for KUWANA must succeed");

  // KUWANA の PinStatus はクリアされヘッダーのみ残存
  assert.equal(kuwanaPin.rows.length, 1, "KUWANA PinStatus data rows must be cleared");
  // OKAYAMA の PinStatus は完全不変 (mutation 0)
  assert.deepEqual(okayamaPin.rows, okayamaPinSnapshot, "OKAYAMA PinStatus must have ZERO mutations when provisioning KUWANA (Blast Radius fixed)");

  // 1-2. disabled 新地区 (NEW_DIST_DISABLED, enabled: false) のプロビジョニング検証
  const ssDisabledNew = new MockSpreadsheet("ss-disabled-new-id", "POSTING_MAP_NEW_DIST_DISABLED");
  mockSpreadsheets["ss-disabled-new-id"] = ssDisabledNew;
  const disabledProvResult = DistrictProvisioner.getInstance().provisionNewDistrict(
    sampleAddresses,
    {
      provisioningToken: validToken,
      targetSpreadsheetId: "ss-disabled-new-id",
      operationMode: "SUBSCRIPTION",
      targetMonth: "2026-09",
      baseUrl: "https://explicit-disabled.example"
    },
    "NEW_DIST_DISABLED"
  );
  assert.equal(disabledProvResult.success, true, "provisionNewDistrict must succeed for disabled new district via explicit targetSpreadsheetId");
  assert.ok(ssDisabledNew.getSheetByName("SYSTEM_INFO"), "SYSTEM_INFO must be created in disabled district");
  assert.ok(ssDisabledNew.getSheetByName("配布実績2026-09"), "Operational dataset sheet must be created in disabled district");

  // 1-3. 月次 rollover 全有効地区実行 (rolloverMonthlySheetsDailyCheck)
  // DISTRICT_REGISTRY: KUWANA enabled, OKAYAMA enabled, DISABLED_DIST disabled
  const registryFixture = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true },
    "DISABLED_DIST": { spreadsheetId: "ss-disabled-id", storageFolderId: "folder_disabled_id", enabled: false }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(registryFixture);
  resolver.clearCache();

  // DISABLED_DIST のスプレッドシート
  const ssDisabled = new MockSpreadsheet("ss-disabled-id", "POSTING_MAP_DISABLED_DIST");
  mockSpreadsheets["ss-disabled-id"] = ssDisabled;
  masterNames.forEach(m => {
    const s = ssDisabled.addSheet(m);
    s.appendRow(["h1", "h2"]);
  });

  // 日次トリガー実行
  rolloverMonthlySheetsDailyCheck();

  // KUWANA と OKAYAMA に当月 5 シートが存在すること
  const checkTypes = ["配布実績2026-09", "名簿2026-09", "保有チラシ枚数2026-09", "受渡要請履歴2026-09", "PinStatus2026-09"];
  checkTypes.forEach(sheetName => {
    assert.ok(ssKuwana.getSheetByName(sheetName), `KUWANA must have ${sheetName}`);
    assert.ok(ssOkayama.getSheetByName(sheetName), `OKAYAMA must have ${sheetName}`);
  });

  // DISABLED_DIST には作成されないこと (mutation 0)
  checkTypes.forEach(sheetName => {
    assert.equal(ssDisabled.getSheetByName(sheetName), null, `DISABLED_DIST must NOT have ${sheetName} (mutation 0)`);
  });

  // 1-4. 片肺障害隔離検証: CORRUPT_DIST (3/5 破損) と OKAYAMA (0/5)
  const ssCorrupt = new MockSpreadsheet("ss-corrupt-id", "POSTING_MAP_CORRUPT_DIST");
  mockSpreadsheets["ss-corrupt-id"] = ssCorrupt;
  const corruptSys = ssCorrupt.addSheet("SYSTEM_INFO");
  corruptSys.rows = [["項目", "設定値"], ["地区コード", "CORRUPT_DIST"], ["運用モード", "SUBSCRIPTION"]];
  masterNames.forEach(m => {
    const s = ssCorrupt.addSheet(m);
    s.appendRow(["h1", "h2"]);
  });
  // 3シートのみ作成 (破損状態)
  ssCorrupt.addSheet("配布実績2026-09");
  ssCorrupt.addSheet("名簿2026-09");
  ssCorrupt.addSheet("保有チラシ枚数2026-09");
  const corruptSheetsCountBefore = ssCorrupt.getSheets().length;

  const corruptReg = {
    "CORRUPT_DIST": { spreadsheetId: "ss-corrupt-id", storageFolderId: "folder_corrupt_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(corruptReg);
  resolver.clearCache();

  // 実行: CORRUPT_DIST は Fail-Closed、OKAYAMA は継続実行
  rolloverMonthlySheetsDailyCheck();

  // CORRUPT_DIST は一切変更されていないこと (mutation 0)
  assert.equal(ssCorrupt.getSheets().length, corruptSheetsCountBefore, "CORRUPT_DIST must have ZERO mutations on partial corruption");
  assert.equal(ssCorrupt.getSheetByName("受渡要請履歴2026-09"), null, "Missing sheet must not be created (fail-closed)");
});

// -----------------------------------------------------------------------------
// TEST 26: PinStatus cleanup の全地区 Trigger 実行と地区分離
// -----------------------------------------------------------------------------
runTest("Scenario 26: PinStatus cleanup の全地区 Trigger 実行と地区分離", () => {
  const ssKuwana = mockSpreadsheets["ss-kuwana-id"];
  const ssOkayama = mockSpreadsheets["ss-okayama-id"];
  const ssDisabled = mockSpreadsheets["ss-disabled-id"] || (mockSpreadsheets["ss-disabled-id"] = new MockSpreadsheet("ss-disabled-id", "POSTING_MAP_DISABLED_DIST"));

  const pinKuwana = ssKuwana.getSheetByName("PinStatus2026-09");
  pinKuwana.rows = [["rowId", "status"], ["k1", "IN_PROGRESS"], ["k2", "IN_PROGRESS"]];

  const pinOkayama = ssOkayama.getSheetByName("PinStatus2026-09");
  pinOkayama.rows = [["rowId", "status"], ["o1", "IN_PROGRESS"], ["o2", "IN_PROGRESS"], ["o3", "IN_PROGRESS"]];

  const pinDisabled = ssDisabled.addSheet("PinStatus2026-09");
  pinDisabled.rows = [["rowId", "status"], ["d1", "IN_PROGRESS"]];

  // 配布実績シートの行数 snapshot
  const distKuwana = ssKuwana.getSheetByName("配布実績2026-09");
  const distKuwanaRowsBefore = distKuwana ? distKuwana.rows.length : 0;

  const reg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true },
    "DISABLED_DIST": { spreadsheetId: "ss-disabled-id", storageFolderId: "folder_disabled_id", enabled: false }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(reg);
  SpreadsheetResolver.getInstance().clearCache();

  // Trigger 実行
  cleanupPinStatusDaily();

  // KUWANA / OKAYAMA の PinStatus データ行が削除され、ヘッダーのみ残存
  assert.equal(pinKuwana.rows.length, 1, "KUWANA PinStatus data rows cleared");
  assert.deepEqual(pinKuwana.rows[0], ["rowId", "status"], "KUWANA PinStatus header preserved");

  assert.equal(pinOkayama.rows.length, 1, "OKAYAMA PinStatus data rows cleared");
  assert.deepEqual(pinOkayama.rows[0], ["rowId", "status"], "OKAYAMA PinStatus header preserved");

  // 配布実績シートには一切触れていないこと (完全不可侵)
  if (distKuwana) {
    assert.equal(distKuwana.rows.length, distKuwanaRowsBefore, "Distribution sheet rows must not be touched");
  }

  // DISABLED_DIST は除外され変更なし (mutation 0)
  assert.equal(pinDisabled.rows.length, 2, "DISABLED_DIST PinStatus must NOT be cleared (mutation 0)");
});

// -----------------------------------------------------------------------------
// TEST 27: Drive cleanup の地区分離と mutation 0 保証
// -----------------------------------------------------------------------------
runTest("Scenario 27: Drive cleanup の地区分離と mutation 0 保証", () => {
  const folderKuwana = DriveApp.getFolderById("folder_kuwana_id");
  const folderOkayama = DriveApp.getFolderById("folder_okayama_id");
  const folderDisabled = DriveApp.getFolderById("folder_disabled_id");

  // ファイル配置: 35日前の写真 (古い)
  const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
  const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  const fKuwanaOld = folderKuwana.createFile({ getName: () => "k_old.jpg" });
  fKuwanaOld.created = oldDate;
  const fKuwanaFresh = folderKuwana.createFile({ getName: () => "k_fresh.jpg" });
  fKuwanaFresh.created = freshDate;

  const fOkayamaOld = folderOkayama.createFile({ getName: () => "o_old.jpg" });
  fOkayamaOld.created = oldDate;

  const fDisabledOld = folderDisabled.createFile({ getName: () => "d_old.jpg" });
  fDisabledOld.created = oldDate;

  const reg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true },
    "DISABLED_DIST": { spreadsheetId: "ss-disabled-id", storageFolderId: "folder_disabled_id", enabled: false }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(reg);

  // cleanupOldPhotosBatch 実行
  cleanupOldPhotosBatch();

  // KUWANA の古い写真のみ trashed
  assert.equal(fKuwanaOld.isTrashed(), true, "KUWANA old photo must be trashed");
  assert.equal(fKuwanaFresh.isTrashed(), false, "KUWANA fresh photo must not be trashed");

  // OKAYAMA の古い写真のみ trashed
  assert.equal(fOkayamaOld.isTrashed(), true, "OKAYAMA old photo must be trashed");

  // DISABLED_DIST は処理されずゴミ箱に入らない (mutation 0)
  assert.equal(fDisabledOld.isTrashed(), false, "DISABLED_DIST photo must NOT be trashed (mutation 0)");
});

// -----------------------------------------------------------------------------
// TEST 28: getStorageFolderId() の空 districtId Fail-Closed & 存在判定統一
// -----------------------------------------------------------------------------
runTest("Scenario 28: getStorageFolderId() の空 districtId Fail-Closed & 存在判定統一", () => {
  const reg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(reg);

  // 1. DISTRICT_REGISTRY 設定時に空 districtId ➔ 例外スロー (global fallback 禁止)
  assert.throws(() => {
    getStorageFolderId("");
  }, /districtId is required for multi-district drive resolution/, "Empty districtId must throw when registry configured");

  // 2. DISTRICT_REGISTRY が空文字 ➔ configured-corrupt (例外スロー)
  mockScriptProperties["DISTRICT_REGISTRY"] = "   ";
  assert.throws(() => {
    getStorageFolderId("KUWANA");
  }, /DISTRICT_REGISTRY is configured but empty/, "Whitespace registry must throw corrupted");

  // 3. DISTRICT_REGISTRY 未設定 (null) ➔ STORAGE_PARENT_ID fallback
  delete mockScriptProperties["DISTRICT_REGISTRY"];
  mockScriptProperties["STORAGE_PARENT_ID"] = "fallback_folder_id";
  const fallbackId = getStorageFolderId("");
  assert.equal(fallbackId, "fallback_folder_id", "null registry must fallback to STORAGE_PARENT_ID");
});

// -----------------------------------------------------------------------------
// TEST 29: getEnabledDistricts() の厳格状態区分 & Registry 破損時の Fail-Closed
// -----------------------------------------------------------------------------
runTest("Scenario 29: getEnabledDistricts() の厳格状態区分 & Registry 破損時の Fail-Closed", () => {
  const resolver = SpreadsheetResolver.getInstance();

  // 1. 未設定 (null) ➔ null
  delete mockScriptProperties["DISTRICT_REGISTRY"];
  assert.equal(resolver.getEnabledDistricts(), null, "Unconfigured registry must return null (Legacy)");

  // 2. 空文字 ➔ 例外スロー
  mockScriptProperties["DISTRICT_REGISTRY"] = "";
  assert.throws(() => {
    resolver.getEnabledDistricts();
  }, /DISTRICT_REGISTRY is configured but empty/, "Empty string registry must throw");

  // 3. 設定済みだが有効地区 0 件 ({}) ➔ []
  mockScriptProperties["DISTRICT_REGISTRY"] = "{}";
  assert.deepEqual(resolver.getEnabledDistricts(), [], "Empty object registry must return []");

  // 4. 全地区 disabled ➔ []
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify({
    "DIST_A": { spreadsheetId: "ss-a", enabled: false },
    "DIST_B": { spreadsheetId: "ss-b", enabled: false }
  });
  assert.deepEqual(resolver.getEnabledDistricts(), [], "All-disabled registry must return []");

  // 5. 破損 JSON ➔ 例外スロー
  mockScriptProperties["DISTRICT_REGISTRY"] = "{bad_json";
  assert.throws(() => {
    resolver.getEnabledDistricts();
  }, /DISTRICT_REGISTRY is corrupted/, "Corrupted JSON registry must throw");
});

// -----------------------------------------------------------------------------
// TEST 30: setupRosterSheet(districtId) および v2_api Provisioning 経路の明示的伝播
// -----------------------------------------------------------------------------
runTest("Scenario 30: setupRosterSheet(districtId) および v2_api Provisioning 経路の明示的伝播", () => {
  const reg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(reg);
  SpreadsheetResolver.getInstance().clearCache();

  // 1. resetRoster アクションの特権認証 & districtId 伝播
  // 1a. 一般Staff liffToken のみ => 拒絶 (UNAUTHORIZED)
  const staffResetReq = {
    postData: {
      contents: JSON.stringify({
        action: "resetRoster",
        districtId: "OKAYAMA",
        liffToken: "token_okayama_user1"
      })
    }
  };
  const staffResetRes = doPost(staffResetReq);
  const staffResetData = JSON.parse(staffResetRes.text);
  assert.equal(staffResetData.success, false, "resetRoster without provisioningToken must be rejected");
  assert.equal(staffResetData.code, "UNAUTHORIZED");

  // 1b. 有効な provisioningToken 付与 => 成功 & OKAYAMA ロスター再作成
  const privResetReq = {
    postData: {
      contents: JSON.stringify({
        action: "resetRoster",
        districtId: "OKAYAMA",
        provisioningToken: validToken
      })
    }
  };
  const privResetRes = doPost(privResetReq);
  const privResetData = JSON.parse(privResetRes.text);
  assert.equal(privResetData.success, true, "resetRoster with valid provisioningToken for OKAYAMA must succeed");

  // 2. syncSystemInfo の POST 専用性 & districtId 伝播
  // テスト側 KUWANA SYSTEM_INFO fixture に事前設定 (新契約: HアプリURL Authority & 運用モード保証)
  const kSS = mockSpreadsheets["ss-kuwana-id"];
  let kSysSheet = kSS.getSheetByName("SYSTEM_INFO");
  if (!kSysSheet) {
    kSysSheet = kSS.addSheet("SYSTEM_INFO");
  }
  let hasHAppUrl = false;
  let hasOpMode = false;
  for (let r = 0; r < kSysSheet.rows.length; r++) {
    if (kSysSheet.rows[r][0] === "HアプリURL") {
      kSysSheet.rows[r][1] = "https://kuwana.postingmap.jp/";
      hasHAppUrl = true;
    }
    if (kSysSheet.rows[r][0] === "運用モード") {
      kSysSheet.rows[r][1] = "SUBSCRIPTION";
      hasOpMode = true;
    }
  }
  if (!hasHAppUrl) kSysSheet.rows.push(["HアプリURL", "https://kuwana.postingmap.jp/"]);
  if (!hasOpMode) kSysSheet.rows.push(["運用モード", "SUBSCRIPTION"]);

  // 2a. doGet 経由 => METHOD_NOT_ALLOWED で拒絶
  const getSysReq = {
    parameter: {
      action: "syncSystemInfo",
      provisioningToken: validToken,
      districtId: "KUWANA"
    }
  };
  const getSysRes = doGet(getSysReq);
  const getSysData = JSON.parse(getSysRes.text);
  assert.equal(getSysData.success, false, "doGet syncSystemInfo must fail");
  assert.equal(getSysData.code, "METHOD_NOT_ALLOWED", "doGet syncSystemInfo must return METHOD_NOT_ALLOWED");

  // 2b. doPost 経由 => 成功 & KUWANA SYSTEM_INFO 同期
  const postSysReq = {
    postData: {
      contents: JSON.stringify({
        action: "syncSystemInfo",
        provisioningToken: validToken,
        districtId: "KUWANA"
      })
    }
  };
  const postSysRes = doPost(postSysReq);
  const postSysData = JSON.parse(postSysRes.text);
  assert.equal(postSysData.success, true, "doPost syncSystemInfo for KUWANA must succeed");
});

// -----------------------------------------------------------------------------
// TEST 31: action=healSchemaHeaders の POST 専用性（GET 拒否 & METHOD_NOT_ALLOWED）
// -----------------------------------------------------------------------------
runTest("Scenario 31: action=healSchemaHeaders および runIdentityMigration の POST 専用性", () => {
  // 1. doGet healSchemaHeaders -> METHOD_NOT_ALLOWED
  const getHealRes = doGet({ parameter: { action: "healSchemaHeaders" } });
  const getHealData = JSON.parse(getHealRes.text);
  assert.equal(getHealData.success, false);
  assert.equal(getHealData.code, "METHOD_NOT_ALLOWED");

  // 2. doGet runIdentityMigration -> METHOD_NOT_ALLOWED
  const getMigRes = doGet({ parameter: { action: "runIdentityMigration" } });
  const getMigData = JSON.parse(getMigRes.text);
  assert.equal(getMigData.success, false);
  assert.equal(getMigData.code, "METHOD_NOT_ALLOWED");
});

// -----------------------------------------------------------------------------
// TEST 32: action=healSchemaHeaders の必須パラメータ検証 (token, districtId, targetMonth)
// -----------------------------------------------------------------------------
runTest("Scenario 32: action=healSchemaHeaders の必須パラメータ検証", () => {
  // 1. token 不在 -> UNAUTHORIZED
  const noTokenRes = doPost({
    postData: { contents: JSON.stringify({ action: "healSchemaHeaders", districtId: "KUWANA", targetMonth: "2026-10" }) }
  });
  assert.equal(JSON.parse(noTokenRes.text).success, false);
  assert.equal(JSON.parse(noTokenRes.text).code, "UNAUTHORIZED");

  // 2. token 不正 -> UNAUTHORIZED
  const badTokenRes = doPost({
    postData: { contents: JSON.stringify({ action: "healSchemaHeaders", provisioningToken: "wrong", districtId: "KUWANA", targetMonth: "2026-10" }) }
  });
  assert.equal(JSON.parse(badTokenRes.text).success, false);
  assert.equal(JSON.parse(badTokenRes.text).code, "UNAUTHORIZED");

  // 3. districtId 不在 -> MISSING_DISTRICT_ID
  const noDistRes = doPost({
    postData: { contents: JSON.stringify({ action: "healSchemaHeaders", provisioningToken: validToken, targetMonth: "2026-10" }) }
  });
  assert.equal(JSON.parse(noDistRes.text).success, false);
  assert.equal(JSON.parse(noDistRes.text).code, "MISSING_DISTRICT_ID");

  // 4. targetMonth 不在 -> INVALID_ARGUMENT
  const noMonthRes = doPost({
    postData: { contents: JSON.stringify({ action: "healSchemaHeaders", provisioningToken: validToken, districtId: "KUWANA" }) }
  });
  assert.equal(JSON.parse(noMonthRes.text).success, false);
  assert.equal(JSON.parse(noMonthRes.text).code, "INVALID_ARGUMENT");

  // 5. targetMonth フォーマット不正 ("2026/10") -> INVALID_ARGUMENT
  const badMonthRes = doPost({
    postData: { contents: JSON.stringify({ action: "healSchemaHeaders", provisioningToken: validToken, districtId: "KUWANA", targetMonth: "2026/10" }) }
  });
  assert.equal(JSON.parse(badMonthRes.text).success, false);
  assert.equal(JSON.parse(badMonthRes.text).code, "INVALID_ARGUMENT");
});

// -----------------------------------------------------------------------------
// TEST 33: action=healSchemaHeaders の targetSpreadsheetId バイパス禁止 & Runtime Resolver 解決
// -----------------------------------------------------------------------------
runTest("Scenario 33: action=healSchemaHeaders の targetSpreadsheetId バイパス禁止 & Runtime Resolver 解決", () => {
  const reg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true },
    "DISABLED_DIST": { spreadsheetId: "ss-disabled-id", storageFolderId: "folder_disabled_id", enabled: false }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(reg);
  SpreadsheetResolver.getInstance().clearCache();

  // KUWANA SS に必要な原本・当月シートを準備 (原本5種は削除し新構造実証)
  const kSS = mockSpreadsheets["ss-kuwana-id"];
  ["配布実績の原本", "名簿の原本", "保有チラシ枚数の原本", "受渡要請履歴の原本", "PinStatusの原本"].forEach(m => {
    delete kSS.sheets[m];
  });

  (kSS.getSheetByName("配布実績2026-10") || kSS.addSheet("配布実績2026-10")).rows = [["ID", "市町村", "町域", "配布完了日時", "配布枚数", "担当者ID", "担当者名", "GPS", "写真", "緯度", "経度", "GPS日時", "写真ファイルID", "写真URL", "写真日時", "lineUserId", "requestId"]];
  (kSS.getSheetByName("名簿2026-10") || kSS.addSheet("名簿2026-10")).rows = [["ID", "名前", "LINE_USER_ID", "登録日時"]];
  (kSS.getSheetByName("保有チラシ枚数2026-10") || kSS.addSheet("保有チラシ枚数2026-10")).rows = [["ID", "担当者ID", "担当者名", "保管場所", "保有枚数", "最終更新日時", "lineUserId"]];
  (kSS.getSheetByName("受渡要請履歴2026-10") || kSS.addSheet("受渡要請履歴2026-10")).rows = [["日時", "要請者", "要請者ID", "保管者", "保管者ID", "連絡方法", "連絡先", "状態", "requestId", "LINE送信状態", "LINE HTTP status", "LINE送信日時", "requesterLineUserId", "holderLineUserId"]];
  (kSS.getSheetByName("PinStatus2026-10") || kSS.addSheet("PinStatus2026-10")).rows = [["rowId", "status"]];

  const kuwanaSys = kSS.getSheetByName("SYSTEM_INFO");
  if (kuwanaSys) {
    kuwanaSys.rows = [
      ["項目", "内容"],
      ["地区コード", "KUWANA"],
      ["運用モード", "SUBSCRIPTION"]
    ];
  }

  // 1. targetSpreadsheetId に別 ID を渡しても無視され、KUWANA の SS (ss-kuwana-id) が解決されること
  const reqWithBypass = {
    postData: {
      contents: JSON.stringify({
        action: "healSchemaHeaders",
        provisioningToken: validToken,
        districtId: "KUWANA",
        targetMonth: "2026-10",
        targetSpreadsheetId: "fake-spreadsheet-id-to-be-ignored",
        isDryRun: true
      })
    }
  };
  const bypassRes = doPost(reqWithBypass);
  const bypassData = JSON.parse(bypassRes.text);
  assert.equal(bypassData.success, true, "Must succeed using KUWANA Runtime Resolver, ignoring targetSpreadsheetId");

  // 2. enabled: false な地区は Runtime Resolver の enabled チェックで拒否されること
  const reqDisabled = {
    postData: {
      contents: JSON.stringify({
        action: "healSchemaHeaders",
        provisioningToken: validToken,
        districtId: "DISABLED_DIST",
        targetMonth: "2026-10"
      })
    }
  };
  const disabledRes = doPost(reqDisabled);
  const disabledData = JSON.parse(disabledRes.text);
  assert.equal(disabledData.success, false, "Disabled district must be rejected");
  assert.equal(disabledData.code, "SPREADSHEET_NOT_FOUND");
});

// -----------------------------------------------------------------------------
// TEST 34: action=runIdentityMigration の districtId 伝播検証
// -----------------------------------------------------------------------------
runTest("Scenario 34: action=runIdentityMigration の districtId 伝播検証", () => {
  const reg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(reg);
  SpreadsheetResolver.getInstance().clearCache();

  const req = {
    postData: {
      contents: JSON.stringify({
        action: "runIdentityMigration",
        provisioningToken: validToken,
        districtId: "KUWANA",
        isDryRun: true
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true, "runIdentityMigration must succeed with districtId");
  assert.equal(data.districtId, "KUWANA", "districtId must be propagated in report");
});

// -----------------------------------------------------------------------------
// TEST 35: action=switchDistrictSpreadsheet の Fail-Closed / バリデーション検証
// -----------------------------------------------------------------------------
runTest("Scenario 35: action=switchDistrictSpreadsheet の Fail-Closed / バリデーション検証 (mutation 0)", () => {
  const baseReg = {
    "KUWANA": { spreadsheetId: "ss-kuwana-id", storageFolderId: "folder_kuwana_id", enabled: true, name: "桑名" },
    "OKAYAMA": { spreadsheetId: "ss-okayama-id", storageFolderId: "folder_okayama_id", enabled: true, name: "岡山" }
  };
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(baseReg);
  mockScriptProperties["STORAGE_PARENT_ID"] = "parent_folder_id";
  mockScriptProperties["PROVISIONING_TOKEN_HASH"] = crypto.createHash('sha256').update(validToken).digest('hex');
  SpreadsheetResolver.getInstance().clearCache();

  const snapProps = JSON.stringify(mockScriptProperties);

  // 1. Tokenなし → UNAUTHORIZED / mutation 0
  const resNoToken = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataNoToken = JSON.parse(resNoToken.text);
  assert.equal(dataNoToken.success, false);
  assert.equal(dataNoToken.code, "UNAUTHORIZED");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on UNAUTHORIZED");

  // 2. 必須引数欠損 → INVALID_ARGUMENT / mutation 0
  // 2a. districtId 欠損
  const resMissingDist = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataMissingDist = JSON.parse(resMissingDist.text);
  assert.equal(dataMissingDist.success, false);
  assert.equal(dataMissingDist.code, "INVALID_ARGUMENT");

  // 2b. expectedCurrentSpreadsheetId 欠損
  const resMissingExpected = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataMissingExpected = JSON.parse(resMissingExpected.text);
  assert.equal(dataMissingExpected.success, false);
  assert.equal(dataMissingExpected.code, "INVALID_ARGUMENT");

  // 2c. targetSpreadsheetId 欠損
  const resMissingTarget = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-id"
      })
    }
  });
  const dataMissingTarget = JSON.parse(resMissingTarget.text);
  assert.equal(dataMissingTarget.success, false);
  assert.equal(dataMissingTarget.code, "INVALID_ARGUMENT");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on INVALID_ARGUMENT");

  // 3. Registry空文字 → CORRUPTED_REGISTRY / mutation 0
  mockScriptProperties["DISTRICT_REGISTRY"] = "";
  const resEmptyReg = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataEmptyReg = JSON.parse(resEmptyReg.text);
  assert.equal(dataEmptyReg.success, false);
  assert.equal(dataEmptyReg.code, "CORRUPTED_REGISTRY");
  assert.equal(mockScriptProperties["DISTRICT_REGISTRY"], "", "Registry remains empty with mutation 0");

  // 4. Registry破損JSON → CORRUPTED_REGISTRY / mutation 0
  mockScriptProperties["DISTRICT_REGISTRY"] = "{ broken json !!";
  const resBrokenJson = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataBrokenJson = JSON.parse(resBrokenJson.text);
  assert.equal(dataBrokenJson.success, false);
  assert.equal(dataBrokenJson.code, "CORRUPTED_REGISTRY");
  assert.equal(mockScriptProperties["DISTRICT_REGISTRY"], "{ broken json !!", "Registry remains intact with mutation 0");

  // Registry復元
  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(baseReg);

  // 5. district不存在 → DISTRICT_NOT_FOUND / mutation 0
  const resUnknownDist = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "UNKNOWN_DISTRICT",
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataUnknownDist = JSON.parse(resUnknownDist.text);
  assert.equal(dataUnknownDist.success, false);
  assert.equal(dataUnknownDist.code, "DISTRICT_NOT_FOUND");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on DISTRICT_NOT_FOUND");

  // 6. expectedCurrentSpreadsheetId不一致 → STALE_WRITE / mutation 0
  const resStaleWrite = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-wrong-old-id",
        targetSpreadsheetId: "ss-new-kuwana-id"
      })
    }
  });
  const dataStaleWrite = JSON.parse(resStaleWrite.text);
  assert.equal(dataStaleWrite.success, false);
  assert.equal(dataStaleWrite.code, "STALE_WRITE");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on STALE_WRITE");

  // 7. targetSpreadsheetId不存在 → RESOURCE_NOT_FOUND / mutation 0
  const resNotFound = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-nonexistent-target-id"
      })
    }
  });
  const dataNotFound = JSON.parse(resNotFound.text);
  assert.equal(dataNotFound.success, false);
  assert.equal(dataNotFound.code, "RESOURCE_NOT_FOUND");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on RESOURCE_NOT_FOUND");

  // 8. target SYSTEM_INFO地区コード不一致 → DISTRICT_MISMATCH / mutation 0
  const ssMismatch = new MockSpreadsheet("ss-mismatch-kuwana-id", "POSTING_MAP_MISMATCH");
  const sMismatchSys = ssMismatch.addSheet("SYSTEM_INFO");
  sMismatchSys.rows = [
    ["項目", "内容"],
    ["地区コード", "WRONG_DISTRICT_CODE"]
  ];
  mockSpreadsheets["ss-mismatch-kuwana-id"] = ssMismatch;

  const resMismatch = doPost({
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-id",
        targetSpreadsheetId: "ss-mismatch-kuwana-id"
      })
    }
  });
  const dataMismatch = JSON.parse(resMismatch.text);
  assert.equal(dataMismatch.success, false);
  assert.equal(dataMismatch.code, "DISTRICT_MISMATCH");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on DISTRICT_MISMATCH");

  // 13. GET switchDistrictSpreadsheet → METHOD_NOT_ALLOWED
  const resGet = doGet({
    parameter: {
      action: "switchDistrictSpreadsheet",
      provisioningToken: validToken,
      districtId: "KUWANA"
    }
  });
  const dataGet = JSON.parse(resGet.text);
  assert.equal(dataGet.success, false);
  assert.equal(dataGet.code, "METHOD_NOT_ALLOWED");
  assert.equal(JSON.stringify(mockScriptProperties), snapProps, "Props must have mutation 0 on GET METHOD_NOT_ALLOWED");
});

// -----------------------------------------------------------------------------
// TEST 36: action=switchDistrictSpreadsheet 正常切替と絶対境界保護
// -----------------------------------------------------------------------------
runTest("Scenario 36: action=switchDistrictSpreadsheet 正常切替と絶対境界保護 (KUWANA.spreadsheetIdのみ変更、他完全不変)", () => {
  const initialRegistry = {
    "KUWANA": {
      spreadsheetId: "ss-kuwana-old-id",
      storageFolderId: "folder_kuwana_id",
      enabled: true,
      name: "桑名地区"
    },
    "OKAYAMA": {
      spreadsheetId: "ss-okayama-id",
      storageFolderId: "folder_okayama_id",
      enabled: true,
      name: "岡山地区"
    },
    "DISABLED_DIST": {
      spreadsheetId: "ss-disabled-id",
      storageFolderId: "folder_disabled_id",
      enabled: false,
      name: "停止地区"
    }
  };

  mockScriptProperties["DISTRICT_REGISTRY"] = JSON.stringify(initialRegistry);
  mockScriptProperties["STORAGE_PARENT_ID"] = "parent_folder_123";
  mockScriptProperties["PROVISIONING_TOKEN_HASH"] = crypto.createHash('sha256').update(validToken).digest('hex');
  mockScriptProperties["OTHER_SECRET_KEY"] = "untouchable_value";

  const otherPropsBefore = {
    STORAGE_PARENT_ID: mockScriptProperties["STORAGE_PARENT_ID"],
    PROVISIONING_TOKEN_HASH: mockScriptProperties["PROVISIONING_TOKEN_HASH"],
    OTHER_SECRET_KEY: mockScriptProperties["OTHER_SECRET_KEY"]
  };

  // 新スプレッドシート（新世代DB）を準備
  const newKuwanaSS = new MockSpreadsheet("ss-kuwana-new-gen2-id", "POSTING_MAP_KUWANA_V2");
  const newSysSheet = newKuwanaSS.addSheet("SYSTEM_INFO");
  newSysSheet.rows = [
    ["項目", "内容"],
    ["地区コード", "KUWANA"],
    ["地区名", "桑名地区"],
    ["HアプリURL", "https://kuwana.postingmap.jp/"],
    ["運用モード", "SUBSCRIPTION"],
    ["契約終了日", "2026-12-31"]
  ];
  mockSpreadsheets["ss-kuwana-new-gen2-id"] = newKuwanaSS;

  SpreadsheetResolver.getInstance().clearCache();

  // 9. 正常切替実行
  const switchReq = {
    postData: {
      contents: JSON.stringify({
        action: "switchDistrictSpreadsheet",
        provisioningToken: validToken,
        districtId: "KUWANA",
        expectedCurrentSpreadsheetId: "ss-kuwana-old-id",
        targetSpreadsheetId: "ss-kuwana-new-gen2-id"
      })
    }
  };

  const res = doPost(switchReq);
  const data = JSON.parse(res.text);

  assert.equal(data.success, true, "switchDistrictSpreadsheet must succeed");
  assert.equal(data.districtId, "KUWANA");
  assert.equal(data.previousSpreadsheetId, "ss-kuwana-old-id");
  assert.equal(data.newSpreadsheetId, "ss-kuwana-new-gen2-id");

  // 変更後Registry取得
  const updatedRegistry = JSON.parse(mockScriptProperties["DISTRICT_REGISTRY"]);

  // 9. KUWANA.spreadsheetId だけ変更されていること
  assert.equal(updatedRegistry["KUWANA"].spreadsheetId, "ss-kuwana-new-gen2-id");

  // 10. KUWANA.enabled / storageFolderId / name 完全不変
  assert.equal(updatedRegistry["KUWANA"].enabled, initialRegistry["KUWANA"].enabled);
  assert.equal(updatedRegistry["KUWANA"].storageFolderId, initialRegistry["KUWANA"].storageFolderId);
  assert.equal(updatedRegistry["KUWANA"].name, initialRegistry["KUWANA"].name);

  // 11. 他地区（OKAYAMA, DISABLED_DIST）deepEqual 完全不変
  assert.deepEqual(updatedRegistry["OKAYAMA"], initialRegistry["OKAYAMA"], "OKAYAMA must be completely unchanged");
  assert.deepEqual(updatedRegistry["DISABLED_DIST"], initialRegistry["DISABLED_DIST"], "DISABLED_DIST must be completely unchanged");

  // 12. STORAGE_PARENT_ID等、他Script Properties完全不変
  assert.equal(mockScriptProperties["STORAGE_PARENT_ID"], otherPropsBefore.STORAGE_PARENT_ID);
  assert.equal(mockScriptProperties["PROVISIONING_TOKEN_HASH"], otherPropsBefore.PROVISIONING_TOKEN_HASH);
  assert.equal(mockScriptProperties["OTHER_SECRET_KEY"], otherPropsBefore.OTHER_SECRET_KEY);

  // 機械検証: 変更前Registry全体と変更後Registry全体を比較し、差分がKUWANA.spreadsheetId 1箇所だけであることを検証
  const diffKeys = [];
  Object.keys(initialRegistry).forEach(distKey => {
    const origEntry = initialRegistry[distKey];
    const newEntry = updatedRegistry[distKey];
    Object.keys(origEntry).forEach(prop => {
      if (origEntry[prop] !== newEntry[prop]) {
        diffKeys.push(`${distKey}.${prop}: ${origEntry[prop]} -> ${newEntry[prop]}`);
      }
    });
  });
  assert.equal(diffKeys.length, 1, `Exactly 1 property must differ in entire registry: ${JSON.stringify(diffKeys)}`);
  assert.equal(diffKeys[0], "KUWANA.spreadsheetId: ss-kuwana-old-id -> ss-kuwana-new-gen2-id");

  // Resolver cache clear の確認: getSpreadsheet("KUWANA") で新SSが返ること
  const resolvedSS = SpreadsheetResolver.getInstance().getSpreadsheet("KUWANA");
  assert.equal(resolvedSS.getId(), "ss-kuwana-new-gen2-id", "Resolver must resolve newly switched spreadsheet ID");
});

console.log('\n================================================================');
console.log(`TEST SUMMARY: Total=${passCount + failCount}, PASS=${passCount}, FAIL=${failCount}`);
console.log('================================================================\n');

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
