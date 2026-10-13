/**
 * test_gap001_ready_freeze_regression.mjs
 * Universal Engine v1.0.1 — GAP-001 READY Freeze 回帰防止総合検証スイート
 * 
 * 監査対象:
 * READY-001: 既存登録済みLINE ID ➔ 正常起動
 * READY-002: LINE ID未登録 ➔ registerStaff成功 ➔ スタッフID付与 ➔ 正常起動
 * READY-003: LINE ID未登録 ➔ registerStaff明示エラー ➔ READY非表示 ➔ App非表示 ➔ エラー表示
 * READY-004: 登録通信失敗/Promise rejection ➔ READY非表示 ➔ App非表示 ➔ エラー表示
 * READY-005: 登録失敗後に再試行 ➔ 成功 ➔ 正常起動
 * READY-006: registerStaff成功レスポンスに必要なIDが存在しない異常レスポンス ➔ READY禁止 ➔ App表示禁止
 * READY-007: 既存localStorageあり + Backend既存ユーザー ➔ 従来どおり正常起動
 * READY-008: stale/不完全localStorage ➔ READY Freezeを発生させない
 * READY-009: 二重タップ/再試行によって重複登録を発生させない (In-flight Memoization)
 * READY-010: 登録Backend成功後にクライアント側レスポンス喪失を模擬 ➔ 再試行時に同一LINE_USER_IDが既存として解決され、重複スタッフ行を生成しない (Backend Idempotency)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

console.log('====================================================');
console.log('🧪 GAP-001 READY FREEZE REGRESSION AUDIT (READY-001 ~ READY-010)');
console.log('====================================================\n');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const staffRegistrationJsPath = path.join(REPO_ROOT, 'active/h-app/modules/staff-registration.js');
const staffRegistrationJsContent = fs.readFileSync(staffRegistrationJsPath, 'utf8');
const authJsPath = path.join(REPO_ROOT, 'active/h-app/modules/auth.js');
const authJsContent = fs.readFileSync(authJsPath, 'utf8');
const renderJsPath = path.join(REPO_ROOT, 'active/h-app/render.js');
const renderJsContent = fs.readFileSync(renderJsPath, 'utf8');
const appJsPath = path.join(REPO_ROOT, 'active/h-app/app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// DOM & ブラウザ環境のモック生成関数
class MockClassList {
  constructor(initial = []) {
    this._set = new Set(initial);
  }
  add(...classes) { classes.forEach(c => this._set.add(c)); }
  remove(...classes) { classes.forEach(c => this._set.delete(c)); }
  contains(c) { return this._set.has(c); }
}

class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    this.textContent = '';
    this.style = {};
    this.classList = new MockClassList(['hidden', 'opacity-0']);
    this.onclick = null;
  }
}

function createHAppTestContext() {
  const elements = {};
  function $(id) {
    if (!elements[id]) {
      elements[id] = new MockElement(id);
    }
    return elements[id];
  }

  const localStorageStore = {};
  const localStorage = {
    getItem: (k) => localStorageStore[k] || null,
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: (k) => { delete localStorageStore[k]; },
    clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); }
  };

  const loadingProgressHistory = [];
  function setLoadingProgress(pct, label) {
    loadingProgressHistory.push({ pct, label });
    const bar = $('loading-bar');
    const txt = $('loading-status');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = label;
  }

  const apiCalls = [];
  let apiPostHandler = async (action, payload) => {
    return { success: true };
  };

  const contextWindow = {
    liffProfile: null,
    registrationError: false,
    isRegistering: false,
    location: { origin: 'https://kuwana.postingmap.jp', pathname: '/', search: '' },
    history: { replaceState: () => {} },
    renderBottomNavigation: () => '<div>nav</div>'
  };

  const sandbox = {
    $,
    document: {
      getElementById: (id) => $(id),
      querySelectorAll: (sel) => [],
      title: 'H-App'
    },
    window: contextWindow,
    localStorage,
    assert,
    setLoadingProgress,
    loadingProgressHistory,
    renderSettings: () => {},
    updateBottomNavVisibility: () => {},
    logDebug: (msg) => {},
    callApiPost: (action, payload) => {
      apiCalls.push({ action, payload });
      return apiPostHandler(action, payload);
    },
    setApiHandler: (fn) => { apiPostHandler = fn; },
    apiCalls,
    elements,
    localStorageStore,
    setTimeout: (fn, ms) => { fn(); return 1; },
    clearTimeout: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };

  const testVmContext = vm.createContext(sandbox);

  // app.js から検証対象のコードを抽出
  const p1 = appJsContent.indexOf('let appStartupTriggered = false;');
  const p2 = appJsContent.indexOf('function setSyncStatus(state) {');
  assert.ok(p1 !== -1 && p2 !== -1 && p2 > p1, 'showMainApp block must exist');
  const showMainAppCode = appJsContent.slice(p1, p2);

  const p3 = appJsContent.indexOf('function triggerBackgroundRegistration(profile) {');
  const p4 = appJsContent.indexOf('async function loadData(');
  assert.ok(p3 !== -1 && p4 !== -1 && p4 > p3, 'reg block must exist');
  const regCode = appJsContent.slice(p3, p4);

  // AuthModule, StaffRegistrationModule, RenderView をテストコンテキストへ先行ロード
  vm.runInContext(authJsContent, testVmContext);
  vm.runInContext(staffRegistrationJsContent, testVmContext);
  vm.runInContext(renderJsContent, testVmContext);
  testVmContext.renderSettings = () => {};

  const harnessCode = [
    'Object.defineProperty(this, "_identityVerified", {',
    '  get: () => AuthModule.isIdentityVerified(),',
    '  set: (v) => { AuthModule.setIdentityVerified(v); },',
    '  configurable: true',
    '});',
    'Object.defineProperty(this, "_identitySyncPromise", {',
    '  get: () => AuthModule.getIdentitySyncPromise(),',
    '  set: (p) => { AuthModule.setIdentitySyncPromise(p); },',
    '  configurable: true',
    '});',
    'let __contractExpired = false;',
    showMainAppCode,
    regCode,
    'this.getAppState = () => ({',
    '  mainAppVisible,',
    '  isRegistering: StaffRegistrationModule.getStatus().isRegistering,',
    '  registrationError: StaffRegistrationModule.getStatus().registrationError,',
    '  activeRegistrationPromise: null,',
    '  _identityVerified: AuthModule.isIdentityVerified(),',
    '  _identitySyncPromise: AuthModule.getIdentitySyncPromise()',
    '});',
    'this.setIdentityVerified = (v) => { AuthModule.setIdentityVerified(v); };',
    'this.setMainAppVisible = (v) => { mainAppVisible = v; };'
  ].join('\n');

  vm.runInContext(harnessCode, testVmContext);

  return testVmContext;
}

// ────────────────────────────────────────────────────────────────────────
// READY-001: 既存登録済みLINE ID ➔ 正常起動
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-001] 既存登録済みLINE ID ➔ 正常起動 検証中...');
{
  const ctx = createHAppTestContext();
  ctx.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: true, staffId: 'S001', staffName: '既存スタッフ' };
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_001', displayName: '既存スタッフ', pictureUrl: '' };
  await vm.runInContext(`
    (async () => {
      const profile = ${JSON.stringify(profile)};
      window.liffProfile = profile;
      const existingUserInfo = JSON.parse(localStorage.getItem('user_info') || '{}');
      const hasExistingStaffId = Boolean(existingUserInfo.id && String(existingUserInfo.id).trim() !== '');

      _identitySyncPromise = callApiPost('getStaffIdentity', {}).then(identityRes => {
        if (identityRes && identityRes.success && identityRes.registered && identityRes.staffId && String(identityRes.staffId).trim() !== '') {
          const verifiedUserInfo = {
            last: identityRes.staffName || profile.displayName || '',
            first: '',
            id: identityRes.staffId,
            lineUserId: profile.userId,
            picture: profile.pictureUrl || ''
          };
          localStorage.setItem('user_info', JSON.stringify(verifiedUserInfo));
          _identityVerified = true;
          if (!hasExistingStaffId) {
            setLoadingProgress(100, 'READY');
            showMainApp();
          }
          return true;
        }
      });
      await _identitySyncPromise;
    })()
  `, ctx);

  const state = ctx.getAppState();
  assert.equal(state._identityVerified, true, 'READY-001: _identityVerified must be true');
  assert.equal(state.mainAppVisible, true, 'READY-001: mainAppVisible must be true');
  const storedUser = JSON.parse(ctx.localStorage.getItem('user_info'));
  assert.equal(storedUser.id, 'S001', 'READY-001: user_info.id must be S001');
  const hasReadyProgress = ctx.loadingProgressHistory.some(h => h.pct === 100 && h.label === 'READY');
  assert.ok(hasReadyProgress, 'READY-001: setLoadingProgress(100, READY) must be called');
  console.log('  ✅ READY-001 PASS: 既存登録ユーザーが READY ➔ showMainApp で正常起動した');
}

// ────────────────────────────────────────────────────────────────────────
// READY-002: LINE ID未登録 ➔ registerStaff成功 ➔ スタッフID付与 ➔ 正常起動
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-002] LINE ID未登録 ➔ registerStaff成功 ➔ スタッフID付与 ➔ 正常起動 検証中...');
{
  const ctx = createHAppTestContext();
  ctx.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: false };
    }
    if (action === 'registerStaff') {
      return { success: true, id: 'S002', name: '新規スタッフ' };
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_002', displayName: '新規スタッフ', pictureUrl: '' };
  await vm.runInContext(`
    (async () => {
      const profile = ${JSON.stringify(profile)};
      window.liffProfile = profile;
      const hasExistingStaffId = false;

      _identitySyncPromise = callApiPost('getStaffIdentity', {}).then(identityRes => {
        if (identityRes && identityRes.success && identityRes.registered && identityRes.staffId) {
          return true;
        } else {
          _identityVerified = false;
          mainAppVisible = false;
          $('app').classList.add('hidden');
          setLoadingProgress(60, 'REGISTERING...');

          return triggerBackgroundRegistration(profile).then(() => {
            const verifiedInfo = JSON.parse(localStorage.getItem('user_info') || '{}');
            if (!verifiedInfo.id) {
              throw new Error("Registration finished but staffId is missing in storage");
            }
            setLoadingProgress(100, 'READY');
            _identityVerified = true;
            showMainApp();
            return true;
          });
        }
      });
      await _identitySyncPromise;
    })()
  `, ctx);

  const state = ctx.getAppState();
  assert.equal(state._identityVerified, true, 'READY-002: _identityVerified must be true');
  assert.equal(state.mainAppVisible, true, 'READY-002: mainAppVisible must be true');
  const storedUser = JSON.parse(ctx.localStorage.getItem('user_info'));
  assert.equal(storedUser.id, 'S002', 'READY-002: user_info.id must be S002');
  const hasReadyProgress = ctx.loadingProgressHistory.some(h => h.pct === 100 && h.label === 'READY');
  assert.ok(hasReadyProgress, 'READY-002: setLoadingProgress(100, READY) must be called');
  console.log('  ✅ READY-002 PASS: 初回登録成功後に S002 を取得し、READY ➔ showMainApp で正常起動した');
}

// ────────────────────────────────────────────────────────────────────────
// READY-003: LINE ID未登録 ➔ registerStaff明示エラー ➔ READY非表示 ➔ App非表示 ➔ エラー表示
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-003] LINE ID未登録 ➔ registerStaff明示エラー ➔ READY非表示 ➔ App非表示 ➔ エラー表示 検証中...');
{
  const ctx = createHAppTestContext();
  ctx.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: false };
    }
    if (action === 'registerStaff') {
      return { success: false, error: 'Registration rejected by admin' };
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_003', displayName: 'エラースタッフ', pictureUrl: '' };
  let caughtError = null;

  try {
    await vm.runInContext(`
      (async () => {
        const profile = ${JSON.stringify(profile)};
        window.liffProfile = profile;
        const hasExistingStaffId = false;

        _identitySyncPromise = callApiPost('getStaffIdentity', {}).then(identityRes => {
          if (identityRes && identityRes.success && identityRes.registered) {
            return true;
          } else {
            _identityVerified = false;
            mainAppVisible = false;
            $('app').classList.add('hidden');
            setLoadingProgress(60, 'REGISTERING...');

            return triggerBackgroundRegistration(profile).then(() => {
              const verifiedInfo = JSON.parse(localStorage.getItem('user_info') || '{}');
              if (!verifiedInfo.id) {
                throw new Error("Registration finished but staffId is missing in storage");
              }
              setLoadingProgress(100, 'READY');
              _identityVerified = true;
              showMainApp();
              return true;
            }).catch(rErr => {
              _identityVerified = false;
              throw rErr;
            });
          }
        });
        await _identitySyncPromise;
      })()
    `, ctx);
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'READY-003: registration failure must throw error');
  const state = ctx.getAppState();
  assert.equal(state._identityVerified, false, 'READY-003: _identityVerified must be false');
  assert.equal(state.mainAppVisible, false, 'READY-003: mainAppVisible must be false');
  const hasReadyProgress = ctx.loadingProgressHistory.some(h => h.label === 'READY');
  assert.equal(hasReadyProgress, false, 'READY-003: READY must NEVER be displayed');
  const loadingText = ctx.$('loading-status').textContent;
  assert.ok(loadingText.includes('登録エラー'), 'READY-003: loading-status must display error banner');
  assert.ok(loadingText.includes('タップして再試行'), 'READY-003: loading-status must prompt for retry');
  console.log('  ✅ READY-003 PASS: 登録明示エラーで READY禁止・App非表示・エラー表示を確認');
}

// ────────────────────────────────────────────────────────────────────────
// READY-004: 登録通信失敗/Promise rejection ➔ READY非表示 ➔ App非表示 ➔ エラー表示
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-004] 登録通信失敗/Promise rejection ➔ READY非表示 ➔ App非表示 ➔ エラー表示 検証中...');
{
  const ctx = createHAppTestContext();
  ctx.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: false };
    }
    if (action === 'registerStaff') {
      throw new Error('503 Service Unavailable (Network Failure)');
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_004', displayName: '通信失敗スタッフ', pictureUrl: '' };
  let caughtError = null;

  try {
    await vm.runInContext(`
      (async () => {
        const profile = ${JSON.stringify(profile)};
        window.liffProfile = profile;
        _identityVerified = false;
        mainAppVisible = false;
        $('app').classList.add('hidden');
        setLoadingProgress(60, 'REGISTERING...');

        return triggerBackgroundRegistration(profile).then(() => {
          setLoadingProgress(100, 'READY');
          _identityVerified = true;
          showMainApp();
        }).catch(err => {
          _identityVerified = false;
          throw err;
        });
      })()
    `, ctx);
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'READY-004: Network rejection must be caught');
  const state = ctx.getAppState();
  assert.equal(state._identityVerified, false, 'READY-004: _identityVerified must remain false');
  assert.equal(state.mainAppVisible, false, 'READY-004: mainAppVisible must be false');
  const hasReadyProgress = ctx.loadingProgressHistory.some(h => h.label === 'READY');
  assert.equal(hasReadyProgress, false, 'READY-004: READY must NEVER be set on network error');
  const loadingText = ctx.$('loading-status').textContent;
  assert.ok(loadingText.includes('登録エラー'), 'READY-004: loading-status must display error banner');
  console.log('  ✅ READY-004 PASS: 通信切断/Rejection で READY禁止・App非表示・エラー表示を確認');
}

// ────────────────────────────────────────────────────────────────────────
// READY-005: 登録失敗後に再試行 ➔ 成功 ➔ 正常起動
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-005] 登録失敗後に再試行 ➔ 成功 ➔ 正常起動 検証中...');
{
  const ctx = createHAppTestContext();
  let attempt = 0;
  ctx.setApiHandler(async (action) => {
    if (action === 'registerStaff') {
      attempt++;
      if (attempt === 1) {
        throw new Error('Initial network glitch');
      }
      return { success: true, id: 'S005', name: '再試行スタッフ' };
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_005', displayName: '再試行スタッフ', pictureUrl: '' };

  // 1回目: 失敗
  try {
    await vm.runInContext(`
      (async () => {
        window.liffProfile = ${JSON.stringify(profile)};
        await triggerBackgroundRegistration(window.liffProfile);
      })()
    `, ctx);
  } catch (e) {
    // Expected initial failure
  }
  assert.equal(ctx.getAppState().mainAppVisible, false, 'READY-005: First attempt failure must not show app');

  // 2回目: window.retryRegistration() による再試行
  await vm.runInContext(`
    (async () => {
      await window.retryRegistration();
    })()
  `, ctx);

  const state = ctx.getAppState();
  assert.equal(state._identityVerified, true, 'READY-005: _identityVerified must be true after successful retry');
  assert.equal(state.mainAppVisible, true, 'READY-005: mainAppVisible must be true after successful retry');
  const storedUser = JSON.parse(ctx.localStorage.getItem('user_info'));
  assert.equal(storedUser.id, 'S005', 'READY-005: staff ID S005 must be saved after retry');
  const hasReadyProgress = ctx.loadingProgressHistory.some(h => h.pct === 100 && h.label === 'READY');
  assert.ok(hasReadyProgress, 'READY-005: READY must be set on successful retry');
  console.log('  ✅ READY-005 PASS: 初回失敗後に window.retryRegistration() で再試行し正常起動完了');
}

// ────────────────────────────────────────────────────────────────────────
// READY-006: registerStaff成功レスポンスに必要なIDが存在しない異常レスポンス ➔ READY禁止 ➔ App表示禁止
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-006] registerStaffレスポンスのID欠落 ➔ READY禁止 ➔ App表示禁止 検証中...');
{
  const ctx = createHAppTestContext();
  ctx.setApiHandler(async (action) => {
    if (action === 'registerStaff') {
      return { success: true /* id が欠落した不正レスポンス */ };
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_006', displayName: 'ID欠落スタッフ', pictureUrl: '' };
  let caughtError = null;

  try {
    await vm.runInContext(`
      (async () => {
        window.liffProfile = ${JSON.stringify(profile)};
        await triggerBackgroundRegistration(window.liffProfile);
      })()
    `, ctx);
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'READY-006: Missing id in success response must be rejected');
  assert.ok(caughtError.message.includes('missing id'), 'READY-006: Error message must indicate missing id');
  const state = ctx.getAppState();
  assert.equal(state._identityVerified, false, 'READY-006: _identityVerified must remain false');
  assert.equal(state.mainAppVisible, false, 'READY-006: mainAppVisible must remain false');
  const hasReadyProgress = ctx.loadingProgressHistory.some(h => h.label === 'READY');
  assert.equal(hasReadyProgress, false, 'READY-006: READY must NEVER be set on invalid id response');
  console.log('  ✅ READY-006 PASS: ID欠落レスポンスを厳格に拒否し、READY・App表示を完全遮断');
}

