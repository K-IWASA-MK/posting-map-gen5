/**
 * tests/test_bulletin_module_lifecycle.mjs
 * H-App Bulletin Separation Regression & Lifecycle Verification Suite (21 Gates)
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
console.log("🧪 H-APP BULLETIN MODULE LIFECYCLE AUDIT (21 GATES)");
console.log("====================================================\n");

// ─── Mock DOM Element ──────────────────────────────────────────────
class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.classListSet = new Set();
    this.style = {};
    this._listeners = {};
    this.focused = false;

    this.classList = {
      add: (cls) => this.classListSet.add(cls),
      remove: (cls) => this.classListSet.delete(cls),
      contains: (cls) => this.classListSet.has(cls),
      has: (cls) => this.classListSet.has(cls)
    };
  }
  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  focus() {
    this.focused = true;
  }
}

// ─── Environment Builder ───────────────────────────────────────────
function createBulletinTestContext(customConfig = {}) {
  const elements = {};
  function $(id) {
    if (!elements[id]) {
      const tag = id.includes('input') || id.includes('message') ? 'textarea' :
                  id.includes('btn') ? 'button' : 'div';
      elements[id] = new MockElement(id, tag);
    }
    return elements[id];
  }

  // 初期化: page-bulletin (デフォルト表示状態)
  const pageBulletin = $('page-bulletin');
  pageBulletin.classList.remove('hidden');

  const container = $('bulletin-list-container');
  const msgInput = $('bulletin-message-input');
  const submitBtn = $('btn-bulletin-submit');
  submitBtn.textContent = '投稿する';
  const charCounter = $('bulletin-char-counter');
  charCounter.textContent = '0 / 150';

  let alertMessages = [];
  let apiCallLog = [];
  let timerCallbacks = [];
  let timerIdSeq = 0;

  // Controlled Timers
  const mockSetTimeout = (fn, delay) => {
    const id = ++timerIdSeq;
    timerCallbacks.push({ id, fn, delay, executed: false, cancelled: false });
    return id;
  };

  const mockClearTimeout = (id) => {
    const entry = timerCallbacks.find(t => t.id === id);
    if (entry) entry.cancelled = true;
  };

  const advanceTimersByTime = async (ms) => {
    // 期限が来たタイマーを実行
    for (const t of timerCallbacks) {
      if (!t.executed && !t.cancelled && t.delay <= ms) {
        t.executed = true;
        t.fn();
      }
    }
    // microtask を消化
    await new Promise(r => setImmediate(r));
  };

  const localStorageData = {
    'user_info': JSON.stringify({ id: 'STAFF_007', first: '太郎', last: '桑名' })
  };

  const mockLocalStorage = {
    getItem: (k) => localStorageData[k] || null,
    setItem: (k, v) => { localStorageData[k] = String(v); }
  };

  let identityVerifiedShouldPass = customConfig.identityVerifiedPass !== false;
  const mockWaitForIdentityVerified = () => {
    if (identityVerifiedShouldPass) {
      return Promise.resolve();
    }
    return Promise.reject(new Error("IDENTITY_FAILED"));
  };

  let apiHandler = customConfig.apiHandler || (async (action, payload) => {
    apiCallLog.push({ action, payload: payload ? JSON.parse(JSON.stringify(payload)) : {} });
    if (action === 'getBulletinPosts') {
      return {
        success: true,
        posts: [
          { id: 'BP_1', updatedAt: '2026/10/02 10:00', staffId: 'STAFF_001', staffName: 'リーダーA', message: '雨天注意', isMe: false },
          { id: 'BP_2', updatedAt: '2026/10/02 11:00', staffId: 'STAFF_007', staffName: '桑名 太郎', message: '補充完了', isMe: true }
        ]
      };
    }
    if (action === 'createBulletinPost') {
      return { success: true, post: { ...payload, updatedAt: '2026/10/02 12:00' } };
    }
    return { success: true };
  });

  const windowObj = {
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const sandbox = {
    console: {
      log: () => {},
      warn: (...args) => {},
      error: (...args) => {}
    },
    document: {
      getElementById: (id) => $(id),
      createElement: (tag) => new MockElement('dynamic', tag),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    $: $,
    window: windowObj,
    globalThis: windowObj,
    localStorage: mockLocalStorage,
    setTimeout: mockSetTimeout,
    clearTimeout: mockClearTimeout,
    alert: (msg) => { alertMessages.push(msg); },
    waitForIdentityVerified: mockWaitForIdentityVerified,
    callApiPost: (action, payload) => apiHandler(action, payload),
    setQueueLifecycleGates: () => {},
    currentUser: null,
    escapeHtml: (str) => String(str || '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
  };

  const context = vm.createContext(sandbox);

  // ソース読み込み順序の完全再現
  const authModulePath = path.join(REPO_ROOT, 'active/h-app/modules/auth.js');
  if (fs.existsSync(authModulePath)) {
    const authSrc = fs.readFileSync(authModulePath, 'utf8');
    vm.runInContext(authSrc, context);
  }

  const renderSrc = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
  vm.runInContext(renderSrc, context);

  const bulletinModulePath = path.join(REPO_ROOT, 'active/h-app/modules/bulletin.js');
  if (fs.existsSync(bulletinModulePath)) {
    const bulletinSrc = fs.readFileSync(bulletinModulePath, 'utf8');
    vm.runInContext(bulletinSrc, context);
  }

  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/app.js'), 'utf8');
  vm.runInContext(appSrc, context);

  // AuthModule の Identity Gate をデフォルトで認証済みに設定
  vm.runInContext("AuthModule.setIdentityVerified(true);", context);

  // window に公開された entry point を sandbox 側にも同期
  Object.assign(sandbox, windowObj);

  return {
    context,
    sandbox,
    window: windowObj,
    elements,
    $,
    apiCallLog,
    alertMessages,
    advanceTimersByTime,
    setApiHandler: (fn) => { apiHandler = fn; },
    setIdentityVerifiedPass: (pass) => {
      identityVerifiedShouldPass = pass;
      vm.runInContext(`AuthModule.setIdentityVerified(${pass ? 'true' : 'false'}); AuthModule.setIdentitySyncPromise(null);`, context);
    }
  };
}

async function runAllGates() {
  let passedGates = 0;

  // ────────────────────────────────────────────────────────────────
  // Gate 1: Initial fetch (loading -> posts)
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    const fetchPromise = env.sandbox.fetchBulletinPosts();
    // 初回 Loading UI 確認
    const loadingHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(loadingHtml.includes('Loading Bulletin'), "Gate 1: Initial fetch must display loading UI");

    const posts = await fetchPromise;
    assert.ok(Array.isArray(posts) && posts.length > 0, "Gate 1: Initial fetch must resolve with posts array");
    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(containerHtml.includes('bulletin-row') || containerHtml.includes('雨天注意'), "Gate 1: Posts must be rendered to container");
    console.log("  ✅ Gate 1 PASS: Initial fetch displays loading then renders posts");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 2: Cached revisit (no loading, no api, immediate cache render)
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    await env.sandbox.fetchBulletinPosts(); // 1回目
    env.apiCallLog.length = 0; // ログクリア
    env.$('bulletin-list-container').innerHTML = ''; // コンテナクリア

    // 2回目（force=false）
    const secondPromise = env.sandbox.fetchBulletinPosts();
    assert.equal(env.apiCallLog.length, 0, "Gate 2: Cached revisit must not invoke API");
    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(!containerHtml.includes('Loading Bulletin'), "Gate 2: Cached revisit must not show loading UI");
    assert.ok(containerHtml.includes('雨天注意'), "Gate 2: Cached revisit must immediately render cached posts");
    const posts = await secondPromise;
    assert.ok(Array.isArray(posts) && posts.length > 0, "Gate 2: Cached revisit must resolve immediately with cached posts");
    console.log("  ✅ Gate 2 PASS: Cached revisit renders immediately without API call");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 3: No-cache in-flight Promise sharing
  // ────────────────────────────────────────────────────────────────
  {
    let resolveFirstApi;
    const env = createBulletinTestContext({
      apiHandler: async (action) => {
        if (action === 'getBulletinPosts') {
          return new Promise(resolve => { resolveFirstApi = resolve; });
        }
        return { success: true };
      }
    });

    const promise1 = env.sandbox.fetchBulletinPosts();
    const promise2 = env.sandbox.fetchBulletinPosts(); // キャッシュなし通信中に2本目

    assert.strictEqual(promise1, promise2, "Gate 3: In-flight fetch without cache must share identical Promise instance");

    // 通信完了
    resolveFirstApi({
      success: true,
      posts: [{ id: 'BP_1', updatedAt: '2026/10/02', staffId: 'S1', staffName: 'N1', message: 'M1', isMe: false }]
    });

    const res1 = await promise1;
    const res2 = await promise2;
    assert.deepStrictEqual(res1, res2, "Gate 3: Both callers receive identical resolved posts");
    console.log("  ✅ Gate 3 PASS: No-cache in-flight Promise is shared identically");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 4: Cache precedence over forced in-flight
  // ────────────────────────────────────────────────────────────────
  {
    let resolveForceApi;
    const env = createBulletinTestContext({
      apiHandler: async (action) => {
        if (action === 'getBulletinPosts') {
          return new Promise(resolve => { resolveForceApi = resolve; });
        }
        return { success: true };
      }
    });

    // まずキャッシュを確立するため通常成功させる
    env.setApiHandler(async () => ({
      success: true,
      posts: [{ id: 'BP_1', message: 'Initial Cache', isMe: false }]
    }));
    await env.sandbox.fetchBulletinPosts();

    // 次に force: true で通信を開始し、pending 状態にする
    env.setApiHandler(async () => new Promise(resolve => { resolveForceApi = resolve; }));
    const forcePromise = env.sandbox.fetchBulletinPosts({ force: true });

    // force 通信が in-flight 中の状態で、通常 fetch (force: false) を実行
    const normalPromise = env.sandbox.fetchBulletinPosts({ force: false });

    // 重要契約: cache があり force: false なら、in-flight 通信を待たずに即時 resolve
    let normalResolved = false;
    normalPromise.then(() => { normalResolved = true; });
    await new Promise(r => setImmediate(r));

    assert.ok(normalResolved, "Gate 4: Normal fetch must immediately resolve from cache even when force refresh is in-flight");
    assert.notStrictEqual(normalPromise, forcePromise, "Gate 4: Normal fetch must not share the in-flight force Promise");

    // 後始末: force 通信を settle
    resolveForceApi({ success: true, posts: [{ id: 'BP_1', message: 'Updated', isMe: false }] });
    await forcePromise;
    console.log("  ✅ Gate 4 PASS: Cache precedence over in-flight force refresh strictly maintained");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 5: Force reservation
  // ────────────────────────────────────────────────────────────────
  {
    let apiCallCount = 0;
    let resolveApi;
    const env = createBulletinTestContext({
      apiHandler: async (action) => {
        if (action === 'getBulletinPosts') {
          apiCallCount++;
          return new Promise(resolve => { resolveApi = resolve; });
        }
        return { success: true };
      }
    });

    const promise1 = env.sandbox.fetchBulletinPosts();
    assert.equal(apiCallCount, 1, "Gate 5: First API call fired");

    // 通信中に force: true 要求
    const promiseForce = env.sandbox.fetchBulletinPosts({ force: true });
    assert.equal(apiCallCount, 1, "Gate 5: Force during in-flight must not immediately fire second GET");
    assert.strictEqual(promise1, promiseForce, "Gate 5: Force during in-flight must return existing in-flight Promise");

    resolveApi({ success: true, posts: [{ id: 'BP_1', message: 'P1', isMe: false }] });
    await promise1;
    console.log("  ✅ Gate 5 PASS: Force during in-flight is reserved and returns existing Promise");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 6: Exactly-one queued refresh
  // ────────────────────────────────────────────────────────────────
  {
    let apiCallCount = 0;
    let resolveFirstApi;
    const env = createBulletinTestContext({
      apiHandler: async (action) => {
        if (action === 'getBulletinPosts') {
          apiCallCount++;
          if (apiCallCount === 1) {
            return new Promise(resolve => { resolveFirstApi = resolve; });
          }
          return { success: true, posts: [{ id: 'BP_2', message: 'Refreshed', isMe: false }] };
        }
        return { success: true };
      }
    });

    const p1 = env.sandbox.fetchBulletinPosts();
    // 複数回 force 要求を入れる
    env.sandbox.fetchBulletinPosts({ force: true });
    env.sandbox.fetchBulletinPosts({ force: true });
    assert.equal(apiCallCount, 1, "Gate 6: Still exactly 1 call while in-flight");

    // 1本目を settle させる
    resolveFirstApi({ success: true, posts: [{ id: 'BP_1', message: 'Initial', isMe: false }] });
    await p1;
    // settle 後の queued microtask を消化
    await new Promise(r => setTimeout(r, 10));

    assert.equal(apiCallCount, 2, "Gate 6: Exactly one queued refresh fired after initial settle");
    console.log("  ✅ Gate 6 PASS: Exactly one queued force refresh executes after settle");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 7: UI timeout / network continuation
  // ────────────────────────────────────────────────────────────────
  {
    let networkSettled = false;
    const env = createBulletinTestContext({
      apiHandler: async () => {
        return new Promise(resolve => {
          // 意図的に未解決のまま保持
        });
      }
    });

    env.sandbox.fetchBulletinPosts();
    // 15秒経過させる
    await env.advanceTimersByTime(15000);

    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(containerHtml.includes('タイムアウト') || containerHtml.includes('⚠️'), "Gate 7: UI must present timeout error after 15s");
    console.log("  ✅ Gate 7 PASS: UI presents timeout error while network continues");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 8: Returned Promise remains network Promise
  // ────────────────────────────────────────────────────────────────
  {
    let resolveNetwork;
    const env = createBulletinTestContext({
      apiHandler: async () => {
        return new Promise(resolve => { resolveNetwork = resolve; });
      }
    });

    const returnedPromise = env.sandbox.fetchBulletinPosts();
    let promiseSettled = false;
    returnedPromise.then(() => { promiseSettled = true; }).catch(() => { promiseSettled = true; });

    // 15秒経過させて UI をタイムアウトさせる
    await env.advanceTimersByTime(15000);
    assert.equal(promiseSettled, false, "Gate 8: Returned Promise must NOT settle when UI times out");

    // 20秒後に network が解決
    resolveNetwork({ success: true, posts: [{ id: 'BP_1', message: 'Late', isMe: false }] });
    await new Promise(r => setImmediate(r));
    assert.equal(promiseSettled, true, "Gate 8: Returned Promise settles only when real network settles");
    console.log("  ✅ Gate 8 PASS: Returned Promise remains network Promise and ignores UI timeout");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 9: Late success
  // ────────────────────────────────────────────────────────────────
  {
    let resolveNetwork;
    const env = createBulletinTestContext({
      apiHandler: async () => {
        return new Promise(resolve => { resolveNetwork = resolve; });
      }
    });

    env.sandbox.fetchBulletinPosts();
    await env.advanceTimersByTime(15000); // UI タイムアウト発生
    assert.ok(env.$('bulletin-list-container').innerHTML.includes('タイムアウト'), "Gate 9: Timeout UI active");

    // 遅延成功が到着
    resolveNetwork({
      success: true,
      posts: [{ id: 'BP_99', message: 'Late Arrived Post', isMe: false }]
    });
    await new Promise(r => setTimeout(r, 10));

    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(containerHtml.includes('Late Arrived Post'), "Gate 9: Late success must quietly update display if page is active");
    console.log("  ✅ Gate 9 PASS: Late success updates cache and active display");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 10: Timeout -> force coalescing -> exactly-one refresh
  // ────────────────────────────────────────────────────────────────
  {
    let callCount = 0;
    let resolveInitial;
    const env = createBulletinTestContext({
      apiHandler: async () => {
        callCount++;
        if (callCount === 1) {
          return new Promise(resolve => { resolveInitial = resolve; });
        }
        return { success: true, posts: [{ id: 'BP_10', message: 'Queued Result', isMe: false }] };
      }
    });

    const p1 = env.sandbox.fetchBulletinPosts();
    await env.advanceTimersByTime(15000); // タイムアウトUI表示

    // タイムアウト表示中にユーザーが再読み込み（force: true）を押下
    const pRetry = env.sandbox.fetchBulletinPosts({ force: true });
    assert.equal(callCount, 1, "Gate 10: Retry during in-flight must coalesce into existing network");
    assert.strictEqual(p1, pRetry, "Gate 10: Retry returns existing active Promise");

    // 元の通信が settle
    resolveInitial({ success: true, posts: [{ id: 'BP_1', message: 'First', isMe: false }] });
    await p1;
    await new Promise(r => setTimeout(r, 10));

    assert.equal(callCount, 2, "Gate 10: Exactly one queued refresh starts after initial settles");
    console.log("  ✅ Gate 10 PASS: Timeout force coalesces and triggers exactly-one queued refresh");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 11: Error with cache
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    // キャッシュを確立
    await env.sandbox.fetchBulletinPosts();
    assert.ok(env.$('bulletin-list-container').innerHTML.includes('雨天注意'), "Gate 11: Cache rendered");

    // 通信エラーを発生させる
    env.setApiHandler(async () => { throw new Error("NETWORK_DOWN"); });
    await env.sandbox.fetchBulletinPosts({ force: true }).catch(() => {});

    // キャッシュ表示が維持されていること（エラーUIで破壊されない）
    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(containerHtml.includes('雨天注意'), "Gate 11: Display must preserve cached posts on error");
    assert.ok(!containerHtml.includes('失敗しました'), "Gate 11: Display must not be overwritten by error UI when cache exists");
    console.log("  ✅ Gate 11 PASS: Error preserves existing cache display");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 12: Initial error/retry
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext({
      apiHandler: async () => { throw new Error("API_ERROR"); }
    });

    await env.sandbox.fetchBulletinPosts().catch(() => {});
    await new Promise(r => setImmediate(r));
    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(containerHtml.includes('失敗しました') || containerHtml.includes('⚠️'), "Gate 12: Initial error without cache must render error UI");
    assert.ok(containerHtml.includes('再読み込み'), "Gate 12: Error UI must include reload button");
    console.log("  ✅ Gate 12 PASS: Initial error renders retry UI");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 13: Current double-presentation success behavior
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    let renderCount = 0;
    env.sandbox.renderBulletinList = (posts) => { renderCount++; };

    await env.sandbox.fetchBulletinPosts();
    // microtask キュー（Promise.race.then ハンドラ）を消化
    await new Promise(r => setImmediate(r));

    assert.equal(renderCount, 2, "Gate 13: Exactly 2 render invocations on normal success");
    console.log(`  ✅ Gate 13 PASS: Normal success rendering executed (invocations: ${renderCount})`);
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 14: create post payload
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    let postPayload = null;
    env.setApiHandler(async (action, payload) => {
      if (action === 'createBulletinPost') {
        postPayload = payload;
        return { success: true };
      }
      return { success: true, posts: [] };
    });

    env.$('bulletin-message-input').value = 'テスト投稿メッセージ';
    await env.sandbox.submitBulletinPost();

    assert.ok(postPayload !== null, "Gate 14: createBulletinPost must be called");
    assert.strictEqual(postPayload.staffId, 'STAFF_007', "Gate 14: staffId must match user_info");
    assert.strictEqual(postPayload.staffName, '桑名 太郎', "Gate 14: staffName must match user_info");
    assert.strictEqual(postPayload.message, 'テスト投稿メッセージ', "Gate 14: message must match input");
    assert.deepStrictEqual(Object.keys(postPayload).sort(), ['message', 'staffId', 'staffName'], "Gate 14: Payload contains only allowed keys");
    console.log("  ✅ Gate 14 PASS: createBulletinPost payload strictly invariant");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 15: successful submit execution order
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    const executionOrder = [];

    // 入力クリア・カウンタ・alert・force refresh の順序を追跡
    const origInput = env.$('bulletin-message-input');
    origInput.value = '順序検証メッセージ';

    let clearRecorded = false;
    Object.defineProperty(origInput, 'value', {
      get() { return this._val || ''; },
      set(v) {
        this._val = v;
        if (v === '' && !clearRecorded) {
          executionOrder.push('1_INPUT_CLEARED');
          clearRecorded = true;
        }
      }
    });
    origInput._val = '順序検証メッセージ';

    const origCounter = env.$('bulletin-char-counter');
    Object.defineProperty(origCounter, 'textContent', {
      get() { return this._txt || ''; },
      set(v) {
        this._txt = v;
        if (v === '0 / 150') executionOrder.push('2_COUNTER_RESET');
      }
    });

    env.sandbox.alert = (msg) => {
      if (msg.includes('完了')) executionOrder.push('3_ALERT_SUCCESS');
    };

    const origFetch = env.window.fetchBulletinPosts;
    env.window.fetchBulletinPosts = function(opts) {
      if (opts && opts.force) executionOrder.push('4_FORCE_REFRESH');
      return origFetch.call(this, opts);
    };

    const origBtn = env.$('btn-bulletin-submit');
    origBtn.textContent = '投稿する';

    await env.sandbox.submitBulletinPost();
    if (!origBtn.disabled && origBtn.textContent === '投稿する') {
      executionOrder.push('5_BUTTON_RESTORED');
    }

    assert.deepStrictEqual(executionOrder, [
      '1_INPUT_CLEARED',
      '2_COUNTER_RESET',
      '3_ALERT_SUCCESS',
      '4_FORCE_REFRESH',
      '5_BUTTON_RESTORED'
    ], "Gate 15: Successful submit execution sequence strictly matches baseline");
    console.log("  ✅ Gate 15 PASS: Successful submit execution sequence strictly preserved");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 16: empty / >150 validation
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    let apiCalled = false;
    env.setApiHandler(async () => { apiCalled = true; return { success: true }; });

    // 空文字
    env.$('bulletin-message-input').value = '   ';
    await env.sandbox.submitBulletinPost();
    assert.equal(apiCalled, false, "Gate 16: Empty message must prevent API call");
    assert.ok(env.alertMessages.some(m => m.includes('入力してください')), "Gate 16: Empty message alerts user");

    // 151文字
    env.alertMessages.length = 0;
    env.$('bulletin-message-input').value = 'あ'.repeat(151);
    await env.sandbox.submitBulletinPost();
    assert.equal(apiCalled, false, "Gate 16: >150 message must prevent API call");
    assert.ok(env.alertMessages.some(m => m.includes('150文字以内')), "Gate 16: >150 message alerts user");
    console.log("  ✅ Gate 16 PASS: Message validation rules (empty, >150) enforced");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 17: isMe filtering
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    const testPosts = [
      { id: 'P1', staffId: 'OTHER_01', message: '他人の投稿', isMe: false },
      { id: 'P2', staffId: 'ME_07', message: '自分の投稿', isMe: true }
    ];

    env.sandbox.renderBulletinList(testPosts);
    const containerHtml = env.$('bulletin-list-container').innerHTML;
    assert.ok(containerHtml.includes('他人の投稿'), "Gate 17: Other posts must be rendered");
    assert.ok(!containerHtml.includes('自分の投稿'), "Gate 17: isMe=true posts must be filtered out");
    console.log("  ✅ Gate 17 PASS: renderBulletinList filters out isMe=true posts");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 18: lineUserId privacy boundary (実Backendソース評価)
  // ────────────────────────────────────────────────────────────────
  {
    const backendSrc = fs.readFileSync(path.join(REPO_ROOT, 'active/business/bulletin/bulletin_service.js'), 'utf8');
    const bSandbox = {
      Utilities: {
        formatDate: () => '2026/10/02 12:00'
      },
      Logger: { log: () => {} }
    };
    const bContext = vm.createContext(bSandbox);
    vm.runInContext(backendSrc, bContext);

    const BulletinService = bSandbox.BulletinService;
    assert.ok(BulletinService, "Gate 18: BulletinService class loaded from real source");

    // スプレッドシートモック (lineUserId を含むデータ)
    const mockSheet = {
      getLastRow: () => 3,
      getLastColumn: () => 5,
      getRange: () => ({
        getValues: () => [
          ['2026/10/02', 'STAFF_01', '田中', 'メッセージ1', 'LINE_USER_SECRET_01'],
          ['2026/10/02', 'STAFF_02', '佐藤', 'メッセージ2', 'LINE_USER_SECRET_02']
        ]
      })
    };

    const serviceInstance = new BulletinService();
    serviceInstance.getBulletinSheet = () => mockSheet;

    const res = serviceInstance.getPosts('LINE_USER_SECRET_02', 'test_district');
    assert.ok(res.success, "Gate 18: getPosts succeeds");
    assert.equal(res.posts.length, 2, "Gate 18: 2 posts returned");

    for (const post of res.posts) {
      assert.strictEqual('lineUserId' in post, false, "Gate 18: lineUserId must NEVER exist in output posts");
      assert.strictEqual(typeof post.isMe, 'boolean', "Gate 18: isMe boolean must be derived instead");
    }
    // 佐藤の投稿のみ isMe=true
    const satoPost = res.posts.find(p => p.staffName === '佐藤');
    assert.strictEqual(satoPost.isMe, true, "Gate 18: isMe correctly derived for matched user");
    console.log("  ✅ Gate 18 PASS: Real backend code guarantees lineUserId is never exposed");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 19: Identity failure prevents post
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    env.setIdentityVerifiedPass(false); // 本人確認失敗シミュレーション

    let apiCalled = false;
    env.setApiHandler(async () => { apiCalled = true; return { success: true }; });

    env.$('bulletin-message-input').value = '投稿テスト';
    const btn = env.$('btn-bulletin-submit');

    await env.sandbox.submitBulletinPost();

    assert.equal(apiCalled, false, "Gate 19: Identity verification failure must abort API post");
    assert.ok(env.alertMessages.some(m => m.includes('本人確認')), "Gate 19: User alerted of identity requirement");
    assert.equal(btn.disabled, false, "Gate 19: Button restored to enabled");
    assert.equal(btn.textContent, '投稿する', "Gate 19: Button text restored");
    console.log("  ✅ Gate 19 PASS: Identity verification failure safely aborts post and restores button");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 20: API failure restores UI state
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext({
      apiHandler: async (action) => {
        if (action === 'createBulletinPost') {
          return { success: false, message: 'DB_LOCKED' };
        }
        return { success: true };
      }
    });

    const input = env.$('bulletin-message-input');
    input.value = '消えては困る下書きテキスト';
    const btn = env.$('btn-bulletin-submit');

    await env.sandbox.submitBulletinPost();

    assert.ok(env.alertMessages.some(m => m.includes('DB_LOCKED')), "Gate 20: Error message alerted to user");
    assert.equal(input.value, '消えては困る下書きテキスト', "Gate 20: Input text must NOT be cleared on failure");
    assert.equal(btn.disabled, false, "Gate 20: Button restored to enabled");
    assert.equal(btn.textContent, '投稿する', "Gate 20: Button text restored");
    console.log("  ✅ Gate 20 PASS: API failure alerts user and restores UI without losing input");
    passedGates++;
  }

  // ────────────────────────────────────────────────────────────────
  // Gate 21: Inactive page suppresses presentation
  // ────────────────────────────────────────────────────────────────
  {
    const env = createBulletinTestContext();
    // 画面を非表示（hidden）にする
    env.$('page-bulletin').classList.add('hidden');
    env.$('bulletin-list-container').innerHTML = 'PREVIOUS_CONTENT';

    await env.sandbox.fetchBulletinPosts();

    assert.equal(env.$('bulletin-list-container').innerHTML, 'PREVIOUS_CONTENT', "Gate 21: Presentation must be suppressed when page-bulletin is hidden");
    console.log("  ✅ Gate 21 PASS: Presentation strictly suppressed when bulletin page is hidden");
    passedGates++;
  }

  console.log("\n====================================================");
  console.log(`📊 BULLETIN AUDIT VERDICT: ${passedGates}/21 GATES PASSED`);
  console.log("====================================================");

  assert.equal(passedGates, 21, "All 21 Gates must pass");
}

runAllGates().catch(err => {
  console.error("❌ Gate Failure:", err);
  process.exit(1);
});
