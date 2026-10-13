#!/usr/bin/env node
/**
 * test_sec001_dashboard_auth_fix.mjs
 * 
 * SEC-001: Dashboard 認証バイパス完全修正 検証スイート
 * 
 * 目的:
 * 1. 6桁PINを知らない第三者による Dashboard API 取得が 100% 拒否されることの実証
 * 2. 6桁PIN照合成功時のサーバーサイドセッション発行と検証の完全性
 * 3. localStorage 改ざん（pm_auth_xxx=true）によるUI突破耐性
 * 4. GET/POST 直接アクセスの遮断
 * 5. セッション期限切れ（TTL）および districtId 拘束（テナントバインド）
 * 6. ログアウト（logoutManager）によるセッション即時破棄
 * 7. Hアプリ（配布員・LINE認証）との完全分離と互換性維持
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

console.log('================================================================');
console.log('🛡️ SEC-001 DASHBOARD AUTHENTICATION FIX VERIFICATION SUITE');
console.log('================================================================\n');

const rootDir = process.cwd();

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

// 1. モック環境の構築
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
  setFontColor() {}
  setBackground() {}
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
  insertSheet(name) { return new MockSheet(name); }
  clear() { this.data = []; }
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
}

// キャッシュモック
const cacheStore = new Map();
class MockCache {
  get(key) {
    const item = cacheStore.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      cacheStore.delete(key);
      return null;
    }
    return item.value;
  }
  put(key, value, expirationInSeconds = 21600) {
    cacheStore.set(key, {
      value: String(value),
      expiresAt: Date.now() + (expirationInSeconds * 1000)
    });
  }
  remove(key) {
    cacheStore.delete(key);
  }
}
const mockCacheInstance = new MockCache();

const scriptPropertiesStore = {};
const mockSpreadsheets = {};

// グローバル環境の注入
global.CacheService = {
  getScriptCache: () => mockCacheInstance
};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => scriptPropertiesStore[k] || null,
    setProperty: (k, v) => { scriptPropertiesStore[k] = String(v); },
    setProperties: (obj) => { Object.assign(scriptPropertiesStore, obj); }
  })
};

global.SpreadsheetApp = {
  openById: (id) => {
    if (mockSpreadsheets[id]) return mockSpreadsheets[id];
    throw new Error("Spreadsheet not found: " + id);
  },
  getActiveSpreadsheet: () => mockSpreadsheets["ss-kuwana-id"] || null,
  flush: () => {}
};

global.LockService = {
  getScriptLock: () => ({
    waitLock: () => true,
    releaseLock: () => {}
  })
};

global.ContentService = {
  createTextOutput: (str) => ({
    text: str,
    mimeType: "JSON",
    setMimeType: function(m) { this.mimeType = m; return this; }
  }),
  MimeType: { JSON: "JSON" }
};

global.Utilities = {
  computeDigest: (alg, str) => {
    return Array.from(crypto.createHash('sha256').update(str).digest());
  },
  formatDate: (d, tz, fmt) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (fmt === "yyyy-MM") return `${year}-${month}`;
    if (fmt === "yyyy/MM/dd HH:mm:ss") return `${year}/${month}/${day} 12:00:00`;
    return `${year}-${month}-${day}`;
  },
  getUuid: () => 'uuid_' + Math.random().toString(36).substring(2, 10)
};


// スプレッドシートデータのセットアップ (KUWANA & OKAYAMA)
const kuwanaSS = new MockSpreadsheet("ss-kuwana-id", "KUWANA", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "内容"],
    ["地区コード", "KUWANA"],
    ["地区名", "KUWANA"],
    ["運用モード", "SUBSCRIPTION"],
    ["HアプリURL", "https://kuwana.postingmap.jp/"],
    ["Dashboard URL", "https://kuwana.postingmap.jp/active/manager/"],
    ["Manager認証パスワード", "884219"],
    ["状態", "ACTIVE"],
    ["契約終了日", "2029-12-31"]
  ]),
  "名簿2026-09": new MockSheet("名簿2026-09", [
    ["ID", "氏名", "LINE_USER_ID", "登録日時"],
    ["S001", "桑名 太郎", "U_KUWANA_001", "2026-09-01 10:00:00"],
    ["S002", "桑名 花子", "U_KUWANA_002", "2026-09-02 11:00:00"]
  ]),
  "保有チラシ枚数2026-09": new MockSheet("保有チラシ枚数2026-09", [
    ["ID", "配布員ID", "配布員名", "保管場所", "枚数", "更新日時", "LINE_USER_ID"],
    ["1", "S001", "桑名 太郎", "自宅", 500, "2026-09-20", "U_KUWANA_001"]
  ]),
  "配布実績2026-09": new MockSheet("配布実績2026-09", [
    ["rowId", "cityName", "townName", "completedAt", "count", "staffId", "staffName", "", "", "", "", "", "", "", "", "lineUserId"],
    ["1", "桑名市", "中央町1", "2026-09-20 10:00:00", 150, "S001", "桑名 太郎", "", "", "", "", "", "", "", "", "U_KUWANA_001"]
  ]),
  "受渡要請履歴2026-09": new MockSheet("受渡要請履歴2026-09", [
    ["要請ID", "要請者ID", "要請者名", "対象者ID", "対象者名", "チラシ種別", "希望枚数", "ステータス", "作成日時"],
    ["REQ001", "S001", "桑名 太郎", "S002", "桑名 花子", "A4チラシ", 100, "PENDING", "2026/09/22"]
  ]),
  "PinStatus2026-09": new MockSheet("PinStatus2026-09", [
    ["rowId", "status", "updatedAt"],
    ["1", "completed", "2026/09/20"]
  ])
});

const okayamaSS = new MockSpreadsheet("ss-okayama-id", "OKAYAMA", {
  "SYSTEM_INFO": new MockSheet("SYSTEM_INFO", [
    ["項目", "内容"],
    ["地区コード", "OKAYAMA"],
    ["地区名", "OKAYAMA"],
    ["運用モード", "SUBSCRIPTION"],
    ["Manager認証パスワード", "112233"],
    ["状態", "ACTIVE"],
    ["契約終了日", "2029-12-31"]
  ]),
  "名簿2026-09": new MockSheet("名簿2026-09", [
    ["ID", "氏名", "LINE_USER_ID", "登録日時"],
    ["O001", "岡山 次郎", "U_OKAYAMA_001", "2026-09-01 10:00:00"]
  ])
});

mockSpreadsheets["ss-kuwana-id"] = kuwanaSS;
mockSpreadsheets["ss-okayama-id"] = okayamaSS;

scriptPropertiesStore["DISTRICT_REGISTRY"] = JSON.stringify({
  "KUWANA": "ss-kuwana-id",
  "OKAYAMA": "ss-okayama-id"
});

// スクリプト群を VM コンテキストで読み込み
const sessionCode = fs.readFileSync(path.join(rootDir, "active/api/auth/session.js"), "utf8");
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

// LINE 認証モック (Hアプリ側用)
global.authenticateRequest = (payload) => {
  if (payload && payload.liffToken === "valid_line_token_user1") {
    return { success: true, user: { lineUserId: "U_KUWANA_001" } };
  }
  return { success: false, code: "UNAUTHORIZED", message: "Missing or invalid liffToken" };
};

vm.runInThisContext(v2ApiCode);

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    failCount++;
  }
}

// =============================================================================
// テストスイート実行
// =============================================================================

// ─── [CASE 1] PINなし直接アクセス ➔ DENY ────────────────────────────────────
console.log('▶ [TEST 1] PINなしで Dashboard API (Snapshot/Roster) を直接呼び出し');
runTest('PINなし POST getDashboardSnapshot ➔ UNAUTHORIZED で拒否', () => {
  const req = {
    postData: { contents: JSON.stringify({ action: "getDashboardSnapshot", districtId: "KUWANA" }) }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

runTest('PINなし POST getRoster ➔ UNAUTHORIZED で拒否', () => {
  const req = {
    postData: { contents: JSON.stringify({ action: "getRoster", districtId: "KUWANA" }) }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

// ─── [CASE 2] 間違った PIN ➔ DENY ──────────────────────────────────────────
console.log('\n▶ [TEST 2] 間違った 6桁PIN での照合');
runTest('間違った PIN で verifyManagerPassword ➔ UNAUTHORIZED で拒否 (トークン発行なし)', () => {
  const req = {
    postData: { contents: JSON.stringify({ action: "verifyManagerPassword", password: "wrong_password", districtId: "KUWANA" }) }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.dashboardSessionToken, undefined);
});

// ─── [CASE 3] 正しい PIN ➔ ALLOW & セッショントークン発行 ────────────────────
console.log('\n▶ [TEST 3] 正しい 6桁PIN での照合とセッション発行');
let validKuwanaSessionToken = "";
runTest('正しい PIN (884219) で verifyManagerPassword ➔ ALLOW & dashboardSessionToken 発行', () => {
  const req = {
    postData: { contents: JSON.stringify({ action: "verifyManagerPassword", password: "884219", districtId: "KUWANA" }) }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true);
  assert.equal(data.districtCode, "KUWANA");
  assert.ok(data.dashboardSessionToken);
  assert.ok(data.dashboardSessionToken.startsWith("pms_dash_"));
  assert.ok(data.expiresAt > Date.now());
  validKuwanaSessionToken = data.dashboardSessionToken;
});

// ─── [CASE 4] 有効なセッションで getDashboardSnapshot ➔ ALLOW ────────────────
console.log('\n▶ [TEST 4] 有効なセッショントークンでの Dashboard データ取得');
runTest('発行された dashboardSessionToken で getDashboardSnapshot ➔ ALLOW (全7ドメイン返却)', () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getDashboardSnapshot",
        districtId: "KUWANA",
        dashboardSessionToken: validKuwanaSessionToken,
        limit: 20
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true);
  assert.equal(data.districtId, "KUWANA");
  assert.ok(data.domains);
  assert.ok(data.domains.summary);
  assert.ok(data.domains.roster);
  assert.equal(data.domains.roster.roster.length, 2);
});

// ─── [CASE 5] 有効なセッションで getRoster ➔ ALLOW ───────────────────────────
runTest('発行された dashboardSessionToken で getRoster ➔ ALLOW (全名簿返却)', () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getRoster",
        districtId: "KUWANA",
        dashboardSessionToken: validKuwanaSessionToken
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.roster));
  assert.equal(data.roster.length, 2);
  assert.equal(data.roster[0].name, "桑名 太郎");
});

// ─── [CASE 6] localStorage 改ざん耐性 ➔ DENY ─────────────────────────────────
console.log('\n▶ [TEST 6] localStorage 改ざん（pm_auth_KUWANA=true のみでトークンなし）の耐性');
runTest('pm_auth_KUWANA=true のみ設定されたクライアントからの API 呼出 ➔ サーバー側で UNAUTHORIZED 拒否', () => {
  // localStorage にフラグだけがあり、セッショントークンが送信されない場合
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getDashboardSnapshot",
        districtId: "KUWANA"
        // dashboardSessionToken 欠落
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

// ─── [CASE 7] GET 直接アクセス ➔ DENY ───────────────────────────────────────
console.log('\n▶ [TEST 7] GET リクエストによる直接アクセス遮断');
runTest('ブラウザ URL 欄から GET ?action=getRoster&districtId=KUWANA ➔ 401 UNAUTHORIZED で拒否', () => {
  const req = {
    parameter: {
      action: "getRoster",
      districtId: "KUWANA"
    }
  };
  const res = doGet(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

runTest('ブラウザ URL 欄から GET ?action=getDashboardSnapshot&districtId=KUWANA ➔ UNAUTHORIZED で拒否', () => {
  const req = {
    parameter: {
      action: "getDashboardSnapshot",
      districtId: "KUWANA"
    }
  };
  const res = doGet(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

// ─── [CASE 8] POST 直接アクセス (トークンなし) ➔ DENY ───────────────────────
console.log('\n▶ [TEST 8] curl や API ツールからの POST 直接アクセス遮断');
runTest('トークンなし POST getSystemSummary ➔ UNAUTHORIZED で拒否', () => {
  const req = {
    postData: { contents: JSON.stringify({ action: "getSystemSummary", districtId: "KUWANA" }) }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

// ─── [CASE 9] セッション期限切れ (TTL) ➔ DENY ────────────────────────────────
console.log('\n▶ [TEST 9] セッション有効期限切れシミュレーション');
runTest('期限切れセッショントークンでのアクセス ➔ UNAUTHORIZED で拒否', () => {
  // 意図的に期限切れのトークンを作成してキャッシュに投入
  const expiredToken = "pms_dash_expired_test_token_12345";
  const key = 'DASH_SESSION_' + hashSessionToken(expiredToken);
  cacheStore.set(key, {
    value: JSON.stringify({
      token: expiredToken,
      districtId: "KUWANA",
      role: "MANAGER",
      createdAt: Date.now() - 30000000,
      expiresAt: Date.now() - 1000 // 既に期限切れ
    }),
    expiresAt: Date.now() - 1000
  });

  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getDashboardSnapshot",
        districtId: "KUWANA",
        dashboardSessionToken: expiredToken
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

// ─── [CASE 10] テナント拘束 (districtId Mismatch) ➔ DENY ────────────────────
console.log('\n▶ [TEST 10] テナント拘束 (KUWANA セッションで OKAYAMA へのアクセス遮断)');
runTest('KUWANA のセッショントークンで OKAYAMA のデータを取得 ➔ DISTRICT_MISMATCH で拒否', () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getDashboardSnapshot",
        districtId: "OKAYAMA",
        dashboardSessionToken: validKuwanaSessionToken
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "DISTRICT_MISMATCH");
});

// ─── [CASE 11] 不正・改変トークン ➔ DENY ────────────────────────────────────
console.log('\n▶ [TEST 11] 不正・改変されたセッショントークン');
runTest('適当に捏造したトークン ➔ UNAUTHORIZED で拒否', () => {
  const req = {
    postData: {
      contents: JSON.stringify({
        action: "getRoster",
        districtId: "KUWANA",
        dashboardSessionToken: "pms_dash_fake_tampered_token_9999"
      })
    }
  };
  const res = doPost(req);
  const data = JSON.parse(res.text);
  assert.equal(data.success, false);
  assert.equal(data.code, "UNAUTHORIZED");
});

// ─── [CASE 12] ログアウト (logoutManager) ➔ セッション即時破棄 ───────────────
console.log('\n▶ [TEST 12] ログアウト機構 (logoutManager) とアクセス無効化');
runTest('logoutManager 呼出 ➔ サーバーセッション破棄 ➔ 以後の Snapshot 呼出が UNAUTHORIZED で拒否されること', () => {
  // 1. ログアウト実行
  const logoutReq = {
    postData: {
      contents: JSON.stringify({
        action: "logoutManager",
        districtId: "KUWANA",
        dashboardSessionToken: validKuwanaSessionToken
      })
    }
  };
  const logoutRes = doPost(logoutReq);
  const logoutData = JSON.parse(logoutRes.text);
  assert.equal(logoutData.success, true);

  // 2. 破棄されたトークンで再度 Snapshot を呼出
  const afterReq = {
    postData: {
      contents: JSON.stringify({
        action: "getDashboardSnapshot",
        districtId: "KUWANA",
        dashboardSessionToken: validKuwanaSessionToken
      })
    }
  };
  const afterRes = doPost(afterReq);
  const afterData = JSON.parse(afterRes.text);
  assert.equal(afterData.success, false);
  assert.equal(afterData.code, "UNAUTHORIZED");
});

// ─── [CASE 13] Hアプリ (配布員・LINE認証) との完全分離・互換性維持 ─────────
console.log('\n▶ [TEST 13] Hアプリ (LINE liffToken) との互換性維持');
runTest('Hアプリからの liffToken による getRanking / getFlyerStock ➔ 正常に ALLOW', () => {
  const reqRanking = {
    postData: {
      contents: JSON.stringify({
        action: "getRanking",
        districtId: "KUWANA",
        liffToken: "valid_line_token_user1"
      })
    }
  };
  const resRanking = doPost(reqRanking);
  const dataRanking = JSON.parse(resRanking.text);
  assert.equal(dataRanking.success, true);
  assert.ok(dataRanking.ranking);

  const reqStock = {
    postData: {
      contents: JSON.stringify({
        action: "getFlyerStock",
        districtId: "KUWANA",
        liffToken: "valid_line_token_user1"
      })
    }
  };
  const resStock = doPost(reqStock);
  const dataStock = JSON.parse(resStock.text);
  assert.equal(dataStock.success, true);
  assert.ok(dataStock.stocks);
});

// =============================================================================
// サマリー
// =============================================================================
console.log('\n================================================================');
console.log(`TEST SUMMARY: Total=${passCount + failCount}, PASS=${passCount}, FAIL=${failCount}`);
console.log('================================================================\n');

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