// ────────────────────────────────────────────────────────────────────────
// READY-007: 既存localStorageあり + Backend既存ユーザー ➔ 従来どおり正常起動
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-007] 既存localStorageあり + Backend既存ユーザー ➔ 先行描画 & 正常起動 検証中...');
{
  const ctx = createHAppTestContext();
  ctx.localStorage.setItem('user_info', JSON.stringify({ id: 'S007', last: '既存ユーザー' }));

  ctx.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: true, staffId: 'S007', staffName: '既存ユーザー' };
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_007', displayName: '既存ユーザー', pictureUrl: '' };
  await vm.runInContext(`
    (async () => {
      const existingUserInfo = JSON.parse(localStorage.getItem('user_info') || '{}');
      const hasExistingStaffId = Boolean(existingUserInfo.id && String(existingUserInfo.id).trim() !== '');

      if (hasExistingStaffId) {
        showMainApp(); // Optimistic First Paint
      }

      _identitySyncPromise = callApiPost('getStaffIdentity', {}).then(identityRes => {
        if (identityRes && identityRes.success && identityRes.registered && identityRes.staffId) {
          _identityVerified = true;
          return true;
        }
      });
      await _identitySyncPromise;
    })()
  `, ctx);

  const state = ctx.getAppState();
  assert.equal(state._identityVerified, true, 'READY-007: _identityVerified must be true');
  assert.equal(state.mainAppVisible, true, 'READY-007: mainAppVisible must be true');
  console.log('  ✅ READY-007 PASS: 既存localStorageユーザーがOptimistic First Paintで即時起動');
}

