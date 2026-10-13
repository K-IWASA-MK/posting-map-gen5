/**
 * tests/test_transfer_module_lifecycle.mjs
 * H-App Transfer Module Separation Lifecycle & Regression Verification Suite
 *
 * 検証対象:
 * 1. TransferModule の初期化・プライベート状態管理
 * 2. 連絡先バリデーション
 * 3. 認証待機前の先行送信ロック (Pre-Auth In-Flight Lock) と連打抑止
 * 4. 正常送信・ペイロード整合性・モック隔離
 * 5. 通信失敗後の再試行と新規 requestId 送信
 * 6. 閉じる→再表示時の世代遮断 (Session Generation Guard: Stale Abort)
 * 7. 遅延応答時の競合保護
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log("====================================================");
console.log("🧪 H-APP TRANSFER MODULE LIFECYCLE AUDIT");
console.log("====================================================\n");

// TransferModule コードの読み込み
const transferModuleCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/transfer.js'), 'utf8');

function createSandboxContext(initialGlobals = {}) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    ...initialGlobals
  };
  vm.createContext(context);
  const TM = vm.runInContext(transferModuleCode + '\n; TransferModule;', context);
  context.TransferModule = TM;
  return context;
}

let passedGates = 0;
function logGate(name) {
  passedGates++;
  console.log(`  ✅ Gate ${passedGates}: ${name}`);
}

async function runTests() {
  // ─── GATE 1: 初期状態検証 ──────────────────────────────────────────
  {
    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;
    assert.ok(TM, 'TransferModule must be defined');
    assert.equal(TM.getCurrentRequest(), null, 'Initial request must be null');
    assert.equal(TM.getCurrentSessionId(), null, 'Initial sessionId must be null');
    assert.equal(TM.isSubmitting(), false, 'Initial isSubmitting must be false');
    logGate('TransferModule initial state and private encapsulation');
  }

  // ─── GATE 2: セッション開始とプライベート状態保持 ──────────────────
  {
    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;
    const sId = TM.startSession('山田太郎', 'U12345', '桑名市中央町', 500, ' ST001 ');
    assert.equal(typeof sId, 'number', 'sessionId must be a number');
    assert.ok(sId > 0, 'sessionId must be positive');
    assert.equal(TM.isSessionActive(sId), true, 'Session must be active');

    const req = TM.getCurrentRequest();
    assert.equal(JSON.stringify(req), JSON.stringify({
      holderName: '山田太郎',
      holderUserId: 'U12345',
      requestArea: '桑名市中央町',
      stockCount: 500,
      storageId: 'ST001' // trimmed
    }));

    // 内部オブジェクトの不変性（コピーであること）
    req.holderName = '改ざん';
    assert.equal(TM.getCurrentRequest().holderName, '山田太郎', 'Direct mutation must not affect internal state');
    logGate('startSession correctly initializes generation and encapsulates private state');
  }

  // ─── GATE 3: セッション無効化（破棄） ──────────────────────────────
  {
    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;
    const sId = TM.startSession('田中次郎', 'U99999', '大山田', 200, 'ST002');
    assert.equal(TM.isSessionActive(sId), true);

    TM.invalidateSession(sId);
    assert.equal(TM.isSessionActive(sId), false, 'Session must be inactive after invalidate');
    assert.equal(TM.getCurrentRequest(), null, 'Request must be reset to null');
    assert.equal(TM.getCurrentSessionId(), null, 'SessionId must be null');
    logGate('invalidateSession resets generation and clears internal state');
  }

  // ─── GATE 4: 連絡先バリデーション ──────────────────────────────────
  {
    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;

    // 空文字
    const empty1 = TM.validateContact('LINE', '');
    assert.equal(empty1.valid, false);
    assert.equal(empty1.error, 'EMPTY_CONTACT');

    // 空白のみ
    const empty2 = TM.validateContact('電話', '   ');
    assert.equal(empty2.valid, false);
    assert.equal(empty2.error, 'EMPTY_CONTACT');

    // 正常入力（トリムされること）
    const valid1 = TM.validateContact('メール', '  taro@example.com  ');
    assert.equal(valid1.valid, true);
    assert.equal(valid1.value, 'taro@example.com');
    logGate('validateContact enforces mandatory input and trims whitespace');
  }

  // ─── GATE 5: 認証待機前の先行送信ロック (Pre-Auth In-Flight Lock) ─
  {
    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;

    assert.equal(TM.isSubmitting(), false);
    TM.setSubmitting(true);
    assert.equal(TM.isSubmitting(), true, 'Must be locked prior to auth wait');
    TM.setSubmitting(false);
    assert.equal(TM.isSubmitting(), false);
    logGate('Pre-auth in-flight lock mechanism is functional');
  }

  // ─── GATE 6: 正常送信ペイロード検証（完全モック通信） ────────────
  {
    let apiCallLog = [];
    const mockCallApiPost = async (action, payload) => {
      apiCallLog.push({ action, payload });
      return { status: 'SENT', success: true };
    };

    const ctx = createSandboxContext({ callApiPost: mockCallApiPost });
    const TM = ctx.TransferModule;

    const sId = TM.startSession('佐藤花子', 'U77777', '駅前', 100, 'ST003');
    const result = await TM.submitTransferRequest({
      sessionId: sId,
      contactMethod: 'LINE',
      contactValue: 'satoh_line',
      requestUserId: 'REQ001',
      requestId: 'req_tr_test_123',
      callApiFn: mockCallApiPost
    });

    assert.equal(result.success, true);
    assert.equal(result.res.status, 'SENT');
    assert.equal(apiCallLog.length, 1);
    assert.equal(JSON.stringify(apiCallLog[0]), JSON.stringify({
      action: 'requestFlyerTransfer',
      payload: {
        requestId: 'req_tr_test_123',
        requestUserId: 'REQ001',
        holderUserId: 'U77777',
        storageId: 'ST003',
        contactMethod: 'LINE',
        contactValue: 'satoh_line'
      }
    }));
    assert.equal(TM.isSubmitting(), false, 'isSubmitting must be restored after completion');
    logGate('Normal submission generates exact payload and isolates mock API');
  }

  // ─── GATE 7: 連打・多重送信の完全遮断 ──────────────────────────────
  {
    let callCount = 0;
    let resolveApi;
    const delayedApi = () => new Promise(resolve => {
      callCount++;
      resolveApi = resolve;
    });

    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;
    const sId = TM.startSession('鈴木一郎', 'U88888', '星見', 300, 'ST004');

    // 1回目のリクエスト開始（未完了のまま保留）
    const p1 = TM.submitTransferRequest({
      sessionId: sId,
      contactMethod: '電話',
      contactValue: '090-1234-5678',
      requestUserId: 'REQ002',
      requestId: 'req_tr_1',
      callApiFn: delayedApi
    });

    // 2回目・3回目の多重クリック（In-flight 中）
    assert.equal(TM.isSubmitting(), true);
    const p2 = TM.submitTransferRequest({
      sessionId: sId,
      contactMethod: '電話',
      contactValue: '090-1234-5678',
      requestUserId: 'REQ002',
      requestId: 'req_tr_2',
      callApiFn: delayedApi
    });

    // 2回目は即座にブロックされる（callCount は増えない）
    resolveApi({ status: 'SENT', success: true });
    await p1;
    await p2;

    assert.equal(callCount, 1, 'Only 1 API call must be executed during rapid clicks');
    logGate('Rapid clicks during in-flight request are strictly blocked');
  }

  // ─── GATE 8: 通信失敗後の再試行と新規 requestId 送信 ──────────────
  {
    let callHistory = [];
    let shouldFail = true;

    const testApi = async (action, payload) => {
      callHistory.push(payload);
      if (shouldFail) {
        throw new Error('Network error');
      }
      return { status: 'SENT', success: true };
    };

    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;
    const sId = TM.startSession('保管者A', 'U111', '北区', 50, 'ST005');

    // 1回目: 失敗
    const res1 = await TM.submitTransferRequest({
      sessionId: sId,
      contactMethod: 'LINE',
      contactValue: 'my_id',
      requestUserId: 'REQ003',
      requestId: 'req_tr_attempt_1',
      callApiFn: testApi
    });
    assert.equal(res1.success, false);
    assert.equal(res1.error.message, 'Network error');
    assert.equal(TM.isSubmitting(), false, 'Lock must be released on failure');

    // 2回目: 再試行（新規 requestId で送信）
    shouldFail = false;
    const res2 = await TM.submitTransferRequest({
      sessionId: sId,
      contactMethod: 'LINE',
      contactValue: 'my_id_fixed',
      requestUserId: 'REQ003',
      requestId: 'req_tr_attempt_2',
      callApiFn: testApi
    });
    assert.equal(res2.success, true);
    assert.equal(res2.res.status, 'SENT');
    assert.equal(callHistory.length, 2);
    assert.equal(callHistory[0].requestId, 'req_tr_attempt_1');
    assert.equal(callHistory[1].requestId, 'req_tr_attempt_2');
    assert.equal(callHistory[1].contactValue, 'my_id_fixed');
    logGate('Retry after failure unlocks state and sends fresh requestId');
  }

  // ─── GATE 9: 閉じる→再表示時の世代遮断 (Session Generation Guard) ──
  {
    let resolveSlowApi;
    const slowApi = () => new Promise(resolve => {
      resolveSlowApi = resolve;
    });

    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;

    // ダイアログ1を開いて送信開始
    const sId1 = TM.startSession('旧保管者', 'U_OLD', '南区', 10, 'ST_OLD');
    const slowPromise = TM.submitTransferRequest({
      sessionId: sId1,
      contactMethod: 'LINE',
      contactValue: 'old_line',
      requestUserId: 'REQ_ME',
      requestId: 'req_tr_old',
      callApiFn: slowApi
    });

    // ユーザーがダイアログ1を閉じて、ダイアログ2（別の保管場所）を開いた
    TM.invalidateSession(sId1);
    const sId2 = TM.startSession('新保管者', 'U_NEW', '西区', 20, 'ST_NEW');
    assert.notEqual(sId1, sId2);
    assert.equal(TM.isSessionActive(sId1), false);
    assert.equal(TM.isSessionActive(sId2), true);

    // 古い通信が遅れて完了
    resolveSlowApi({ status: 'SENT', success: true });
    const slowResult = await slowPromise;

    // 古い通信結果は aborted となり破棄される
    assert.equal(slowResult.aborted, true, 'Stale execution must be aborted');
    assert.equal(slowResult.reason, 'SESSION_SUPERSEDED');
    assert.equal(TM.getCurrentRequest().holderUserId, 'U_NEW', 'Current state must remain intact for session 2');
    logGate('Session Generation Guard discards stale response after close and reopening');
  }

  // ─── GATE 10: 認証待機中のキャンセルと破棄 ────────────────────────
  {
    const ctx = createSandboxContext();
    const TM = ctx.TransferModule;

    const sId = TM.startSession('保管者X', 'UX', '東区', 30, 'STX');
    TM.setSubmitting(true);

    // 認証待機中にダイアログが破棄されたケース
    TM.invalidateSession(sId);

    assert.equal(TM.isSessionActive(sId), false);
    assert.equal(TM.isSubmitting(), false);
    logGate('Canceling during auth wait safely invalidates session and releases lock');
  }

  console.log("\n====================================================");
  console.log(`🎉 ALL ${passedGates} GATES PASSED: TRANSFER MODULE FULLY VERIFIED`);
  console.log("====================================================");
}

runTests().catch(err => {
  console.error("🛑 Test failed:", err);
  process.exit(1);
});
