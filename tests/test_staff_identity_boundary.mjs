/**
 * test_staff_identity_boundary.mjs
 * KUWANA Hアプリ Staff Identity 誤紐付け問題 修正検証テストスイート
 * 
 * 仕様検証原則:
 * 「Staff IDは表示用。HアプリとBackend間の操作主体の認識は、常に認証済みLINE User ID。」
 * 
 * TEST 1: 新規LINEユーザー (初回ログイン -> Staff登録 -> S001)
 * TEST 2: 既存ユーザー (再ログイン -> 同じStaff ID)
 * TEST 3: 別ユーザー (ログインしても他人のStaff IDを取得しない)
 * TEST 4: 古いlocalStorage (localStorage.user_info.id=S001 が残っていてもS001を使用しない)
 * TEST 5: 保有チラシ偽装遮断 (クライアントが staffId=S001 と送っても S001 として保存できない)
 * TEST 6: 未登録ユーザー (名簿にないLINE User IDからの業務API呼び出しが NOT_REGISTERED で拒否される)
 * TEST 7: 配布実績偽装遮断 (staffId偽装ができない)
 * TEST 8: 掲示板偽装遮断 (他人のstaffIdを指定して投稿できない)
 * TEST 9: 受渡要請偽装遮断 (他人のstaffIdを指定して要請者になれない)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('====================================================');
console.log('🧪 STAFF IDENTITY & AUTH BOUNDARY VERIFICATION SUITE');
console.log('====================================================\n');

// 1. スプレッドシート & 名簿のモック環境構築
class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows.length > 0 ? this.rows[0].length : 0;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
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
        if (!sheet.rows[rowIdx]) sheet.rows[rowIdx] = [];
        sheet.rows[rowIdx][colIdx] = val;
      }
    };
  }
  appendRow(rowVals) {
    this.rows.push([...rowVals]);
  }
}

const mockSheets = {
  '名簿2026-09': new MockSheet('名簿2026-09'),
  '保有チラシ枚数2026-09': new MockSheet('保有チラシ枚数2026-09'),
  '配布実績2026-09': new MockSheet('配布実績2026-09'),
  '掲示板': new MockSheet('掲示板'),
  '掲示板連絡履歴': new MockSheet('掲示板連絡履歴'),
  '受渡要請履歴2026-09': new MockSheet('受渡要請履歴2026-09')
};

// ヘッダー行の初期化
mockSheets['名簿2026-09'].appendRow(['ID', '名前', 'LINE_USER_ID', '登録日時']);
mockSheets['保有チラシ枚数2026-09'].appendRow(['ID', '配布員ID', '配布員名', '保管場所', '枚数', '更新日時']);
mockSheets['掲示板'].appendRow(['日時', '投稿者ID', '投稿者名', 'メッセージ']);
mockSheets['掲示板連絡履歴'].appendRow(['日時', '送信者ID', '送信者名', '相手ID', '連絡方法', '連絡先', 'requestId', 'LINE送信状態', 'LINE HTTP status', 'LINE送信日時']);
mockSheets['受渡要請履歴2026-09'].appendRow(['日時', '要請者', '要請者ID', '保管者', '保管者ID', '連絡方法', '連絡先', '状態', 'requestId', 'LINE送信状態', 'LINE HTTP status', 'LINE送信日時']);

// グローバルモックの注入
global.MonthlySheetResolver = {
  getInstance: () => ({
    getCurrentSheet: (type) => {
      if (type === 'staff') return mockSheets['名簿2026-09'];
      if (type === 'flyer') return mockSheets['保有チラシ枚数2026-09'];
      if (type === 'distribution') return mockSheets['配布実績2026-09'];
      if (type === 'transfer') return mockSheets['受渡要請履歴2026-09'];
      return null;
    }
  })
};

global.getMonthlySheet = (type) => global.MonthlySheetResolver.getInstance().getCurrentSheet(type);
global.getSS = () => ({
  getSheetByName: (name) => mockSheets[name] || null
});

global.CacheService = {
  getScriptCache: () => ({
    get: () => null,
    put: () => {}
  })
};

global.LockService = {
  getScriptLock: () => ({
    waitLock: () => {},
    releaseLock: () => {}
  })
};

global.Utilities = {
  formatDate: (d, tz, format) => '2026/09/22 08:00:00',
  getUuid: () => 'uuid-' + Math.random().toString(36).substr(2, 9)
};

global.ContentService = {
  createTextOutput: (str) => ({
    content: str,
    setMimeType: () => ({ content: str })
  }),
  MimeType: { JSON: 'JSON' }
};

global.SpreadsheetApp = {
  flush: () => {}
};

// クラス定義の読み込み
const staffModelCode = fs.readFileSync(path.resolve('active/business/staff/staff_model.js'), 'utf8');
const staffRepoCode = fs.readFileSync(path.resolve('active/business/staff/staff_repository.js'), 'utf8');
const staffServiceCode = fs.readFileSync(path.resolve('active/business/staff/staff_service.js'), 'utf8');
const flyerRepoCode = fs.readFileSync(path.resolve('active/business/flyer/flyer_repository.js'), 'utf8');
const flyerServiceCode = fs.readFileSync(path.resolve('active/business/flyer/flyer_service.js'), 'utf8');
const bulletinServiceCode = fs.readFileSync(path.resolve('active/business/bulletin/bulletin_service.js'), 'utf8');
const transferServiceCode = fs.readFileSync(path.resolve('active/business/transfer/transfer_service.js'), 'utf8');
const v2ApiCode = fs.readFileSync(path.resolve('active/api/v2_api.js'), 'utf8');

// Node.js ESM 環境での暗黙的グローバル変数宣言
globalThis.Staff = undefined;
globalThis.StaffIdentity = undefined;
globalThis.StaffRepository = undefined;
globalThis.StaffService = undefined;
globalThis.FlyerRepository = undefined;
globalThis.FlyerService = undefined;
globalThis.BulletinService = undefined;
globalThis.TransferService = undefined;

new Function('global', staffModelCode)(globalThis);
new Function('global', staffRepoCode)(globalThis);
new Function('global', staffServiceCode)(globalThis);
new Function('global', flyerRepoCode)(globalThis);
new Function('global', flyerServiceCode)(globalThis);
new Function('global', bulletinServiceCode)(globalThis);
new Function('global', transferServiceCode)(globalThis);
globalThis.TransferService.prototype.sendLinePushMessage = () => ({ status: 'SENT', httpStatus: 200 });

globalThis.GPSService = {
  getInstance: () => ({
    updateRecordWithGPSPhoto: (data) => ({ success: true, staffId: data.staffId, staffName: data.staffName })
  })
};

// v2_api.js の processPostAction をテスト可能に読み込む
const processPostActionSource = v2ApiCode.substring(v2ApiCode.indexOf('function processPostAction('));
new Function('global', processPostActionSource + '\nglobal.processPostAction = processPostAction;')(globalThis);

// -------------------------------------------------------------
// TEST 1: 新規LINEユーザー
// LINE User A -> 初回ログイン -> Staff登録 -> S001
// 名簿とHアプリのIdentityが一致すること
// -------------------------------------------------------------
console.log('▶ [TEST 1] 新規LINEユーザー（初回ログイン & Staff登録）検証中...');
{
  const lineUserA = 'U_USER_A_111111111111111111111111';
  
  // 1. 初回ログイン時: getStaffIdentity で未登録判定
  const idResBefore = processPostAction('getStaffIdentity', {
    user: { lineUserId: lineUserA, displayName: 'User A' }
  });
  assert.equal(idResBefore.success, true);
  assert.equal(idResBefore.registered, false);
  assert.equal(idResBefore.code, 'NOT_REGISTERED');

  // 2. Staff登録 (registerStaff)
  const regRes = processPostAction('registerStaff', {
    displayName: 'User A',
    user: { lineUserId: lineUserA }
  });
  assert.equal(regRes.success, true);
  assert.equal(regRes.id, 'S001');
  assert.equal(regRes.name, 'User A');

  // 3. 登録後の getStaffIdentity
  const idResAfter = processPostAction('getStaffIdentity', {
    user: { lineUserId: lineUserA, displayName: 'User A' }
  });
  assert.equal(idResAfter.success, true);
  assert.equal(idResAfter.registered, true);
  assert.equal(idResAfter.staffId, 'S001');
  assert.equal(idResAfter.staffName, 'User A');
  console.log('  ✅ TEST 1 PASS: User A が名簿 S001 として正しく登録・照合された');
}

// -------------------------------------------------------------
// TEST 2: 既存ユーザー
// LINE User A -> 再ログイン -> 同じStaff ID (S001) になること
// -------------------------------------------------------------
console.log('▶ [TEST 2] 既存ユーザー（再ログインと同一Staff ID維持）検証中...');
{
  const lineUserA = 'U_USER_A_111111111111111111111111';
  const idRes = processPostAction('getStaffIdentity', {
    user: { lineUserId: lineUserA }
  });
  assert.equal(idRes.success, true);
  assert.equal(idRes.registered, true);
  assert.equal(idRes.staffId, 'S001');
  assert.equal(idRes.staffName, 'User A');
  console.log('  ✅ TEST 2 PASS: 既存ユーザー A は再ログイン時も確実に S001 と判定された');
}

// -------------------------------------------------------------
// TEST 3: 別ユーザー
// LINE User B -> ログイン しても、AのStaff IDを取得しないこと
// -------------------------------------------------------------
console.log('▶ [TEST 3] 別ユーザー（User BがAのIDを取得しない）検証中...');
{
  const lineUserB = 'U_USER_B_222222222222222222222222';
  const idResB = processPostAction('getStaffIdentity', {
    user: { lineUserId: lineUserB }
  });
  assert.equal(idResB.success, true);
  assert.equal(idResB.registered, false);
  assert.equal(idResB.code, 'NOT_REGISTERED');
  assert.notEqual(idResB.staffId, 'S001');
  console.log('  ✅ TEST 3 PASS: 別ユーザー B は User A の S001 を決して取得しない');
}

// -------------------------------------------------------------
// TEST 4: 古いlocalStorage
// 端末に意図的に localStorage.user_info.id = S001 が残った状態で
// LINE User B がログイン -> S001を使用しないこと
// -------------------------------------------------------------
console.log('▶ [TEST 4] 古いlocalStorage（キャッシュに他人のS001が残存）検証中...');
{
  const mockLocalStorage = {
    'user_info': JSON.stringify({ id: 'S001', last: 'User A', lineUserId: 'U_USER_A_111111111111111111111111' })
  };

  const lineUserB = 'U_USER_B_222222222222222222222222';
  
  // Hアプリ起動時の検証ロジックをシミュレート
  const identityRes = processPostAction('getStaffIdentity', {
    user: { lineUserId: lineUserB, displayName: 'User B' }
  });

  if (identityRes && identityRes.success && identityRes.registered) {
    mockLocalStorage['user_info'] = JSON.stringify({ id: identityRes.staffId, last: identityRes.staffName });
  } else {
    // 未登録判定: 古いS001を無効化し、新規登録へ
    mockLocalStorage['user_info'] = JSON.stringify({ id: '', last: 'User B' });
    const regRes = processPostAction('registerStaff', {
      displayName: 'User B',
      user: { lineUserId: lineUserB }
    });
    assert.equal(regRes.success, true);
    assert.equal(regRes.id, 'S002'); // 新規ID採番
    mockLocalStorage['user_info'] = JSON.stringify({ id: regRes.id, last: regRes.name });
  }

  const finalUserInfo = JSON.parse(mockLocalStorage['user_info']);
  assert.equal(finalUserInfo.id, 'S002');
  assert.notEqual(finalUserInfo.id, 'S001');
  console.log('  ✅ TEST 4 PASS: 端末に残っていた古い S001 は無効化され、User B の正規ID S002 に更新された');
}

// -------------------------------------------------------------
// TEST 5: 保有チラシ
// クライアントから staffId = S001, staffName = K. IWASA と偽装して送っても、
// S001 / K. IWASA として保存できないこと
// -------------------------------------------------------------
console.log('▶ [TEST 5] 保有チラシ（クライアントによるStaff ID偽装の遮断）検証中...');
{
  const lineUserB = 'U_USER_B_222222222222222222222222'; // 正規IDは S002 / User B
  
  // クライアントが意図的に S001 を偽装送信
  const updateRes = processPostAction('updateFlyerStock', {
    location: '桑名市',
    count: 1000,
    staffId: 'S001',        // 偽装
    staffName: 'K. IWASA',  // 偽装
    user: { lineUserId: lineUserB } // 通信者は User B
  });
  assert.equal(updateRes.success, true);

  // 保有チラシシートの確認: S001ではなく、正規の S002 / User B で保存されたこと
  const flyerSheet = mockSheets['保有チラシ枚数2026-09'];
  const lastRow = flyerSheet.getLastRow();
  const savedRow = flyerSheet.getRange(lastRow, 1, 1, 6).getValues()[0];
  
  const savedStaffId = savedRow[1];
  const savedStaffName = savedRow[2];
  const savedCount = savedRow[4];

  assert.equal(savedStaffId, 'S002');
  assert.equal(savedStaffName, 'User B');
  assert.notEqual(savedStaffId, 'S001');
  assert.notEqual(savedStaffName, 'K. IWASA');
  assert.equal(savedCount, 1000);
  console.log(`  ✅ TEST 5 PASS: 偽装送信(S001)は無視され、正規の ${savedStaffId} (${savedStaffName}) として台帳に安全に保存された`);
}

// -------------------------------------------------------------
// TEST 6: 未登録ユーザー
// 名簿に存在しないLINE User IDからStaff依存APIを呼ぶ -> NOT_REGISTERED で拒絶
// -------------------------------------------------------------
console.log('▶ [TEST 6] 未登録ユーザーによる業務APIアクセスの遮断検証中...');
{
  const lineUserC = 'U_USER_C_333333333333333333333333'; // 未登録
  
  const flyerRes = processPostAction('updateFlyerStock', {
    location: '桑名市',
    count: 500,
    user: { lineUserId: lineUserC }
  });
  assert.equal(flyerRes.success, false);
  assert.equal(flyerRes.code, 'NOT_REGISTERED');

  const distRes = processPostAction('submitDistribution', {
    rowId: 1,
    count: 50,
    user: { lineUserId: lineUserC }
  });
  assert.equal(distRes.success, false);
  assert.equal(distRes.code, 'NOT_REGISTERED');
  console.log('  ✅ TEST 6 PASS: 未登録ユーザーからの保有チラシ・配布実績更新は NOT_REGISTERED で完全に遮断された');
}

// -------------------------------------------------------------
// TEST 7: 配布実績偽装遮断
// updateRecordWithGPSPhoto で staffId=S001 を偽装送信しても本人の正規IDで記録
// -------------------------------------------------------------
console.log('▶ [TEST 7] 配布実績（GPS/写真登録でのStaff ID偽装遮断）検証中...');
{
  const lineUserB = 'U_USER_B_222222222222222222222222'; // 正規IDは S002
  const postData = {
    rowId: 1,
    count: 100,
    staffId: 'S001',       // 偽装
    staffName: '他人の名前', // 偽装
    user: { lineUserId: lineUserB }
  };
  
  // ディスパッチャのガードを通過
  processPostAction('updateRecordWithGPSPhoto', postData);

  assert.equal(postData.staffId, 'S002');
  assert.equal(postData.staffName, 'User B');
  assert.notEqual(postData.staffId, 'S001');
  console.log('  ✅ TEST 7 PASS: 配布実績ペイロードの staffId 偽装は強制的に正規の S002 に補正された');
}

// -------------------------------------------------------------
// TEST 8: 掲示板偽装遮断
// createBulletinPost で他人の staffId を指定して投稿できないこと
// -------------------------------------------------------------
console.log('▶ [TEST 8] 掲示板投稿（他人のStaff IDでのなりすまし遮断）検証中...');
{
  const lineUserB = 'U_USER_B_222222222222222222222222'; // 正規IDは S002
  const postData = {
    staffId: 'S001',        // 偽装
    staffName: 'User A',    // 偽装
    message: '偽装投稿テスト',
    user: { lineUserId: lineUserB }
  };

  const res = processPostAction('createBulletinPost', postData);
  assert.equal(res.success, true);
  assert.equal(res.post.staffId, 'S002');
  assert.equal(res.post.staffName, 'User B');
  assert.notEqual(res.post.staffId, 'S001');

  // シートの最新行を確認
  const sheet = mockSheets['掲示板'];
  const lastRow = sheet.getLastRow();
  const savedPost = sheet.getRange(lastRow, 1, 1, 4).getValues()[0];
  assert.equal(savedPost[1], 'S002');
  assert.equal(savedPost[2], 'User B');
  console.log('  ✅ TEST 8 PASS: 掲示板シートには偽装(S001)ではなく、本人の S002 として記録された');
}

// -------------------------------------------------------------
// TEST 9: 受渡要請偽装遮断
// requestFlyerTransfer で他人の staffId を要請者として指定できないこと
// -------------------------------------------------------------
console.log('▶ [TEST 9] 受渡要請（他人のStaff IDでの要請者なりすまし遮断）検証中...');
{
  const lineUserB = 'U_USER_B_222222222222222222222222'; // 正規IDは S002
  const postData = {
    requestId: 'req_test_001',
    requestUserId: 'S001',  // 偽装
    holderUserId: 'S001',
    contactMethod: 'LINE',
    contactValue: 'user_b_line',
    user: { lineUserId: lineUserB }
  };

  const res = processPostAction('requestFlyerTransfer', postData);
  assert.equal(res.success, true);

  // シートの最新行を確認
  const sheet = mockSheets['受渡要請履歴2026-09'];
  const lastRow = sheet.getLastRow();
  const savedTransfer = sheet.getRange(lastRow, 1, 1, 12).getValues()[0];
  const savedRequesterId = savedTransfer[2];
  
  assert.equal(savedRequesterId, 'S002');
  assert.notEqual(savedRequesterId, 'S001');
  console.log('  ✅ TEST 9 PASS: 受渡要請シートには偽装(S001)ではなく、本人の正規ID S002 が要請者として記録された');
}

console.log('\n====================================================');
console.log('🎉 ALL 9 TESTS PASSED PERFECTLY!');
console.log('====================================================');