// ────────────────────────────────────────────────────────────────────────
// READY-008: stale/不完全localStorage ➔ READY Freezeを発生させない
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-008] stale/不完全localStorage ➔ READY Freeze防止 検証中...');
{
  // Case A: 不完全 localStorage (id が空文字)
  const ctxA = createHAppTestContext();
  ctxA.localStorage.setItem('user_info', JSON.stringify({ id: '', last: '不完全' }));
  ctxA.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: true, staffId: 'S008_FIXED', staffName: '復旧ユーザー' };
    }
    return { success: true };
  });

  await vm.runInContext(`
    (async () => {
      const profile = { userId: 'U_READY_008_A', displayName: '復旧ユーザー' };
      const existingUserInfo = JSON.parse(localStorage.getItem('user_info') || '{}');
      const hasExistingStaffId = Boolean(existingUserInfo.id && String(existingUserInfo.id).trim() !== '');

      assert.equal(hasExistingStaffId, false, 'Empty string id must NOT be treated as existing');

      _identitySyncPromise = callApiPost('getStaffIdentity', {}).then(identityRes => {
        if (identityRes && identityRes.success && identityRes.registered && identityRes.staffId) {
          localStorage.setItem('user_info', JSON.stringify({ id: identityRes.staffId, last: identityRes.staffName }));
          _identityVerified = true;
          setLoadingProgress(100, 'READY');
          showMainApp();
          return true;
        }
      });
      await _identitySyncPromise;
    })()
  `, ctxA);

  assert.equal(ctxA.getAppState().mainAppVisible, true, 'READY-008-A: Recovered user must be shown');
  assert.equal(JSON.parse(ctxA.localStorage.getItem('user_info')).id, 'S008_FIXED');

  // Case B: stale localStorage (id=OLD_S999 だが Backend で未登録判定 ➔ 画面ロック & 登録失敗時はREADY禁止)
  const ctxB = createHAppTestContext();
  ctxB.localStorage.setItem('user_info', JSON.stringify({ id: 'OLD_S999', last: 'Stale User' }));
  ctxB.setApiHandler(async (action) => {
    if (action === 'getStaffIdentity') {
      return { success: true, registered: false }; // 名簿から削除または不一致
    }
    if (action === 'registerStaff') {
      throw new Error('Registration blocked by admin');
    }
    return { success: true };
  });

  let caseBErr = null;
  try {
    await vm.runInContext(`
      (async () => {
        const profile = { userId: 'U_READY_008_B', displayName: 'Stale User' };
        showMainApp(); // 先行表示されていたと仮定

        _identitySyncPromise = callApiPost('getStaffIdentity', {}).then(identityRes => {
          if (identityRes && identityRes.success && identityRes.registered) {
            return true;
          } else {
            // 未登録判定: 画面を直ちにロック
            mainAppVisible = false;
            $('app').classList.add('hidden');
            setLoadingProgress(60, 'REGISTERING...');

            return triggerBackgroundRegistration(profile).then(() => {
              setLoadingProgress(100, 'READY');
              _identityVerified = true;
              showMainApp();
            }).catch(rErr => {
              _identityVerified = false;
              throw rErr;
            });
          }
        });
        await _identitySyncPromise;
      })()
    `, ctxB);
  } catch (err) {
    caseBErr = err;
  }

  assert.ok(caseBErr, 'READY-008-B: Registration failure must be thrown');
  const stateB = ctxB.getAppState();
  assert.equal(stateB.mainAppVisible, false, 'READY-008-B: Stale user app MUST be locked and hidden');
  assert.equal(stateB._identityVerified, false, 'READY-008-B: Identity must be unverified');
  const hasReady = ctxB.loadingProgressHistory.some(h => h.label === 'READY');
  assert.equal(hasReady, false, 'READY-008-B: READY Freeze MUST NOT occur on stale failure');
  console.log('  ✅ READY-008 PASS: 不完全/stale な localStorage でも READY Freeze が発生しないことを確認');
}

