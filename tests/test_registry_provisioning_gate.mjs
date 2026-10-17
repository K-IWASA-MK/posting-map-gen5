/**
 * test_registry_provisioning_gate.mjs
 * Generation 2 Registry Provisioning Acceptance Gate 機械検証スイート
 *
 * 必須検証項目:
 * 1. Registry exists             PASS
 * 2. New district entry exists   PASS
 * 3. spreadsheetId matches       PASS
 * 4. enabled                     PASS
 * 5. Known district routing      PASS
 * 6. Unknown district rejection  PASS
 * 7. Legacy fallback not used    PASS
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log("====================================================");
console.log("🏛️ GENERATION 2 REGISTRY PROVISIONING ACCEPTANCE GATE");
console.log("====================================================");

// モック環境
const mockSpreadsheets = {};
const mockScriptProperties = {};

global.PropertiesService = {
  getScriptProperties() {
    return {
      getProperty(k) { return mockScriptProperties[k] || null; },
      setProperty(k, v) { mockScriptProperties[k] = String(v); },
      deleteProperty(k) { delete mockScriptProperties[k]; },
      getProperties() { return { ...mockScriptProperties }; },
      setProperties(obj) {
        for (const [k, v] of Object.entries(obj)) {
          mockScriptProperties[k] = String(v);
        }
      }
    };
  }
};

global.Utilities = {
  computeDigest(algo, str) {
    return Array.from(crypto.createHash('sha256').update(str).digest());
  },
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' }
};

global.CacheService = {
  getScriptCache() {
    return {
      remove(k) {},
      get(k) { return null; },
      put(k, v, ttl) {}
    };
  }
};

global.ContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput(str) {
    return {
      content: str,
      setMimeType(m) { return this; }
    };
  }
};

global.SpreadsheetApp = {
  openById(id) {
    if (mockSpreadsheets[id]) return mockSpreadsheets[id];
    throw new Error(`Spreadsheet not found: ${id}`);
  },
  flush() {}
};

// ソースコードロード
const adapterCode = fs.readFileSync(path.join(REPO_ROOT, 'active/infrastructure/spreadsheet/spreadsheet_adapter.js'), 'utf8');
const provisionerCode = fs.readFileSync(path.join(REPO_ROOT, 'active/business/system/district_provisioner.js'), 'utf8');
const v2ApiCode = fs.readFileSync(path.join(REPO_ROOT, 'active/api/v2_api.js'), 'utf8');
vm.runInThisContext(adapterCode);
vm.runInThisContext(v2ApiCode);

// Drive モック環境の構築
const mockFolders = {};
const mockFiles = {};

function createMockFolder(id, name, parent = null) {
  const folder = {
    id,
    name,
    parent,
    files: [],
    subFolders: {},
    getId() { return this.id; },
    getName() { return this.name; },
    getParents() {
      let yielded = false;
      const p = this.parent;
      return {
        hasNext() { return !yielded && p !== null; },
        next() { yielded = true; return p; }
      };
    },
    createFolder(subName) {
      const subId = `${this.id}_${subName}`;
      const sub = createMockFolder(subId, subName, this);
      this.subFolders[subName] = sub;
      mockFolders[subId] = sub;
      return sub;
    },
    getFoldersByName(subName) {
      const sub = this.subFolders[subName];
      let yielded = false;
      return {
        hasNext() { return !!sub && !yielded; },
        next() { yielded = true; return sub; }
      };
    },
    getFilesByName(fileName) {
      const matched = this.files.filter(f => f.getName() === fileName && !f.trashed);
      let idx = 0;
      return {
        hasNext() { return idx < matched.length; },
        next() { return matched[idx++]; }
      };
    },
    getFiles() {
      let idx = 0;
      return {
        hasNext() { return idx < this.files.length; },
        next() { return this.files[idx++]; }
      };
    },
    addFile(file) {
      if (!this.files.includes(file)) this.files.push(file);
      file.parent = this;
    },
    removeFile(file) {
      const idx = this.files.indexOf(file);
      if (idx !== -1) this.files.splice(idx, 1);
    }
  };
  mockFolders[id] = folder;
  return folder;
}

function createMockFile(id, name, parent = null, mimeType = "application/vnd.google-apps.spreadsheet") {
  const file = {
    id,
    name,
    parent,
    mimeType,
    trashed: false,
    getId() { return this.id; },
    getName() { return this.name; },
    getUrl() { return `https://drive.google.com/file/d/${this.id}/view`; },
    getMimeType() { return this.mimeType; },
    isTrashed() { return this.trashed; },
    setTrashed(v) { this.trashed = !!v; },
    getParents() {
      let yielded = false;
      const p = this.parent;
      return {
        hasNext() { return !yielded && p !== null; },
        next() { yielded = true; return p; }
      };
    },
    moveTo(targetFolder) {
      if (this.parent && this.parent.files) {
        const idx = this.parent.files.indexOf(this);
        if (idx !== -1) this.parent.files.splice(idx, 1);
      }
      this.parent = targetFolder;
      if (targetFolder && targetFolder.files) {
        targetFolder.files.push(this);
      }
      return this;
    },
    makeCopy(newName, targetFolder) {
      const copyId = `copy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const copiedFile = createMockFile(copyId, newName, targetFolder, this.mimeType);
      mockFiles[copyId] = copiedFile;

      // Spreadsheetモックも同時に複製
      const copySS = new MockSpreadsheet(copyId, newName, newName.replace(/^POSTING_MAP_DB_/i, ''));
      mockSpreadsheets[copyId] = copySS;

      return copiedFile;
    }
  };
  mockFiles[id] = file;
  if (parent) {
    parent.files.push(file);
  }
  return file;
}

global.DriveApp = {
  getFolderById(id) {
    if (!mockFolders[id]) {
      throw new Error(`Drive folder not found: ${id}`);
    }
    return mockFolders[id];
  },
  getFileById(id) {
    if (!mockFiles[id]) {
      throw new Error(`Drive file not found: ${id}`);
    }
    return mockFiles[id];
  }
};

global.LockService = {
  getScriptLock() {
    return {
      waitLock() {},
      releaseLock() {},
      tryLock() { return true; }
    };
  }
};

mockScriptProperties['PROVISIONING_TOKEN_HASH'] = computeSha256("valid-token");

vm.runInThisContext(provisionerCode);

// テスト用データ設定
const TEST_DISTRICT = "KUWANA";
const TEST_SS_ID = "ss-kuwana-pure-db-id";
const LEGACY_SS_ID = "ss-legacy-fallback-id";
const BRANCH_ROOT_ID = "folder-03-branch-root-id";

// スプレッドシートモック
class MockSheet {
  constructor(rows = [], name = "SYSTEM_INFO") {
    this.rows = rows;
    this.name = name;
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.length > 0 ? this.rows[0].length : 0; }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValues() {
        const res = [];
        for (let i = 0; i < nr; i++) {
          const rowData = sheet.rows[r - 1 + i] || [];
          res.push(rowData.slice(c - 1, c - 1 + nc));
        }
        return res;
      }
    };
  }
}

class MockSpreadsheet {
  constructor(id, name, districtCode) {
    this.id = id;
    this.name = name;
    this.sheets = {
      "SYSTEM_INFO": new MockSheet([
        ["項目", "設定値"],
        ["地区コード", districtCode],
        ["契約終了日", "2027-03-31"]
      ])
    };
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(n) { return this.sheets[n] || null; }
  getSheets() { return Object.values(this.sheets); }
}

mockSpreadsheets[TEST_SS_ID] = new MockSpreadsheet(TEST_SS_ID, TEST_DISTRICT, TEST_DISTRICT);
mockSpreadsheets[LEGACY_SS_ID] = new MockSpreadsheet(LEGACY_SS_ID, "LEGACY", "LEGACY");

// Drive 階層モック初期化
const rootBranchFolder = createMockFolder(BRANCH_ROOT_ID, "03_BRANCH", null);
const templateFolder = createMockFolder("folder-01-template-id", "Templates", null);
const templateSSFile = createMockFile("template-ss-empty-id", "TEMPLATE_EMPTY_DB", templateFolder);
mockSpreadsheets["template-ss-empty-id"] = new MockSpreadsheet("template-ss-empty-id", "TEMPLATE_EMPTY_DB", "TEMPLATE");

// 初期環境: 1地区完結設定（TARGET_SPREADSHEET_ID のみ、DISTRICT_REGISTRY 廃止）
mockScriptProperties["BRANCH_ROOT_FOLDER_ID"] = BRANCH_ROOT_ID;
mockScriptProperties["TARGET_SPREADSHEET_ID"] = TEST_SS_ID;
mockScriptProperties["GOOGLE_MAPS_API_KEY"] = "test-maps-key-kuwana";

let passCount = 0;
let failCount = 0;

function runGate(gateName, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${gateName}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${gateName}:`, err.message);
    failCount++;
  }
}

console.log("\n▶ Running Single-District Resolution & Integrity Gates (Gates 1-7)...");

// Gate 1: TARGET_SPREADSHEET_ID configured & DISTRICT_REGISTRY retired from Runtime
runGate("Gate 1: TARGET_SPREADSHEET_ID configured & DISTRICT_REGISTRY retired from Runtime", () => {
  const targetSsId = PropertiesService.getScriptProperties().getProperty("TARGET_SPREADSHEET_ID");
  assert.equal(targetSsId, TEST_SS_ID, "TARGET_SPREADSHEET_ID must match configured DB ID");
  assert.equal(
    PropertiesService.getScriptProperties().getProperty("DISTRICT_REGISTRY"),
    null,
    "DISTRICT_REGISTRY must not be set in single-district runtime"
  );
  const driveCode = fs.readFileSync(path.join(REPO_ROOT, 'active/infrastructure/drive/drive_adapter.js'), 'utf8');
  const batchCode = fs.readFileSync(path.join(REPO_ROOT, 'active/gas/v2_batch.js'), 'utf8');
  assert.ok(!adapterCode.includes("DISTRICT_REGISTRY"), "spreadsheet_adapter.js must not reference DISTRICT_REGISTRY");
  assert.ok(!driveCode.includes("DISTRICT_REGISTRY"), "drive_adapter.js must not reference DISTRICT_REGISTRY");
  assert.ok(!batchCode.includes("DISTRICT_REGISTRY"), "v2_batch.js must not reference DISTRICT_REGISTRY");
  assert.ok(!v2ApiCode.includes("DISTRICT_REGISTRY"), "v2_api.js must not reference DISTRICT_REGISTRY");
  for (const deprecatedAction of ["bootstrapEnvironment", "switchDistrictSpreadsheet", "repairDistrictDriveBinding", "migrateDistrictPhotos"]) {
    assert.ok(!v2ApiCode.includes(deprecatedAction), `v2_api.js must not expose deprecated parent-GAS action: ${deprecatedAction}`);
  }
});

// Gate 2: SYSTEM_INFO sheet exists and B2 matches districtId
runGate("Gate 2: SYSTEM_INFO sheet exists and B2 matches districtId", () => {
  const ss = SpreadsheetApp.openById(TEST_SS_ID);
  const sysSheet = ss.getSheetByName("SYSTEM_INFO");
  assert.ok(sysSheet, "SYSTEM_INFO sheet must exist");
  const rows = sysSheet.getRange(1, 1, sysSheet.getLastRow(), sysSheet.getLastColumn()).getValues();
  const codeRow = rows.find(r => r[0] === "地区コード");
  assert.ok(codeRow, "地区コード row must exist in SYSTEM_INFO");
  assert.equal(codeRow[1], TEST_DISTRICT, "SYSTEM_INFO B2 must match TEST_DISTRICT");
});

// Gate 3: handleGetMapsApiKey returns GOOGLE_MAPS_API_KEY for matching district
runGate("Gate 3: handleGetMapsApiKey resolves GOOGLE_MAPS_API_KEY for matching district", () => {
  SpreadsheetResolver.getInstance().clearCache();
  const res = handleGetMapsApiKey(TEST_DISTRICT, "");
  assert.equal(res.success, true, "handleGetMapsApiKey must succeed");
  assert.equal(res.mapsApiKey, "test-maps-key-kuwana", "mapsApiKey must match GOOGLE_MAPS_API_KEY");
});

// Gate 4: handleGetMapsApiKey fails closed when GOOGLE_MAPS_API_KEY is missing
runGate("Gate 4: handleGetMapsApiKey fails closed when GOOGLE_MAPS_API_KEY is missing", () => {
  const savedKey = mockScriptProperties["GOOGLE_MAPS_API_KEY"];
  try {
    delete mockScriptProperties["GOOGLE_MAPS_API_KEY"];
    SpreadsheetResolver.getInstance().clearCache();
    const res = handleGetMapsApiKey(TEST_DISTRICT, "");
    assert.equal(res.success, false, "Must fail closed when GOOGLE_MAPS_API_KEY is missing");
  } finally {
    mockScriptProperties["GOOGLE_MAPS_API_KEY"] = savedKey;
  }
});

// Gate 5: Known district routing
runGate("Gate 5: Known district routing", () => {
  SpreadsheetResolver.getInstance().clearCache();
  const ss = SpreadsheetResolver.getInstance().getSpreadsheet(TEST_DISTRICT);
  assert.equal(ss.getId(), TEST_SS_ID, `Resolved spreadsheet must match target DB ID`);
});

// Gate 6: Mismatched / Unknown district rejection (Integrity Guard / Fail-Closed)
runGate("Gate 6: Unknown / Mismatched district rejection", () => {
  SpreadsheetResolver.getInstance().clearCache();
  assert.throws(() => {
    SpreadsheetResolver.getInstance().getSpreadsheet("UNKNOWN_XYZ");
  }, /DISTRICT_MISMATCH/, "Unknown/mismatched district must be rejected by verifyIntegrityGuard with DISTRICT_MISMATCH");
});

// Gate 7: Cross-district leakage prevented
runGate("Gate 7: Cross-district leakage prevented", () => {
  SpreadsheetResolver.getInstance().clearCache();
  assert.throws(() => {
    const ss = SpreadsheetResolver.getInstance().getSpreadsheet("ANOTHER_UNKNOWN");
    if (ss && ss.getId() === LEGACY_SS_ID) {
      throw new Error("CRITICAL: Leaked to legacy fallback!");
    }
  }, /DISTRICT_MISMATCH/);
});

console.log("\n▶ Running Canonical Drive Physical Layout Gates (Gates 8-12)...");

// プロビジョニング実行テスト用の新地区
const PROV_DISTRICT = "SHIZUOKA";
const prov = DistrictProvisioner.getInstance();

// 1. resolveOrCreateDistrictDriveStructure の実行
const driveStructure = prov.resolveOrCreateDistrictDriveStructure(PROV_DISTRICT);

// 2. createDistrictDatabase の実行
const dbResult = prov.createDistrictDatabase("template-ss-empty-id", null, null, {
  districtId: PROV_DISTRICT,
  provisioningToken: "valid-token"
});
assert.equal(dbResult.success, true, "createDistrictDatabase must succeed: " + JSON.stringify(dbResult));

// Gate 8: BRANCH_ROOT_FOLDER_ID exists in Script Properties
runGate("Gate 8: BRANCH_ROOT_FOLDER_ID exists in Script Properties", () => {
  const branchRootId = PropertiesService.getScriptProperties().getProperty("BRANCH_ROOT_FOLDER_ID");
  assert.ok(branchRootId, "BRANCH_ROOT_FOLDER_ID must exist in Script Properties");
  assert.equal(branchRootId, BRANCH_ROOT_ID);
});

// Gate 9: districtFolder.parentId === BRANCH_ROOT_FOLDER_ID
runGate("Gate 9: districtFolder.parentId === BRANCH_ROOT_FOLDER_ID", () => {
  const distFolder = DriveApp.getFolderById(driveStructure.districtFolderId);
  assert.ok(distFolder, "districtFolder must be openable");
  const parentIter = distFolder.getParents();
  assert.ok(parentIter.hasNext(), "districtFolder must have a parent");
  const parentFolder = parentIter.next();
  assert.equal(parentFolder.getId(), BRANCH_ROOT_ID, "districtFolder parent must be 03_BRANCH root");
});

// Gate 10: spreadsheet.parentId === districtFolderId (real spreadsheet, not shortcut)
runGate("Gate 10: spreadsheet.parentId === districtFolderId (real spreadsheet, not shortcut)", () => {
  const ssFile = DriveApp.getFileById(dbResult.spreadsheetId);
  assert.ok(ssFile, "Spreadsheet file must exist");
  assert.equal(ssFile.getName(), PROV_DISTRICT);
  assert.doesNotMatch(ssFile.getName(), /^POSTING_MAP_DB_/, "Canonical DB name must NOT contain POSTING_MAP_DB_ prefix (Regression invariant)");
  assert.notEqual(ssFile.getMimeType(), "application/vnd.google-apps.shortcut", "DB must not be a shortcut");
  const parentIter = ssFile.getParents();
  assert.ok(parentIter.hasNext(), "Spreadsheet file must have a parent");
  const parentFolder = parentIter.next();
  assert.equal(parentFolder.getId(), driveStructure.districtFolderId, "Spreadsheet parent must be districtFolder");
});

// Gate 11: storageFolder.parentId === districtFolderId
runGate("Gate 11: storageFolder.parentId === districtFolderId", () => {
  const storageFolder = DriveApp.getFolderById(driveStructure.storageFolderId);
  assert.ok(storageFolder, "storageFolder must be openable");
  assert.equal(storageFolder.getName(), `${PROV_DISTRICT} 支部_STORAGE`);
  const parentIter = storageFolder.getParents();
  assert.ok(parentIter.hasNext(), "storageFolder must have a parent");
  const parentFolder = parentIter.next();
  assert.equal(parentFolder.getId(), driveStructure.districtFolderId, "storageFolder parent must be districtFolder");
});

// Gate 12: sourceArchiveFolder.parentId === districtFolderId
runGate("Gate 12: sourceArchiveFolder.parentId === districtFolderId", () => {
  const archiveFolder = DriveApp.getFolderById(driveStructure.sourceArchiveFolderId);
  assert.ok(archiveFolder, "archiveFolder must be openable");
  assert.equal(archiveFolder.getName(), "SOURCE_ARCHIVE");
  const parentIter = archiveFolder.getParents();
  assert.ok(parentIter.hasNext(), "archiveFolder must have a parent");
  const parentFolder = parentIter.next();
  assert.equal(parentFolder.getId(), driveStructure.districtFolderId, "archiveFolder parent must be districtFolder");
});

console.log("\n▶ Running Provisioner Unit Invariant Tests...");

// Unit Test 1: resolveOrCreateDistrictDriveStructure 冪等性（重複作成ゼロ）
runGate("Unit 1: resolveOrCreateDistrictDriveStructure idempotency", () => {
  const second = prov.resolveOrCreateDistrictDriveStructure(PROV_DISTRICT);
  assert.equal(second.districtFolderId, driveStructure.districtFolderId, "District folder ID must be identical on second call");
  assert.equal(second.storageFolderId, driveStructure.storageFolderId, "Storage folder ID must be identical on second call");
  assert.equal(second.sourceArchiveFolderId, driveStructure.sourceArchiveFolderId, "Source archive folder ID must be identical on second call");
});

// Unit Test 2: BRANCH_ROOT_FOLDER_ID 欠落時の Fail-Closed
runGate("Unit 2: Missing BRANCH_ROOT_FOLDER_ID fails closed", () => {
  const saved = mockScriptProperties["BRANCH_ROOT_FOLDER_ID"];
  try {
    delete mockScriptProperties["BRANCH_ROOT_FOLDER_ID"];
    assert.throws(() => {
      prov.resolveOrCreateDistrictDriveStructure("FAIL_DISTRICT");
    }, /BRANCH_ROOT_FOLDER_ID is not configured in Script Properties/);
  } finally {
    mockScriptProperties["BRANCH_ROOT_FOLDER_ID"] = saved;
  }
});

// Unit Test 3: createDistrictDatabase の重複作成抑止（自動ゴミ箱送り完全廃止）
runGate("Unit 3: createDistrictDatabase rejects existing DB (No Auto-Trash)", () => {
  const dupResult = prov.createDistrictDatabase("template-ss-empty-id", null, null, {
    districtId: PROV_DISTRICT,
    provisioningToken: "valid-token"
  });
  assert.equal(dupResult.success, false, "Must reject when canonical DB already exists");
  assert.equal(dupResult.code, "DISTRICT_DB_ALREADY_EXISTS");
});

// Unit Test 4: createDistrictDatabase の Legacy Assertion (FOLDER_MISMATCH)
runGate("Unit 4: createDistrictDatabase FOLDER_MISMATCH assertion", () => {
  const badFolderResult = prov.createDistrictDatabase("template-ss-empty-id", null, "wrong-folder-id", {
    districtId: "NEW_DIST_C",
    provisioningToken: "valid-token"
  });
  assert.equal(badFolderResult.success, false);
  assert.equal(badFolderResult.code, "FOLDER_MISMATCH");
});

// Unit Test 5: createDistrictDatabase の Legacy Assertion (INVALID_DISTRICT_NAME)
runGate("Unit 5: createDistrictDatabase INVALID_DISTRICT_NAME assertion", () => {
  const badNameResult = prov.createDistrictDatabase("template-ss-empty-id", "ARBITRARY_NAME_XYZ", null, {
    districtId: "NEW_DIST_D",
    provisioningToken: "valid-token"
  });
  assert.equal(badNameResult.success, false);
  assert.equal(badNameResult.code, "INVALID_DISTRICT_NAME");
});

// Unit Test 6: Canonical name must be cleanDistrictId, reject POSTING_MAP_DB_ prefix
runGate("Unit 6: Canonical DB name must match cleanDistrictId exactly (No prefix)", () => {
  const testDist = "TEST_CANONICAL_CHECK";
  prov.resolveOrCreateDistrictDriveStructure(testDist);
  const result = prov.createDistrictDatabase("template-ss-empty-id", null, null, {
    districtId: testDist,
    provisioningToken: "valid-token"
  });
  assert.equal(result.success, true);
  assert.equal(result.districtName, testDist);
  assert.doesNotMatch(result.districtName, /^POSTING_MAP_DB_/, "Canonical districtName must NOT contain POSTING_MAP_DB_ prefix");

  const file = DriveApp.getFileById(result.spreadsheetId);
  assert.equal(file.getName(), testDist);
  assert.doesNotMatch(file.getName(), /^POSTING_MAP_DB_/, "File name must NOT contain POSTING_MAP_DB_ prefix");
});

const VALID_TOKEN = "valid-token";
const RAW_HASH_VALID = computeSha256(VALID_TOKEN);
mockScriptProperties["PROVISIONING_TOKEN_HASH"] = RAW_HASH_VALID;

// Gate 51: verifyProvisioningToken without PROVISIONING_TOKEN_HASH fails closed
runGate("Gate 51: verifyProvisioningToken without PROVISIONING_TOKEN_HASH fails closed", () => {
  const savedHash = mockScriptProperties["PROVISIONING_TOKEN_HASH"];
  try {
    delete mockScriptProperties["PROVISIONING_TOKEN_HASH"];
    const res = verifyProvisioningToken(VALID_TOKEN);
    assert.equal(res.success, false, "Must fail authentication when PROVISIONING_TOKEN_HASH is missing");
    assert.equal(res.code, "UNAUTHORIZED");
    assert.ok(res.message.includes("Fail-Closed") || res.message.includes("not configured"));
  } finally {
    mockScriptProperties["PROVISIONING_TOKEN_HASH"] = savedHash;
  }
});

console.log("\n====================================================");
console.log(`GATE & UNIT SUMMARY: Total=${passCount + failCount}, PASS=${passCount}, FAIL=${failCount}`);
console.log("====================================================");

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
