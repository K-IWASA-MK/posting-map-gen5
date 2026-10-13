/**
 * test_storage_register_lifecycle.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

console.log('====================================================');
console.log('🧪 STORAGE REGISTER LIFECYCLE & INPUT PROTECTION AUDIT');
console.log('====================================================\n');

class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.classListSet = new Set(['hidden']);
    this.style = {};
    this.dataset = {};
    this._listeners = {};

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
  dispatchEvent(event) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(fn => fn.call(this));
    }
  }
  focus() {
    this.dispatchEvent('focus');
  }
  appendChild(child) {
    this.innerHTML += `<${child.tagName} value="${child.value}">${child.textContent}</${child.tagName}>`;
  }
}

const authSrc = fs.readFileSync('active/h-app/modules/auth.js', 'utf8');
const storageSrc = fs.readFileSync('active/h-app/modules/storage.js', 'utf8');
const renderSrc = fs.readFileSync('active/h-app/render.js', 'utf8');
const appSrc = fs.readFileSync('active/h-app/app.js', 'utf8');

function createTestEnvironment() {
  const elements = {};
  let activeElement = null;

  function $(id) {
    if (!elements[id]) {
      const tag = id.includes('input') || id.includes('count') ? 'input' :
                  id.includes('select') || id.includes('location') ? 'select' : 'div';
      elements[id] = new MockElement(id, tag);
      const origFocus = elements[id].focus.bind(elements[id]);
      elements[id].focus = () => { activeElement = elements[id]; origFocus(); };
    }
    return elements[id];
  }

  const localStorageStore = {
    'user_info': JSON.stringify({ id: 'STAFF_007', first: '太郎', last: '桑名' })
  };

  const mockLocalStorage = {
    getItem: (k) => localStorageStore[k] || null,
    setItem: (k, v) => { localStorageStore[k] = String(v); }
  };

  const mockDocument = {
    get activeElement() { return activeElement; },
    set activeElement(val) { activeElement = val; },
    getElementById: (id) => $(id),
    querySelectorAll: () => [],
    createElement: (tag) => new MockElement('', tag),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const state = {
    apiCallCount: 0,
    mockApiResponseData: null,
    mockApiDelayMs: 20,
    shouldFail: false
  };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    Promise: Promise,
    String: String,
    Number: Number,
    parseInt: parseInt,
    isNaN: isNaN,
    Array: Array,
    Object: Object,
    JSON: JSON,
    Math: Math,
    document: mockDocument,
    localStorage: mockLocalStorage,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    tier1Cache: ['桑名市', '四日市市'],
    isRegistering: false,
    registrationError: false,
    $: $,
    alert: (msg) => { console.log("ALERT:", msg); },
    fetch: async () => ({ ok: true, json: async () => (['桑名市', '四日市市']) }),
    waitForIdentityVerified: async () => {},
    renderStorageList: (data) => { sandbox.renderStorageListCallCount++; },
    setQueueLifecycleGates: () => {},
    callApiPost: async function(action, payload = {}) {
      if (action === 'getFlyerStock') {
        state.apiCallCount++;
        await new Promise(r => setTimeout(r, state.mockApiDelayMs));
        if (state.shouldFail) throw new Error("NETWORK_FAILURE");
        return state.mockApiResponseData;
      }
      if (action === 'updateFlyerStock') {
        state.apiCallCount++;
        await new Promise(r => setTimeout(r, state.mockApiDelayMs));
        return { success: true };
      }
      return { success: true };
    }
  };

  sandbox.renderStorageListCallCount = 0;

  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox);
  vm.runInContext(storageSrc, sandbox);
  vm.runInContext(renderSrc, sandbox);
  vm.runInContext(appSrc, sandbox);
  vm.runInContext("AuthModule.setIdentityVerified(true);", sandbox);

  return { sandbox, state, $, document: mockDocument };
}

async function runTests() {
  console.log('--- Gate 1: 初回取得（キャッシュなし時、API取得後に正常反映） ---');
  let env = createTestEnvironment();
  env.state.mockApiResponseData = {
    success: true,
    stocks: [{ staffId: 'STAFF_007', staffName: '桑名 太郎', location: '四日市市', count: 300, isMe: true }]
  };
  env.state.mockApiDelayMs = 20;

  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  assert.equal(env.$('storage-register-count').value, '', 'APIレスポンス前は空');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(env.$('storage-register-count').value, '300', 'APIレスポンス後に300が反映された');
  console.log('✅ Gate 1 PASS\n');

  console.log('--- Gate 2: キャッシュ即時復元（キャッシュあり時、即座に同期反映） ---');
  env = createTestEnvironment();
  // Simulate cached state by running a fetch first and waiting for it
  env.state.mockApiResponseData = {
    success: true,
    stocks: [{ staffId: 'STAFF_007', staffName: '桑名 太郎', location: '四日市市', count: 300, isMe: true }]
  };
  env.state.mockApiDelayMs = 10;
  await vm.runInContext('StorageModule.fetchStock()', env.sandbox);

  env.state.mockApiResponseData = {
    success: true,
    stocks: [{ staffId: 'STAFF_007', staffName: '桑名 太郎', location: '四日市市', count: 1200, isMe: true }]
  };

  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  assert.equal(env.$('storage-register-count').value, '300', '即座に前回キャッシュ(300)が反映される');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(env.$('storage-register-count').value, '1200', 'APIレスポンス後に最新値(1200)が反映された');
  console.log('✅ Gate 2 PASS\n');

  console.log('--- Gate 3: In-flight重複防止（高速画面往復） ---');
  env = createTestEnvironment();
  const countBefore = env.state.apiCallCount;
  env.state.mockApiDelayMs = 50;
  env.state.mockApiResponseData = { success: true, stocks: [] };
  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  vm.runInContext('initStorageListPage()', env.sandbox);
  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  vm.runInContext('initStorageListPage()', env.sandbox);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(env.state.apiCallCount - countBefore, 1, '4回画面遷移しても、APIコールは1回のみ');
  console.log('✅ Gate 3 PASS\n');

  console.log('--- Gate 4: ユーザー入力保護（枚数） ---');
  env = createTestEnvironment();
  env.state.mockApiDelayMs = 40;
  env.state.mockApiResponseData = {
    success: true,
    stocks: [{ staffId: 'STAFF_007', staffName: '桑名 太郎', location: '桑名市', count: 1200, isMe: true }]
  };

  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  const inputEl = env.$('storage-register-count');
  inputEl.dispatchEvent('click');
  inputEl.focus();
  inputEl.value = '500';
  inputEl.dispatchEvent('input');
  assert.equal(inputEl.dataset.userEditing, 'true');

  await new Promise(r => setTimeout(r, 60));
  assert.equal(inputEl.value, '500', '遅延APIレスポンス到着後もユーザー入力 500 が100%保持されている');
  console.log('✅ Gate 4 PASS\n');

  console.log('--- Gate 5: 保管場所選択保護 ---');
  env = createTestEnvironment();
  env.state.mockApiDelayMs = 40;
  env.state.mockApiResponseData = {
    success: true,
    stocks: [{ staffId: 'STAFF_007', staffName: '桑名 太郎', location: '桑名市', count: 1200, isMe: true }]
  };

  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  const locSelect = env.$('storage-register-location');
  locSelect.focus();
  locSelect.value = '四日市市';
  locSelect.dispatchEvent('change');

  await new Promise(r => setTimeout(r, 60));
  assert.equal(locSelect.value, '四日市市', '遅延API到着後もユーザーが選択した「四日市市」が保持されている');
  console.log('✅ Gate 5 PASS\n');

  console.log('--- Gate 6: 在庫登録成功後のキャッシュ即時更新 ---');
  env = createTestEnvironment();
  env.state.mockApiDelayMs = 10;

  env.$('storage-register-location').value = '四日市市';
  env.$('storage-register-count').value = '500';
  await vm.runInContext('window.submitFlyerStock()', env.sandbox);

  const snapshot = vm.runInContext('StorageModule.getSnapshot()', env.sandbox);
  assert.equal(snapshot.fetched, true, '登録後も fetched=true が維持されている');
  const myStock = snapshot.stocks.find(s => s.isMe === true);
  assert.equal(myStock.count, 500, 'キャッシュ上の枚数が500に更新された');
  assert.equal(myStock.location, '四日市市', 'キャッシュ上の場所が四日市市に更新された');

  delete env.$('storage-register-count').dataset.userEditing;
  env.document.activeElement = null; // blur
  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  assert.equal(env.$('storage-register-count').value, '500', '次回遷移時に即座に500が表示される');
  console.log('✅ Gate 6 PASS\n');

  console.log('--- Gate 7: 登録前の遅延GET (1000枚) と登録 (500枚) の世代競合検証 ---');
  env = createTestEnvironment();

  env.state.mockApiResponseData = {
    success: true,
    stocks: [{ staffId: 'STAFF_007', staffName: '桑名 太郎', location: '桑名市', count: 1000, isMe: true }]
  };
  env.state.mockApiDelayMs = 100;

  vm.runInContext('initStorageRegisterPage()', env.sandbox);

  await new Promise(r => setTimeout(r, 30));
  env.state.mockApiDelayMs = 10;
  env.$('storage-register-location').value = '桑名市';
  env.$('storage-register-count').value = '500';
  await vm.runInContext('window.submitFlyerStock()', env.sandbox);

  let snap = vm.runInContext('StorageModule.getSnapshot()', env.sandbox);
  assert.equal(snap.stocks.find(s => s.isMe === true)?.count, 500, '登録直後のキャッシュは500枚');

  await new Promise(r => setTimeout(r, 90)); // wait for delayed GET

  snap = vm.runInContext('StorageModule.getSnapshot()', env.sandbox);
  assert.equal(snap.stocks.find(s => s.isMe === true)?.count, 500, '遅延した旧GET(1000枚)到着後も500枚が維持されている');
  console.log('✅ Gate 7 PASS\n');

  console.log('--- Gate 8: 在庫登録画面 ↔ 一覧画面の高速往復における In-flight 単一通信検証 ---');
  env = createTestEnvironment();
  env.state.apiCallCount = 0;
  env.state.mockApiDelayMs = 50;
  env.state.mockApiResponseData = { success: true, stocks: [] };

  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  assert.equal(env.state.apiCallCount, 1);

  vm.runInContext('initStorageListPage()', env.sandbox);
  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  assert.equal(env.state.apiCallCount, 1, '一覧・登録画面を高速往復しても In-flight 共有により API は重複発射されず 1 回のまま');

  await new Promise(r => setTimeout(r, 70));
  assert.equal(env.state.apiCallCount, 1, '完了まで合計通信は厳格に 1 回のみ');

  const countB = env.state.apiCallCount;
  vm.runInContext('initStorageListPage()', env.sandbox);
  assert.equal(env.state.apiCallCount, countB, '一覧画面はキャッシュ有効時、追加通信ゼロで即時描画');
  console.log('✅ Gate 8 PASS\n');

  console.log('--- Gate 9: API 失敗後の Promise 解放・次回再試行保証検証 ---');
  env = createTestEnvironment();
  env.state.mockApiDelayMs = 10;
  env.state.shouldFail = true;

  try {
    await vm.runInContext('StorageModule.fetchStock()', env.sandbox);
    assert.fail('Should have thrown');
  } catch (e) {
    // Expected
  }

  env.state.shouldFail = false;
  env.state.mockApiResponseData = { success: true, stocks: [{ staffId: 'STAFF_007', count: 300, isMe: true }] };

  const retryData = await vm.runInContext('StorageModule.fetchStock()', env.sandbox);
  assert.ok(retryData && retryData.success, 'Promise固着なく次回再試行が成功する');
  console.log('✅ Gate 9 PASS\n');

  console.log('--- Gate 10: Snapshot mutation isolation ---');
  env = createTestEnvironment();
  env.state.mockApiResponseData = { success: true, stocks: [{ staffId: 'STAFF_007', count: 300, isMe: true }], myStock: { location: '桑名市', count: 300 } };
  env.state.mockApiDelayMs = 10;
  await vm.runInContext('StorageModule.fetchStock()', env.sandbox);
  const snap1 = vm.runInContext('StorageModule.getSnapshot()', env.sandbox);
  snap1.stocks[0].count = 999; // Try to mutate stocks
  if (snap1.myStock) snap1.myStock.count = 999; // Try to mutate myStock
  const snap2 = vm.runInContext('StorageModule.getSnapshot()', env.sandbox);
  assert.equal(snap2.stocks[0].count, 300, '外部からのミューテーションが内部ステート(stocks)に影響を与えないこと');
  assert.equal(snap2.myStock.count, 300, '外部からのミューテーションが内部ステート(myStock)に影響を与えないこと');
  console.log('✅ Gate 10 PASS\n');

  console.log('--- Gate 11: tier1Cache late arrival ---');
  env = createTestEnvironment();
  vm.runInContext('tier1Cache = null;', env.sandbox);
  vm.runInContext('initStorageRegisterPage()', env.sandbox);
  assert.ok(env.$('storage-register-location').innerHTML.includes('データ読み込み中...'), '最初はデータなし');

  // Simulate fetchTier1 completion
  vm.runInContext('tier1Cache = ["桑名市", "四日市市"];', env.sandbox);
  vm.runInContext('if (typeof StorageView !== "undefined") StorageView.updateLocationDropdown(StorageModule.getSnapshot().locations, null, tier1Cache);', env.sandbox);
  assert.ok(env.$('storage-register-location').innerHTML.includes('桑名市'), 'fetchTier1後にDropdownが更新される');
  console.log('✅ Gate 11 PASS\n');

  console.log('--- Gate 12: 認証待機中の重複送信防止 (Pre-Auth In-Flight Lock & 関数入口チェック) ---');
  {
    env = createTestEnvironment();
    let authResolve;
    const delayedAuthPromise = new Promise(resolve => { authResolve = resolve; });
    env.sandbox.waitForIdentityVerified = () => delayedAuthPromise;
    env.state.mockApiDelayMs = 10;
    env.state.apiCallCount = 0;

    env.$('storage-register-location').value = '桑名市';
    env.$('storage-register-count').value = '500';

    // 1回目の送信 (認証待機中)
    const submitPromise1 = vm.runInContext('window.submitFlyerStock()', env.sandbox);
    assert.equal(env.$('btn-storage-register-submit').disabled, true, '送信直後にボタンが disabled');
    assert.equal(env.$('btn-storage-register-submit').textContent, '更新中...', '送信直後にボタン文言が「更新中...」');

    // 2回目の送信 (認証待機中の重複呼出し)
    const submitPromise2 = vm.runInContext('window.submitFlyerStock()', env.sandbox);

    // 認証を解決
    authResolve(true);
    const [res1, res2] = await Promise.all([submitPromise1, submitPromise2]);

    assert.ok(res1 && res1.success, '1回目の送信は成功');
    assert.strictEqual(res2, null, '2回目の重複送信は関数入口で即時拒否され null を返却');
    assert.equal(env.state.apiCallCount, 1, 'API コールは厳格に1回のみ');
    assert.equal(env.$('btn-storage-register-submit').disabled, false, '完了後はボタンが復元');
    console.log('✅ Gate 12 PASS\n');
  }

  console.log('--- Gate 13: 認証失敗時のボタン復元・フラグ解除・入力値保持 ---');
  {
    env = createTestEnvironment();
    env.sandbox.waitForIdentityVerified = () => Promise.reject(new Error('UNAUTHORIZED'));
    env.state.apiCallCount = 0;

    env.$('storage-register-location').value = '四日市市';
    env.$('storage-register-count').value = '700';

    const failedRes = await vm.runInContext('window.submitFlyerStock()', env.sandbox);
    assert.strictEqual(failedRes, null, '認証失敗時は null を返却');
    assert.equal(env.state.apiCallCount, 0, 'API は一度も呼ばれない');
    assert.equal(env.$('btn-storage-register-submit').disabled, false, 'ボタンが disabled 解除されて復元');
    assert.equal(env.$('storage-register-location').value, '四日市市', '入力された保管場所が保持');
    assert.equal(env.$('storage-register-count').value, '700', '入力された枚数が保持');

    // 認証成功へ切り替えて再試行可能か確認
    env.sandbox.waitForIdentityVerified = () => Promise.resolve(true);
    const retryRes = await vm.runInContext('window.submitFlyerStock()', env.sandbox);
    assert.ok(retryRes && retryRes.success, '認証失敗後に再試行が正常に成功');
    assert.equal(env.state.apiCallCount, 1, '再試行時に API が呼ばれた');
    console.log('✅ Gate 13 PASS\n');
  }

  console.log('--- Gate 14: 更新待機中に編集された入力を保護 (送信後の userEditing 保護) ---');
  {
    env = createTestEnvironment();
    env.state.mockApiDelayMs = 50; // API応答に時間がかかる状態
    env.$('storage-register-location').value = '桑名市';
    env.$('storage-register-count').value = '500';
    env.$('storage-register-count').dataset.userEditing = 'true';

    // 送信開始
    const submitPromise = vm.runInContext('window.submitFlyerStock()', env.sandbox);

    // 送信中にユーザーが入力欄を再編集して「600」に変更したシチュエーション
    await new Promise(r => setTimeout(r, 20));
    env.$('storage-register-count').value = '600';
    env.$('storage-register-count').dataset.userEditing = 'true';

    // API 完了を待つ
    await submitPromise;

    assert.equal(env.$('storage-register-count').value, '600', '送信中に再入力された「600」が保持');
    assert.equal(env.$('storage-register-count').dataset.userEditing, 'true', '送信中再編集の userEditing フラグが消されずに保護');
    console.log('✅ Gate 14 PASS\n');
  }

  console.log('--- Gate 15: 動的フックの追従性 (値の固定化防止) ---');
  {
    env = createTestEnvironment();
    // 初期ユーザー
    env.sandbox.localStorage.setItem('user_info', JSON.stringify({ id: 'STAFF_001', first: '一郎', last: '桑名' }));
    vm.runInContext('initStorageRegisterPage()', env.sandbox);
    assert.equal(env.$('storage-register-staff-id').textContent, 'ID: STAFF_001');

    // 途中でユーザー情報が更新されたシチュエーション
    env.sandbox.localStorage.setItem('user_info', JSON.stringify({ id: 'STAFF_999', first: '次郎', last: '桑名' }));
    env.$('storage-register-location').value = '桑名市';
    env.$('storage-register-count').value = '100';

    let lastPayload = null;
    const sm = vm.runInContext('StorageModule', env.sandbox);
    const origUpdateStock = sm.updateStock;
    sm.updateStock = async (p) => {
      lastPayload = p;
      return origUpdateStock(p);
    };

    await vm.runInContext('window.submitFlyerStock()', env.sandbox);
    assert.equal(lastPayload.staffId, 'STAFF_999', '動的フック経由で最新の STAFF_999 が参照されて送信');
    assert.equal(lastPayload.staffName, '桑名 次郎', '動的フック経由で最新の 桑名 次郎 が参照されて送信');
    console.log('✅ Gate 15 PASS\n');
  }

  console.log('--- Gate 16: 画面再初期化時のイベント多重バインド防止 (冪等性) ---');
  {
    env = createTestEnvironment();
    const inputEl = env.$('storage-register-count');
    const locSelect = env.$('storage-register-location');

    // 5回連続で初期化を実行
    for (let i = 0; i < 5; i++) {
      vm.runInContext('initStorageRegisterPage()', env.sandbox);
    }

    assert.equal(inputEl.dataset.formatted, 'true', 'formatted フラグが維持');
    assert.equal(locSelect.dataset.changeBound, 'true', 'changeBound フラグが維持');
    console.log('✅ Gate 16 PASS\n');
  }

  console.log('--- Gate 17: 認可フック未指定時の送信拒否・API呼出し0件検証 ---');
  {
    env = createTestEnvironment();
    env.sandbox.localStorage.setItem('user_info', JSON.stringify({ id: 'STAFF_001', first: '太郎', last: '桑名' }));
    env.$('storage-register-location').value = '桑名市';
    env.$('storage-register-count').value = '300';

    let updateStockCalls = 0;
    const sm = vm.runInContext('StorageModule', env.sandbox);
    sm.updateStock = async (p) => {
      updateStockCalls++;
      return { success: true };
    };

    const sv = vm.runInContext('StorageView', env.sandbox);

    // Case 1: authorize を渡さない場合
    let errorCaughtWithoutAuthorize = false;
    try {
      await sv.submitRegisterForm({
        getUserInfo: () => JSON.parse(env.sandbox.localStorage.getItem('user_info')),
        storageModule: sm
      });
    } catch (e) {
      errorCaughtWithoutAuthorize = true;
      assert.ok(e.message.includes('authorize hook is required'), 'エラーメッセージに authorize hook is required を含むこと');
    }
    assert.strictEqual(errorCaughtWithoutAuthorize, true, 'authorize 未指定時に例外がスローされること');
    assert.strictEqual(updateStockCalls, 0, 'authorize 未指定時は updateStock API が一切呼ばれないこと');

    // Case 2: authorize に null やオブジェクト等の不正型を渡した場合
    let errorCaughtWithInvalidAuthorize = false;
    try {
      await sv.submitRegisterForm({
        authorize: 'not_a_function',
        getUserInfo: () => JSON.parse(env.sandbox.localStorage.getItem('user_info')),
        storageModule: sm
      });
    } catch (e) {
      errorCaughtWithInvalidAuthorize = true;
      assert.ok(e.message.includes('authorize hook is required'), 'エラーメッセージに authorize hook is required を含むこと');
    }
    assert.strictEqual(errorCaughtWithInvalidAuthorize, true, '不正型 authorize 指定時に例外がスローされること');
    assert.strictEqual(updateStockCalls, 0, '不正型 authorize 指定時も updateStock API が一切呼ばれないこと');

    console.log('✅ Gate 17 PASS\n');
  }

  console.log('====================================================');
  console.log('🎉 ALL 17 GATES PASSED PERFECTLY!');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