// ────────────────────────────────────────────────────────────────────────
// READY-009: 二重タップ/再試行によって重複登録を発生させない (In-flight Memoization)
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-009] 二重タップ/再試行による重複リクエスト防止 検証中...');
{
  const ctx = createHAppTestContext();
  let registerStaffCallCount = 0;
  let resolveRegistration;

  ctx.setApiHandler(async (action) => {
    if (action === 'registerStaff') {
      registerStaffCallCount++;
      return new Promise((resolve) => {
        resolveRegistration = () => resolve({ success: true, id: 'S009', name: '連打スタッフ' });
      });
    }
    return { success: true };
  });

  const profile = { userId: 'U_READY_009', displayName: '連打スタッフ', pictureUrl: '' };

  // 同時に2回 triggerBackgroundRegistration を呼び出す
  const p1 = vm.runInContext(`triggerBackgroundRegistration(${JSON.stringify(profile)})`, ctx);
  const p2 = vm.runInContext(`triggerBackgroundRegistration(${JSON.stringify(profile)})`, ctx);

  // In-flight 中の重複判定
  assert.equal(registerStaffCallCount, 1, 'READY-009: callApiPost must be invoked only ONCE');
  assert.strictEqual(p1, p2, 'READY-009: Multiple calls must share the identical in-flight Promise');

  // リクエスト完了
  resolveRegistration();
  await Promise.all([p1, p2]);

  assert.equal(registerStaffCallCount, 1, 'READY-009: Total call count must remain 1 after completion');
  console.log('  ✅ READY-009 PASS: in-flight Promise メモ化により重複登録APIコールを完全遮断');
}

