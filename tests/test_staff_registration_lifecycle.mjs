import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const staffRegistrationModuleCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/staff-registration.js'), 'utf8');
const authModuleCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/auth.js'), 'utf8');
const staffComponentCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/components/staff.js'), 'utf8');
const renderCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
const appCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/app.js'), 'utf8');

function createTestEnvironment(options = {}) {
  let { mockApiResponse = null, mockApiError = null } = options;

  const storage = {};
  const elements = {};
  const eventLog = [];

  const document = {
    getElementById: (id) => {
      if (!elements[id]) {
        elements[id] = {
          id,
          tagName: 'DIV',
          innerHTML: '',
          textContent: '',
          classList: {
            classes: new Set(),
            add: function(...c) { c.forEach(x => this.classes.add(x)); },
            remove: function(...c) { c.forEach(x => this.classes.delete(x)); },
            contains: function(c) { return this.classes.has(c); }
          },
          style: {},
          dataset: {},
          onclick: null,
          disabled: false
        };
      }
      return elements[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  let apiCallCount = 0;
  let lastAction = null;
  let lastPayload = null;

  const callApiPost = async (action, payload) => {
    apiCallCount++;
    lastAction = action;
    lastPayload = payload;
    eventLog.push({ type: 'CALL_API', action, payload });

    if (mockApiError) {
      if (typeof mockApiError === 'function') {
        throw mockApiError(apiCallCount);
      }
      throw mockApiError;
    }

    if (typeof mockApiResponse === 'function') {
      return mockApiResponse(apiCallCount, action, payload);
    }
    return mockApiResponse;
  };

  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    document,
    localStorage: {
      getItem: (k) => storage[k] || null,
      setItem: (k, v) => {
        storage[k] = String(v);
        eventLog.push({ type: 'LOCAL_STORAGE_SET', key: k, value: String(v) });
      },
      removeItem: (k) => { delete storage[k]; },
      clear: () => { Object.keys(storage).forEach(k => delete storage[k]); }
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    callApiPost,
    setQueueLifecycleGates: () => {},
    logDebug: (msg) => {
      eventLog.push({ type: 'LOG_DEBUG', msg });
    },
    renderStaffCard: () => '<div id="staff-card"></div>',
    updateBottomNavVisibility: () => {
      eventLog.push({ type: 'UPDATE_BOTTOM_NAV' });
    },
    setLoadingProgress: (pct, label) => {
      eventLog.push({ type: 'SET_LOADING_PROGRESS', pct, label });
    },
    showMainApp: () => {
      eventLog.push({ type: 'SHOW_MAIN_APP' });
    },
    setTimeout: (fn) => { fn(); },
    eventLog,
    getApiCallCount: () => apiCallCount,
    getLastAction: () => lastAction,
    getLastPayload: () => lastPayload,
    elements
  };

  const windowObj = {
    ...sandbox,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  sandbox.window = windowObj;
  sandbox.globalThis = windowObj;

  const ctx = vm.createContext(sandbox);
  ctx.AuthModule = undefined;

  // 0. Auth Module
  vm.runInContext(authModuleCode, ctx);
  // 1. Module
  vm.runInContext(staffRegistrationModuleCode, ctx);
  // 2. Staff Component
  vm.runInContext(staffComponentCode, ctx);
  // 3. Render (StorageView, StaffRegistrationView, renderSettings)
  vm.runInContext(renderCode, ctx);

  // Spy on renderSettings
  const actualRenderSettings = ctx.renderSettings;
  ctx.renderSettings = function() {
    eventLog.push({ type: 'RENDER_SETTINGS' });
    if (typeof actualRenderSettings === 'function') {
      try { actualRenderSettings.apply(this, arguments); } catch (e) {}
    }
  };
  ctx.window.renderSettings = ctx.renderSettings;

  // 4. App (triggerBackgroundRegistration, retryRegistration wiring)
  vm.runInContext(appCode, ctx);

  // Spy on setLoadingProgress and showMainApp after appCode execution
  const origSetLoadingProgress = ctx.setLoadingProgress;
  ctx.setLoadingProgress = function(pct, label) {
    eventLog.push({ type: 'SET_LOADING_PROGRESS', pct, label });
    if (typeof origSetLoadingProgress === 'function') origSetLoadingProgress.apply(this, arguments);
  };

  const origShowMainApp = ctx.showMainApp;
  ctx.showMainApp = function() {
    eventLog.push({ type: 'SHOW_MAIN_APP' });
    if (typeof origShowMainApp === 'function') origShowMainApp.apply(this, arguments);
  };

  ctx.getStaffRegistrationStatus = () => vm.runInContext('StaffRegistrationModule.getStatus()', ctx);

  return ctx;
}

console.log('🚀 RUNNING STAFF REGISTRATION LIFECYCLE TESTS (11 GATES)');

// GATE 1: 初回登録成功イベント列
{
  const ctx = createTestEnvironment({
    mockApiResponse: { success: true, id: 'STF_001' }
  });

  const profile = { displayName: '山田太郎', userId: 'U12345678', pictureUrl: 'https://example.com/p.jpg' };
  const res = await ctx.triggerBackgroundRegistration(profile);

  assert.strictEqual(res.id, 'STF_001', 'Gate 1: res.id must be STF_001');
  assert.strictEqual(ctx.getApiCallCount(), 1, 'Gate 1: API called once');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.getLastPayload())), {
    lastName: '山田太郎',
    firstName: '(LINE)',
    lineUserId: 'U12345678'
  }, 'Gate 1: API payload matches specification');

  const savedUser = JSON.parse(ctx.localStorage.getItem('user_info'));
  assert.strictEqual(savedUser.id, 'STF_001', 'Gate 1: user_info.id saved');
  assert.strictEqual(savedUser.last, '山田太郎', 'Gate 1: user_info.last saved');
  assert.strictEqual(savedUser.first, '', 'Gate 1: user_info.first empty string');
  assert.strictEqual(savedUser.picture, 'https://example.com/p.jpg', 'Gate 1: pictureUrl saved');

  const storageIdEl = ctx.elements['storage-register-staff-id'];
  assert.strictEqual(storageIdEl.textContent, 'ID: STF_001', 'Gate 1: Storage ID textContent updated');
  assert.strictEqual(storageIdEl.style.color, 'inherit', 'Gate 1: Storage ID style.color is inherit');
  assert.strictEqual(storageIdEl.style.cursor, 'default', 'Gate 1: Storage ID style.cursor is default');
  assert.strictEqual(storageIdEl.onclick, null, 'Gate 1: Storage ID onclick is null');

  assert.strictEqual(ctx.getStaffRegistrationStatus().isRegistering, false, 'Gate 1: isRegistering finally false');
  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, false, 'Gate 1: registrationError false');

  console.log('  ✅ Gate 1 PASS: 初回登録成功イベント列');
}

