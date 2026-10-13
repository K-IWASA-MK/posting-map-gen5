import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ==========================================
// GAS Environment Mock Engine
// ==========================================
class MockRange {
  constructor(sheet, startRow, startCol, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.startRow = startRow;
    this.startCol = startCol;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValue() {
    const row = this.sheet.rows[this.startRow - 1];
    return row ? row[this.startCol - 1] : "";
  }

  setValue(val) {
    while (this.sheet.rows.length < this.startRow) {
      this.sheet.rows.push([]);
    }
    const row = this.sheet.rows[this.startRow - 1];
    while (row.length < this.startCol) {
      row.push("");
    }
    row[this.startCol - 1] = val;
  }

  getValues() {
    const result = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowIndex = this.startRow - 1 + r;
      const row = this.sheet.rows[rowIndex] || [];
      const rowResult = [];
      for (let c = 0; c < this.numCols; c++) {
        const colIndex = this.startCol - 1 + c;
        rowResult.push(row[colIndex] !== undefined ? row[colIndex] : "");
      }
      result.push(rowResult);
    }
    return result;
  }

  setValues(values) {
    for (let r = 0; r < values.length; r++) {
      const rowIndex = this.startRow - 1 + r;
      while (this.sheet.rows.length <= rowIndex) {
        this.sheet.rows.push([]);
      }
      const row = this.sheet.rows[rowIndex];
      for (let c = 0; c < values[r].length; c++) {
        const colIndex = this.startCol - 1 + c;
        while (row.length <= colIndex) {
          row.push("");
        }
        row[colIndex] = values[r][c];
      }
    }
  }

  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const rowIndex = this.startRow - 1 + r;
      const row = this.sheet.rows[rowIndex];
      if (row) {
        for (let c = 0; c < this.numCols; c++) {
          const colIndex = this.startCol - 1 + c;
          if (row.length > colIndex) {
            row[colIndex] = "";
          }
        }
      }
    }
  }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }

  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() {
    let maxCol = 0;
    for (const r of this.rows) {
      if (r && r.length > maxCol) maxCol = r.length;
    }
    return maxCol;
  }

  getRange(startRow, startCol, numRows = 1, numCols = 1) {
    return new MockRange(this, startRow, startCol, numRows, numCols);
  }

  appendRow(values) {
    this.rows.push([...values]);
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = {};
    const staff = this.insertSheet("staff");
    staff.appendRow(["ID", "氏名", "LINE_USER_ID", "役職"]);
    staff.appendRow(["U001", "要請者A", "line_u001", "スタッフ"]);
    staff.appendRow(["U002", "保管者B", "line_u002", "リーダー"]);
    staff.appendRow(["U003", "LINE未設定者C", "", "スタッフ"]);
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }

  insertSheet(name) {
    if (!this.sheets[name]) {
      this.sheets[name] = new MockSheet(name);
    }
    return this.sheets[name];
  }

  getSheets() {
    return Object.values(this.sheets);
  }
}

class MockLock {
  constructor() {
    this.locked = false;
  }

  waitLock(timeout) {
    if (this.locked) {
      throw new Error("Lock timeout");
    }
    this.locked = true;
  }

  releaseLock() {
    this.locked = false;
  }
}

const mockCacheStorage = {};
const MockCacheService = {
  getScriptCache: () => ({
    get: (key) => mockCacheStorage[key] || null,
    put: (key, value, ttl) => { mockCacheStorage[key] = value; }
  })
};

const mockProperties = {
  LINE_CHANNEL_ACCESS_TOKEN: "mock_token_12345"
};

let linePushCallCount = 0;
let lastLinePushPayload = null;
let mockLineResponse = {
  code: 200,
  body: '{"message":"ok"}'
};
let mockLineException = null;

const MockUrlFetchApp = {
  fetch: (url, options) => {
    linePushCallCount++;
    lastLinePushPayload = JSON.parse(options.payload);

    if (mockLineException) {
      throw mockLineException;
    }

    return {
      getResponseCode: () => mockLineResponse.code,
      getContentText: () => mockLineResponse.body
    };
  }
};

