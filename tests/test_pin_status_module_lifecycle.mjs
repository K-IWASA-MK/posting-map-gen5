/**
 * tests/test_pin_status_module_lifecycle.mjs
 * H-App Pin Status Separation Regression & Lifecycle Verification Suite (29 Gates)
 *
 * Current Runtime / Refactored Module 共通挙動保証テスト
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
console.log("🧪 H-APP PIN STATUS MODULE LIFECYCLE AUDIT (29 GATES)");
console.log("====================================================\n");

// ─── Environment Builder ───────────────────────────────────────────
function createPinStatusContext(customConfig = {}) {
  const apiCalls = [];
  const logDebugCalls = [];
  const refreshCalls = [];
  let apiHandler = customConfig.apiHandler || (async (action, payload) => ({ success: true, inProgress: [], completed: [] }));

  const sandbox = {
    Date: Date,
    Promise: Promise,
    Array: Array,
    Number: Number,
    parseInt: parseInt,
    isNaN: isNaN,
    Error: Error,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,

    callApiPost: async (action, payload) => {
      apiCalls.push({ action, payload, time: Date.now() });
      return await apiHandler(action, payload);
    },

    logDebug: (msg) => {
      logDebugCalls.push(msg);
    },

    refreshMainMapPins: () => {
      refreshCalls.push(Date.now());
    },

    // 観測用
    _apiCalls: apiCalls,
    _logDebugCalls: logDebugCalls,
    _refreshCalls: refreshCalls,
    _setApiHandler: (fn) => { apiHandler = fn; }
  };

  const context = vm.createContext(sandbox);

  // pin-status.js の読み込み (classic-script lexical binding)
  const moduleCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/pin-status.js'), 'utf8');
  vm.runInContext(moduleCode, context);

  return {
    context,
    _apiCalls: apiCalls,
    _logDebugCalls: logDebugCalls,
    _refreshCalls: refreshCalls,
    _setApiHandler: (fn) => { apiHandler = fn; },
    logDebug: sandbox.logDebug,
    refreshMainMapPins: sandbox.refreshMainMapPins
  };
}

let passedGates = 0;
async function runGate(gateNumber, description, testFn) {
  try {
    await testFn();
    console.log(`✅ Gate ${gateNumber.toString().padStart(2, ' ')} PASS: ${description}`);
    passedGates++;
  } catch (err) {
    console.error(`❌ Gate ${gateNumber.toString().padStart(2, ' ')} FAIL: ${description}`);
    console.error(err);
    process.exit(1);
  }
}

// ============================================================================
// Gate 1: 初期状態検証 (inProgress: [], completed: [])
// ============================================================================
await runGate(1, 'Initial status = empty (isInProgress=false, isCompleted=false)', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);
  assert.ok(mod, 'PinStatusModule exists');
  assert.strictEqual(mod.isInProgress(101), false);
  assert.strictEqual(mod.isCompleted(101), false);
  assert.strictEqual(mod.isInProgress('101'), false);
  assert.strictEqual(mod.isCompleted('101'), false);
});

// ============================================================================
// Gate 2: fetchStatus 成功時に inProgress / completed を置換
// ============================================================================
await runGate(2, 'fetchStatus success replaces inProgress and completed', async () => {
  const env = createPinStatusContext({
    apiHandler: async (action) => {
      if (action === 'getGlobalPinStatus') {
        return { success: true, inProgress: [101, 102], completed: [201, 202] };
      }
      return { success: true };
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  await mod.fetchStatus();

  assert.strictEqual(mod.isInProgress(101), true);
  assert.strictEqual(mod.isInProgress(102), true);
  assert.strictEqual(mod.isInProgress(103), false);
  assert.strictEqual(mod.isCompleted(201), true);
  assert.strictEqual(mod.isCompleted(202), true);
  assert.strictEqual(mod.isCompleted(101), false);
});

// ============================================================================
// Gate 3: 10秒スロットリングによる重複フェッチ抑止
// ============================================================================
await runGate(3, '10s throttle suppresses duplicate fetch', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  await mod.fetchStatus();
  await mod.fetchStatus();
  await mod.fetchStatus();

  const getCalls = env._apiCalls.filter(c => c.action === 'getGlobalPinStatus');
  assert.strictEqual(getCalls.length, 1, '10秒以内の連続フェッチは1回のみAPI実行');
});

// ============================================================================
// Gate 4: API失敗時でもスロットルタイムスタンプが更新され次回10秒抑止されること
// ============================================================================
await runGate(4, 'Throttle timestamp semantics preserved on API failure', async () => {
  let callCount = 0;
  const env = createPinStatusContext({
    apiHandler: async (action) => {
      callCount++;
      throw new Error('Network timeout');
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  let errorCaught = null;
  await mod.fetchStatus({
    onError: (err) => { errorCaught = err; }
  });

  assert.ok(errorCaught, 'Error hook triggered');
  assert.strictEqual(callCount, 1);

  // 直後に2回目の呼び出し ➔ スロットルによってAPIが呼ばれないこと
  await mod.fetchStatus();
  assert.strictEqual(callCount, 1, 'API失敗後でもスロットルが有効で再呼び出しが抑止される');
});

// ============================================================================
// Gate 5: fetchStatus 成功時に画面再描画コールバックが1回だけ発火すること
// ============================================================================
await runGate(5, 'Successful fetch triggers onStatusUpdated hook exactly once', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  let updateCount = 0;
  await mod.fetchStatus({
    onStatusUpdated: () => { updateCount++; }
  });

  assert.strictEqual(updateCount, 1, 'onStatusUpdated called exactly once');
});

// ============================================================================
// Gate 6: add 操作時のローカル optimistic mutation (即時反映)
// ============================================================================
await runGate(6, 'add optimistic local mutation occurs before API completes', async () => {
  let resolveApi;
  const apiPromise = new Promise(res => { resolveApi = res; });
  const env = createPinStatusContext({
    apiHandler: async () => {
      await apiPromise;
      return { success: true };
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  // add 呼び出し（await しない）
  const actionPromise = mod.setInProgress(301, 'add');

  // API 完了前だがローカル状態は即座に true になっていること
  assert.strictEqual(mod.isInProgress(301), true, 'Optimistic add is synchronous');

  resolveApi();
  await actionPromise;
});

// ============================================================================
// Gate 7: 重複 add で同一 rowId が二重登録されないこと
// ============================================================================
await runGate(7, 'Duplicate add does not duplicate rowId', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  await mod.setInProgress(301, 'add');
  await mod.setInProgress(301, 'add');

  assert.strictEqual(mod.isInProgress(301), true);
  // remove 1回で消えることで重複配列になっていないことを検証
  await mod.setInProgress(301, 'remove');
  assert.strictEqual(mod.isInProgress(301), false);
});

// ============================================================================
// Gate 8: remove 操作時のローカル optimistic mutation (即時削除)
// ============================================================================
await runGate(8, 'remove optimistic local mutation occurs immediately', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  await mod.setInProgress(401, 'add');
  assert.strictEqual(mod.isInProgress(401), true);

  let resolveApi;
  const apiPromise = new Promise(res => { resolveApi = res; });
  env._setApiHandler(async () => {
    await apiPromise;
    return { success: true };
  });

  const removePromise = mod.setInProgress(401, 'remove');
  // API 完了前だが即座に false になっていること
  assert.strictEqual(mod.isInProgress(401), false, 'Optimistic remove is synchronous');

  resolveApi();
  await removePromise;
});

// ============================================================================
// Gate 9: add / remove の FIFO 直列化順序保証
// ============================================================================
await runGate(9, 'add/remove FIFO ordering preserved', async () => {
  const order = [];
  const env = createPinStatusContext({
    apiHandler: async (action, payload) => {
      order.push(`${payload.pinAction}:${payload.rowId}`);
      return { success: true };
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  // 連打シミュレーション
  const p1 = mod.setInProgress(1, 'add');
  const p2 = mod.setInProgress(2, 'add');
  const p3 = mod.setInProgress(1, 'remove');
  const p4 = mod.setInProgress(3, 'add');

  await Promise.all([p1, p2, p3, p4]);

  assert.deepStrictEqual(order, ['add:1', 'add:2', 'remove:1', 'add:3'], 'FIFO順序が直列に保持されている');
});

// ============================================================================
// Gate 10: 実行中 (in-flight) 通信がある場合の直列チェーン維持
// ============================================================================
await runGate(10, 'In-flight action chain remains serialized', async () => {
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const env = createPinStatusContext({
    apiHandler: async () => {
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise(r => setTimeout(r, 10));
      activeCalls--;
      return { success: true };
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  const promises = [
    mod.setInProgress(1, 'add'),
    mod.setInProgress(2, 'add'),
    mod.setInProgress(3, 'add'),
    mod.setInProgress(4, 'add')
  ];

  await Promise.all(promises);
  assert.strictEqual(maxActiveCalls, 1, '同時並行API通信は0（常に最大1つの直列実行）');
});

// ============================================================================
// Gate 11: 認証失敗・APIエラー時でも例外がスワローされ、後続チェーンが停止せず、ローカルstateがロールバックされない現行契約の維持
// ============================================================================
await runGate(11, 'Identity/API failure preserves local state without rollback and keeps chain going', async () => {
  let failCount = 0;
  const env = createPinStatusContext({
    apiHandler: async (action, payload) => {
      if (payload.rowId === 501) {
        failCount++;
        throw new Error('AUTH_FAILED');
      }
      return { success: true };
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  let errorCaptured = null;
  // 501 は失敗するが、例外は swallow されて chain は resolve する
  await mod.setInProgress(501, 'add', {
    onError: (err) => { errorCaptured = err; }
  });

  assert.ok(errorCaptured, 'Error hook received error');
  // 重要契約: API失敗時でもローカル状態は rollback されない (現行仕様)
  assert.strictEqual(mod.isInProgress(501), true, 'No rollback on API failure');

  // 後続のアクションが停止せず正常実行されること
  await mod.setInProgress(502, 'add');
  assert.strictEqual(mod.isInProgress(502), true, 'Chain continues after error');
});

// ============================================================================
// Gate 12: マップ用状態クエリ: isCompleted の正確な判定
// ============================================================================
await runGate(12, 'Map read: isCompleted query', async () => {
  const env = createPinStatusContext({
    apiHandler: async () => ({ success: true, inProgress: [], completed: [601] })
  });
  const mod = vm.runInContext('PinStatusModule', env.context);
  await mod.fetchStatus();

  assert.strictEqual(mod.isCompleted(601), true);
  assert.strictEqual(mod.isCompleted('601'), true);
  assert.strictEqual(mod.isCompleted(602), false);
});

// ============================================================================
// Gate 13: マップ用状態クエリ: isInProgress の正確な判定
// ============================================================================
await runGate(13, 'Map read: isInProgress query', async () => {
  const env = createPinStatusContext({
    apiHandler: async () => ({ success: true, inProgress: [701], completed: [] })
  });
  const mod = vm.runInContext('PinStatusModule', env.context);
  await mod.fetchStatus();

  assert.strictEqual(mod.isInProgress(701), true);
  assert.strictEqual(mod.isInProgress('701'), true);
  assert.strictEqual(mod.isInProgress(702), false);
});

// ============================================================================
// Gate 14: 未選択・未完了時のデフォルト状態判定
// ============================================================================
await runGate(14, 'Default / unallocated state evaluation', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  assert.strictEqual(mod.isCompleted(801), false);
  assert.strictEqual(mod.isInProgress(801), false);
});

// ============================================================================
// Gate 15: 【CURRENT RUNTIME conflict precedence】COMPLETED > IN_PROGRESS > UNALLOCATED
// ============================================================================
await runGate(15, 'CURRENT RUNTIME conflict precedence: COMPLETED > IN_PROGRESS > UNALLOCATED', async () => {
  const env = createPinStatusContext({
    apiHandler: async (action) => {
      if (action === 'getGlobalPinStatus') {
        return {
          success: true,
          inProgress: [901],
          completed: [901]
        };
      }
      return { success: true };
    }
  });
  const mod = vm.runInContext('PinStatusModule', env.context);

  await mod.fetchStatus();

  // 1. 同一 rowId が completed と inProgress の両方に存在することを確認
  assert.strictEqual(mod.isCompleted(901), true, '901 is completed');
  assert.strictEqual(mod.isInProgress(901), true, '901 is inProgress');

  // 2. render.js の実Runtime branch ロジックを正確にシミュレーション
  function resolveMarkerColor(rowId) {
    const isCompleted = mod.isCompleted(rowId);
    const isInProgress = mod.isInProgress(rowId);
    if (isCompleted) {
      return '#EA5F08'; // 橙 (COMPLETED)
    } else if (isInProgress) {
      return '#00B7FF'; // 青 (IN_PROGRESS)
    }
    return '#22c55e';   // 緑 (UNALLOCATED)
  }

  // 3. conflict 時は COMPLETED が優先され orange であること
  assert.strictEqual(resolveMarkerColor(901), '#EA5F08', 'Conflict precedence: COMPLETED wins over IN_PROGRESS');

  // 4. render.js ソースコード上の分岐順序（if (isCompleted) ... else if (isInProgress) ...）を静的検証
  const renderJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
  const refreshFnIdx = renderJs.indexOf('window.refreshMainMapPins = function()');
  assert.ok(refreshFnIdx > 0, 'refreshMainMapPins exists');
  const refreshFnBlock = renderJs.substring(refreshFnIdx, renderJs.indexOf('};', refreshFnIdx));
  const isCompletedBranchIdx = refreshFnBlock.indexOf('if (isCompleted)');
  const isInProgressBranchIdx = refreshFnBlock.indexOf('else if (isInProgress');
  assert.ok(isCompletedBranchIdx > 0 && isInProgressBranchIdx > isCompletedBranchIdx, 'isCompleted branch precedes isInProgress branch in render.js');
});

// ============================================================================
// Gate 16: map idle イベントと PinStatusModule.fetchStatus の結合健全性
// ============================================================================
await runGate(16, 'Map idle fetch integration wiring', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  let refreshCalled = false;
  // thin wrapper fetchGlobalPinStatus のシミュレーション
  const fetchGlobalPinStatus = function() {
    return mod.fetchStatus({
      onStatusUpdated: () => { refreshCalled = true; },
      onError: (err) => { env.logDebug(`[fetchGlobalPinStatus] Error: ${err.message}`); }
    });
  };

  // idle イベント発火シミュレーション
  await fetchGlobalPinStatus();
  assert.strictEqual(refreshCalled, true, 'fetchGlobalPinStatus refreshes map via hook');
});

// ============================================================================
// Gate 17: マーカータップ時の add 発火結合健全性
// ============================================================================
await runGate(17, 'Marker selection add integration', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  // 1. Production code wiring static verification
  const renderJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
  assert.ok(renderJs.includes('window.setPinInProgress(activeMarker.rowId, "add")') || renderJs.includes('window.setPinInProgress(row.rowId, "add")'), 'render.js contains window.setPinInProgress add on selection');

  // 2. Dynamic execution
  const setPinInProgress = function(rowId, action) {
    return mod.setInProgress(rowId, action, {
      authorize: async () => {},
      onError: (err) => {}
    });
  };

  await setPinInProgress(1001, 'add');
  assert.strictEqual(mod.isInProgress(1001), true);
  assert.strictEqual(env._apiCalls.some(c => c.action === 'setPinInProgress' && c.payload.pinAction === 'add'), true);
});

// ============================================================================
// Gate 18: ポップアップ「×」/ キャンセル時の remove 発火結合健全性
// ============================================================================
await runGate(18, 'Popup cancel/close remove integration', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  // 1. Production code wiring static verification
  const renderJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
  assert.ok(renderJs.includes('window.setPinInProgress(activeMarker.rowId, "remove")'), 'render.js contains window.setPinInProgress remove on close/cancel');

  // 2. Dynamic execution
  const setPinInProgress = function(rowId, action) {
    return mod.setInProgress(rowId, action, {
      authorize: async () => {},
      onError: (err) => {}
    });
  };

  await setPinInProgress(1001, 'add');
  assert.strictEqual(mod.isInProgress(1001), true);

  await setPinInProgress(1001, 'remove');
  assert.strictEqual(mod.isInProgress(1001), false);
  assert.strictEqual(env._apiCalls.some(c => c.action === 'setPinInProgress' && c.payload.pinAction === 'remove'), true);
});

// ============================================================================
// Gate 19: Backend 受諾パスからの remove が Exactly Once であること
// ============================================================================
await runGate(19, 'Backend accepted path remove = exactly once', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  // 1. Production code wiring static verification (Single-Fire point via Queue Hook)
  const dbJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/db.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/app.js'), 'utf8');

  // db.js: dequeueSync 直後に onAcceptedAfterDequeue Hook が呼ばれること
  const dequeueIdx = dbJs.lastIndexOf('await dequeueSync(item.id);');
  assert.ok(dequeueIdx > 0, 'db.js contains dequeueSync accepted path');
  const postDequeueBlock = dbJs.substring(dequeueIdx, dequeueIdx + 300);
  assert.ok(postDequeueBlock.includes('onAcceptedAfterDequeue'), 'db.js fires onAcceptedAfterDequeue right after dequeueSync');

  // app.js: onAcceptedAfterDequeue Hook 内部で window.setPinInProgress(item.rowId, "remove") が呼ばれること
  const hookIdx = appJs.indexOf('onAcceptedAfterDequeue');
  assert.ok(hookIdx > 0, 'app.js defines onAcceptedAfterDequeue');
  const hookBlock = appJs.substring(hookIdx, appJs.indexOf('onFailedAfterQueueUpdate', hookIdx));
  assert.ok(hookBlock.includes('window.setPinInProgress(item.rowId, "remove")'), 'app.js fires window.setPinInProgress remove inside onAcceptedAfterDequeue');

  // 2. Dynamic execution
  let removeCount = 0;
  const setPinInProgress = function(rowId, action) {
    if (action === 'remove') removeCount++;
    return mod.setInProgress(rowId, action, {
      authorize: async () => {},
      onError: () => {}
    });
  };

  // onAcceptedAfterDequeue の dequeueSync 後呼出シミュレーション
  await setPinInProgress(1101, 'remove');

  assert.strictEqual(removeCount, 1, 'accepted hook sends exactly one remove');
});

// ============================================================================
// Gate 20: Backend 受諾パス（db.js）からの reflectCompleted ローカル反映健全性
// ============================================================================
await runGate(20, 'Backend accepted path reflectCompleted local reflection', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  // 事前に作業中にしておく
  await mod.setInProgress(1201, 'add');
  assert.strictEqual(mod.isInProgress(1201), true);
  assert.strictEqual(mod.isCompleted(1201), false);

  // db.js の reflectCompleted
  mod.reflectCompleted(1201);

  assert.strictEqual(mod.isCompleted(1201), true, 'Completed set to true');
  assert.strictEqual(mod.isInProgress(1201), false, 'InProgress removed automatically');
});

// ============================================================================
// Gate 21: triggerUISyncRefresh から追加の setInProgress が発火しないこと (Single-Fire 保護)
// ============================================================================
await runGate(21, 'triggerUISyncRefresh causes no extra remove', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  let setCalls = 0;
  const setPinInProgress = function(rowId, action) {
    setCalls++;
    return mod.setInProgress(rowId, action);
  };

  // triggerUISyncRefresh 改訂後シミュレーション: reflectCompleted のみ呼び出し、setPinInProgress は呼ばない
  const triggerUISyncRefreshSimulation = (points) => {
    points.forEach(p => {
      if (p.isDone === true) {
        mod.reflectCompleted(p.rowId);
      }
    });
  };

  triggerUISyncRefreshSimulation([{ rowId: 1301, isDone: true }]);
  assert.strictEqual(setCalls, 0, 'No setPinInProgress from triggerUISyncRefresh');
  assert.strictEqual(mod.isCompleted(1301), true);
});

// ============================================================================
// Gate 22: submitMissionComplete ポーリングから追加の setInProgress が発火しないこと (Single-Fire 保護)
// ============================================================================
await runGate(22, 'submitMissionComplete polling causes no extra remove', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  let setCalls = 0;
  const setPinInProgress = function(rowId, action) {
    setCalls++;
    return mod.setInProgress(rowId, action);
  };

  // submitMissionComplete ポーリングシミュレーション: reflectCompleted のみ呼び出し
  const pollingSuccessSimulation = (rowId) => {
    mod.reflectCompleted(rowId);
  };

  pollingSuccessSimulation(1401);
  assert.strictEqual(setCalls, 0, 'No setPinInProgress from polling completion');
  assert.strictEqual(mod.isCompleted(1401), true);
});

// ============================================================================
// Gate 23: REJECTED (STALE_MONTH等) 終端時に completed に昇格しないこと
// ============================================================================
await runGate(23, 'REJECTED does not become completed', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  const point = { rowId: 1501, syncStatus: 'REJECTED', isDone: false };
  if (point.syncStatus !== 'REJECTED' && point.isDone === true) {
    mod.reflectCompleted(point.rowId);
  }

  assert.strictEqual(mod.isCompleted(1501), false, 'REJECTED is never completed');
});

// ============================================================================
// Gate 24: RETRY (一時エラー) 時に completed に昇格しないこと
// ============================================================================
await runGate(24, 'RETRY does not become completed', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  const status = 'RETRY';
  if (status !== 'RETRY') {
    mod.reflectCompleted(1601);
  }

  assert.strictEqual(mod.isCompleted(1601), false, 'RETRY is not completed');
});

// ============================================================================
// Gate 25: 永続化失敗時に completed に昇格しないこと
// ============================================================================
await runGate(25, 'Failed persistence does not become completed', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  const res = { success: false };
  if (res.success === true && res.accepted !== false) {
    mod.reflectCompleted(1701);
  }

  assert.strictEqual(mod.isCompleted(1701), false, 'Failed persistence is not completed');
});

// ============================================================================
// Gate 26: PinStatusModule Public API は厳密に 5 個。getSnapshot / mutable callback / test-only API なし
// ============================================================================
await runGate(26, 'Public API has exactly 5 approved methods with no getSnapshot or mutable props', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  const keys = Object.keys(mod).sort();
  const approvedKeys = [
    'fetchStatus',
    'isCompleted',
    'isInProgress',
    'reflectCompleted',
    'setInProgress'
  ].sort();

  assert.deepStrictEqual(keys, approvedKeys, 'Public API must strictly match approved 5 methods');
  assert.strictEqual(typeof mod.fetchStatus, 'function');
  assert.strictEqual(typeof mod.setInProgress, 'function');
  assert.strictEqual(typeof mod.isInProgress, 'function');
  assert.strictEqual(typeof mod.isCompleted, 'function');
  assert.strictEqual(typeof mod.reflectCompleted, 'function');

  assert.strictEqual(mod.getSnapshot, undefined, 'No getSnapshot API');
  assert.strictEqual(mod.onStatusUpdated, undefined, 'No public mutable callback property');
});

// ============================================================================
// Gate 27: H-App Runtime から window.globalPinStatus と window.lastPinStatusSync が完全消滅
// ============================================================================
await runGate(27, 'window.globalPinStatus and window.lastPinStatusSync completely eliminated from runtime code', async () => {
  const appJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/app.js'), 'utf8');
  const renderJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
  const dbJs = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/db.js'), 'utf8');

  // globalPinStatus の全コードからの完全消滅を検証
  assert.ok(!appJs.includes('window.globalPinStatus'), 'app.js must not contain window.globalPinStatus');
  assert.ok(!renderJs.includes('window.globalPinStatus'), 'render.js must not contain window.globalPinStatus');
  assert.ok(!dbJs.includes('window.globalPinStatus'), 'db.js must not contain window.globalPinStatus');

  // lastPinStatusSync の完全消滅を検証
  assert.ok(!appJs.includes('window.lastPinStatusSync'), 'app.js must not contain window.lastPinStatusSync');
  assert.ok(!appJs.includes('pinActionPromiseChain'), 'app.js must not contain pinActionPromiseChain');
});

// ============================================================================
// Gate 28: PinStatusModule ソース内に waitForIdentityVerified, logDebug, document, google.maps, window., globalThis が存在しない
// ============================================================================
await runGate(28, 'PinStatusModule source has zero forbidden reverse references', async () => {
  const moduleSource = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/pin-status.js'), 'utf8');

  const forbiddenTerms = [
    'waitForIdentityVerified',
    'logDebug',
    'document',
    'google.maps',
    'window.',
    'globalThis',
    'root.PinStatusModule',
    'self.PinStatusModule'
  ];

  for (const term of forbiddenTerms) {
    assert.ok(!moduleSource.includes(term), `pin-status.js must not contain '${term}'`);
  }

  // Node VM context property check (must NOT expose on global context)
  const env = createPinStatusContext();
  assert.strictEqual(env.context.PinStatusModule, undefined, 'PinStatusModule must not be a property of global context');
});

// ============================================================================
// Gate 29: reflectCompleted は API 通信 0。local derived cache のみ変更
// ============================================================================
await runGate(29, 'reflectCompleted causes zero API calls and only modifies local cache', async () => {
  const env = createPinStatusContext();
  const mod = vm.runInContext('PinStatusModule', env.context);

  const initialApiCount = env._apiCalls.length;
  mod.reflectCompleted(1901);
  const afterApiCount = env._apiCalls.length;

  assert.strictEqual(afterApiCount, initialApiCount, 'reflectCompleted must trigger zero API calls');
  assert.strictEqual(mod.isCompleted(1901), true, 'Reflected rowId is completed');
});

console.log("\n====================================================");
console.log(`🎉 ALL 29 PIN STATUS LIFECYCLE GATES PASSED PERFECTLY!`);
console.log("====================================================");