// GATE 2: 登録API通信失敗イベント列
{
  const ctx = createTestEnvironment({
    mockApiError: new Error('NETWORK_TIMEOUT')
  });

  const profile = { displayName: '田中次郎', userId: 'U87654321' };
  let errorCaught = null;
  try {
    await ctx.triggerBackgroundRegistration(profile);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, 'Gate 2: exception must be rethrown');
  assert.strictEqual(errorCaught.message, 'NETWORK_TIMEOUT', 'Gate 2: original error preserved');
  assert.strictEqual(ctx.getStaffRegistrationStatus().isRegistering, false, 'Gate 2: isRegistering finally false');
  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, true, 'Gate 2: registrationError set to true');

  const storageIdEl = ctx.elements['storage-register-staff-id'];
  assert.strictEqual(storageIdEl.textContent, 'ID: 登録失敗 (タップして再試行)', 'Gate 2: Storage ID error text');
  assert.strictEqual(storageIdEl.style.color, '#ef4444', 'Gate 2: Storage ID error color');
  assert.strictEqual(storageIdEl.style.cursor, 'pointer', 'Gate 2: Storage ID error cursor');
  assert.strictEqual(typeof storageIdEl.onclick, 'function', 'Gate 2: Storage ID error onclick attached');

  const loadingEl = ctx.elements['loading-status'];
  assert.strictEqual(loadingEl.textContent, '登録エラー (タップして再試行): NETWORK_TIMEOUT', 'Gate 2: Loading status error text');
  assert.strictEqual(loadingEl.style.color, '#ef4444', 'Gate 2: Loading status error color');
  assert.strictEqual(loadingEl.style.cursor, 'pointer', 'Gate 2: Loading status error cursor');
  assert.strictEqual(typeof loadingEl.onclick, 'function', 'Gate 2: Loading status error onclick attached');

  console.log('  ✅ Gate 2 PASS: 登録API通信失敗イベント列');
}

// GATE 3: Invalid Response (ID欠損) イベント列
{
  const ctx = createTestEnvironment({
    mockApiResponse: { success: true, id: '' } // id欠損
  });

  const profile = { displayName: '佐藤三郎', userId: 'U99999999' };
  let errorCaught = null;
  try {
    await ctx.triggerBackgroundRegistration(profile);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, 'Gate 3: exception must be thrown on missing id');
  assert.ok(errorCaught.message.includes('missing id'), 'Gate 3: error message mentions missing id');
  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, true, 'Gate 3: registrationError true');

  console.log('  ✅ Gate 3 PASS: Invalid Response (ID欠損) イベント列');
}