const MockUtilities = {
  formatDate: (date, tz, format) => {
    const d = new Date(date);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
};

const mockLock = new MockLock();
const mockSS = new MockSpreadsheet();

// GAS Global Environment Mocking
global.LockService = { getScriptLock: () => mockLock };
global.CacheService = MockCacheService;
global.PropertiesService = { getScriptProperties: () => ({ getProperty: k => mockProperties[k] }) };
global.UrlFetchApp = MockUrlFetchApp;
global.Utilities = MockUtilities;
global.Logger = { log: () => {} };
global.getSS = () => mockSS;
global.getProductionLiffUrl = () => "https://liff.line.me/mock";
global.MonthlySheetResolver = {
  getInstance: () => ({
    getCurrentSheet: (type) => {
      if (type === 'staff') return mockSS.getSheetByName("staff");
      if (type === 'transfer') {
        let s = mockSS.getSheetByName("受渡要請履歴");
        if (!s) s = mockSS.insertSheet("受渡要請履歴");
        return s;
      }
      return null;
    }
  })
};

// サービスのロード
import vm from 'vm';
const transferCode = fs.readFileSync(path.join(ROOT, 'active/business/transfer/transfer_service.js'), 'utf-8');
const bulletinCode = fs.readFileSync(path.join(ROOT, 'active/business/bulletin/bulletin_service.js'), 'utf-8');

const context = global;
vm.runInThisContext(transferCode);
vm.runInThisContext(bulletinCode);

const transferService = global.TransferService.getInstance();
const bulletinService = global.BulletinService.getInstance();

// ==========================================
// api.js リトライハーネス
// ==========================================
async function simulateCallApiPost(action, payload, serviceFn) {
  const MAX_RETRIES = 3;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    attempts = attempt;
    const res = serviceFn(payload);

    // api.js の挙動：
    // if (data.success === false) throw new Error(...)
    if (res.success === false) {
      if (attempt === MAX_RETRIES) {
        return { attempts, result: res, error: new Error(res.message) };
      }
      // リトライ
      continue;
    }
    // 成功またはリトライ不要エラー（success: true）
    return { attempts, result: res, error: null };
  }
}