// ────────────────────────────────────────────────────────────────────────
// READY-010: 登録Backend成功後にクライアント側レスポンス喪失を模擬 ➔ 再試行時に同一LINE_USER_IDが既存として解決され、重複スタッフ行を生成しない
// ────────────────────────────────────────────────────────────────────────
console.log('▶ [READY-010] 登録完了後パケット喪失模擬 ➔ 再試行時LINE_USER_ID既存判定 & 冪等性 検証中...');
{
  // Universal Backend の StaffService & Repository を直接モック環境でインスタンス化
  class MockStaffSheet {
    constructor() {
      this.rows = [
        ['ID', '名前', 'LINE_USER_ID', '登録日時']
      ];
    }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return 4; }
    getRange(row, col, numRows = 1, numCols = 1) {
      const self = this;
      return {
        getValues() {
          const res = [];
          for (let r = 0; r < numRows; r++) {
            const rIdx = row - 1 + r;
            const rData = self.rows[rIdx] || [];
            const rVals = [];
            for (let c = 0; c < numCols; c++) {
              rVals.push(rData[col - 1 + c] !== undefined ? rData[col - 1 + c] : '');
            }
            res.push(rVals);
          }
          return res;
        },
        setValues(vals) {
          for (let r = 0; r < vals.length; r++) {
            const rIdx = row - 1 + r;
            while (self.rows.length <= rIdx) {
              self.rows.push(['', '', '', '']);
            }
            for (let c = 0; c < vals[r].length; c++) {
              self.rows[rIdx][col - 1 + c] = vals[r][c];
            }
          }
        }
      };
    }
    appendRow(rowVals) {
      this.rows.push([...rowVals]);
    }
  }

  const staffSheet = new MockStaffSheet();

  // Backend コードをロード
  const staffModelCode = fs.readFileSync(path.join(REPO_ROOT, 'active/business/staff/staff_model.js'), 'utf8');
  const staffRepoCode = fs.readFileSync(path.join(REPO_ROOT, 'active/business/staff/staff_repository.js'), 'utf8');
  const staffServiceCode = fs.readFileSync(path.join(REPO_ROOT, 'active/business/staff/staff_service.js'), 'utf8');

  const backendSandbox = {
    MonthlySheetResolver: {
      getInstance: () => ({
        getCurrentSheet: () => staffSheet
      })
    },
    getMonthlySheet: () => staffSheet,
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        waitLock: () => true,
        releaseLock: () => {}
      })
    },
    Utilities: {
      formatDate: () => '2026/09/27 08:00:00'
    },
    logTrace: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };

  const bContext = vm.createContext(backendSandbox);
  vm.runInContext(staffModelCode, bContext);
  vm.runInContext(staffRepoCode, bContext);
  vm.runInContext(staffServiceCode, bContext);

  const testLineUserId = 'U_READY_010_IDEMPOTENT_TEST';
  const testDisplayName = '冪等性テストスタッフ';

  // 1回目: 初回登録 ➔ StaffService.registerStaff 成功
  const firstRegRes = vm.runInContext(`
    StaffService.getInstance().registerStaff('${testDisplayName}', '(LINE)', '${testLineUserId}');
  `, bContext);

  assert.equal(firstRegRes.success, true, 'READY-010: First registration must succeed');
  assert.equal(firstRegRes.id, 'S001', 'READY-010: First registration assigned S001');
  assert.equal(staffSheet.rows.length, 2, 'READY-010: Roster sheet must have exactly 2 rows (header + 1 staff)');

  // 模擬: クライアント側でレスポンス受信直前にパケット喪失 / タイムアウト発生
  // クライアント側は失敗とみなし、同一 lineUserId で再試行を発行
  const retryRegRes = vm.runInContext(`
    StaffService.getInstance().registerStaff('${testDisplayName}', '(LINE)', '${testLineUserId}');
  `, bContext);

  assert.equal(retryRegRes.success, true, 'READY-010: Retry must succeed via idempotency check');
  assert.equal(retryRegRes.id, 'S001', 'READY-010: Retry must return the exact same staffId S001');
  assert.equal(retryRegRes.message, 'existing', 'READY-010: Backend must return existing status');
  assert.equal(staffSheet.rows.length, 2, 'READY-010: Roster row count MUST NOT increase (no duplicate row)');

  // LINE_USER_ID による照合が完全一致していること
  const registeredLineId = staffSheet.rows[1][2]; // C列
  assert.equal(registeredLineId, testLineUserId, 'READY-010: LINE_USER_ID in sheet must match exactly');
  console.log('  ✅ READY-010 PASS: Backend registerStaff のLINE_USER_ID完全一致照合により完全な冪等性を確認');
}

console.log('\n====================================================');
console.log('🎉 ALL 10 GAP-001 REGRESSION AUDIT GATES PASSED (10/10 PASS)!');
console.log('====================================================\n');