// GATE 4: Retry成功イベント列
{
  let attempt = 0;
  const ctx = createTestEnvironment({
    mockApiResponse: () => {
      attempt++;
      if (attempt === 1) throw new Error('TEMP_DISCONNECT');
      return { success: true, id: 'STF_RETRY_OK' };
    }
  });

  const profile = { displayName: '鈴木四郎', userId: 'U44444444' };

  // 1回目: 失敗
  try {
    await ctx.triggerBackgroundRegistration(profile);
  } catch (e) {}

  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, true, 'Gate 4: first attempt failed');

  // 2回目: window.retryRegistration() 実行
  await ctx.window.retryRegistration();

  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, false, 'Gate 4: retry succeeded');
  assert.strictEqual(vm.runInContext('AuthModule.isIdentityVerified()', ctx), true, 'Gate 4: _identityVerified is true');

  const savedUser = JSON.parse(ctx.localStorage.getItem('user_info'));
  assert.strictEqual(savedUser.id, 'STF_RETRY_OK', 'Gate 4: staff ID saved on retry');

  const readyEvent = ctx.eventLog.find(e => e.type === 'SET_LOADING_PROGRESS');
  assert.ok(readyEvent && readyEvent.pct === 100 && readyEvent.label === 'READY', 'Gate 4: READY progress set');

  const showAppEvent = ctx.eventLog.find(e => e.type === 'SHOW_MAIN_APP');
  assert.ok(showAppEvent, 'Gate 4: showMainApp called');

  console.log('  ✅ Gate 4 PASS: Retry成功イベント列');
}

// GATE 5: Retry失敗イベント列
{
  const ctx = createTestEnvironment({
    mockApiError: new Error('PERSISTENT_ERROR')
  });

  const profile = { displayName: '高橋五郎', userId: 'U55555555' };

  try { await ctx.triggerBackgroundRegistration(profile); } catch (e) {}
  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, true, 'Gate 5: first attempt error');

  // 再試行
  await ctx.window.retryRegistration();
  assert.strictEqual(ctx.getStaffRegistrationStatus().registrationError, true, 'Gate 5: error maintained on retry failure');

  console.log('  ✅ Gate 5 PASS: Retry失敗イベント列');
}

// GATE 6: In-Flight重複抑止 (同一Promise返却)
{
  let resolveApi;
  const ctx = createTestEnvironment({
    mockApiResponse: () => new Promise(res => { resolveApi = res; })
  });

  const profile = { displayName: '伊藤六郎', userId: 'U66666666' };

  const p1 = ctx.triggerBackgroundRegistration(profile);
  const p2 = ctx.triggerBackgroundRegistration(profile);

  assert.strictEqual(p1, p2, 'Gate 6: second call returns identical in-flight promise');
  assert.strictEqual(ctx.getApiCallCount(), 1, 'Gate 6: API issued only once while in-flight');

  resolveApi({ success: true, id: 'STF_INFLIGHT' });
  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.id, 'STF_INFLIGHT');
  assert.strictEqual(res2.id, 'STF_INFLIGHT');

  console.log('  ✅ Gate 6 PASS: In-Flight重複抑止 (同一Promise返却)');
}

// GATE 7: Storage ID表示遷移 (正常系)
{
  let resolveApi;
  const ctx = createTestEnvironment({
    mockApiResponse: () => new Promise(res => { resolveApi = res; })
  });

  const profile = { displayName: '渡辺七郎', userId: 'U77777777' };
  const p = ctx.triggerBackgroundRegistration(profile);
  const storageIdEl = ctx.document.getElementById('storage-register-staff-id');

  assert.strictEqual(storageIdEl.textContent, 'ID: 登録中...', 'Gate 7: text is ID: 登録中... on start');

  resolveApi({ success: true, id: 'STF_007' });
  await p;
  assert.strictEqual(storageIdEl.textContent, 'ID: STF_007', 'Gate 7: text is ID: STF_007 on success');

  console.log('  ✅ Gate 7 PASS: Storage ID表示遷移 (正常系)');
}