// ==========================================
// 監査テスト実行
// ==========================================
async function runAudit() {
  console.log("===============================================================");
  console.log("🛡️ LINE PUSH IDEMPOTENCY & SAFETY DEEP AUDIT SUITE");
  console.log("===============================================================\n");

  const results = {};

  // --------------------------------------------------------------------------
  // 【1. 同一requestId二重送信試験】
  // --------------------------------------------------------------------------
  console.log("▶ [TEST 1] 同一requestId二重送信試験 実行中...");
  linePushCallCount = 0;
  mockLineResponse = { code: 200, body: '{"message":"ok"}' };
  mockLineException = null;
  for (const k in mockCacheStorage) delete mockCacheStorage[k];

  const reqId1 = "req_audit_001";
  const trPayload = {
    requestId: reqId1,
    requestUserId: "U001",
    holderUserId: "U002",
    contactMethod: "LINE",
    contactValue: "line_id_abc"
  };

  // 1回目実行
  const tr1 = transferService.requestFlyerTransfer(trPayload);
  const lineCountAfter1 = linePushCallCount;

  // 2回目実行（同一requestId）
  const tr2 = transferService.requestFlyerTransfer(trPayload);
  const lineCountAfter2 = linePushCallCount;

  const trSheet = mockSS.getSheetByName("受渡要請履歴");
  const trRowsWithReqId = trSheet.rows.filter(r => r[8] === reqId1);

  const test1_tr_pass = (
    tr1.success === true && tr1.status === "SENT" &&
    tr2.success === true && tr2.status === "SENT" && tr2.duplicate === true &&
    lineCountAfter1 === 1 && lineCountAfter2 === 1 &&
    trRowsWithReqId.length === 1
  );

  // 掲示板連絡も検証
  const reqId1_bc = "req_bc_audit_001";
  const bcPayload = {
    requestId: reqId1_bc,
    requestUserId: "U001",
    targetStaffId: "U002",
    contactMethod: "LINE",
    contactValue: "line_id_abc"
  };

  const lineCountBeforeBc = linePushCallCount;
  const bc1 = bulletinService.sendContact(bcPayload);
  const lineCountAfterBc1 = linePushCallCount;
  const bc2 = bulletinService.sendContact(bcPayload);
  const lineCountAfterBc2 = linePushCallCount;

  const bcSheet = mockSS.getSheetByName("掲示板連絡履歴");
  const bcRowsWithReqId = bcSheet.rows.filter(r => r[6] === reqId1_bc);

  const test1_bc_pass = (
    bc1.success === true && bc1.status === "SENT" &&
    bc2.success === true && bc2.status === "SENT" && bc2.duplicate === true &&
    (lineCountAfterBc1 - lineCountBeforeBc) === 1 &&
    (lineCountAfterBc2 - lineCountBeforeBc) === 1 &&
    bcRowsWithReqId.length === 1
  );

  results.test1 = {
    pass: test1_tr_pass && test1_bc_pass,
    transfer: {
      callCount: 2,
      actualLinePush: lineCountAfter2,
      ledgerRows: trRowsWithReqId.length,
      firstStatus: tr1.status,
      secondStatus: tr2.status,
      secondDuplicate: tr2.duplicate
    },
    bulletin: {
      callCount: 2,
      actualLinePush: lineCountAfterBc2 - lineCountBeforeBc,
      ledgerRows: bcRowsWithReqId.length,
      firstStatus: bc1.status,
      secondStatus: bc2.status,
      secondDuplicate: bc2.duplicate
    }
  };
  console.log(`  Transfer: PASS=${test1_tr_pass}, PushCount=${results.test1.transfer.actualLinePush}/2, LedgerRows=${results.test1.transfer.ledgerRows}`);
  console.log(`  Bulletin: PASS=${test1_bc_pass}, PushCount=${results.test1.bulletin.actualLinePush}/2, LedgerRows=${results.test1.bulletin.ledgerRows}`);

  // --------------------------------------------------------------------------
  // 【2. 並列同一requestId試験】
  // --------------------------------------------------------------------------
  console.log("\n▶ [TEST 2] 並列同一requestId試験 (Script Lock & 排他直列化) 実行中...");
  const reqId2 = "req_audit_parallel_002";
  const trPayload2 = {
    requestId: reqId2,
    requestUserId: "U001",
    holderUserId: "U002",
    contactMethod: "LINE",
    contactValue: "line_id_abc"
  };

  const lineCountBeforeParallel = linePushCallCount;

  // 1つ目のリクエスト処理中に2つ目が到達する状況を模倣
  // 先行リクエストが行追加(PROCESSING)した状態で後続がロック獲得した場合
  trSheet.appendRow([
    "2026/09/21 13:00:00", "要請者A", "U001", "保管者B", "U002", "LINE", "line_id_abc", "要請中", reqId2, "PROCESSING", "", ""
  ]);

  // 後続リクエストが到達
  const pRes = transferService.requestFlyerTransfer(trPayload2);
  const lineCountAfterParallel = linePushCallCount;

  // 後続はPROCESSINGを検知して LINE Push を実行せず、success: false (PROCESSING) を返すこと
  const test2_pass = (
    pRes.success === false && pRes.status === "PROCESSING" &&
    (lineCountAfterParallel - lineCountBeforeParallel) === 0
  );

  results.test2 = {
    pass: test2_pass,
    parallelCallResultStatus: pRes.status,
    parallelCallSuccess: pRes.success,
    actualLinePush: lineCountAfterParallel - lineCountBeforeParallel
  };
  console.log(`  Parallel Lock Conflict Result: status=${pRes.status}, success=${pRes.success}, LinePush=${results.test2.actualLinePush} (0件: PASS)`);

  // --------------------------------------------------------------------------
  // 【3. UNKNOWN試験】
  // --------------------------------------------------------------------------
  console.log("\n▶ [TEST 3] UNKNOWN試験 (成否不明時の二重送信抑止 & api.jsリトライ非発火) 実行中...");
  const reqId3 = "req_audit_unknown_003";
  const trPayload3 = {
    requestId: reqId3,
    requestUserId: "U001",
    holderUserId: "U002",
    contactMethod: "LINE",
    contactValue: "line_id_abc"
  };

  // LINE API 呼び出し時にネットワーク切断/タイムアウト発生を模擬
  mockLineException = new Error("Connection timed out waiting for LINE server");
  const lineCountBeforeUnknown = linePushCallCount;

  const unknownCallResult = await simulateCallApiPost(
    'requestFlyerTransfer',
    trPayload3,
    p => transferService.requestFlyerTransfer(p)
  );
  const lineCountAfterUnknown1 = linePushCallCount;

  // UNKNOWN 状態になった requestId を再送（手動またはクライアント再試行）
  mockLineException = null; // LINE通信が復旧したとする
  mockLineResponse = { code: 200, body: '{"message":"ok"}' };

  const unknownRetryResult = await simulateCallApiPost(
    'requestFlyerTransfer',
    trPayload3,
    p => transferService.requestFlyerTransfer(p)
  );
  const lineCountAfterUnknown2 = linePushCallCount;

  // 確認事項：
  // 1. 1回目の呼び出しで api.js が不要な自動リトライを行わないこと (attempts === 1)
  // 2. 戻り値が status === 'UNKNOWN' であること
  // 3. 2回目の再送時にも LINE Push を再実行しないこと (push増分が 0)
  // 4. 2回目の戻り値も status === 'UNKNOWN' であること
  const test3_pass = (
    unknownCallResult.attempts === 1 &&
    unknownCallResult.result.status === "UNKNOWN" &&
    unknownRetryResult.attempts === 1 &&
    unknownRetryResult.result.status === "UNKNOWN" &&
    (lineCountAfterUnknown2 - lineCountAfterUnknown1) === 0
  );

  results.test3 = {
    pass: test3_pass,
    firstAttemptCount: unknownCallResult.attempts,
    firstStatus: unknownCallResult.result.status,
    retryAttemptCount: unknownRetryResult.attempts,
    retryStatus: unknownRetryResult.result.status,
    secondLinePushCount: lineCountAfterUnknown2 - lineCountAfterUnknown1
  };
  console.log(`  UNKNOWN Initial: status=${unknownCallResult.result.status}, api.js Attempts=${unknownCallResult.attempts} (1回のみ: PASS)`);
  console.log(`  UNKNOWN Retry: status=${unknownRetryResult.result.status}, Line Push Executed=${results.test3.secondLinePushCount} (0回: PASS)`);

  // --------------------------------------------------------------------------
  // 【4. FAILED / RETRYABLE試験】
  // --------------------------------------------------------------------------
  console.log("\n▶ [TEST 4] FAILED / RETRYABLE 分類 & api.jsリトライ試験 実行中...");
  
  // 4-A: FAILED (HTTP 400, 401, 403) → api.js 自動リトライなし (attempts === 1)
  const failedCodes = [400, 401, 403];
  let failedPass = true;
  const failedReports = [];

  for (const code of failedCodes) {
    mockLineResponse = { code, body: `{"message":"Error ${code}"}` };
    const reqIdFailed = `req_audit_failed_${code}`;
    const payload = {
      requestId: reqIdFailed,
      requestUserId: "U001",
      holderUserId: "U002",
      contactMethod: "LINE",
      contactValue: "test"
    };

    const simRes = await simulateCallApiPost(
      'requestFlyerTransfer',
      payload,
      p => transferService.requestFlyerTransfer(p)
    );

    if (simRes.attempts !== 1 || simRes.result.status !== "FAILED") {
      failedPass = false;
    }
    failedReports.push({ code, status: simRes.result.status, attempts: simRes.attempts });
  }

  // 4-B: RETRYABLE (HTTP 429, 500, 503) → 一時障害は api.js が自動リトライし、復旧すれば同一requestIdでSENT
  const reqIdRetry = "req_audit_retry_500";
  let retryCallCount = 0;
  mockLineResponse = { code: 500, body: '{"message":"Internal Server Error"}' };

  // 1回目と2回目は500、3回目に200で成功するシミュレーション
  const simRetryRes = await simulateCallApiPost(
    'requestFlyerTransfer',
    {
      requestId: reqIdRetry,
      requestUserId: "U001",
      holderUserId: "U002",
      contactMethod: "LINE",
      contactValue: "test"
    },
    p => {
      retryCallCount++;
      if (retryCallCount >= 2) {
        mockLineResponse = { code: 200, body: '{"message":"ok"}' };
      }
      return transferService.requestFlyerTransfer(p);
    }
  );

  const retryPass = (
    simRetryRes.attempts === 2 &&
    simRetryRes.result.status === "SENT" &&
    simRetryRes.result.success === true
  );

  results.test4 = {
    pass: failedPass && retryPass,
    failedReports,
    retryableRecovery: {
      attempts: simRetryRes.attempts,
      finalStatus: simRetryRes.result.status,
      success: simRetryRes.result.success
    }
  };
  console.log(`  FAILED Codes (400, 401, 403): PASS=${failedPass} (All attempts = 1, status = FAILED)`);
  console.log(`  RETRYABLE Recovery (500 -> 200): PASS=${retryPass} (Attempts = ${simRetryRes.attempts}, FinalStatus = ${simRetryRes.result.status})`);

  // --------------------------------------------------------------------------
  // 【5. Ledger破壊防止確認】
  // --------------------------------------------------------------------------
  console.log("\n▶ [TEST 5] Ledger破壊防止確認 (既存履歴・拡張列クリア禁止) 実行中...");
  const rowCountBefore = trSheet.getLastRow();
  const sampleRow = trSheet.rows[1];
  const reqIdBefore = sampleRow[8];
  const statusBefore = sampleRow[9];

  // 新しい受渡要請を実行
  mockLineResponse = { code: 200, body: '{"message":"ok"}' };
  const reqIdNew = "req_audit_ledger_preservation";
  transferService.requestFlyerTransfer({
    requestId: reqIdNew,
    requestUserId: "U001",
    holderUserId: "U002",
    contactMethod: "LINE",
    contactValue: "test"
  });

  const rowCountAfter = trSheet.getLastRow();
  const sampleRowAfter = trSheet.rows[1];

  const test5_pass = (
    rowCountAfter === rowCountBefore + 1 &&
    sampleRowAfter[8] === reqIdBefore &&
    sampleRowAfter[9] === statusBefore &&
    sampleRowAfter[8] !== ""
  );

  results.test5 = {
    pass: test5_pass,
    rowCountBefore,
    rowCountAfter,
    preservedReqId: sampleRowAfter[8],
    preservedStatus: sampleRowAfter[9]
  };
  console.log(`  Ledger Preservation: PASS=${test5_pass} (PrevRow preserved: reqId=${sampleRowAfter[8]}, status=${sampleRowAfter[9]})`);

  // --------------------------------------------------------------------------
  // 【6. requestId未指定の後方互換】
  // --------------------------------------------------------------------------
  console.log("\n▶ [TEST 6] 旧クライアント互換 (requestId未指定) 実行中...");
  mockLineResponse = { code: 200, body: '{"message":"ok"}' };
  const lineCountBeforeLegacy = linePushCallCount;

  const legacyTrRes = transferService.requestFlyerTransfer({
    requestUserId: "U001",
    holderUserId: "U002",
    contactMethod: "LINE",
    contactValue: "test"
  });

  const legacyBcRes = bulletinService.sendContact({
    requestUserId: "U001",
    targetStaffId: "U002",
    contactMethod: "LINE",
    contactValue: "test"
  });

  const test6_pass = (
    legacyTrRes.success === true && legacyTrRes.status === "SENT" &&
    legacyBcRes.success === true && legacyBcRes.status === "SENT" &&
    (linePushCallCount - lineCountBeforeLegacy) === 2
  );

  results.test6 = {
    pass: test6_pass,
    transferLegacyStatus: legacyTrRes.status,
    bulletinLegacyStatus: legacyBcRes.status,
    linePushExecuted: linePushCallCount - lineCountBeforeLegacy
  };
  console.log(`  Legacy Client Support: PASS=${test6_pass} (Tr=${legacyTrRes.status}, Bc=${legacyBcRes.status}, Pushes=${results.test6.linePushExecuted})`);

  // --------------------------------------------------------------------------
  // 総括判定
  // --------------------------------------------------------------------------
  const allPassed = (
    results.test1.pass &&
    results.test2.pass &&
    results.test3.pass &&
    results.test4.pass &&
    results.test5.pass &&
    results.test6.pass
  );

  console.log("\n===============================================================");
  console.log(`📊 FINAL AUDIT VERDICT: ${allPassed ? "🎉 ALL 6 AUDIT GATES PASSED (PRODUCTION READY)" : "❌ AUDIT FAILED"}`);
  console.log("===============================================================");

  return { allPassed, results };
}

runAudit().then(res => {
  if (!res.allPassed) {
    process.exit(1);
  }
});