// GATE 8: Storage ID表示遷移 (異常系 ➔ retry)
{
  let attempt = 0;
  const ctx = createTestEnvironment({
    mockApiResponse: () => {
      attempt++;
      if (attempt === 1) throw new Error('FAIL');
      return { success: true, id: 'STF_RETRY_OK_STORAGE' };
    }
  });

  const profile = { displayName: '山本八郎', userId: 'U88888888' };

  try { await ctx.triggerBackgroundRegistration(profile); } catch (e) {}

  const storageIdEl = ctx.document.getElementById('storage-register-staff-id');
  assert.strictEqual(storageIdEl.textContent, 'ID: 登録失敗 (タップして再試行)', 'Gate 8: error text shown');
  assert.strictEqual(typeof storageIdEl.onclick, 'function', 'Gate 8: onclick attached');

  // タップをシミュレート
  await storageIdEl.onclick();

  assert.strictEqual(storageIdEl.textContent, 'ID: STF_RETRY_OK_STORAGE', 'Gate 8: restored to ID after retry');

  console.log('  ✅ Gate 8 PASS: Storage ID表示遷移 (異常系 ➔ retry)');
}

// GATE 9: Loading表示遷移 (異常系 ➔ 再試行中... ➔ retry)
{
  let attempt = 0;
  const ctx = createTestEnvironment({
    mockApiResponse: () => {
      attempt++;
      if (attempt === 1) throw new Error('NET_ERR');
      return { success: true, id: 'STF_LOADING_RETRY' };
    }
  });

  const profile = { displayName: '中村九郎', userId: 'U99999999' };

  try { await ctx.triggerBackgroundRegistration(profile); } catch (e) {}

  const loadingEl = ctx.document.getElementById('loading-status');
  assert.strictEqual(loadingEl.textContent, '登録エラー (タップして再試行): NET_ERR', 'Gate 9: loading status error');
  assert.strictEqual(typeof loadingEl.onclick, 'function', 'Gate 9: loading onclick attached');

  // タップシミュレート
  const clickHandler = loadingEl.onclick;
  clickHandler();

  assert.strictEqual(loadingEl.textContent, '再試行中...', 'Gate 9: switches to 再試行中... immediately');
  assert.strictEqual(loadingEl.onclick, null, 'Gate 9: onclick cleared on retry tap');

  console.log('  ✅ Gate 9 PASS: Loading表示遷移 (異常系 ➔ 再試行中... ➔ retry)');
}

// GATE 10: 成功時副作用順序
{
  const ctx = createTestEnvironment({
    mockApiResponse: { success: true, id: 'STF_ORDER_TEST' }
  });

  const profile = { displayName: '小林十郎', userId: 'U10101010' };
  await ctx.triggerBackgroundRegistration(profile);

  const events = ctx.eventLog.map(e => e.type);

  const idxApi = events.indexOf('CALL_API');
  const idxStorageSet = events.indexOf('LOCAL_STORAGE_SET');
  const idxRenderSettings = events.indexOf('RENDER_SETTINGS');
  const idxNavUpdate = events.indexOf('UPDATE_BOTTOM_NAV');

  assert.ok(idxApi !== -1, 'Gate 10: API called');
  assert.ok(idxStorageSet > idxApi, 'Gate 10: localStorage.setItem after API');
  assert.ok(idxRenderSettings > idxStorageSet, 'Gate 10: renderSettings after localStorage');
  assert.ok(idxNavUpdate > idxRenderSettings, 'Gate 10: updateBottomNavVisibility after renderSettings');

  console.log('  ✅ Gate 10 PASS: 成功時副作用順序 (localStorage ➔ renderSettings ➔ bottomNav)');
}

// GATE 11: Retry成功時起動順序
{
  let attempt = 0;
  const ctx = createTestEnvironment({
    mockApiResponse: () => {
      attempt++;
      if (attempt === 1) throw new Error('RETRY_ORDER_ERR');
      return { success: true, id: 'STF_RETRY_ORDER' };
    }
  });

  const profile = { displayName: '加藤十一', userId: 'U11111111' };
  try { await ctx.triggerBackgroundRegistration(profile); } catch (e) {}

  ctx.eventLog.length = 0; // ログクリア

  await ctx.window.retryRegistration();

  const events = ctx.eventLog.map(e => e.type);

  const idxReady = events.indexOf('SET_LOADING_PROGRESS');
  const idxShowApp = events.indexOf('SHOW_MAIN_APP');

  assert.ok(idxReady !== -1, 'Gate 11: SET_LOADING_PROGRESS called');
  assert.ok(idxShowApp > idxReady, 'Gate 11: showMainApp called after SET_LOADING_PROGRESS');
  assert.strictEqual(vm.runInContext('AuthModule.isIdentityVerified()', ctx), true, 'Gate 11: _identityVerified true');

  console.log('  ✅ Gate 11 PASS: Retry成功時起動順序 (READY ➔ identityVerified ➔ showMainApp)');
}

console.log('🎉 ALL 11 GATES PASSED PERFECTLY!');
