import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const API_JS_PATH = path.join(REPO_ROOT, 'active/h-app/modules/api.js');
const APP_JS_PATH = path.join(REPO_ROOT, 'active/h-app/app.js');
const MEASURE_JS_PATH = path.join(REPO_ROOT, 'tests/measure_chrome_real.mjs');

const apiJs = fs.readFileSync(API_JS_PATH, 'utf8');
const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');
const measureJs = fs.readFileSync(MEASURE_JS_PATH, 'utf8');

/**
 * Robust function extractor using brace-depth counting
 */
function extractFunction(source, fnName) {
  const startIdx = source.search(new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`));
  if (startIdx === -1) return null;
  const braceStart = source.indexOf('{', startIdx);
  let depth = 1;
  let idx = braceStart + 1;
  while (depth > 0 && idx < source.length) {
    if (source[idx] === '{') depth++;
    else if (source[idx] === '}') depth--;
    idx++;
  }
  return source.slice(startIdx, idx);
}

/**
 * VM Helper: Creates a browser-like sandbox and loads the ACTUAL modules/api.js source
 */
function createApiVmContext({
  tokens = ['mock_token_1'],
  fetchHandler = null,
  hasAuthGate = true,
  hasIdentityGate = true
} = {}) {
  let tokenIndex = 0;
  let fetchCallCount = 0;
  const fetchCalls = [];

  const mockWindow = {
    PMS_DEBUG: false,
    PMS_CLIENT_CONFIG: {
      districtId: 'kuwana',
      api: {
        gasWebAppUrl: 'https://script.google.com/macros/s/dummy/exec'
      }
    },
    getApiUrl: null,
    getLiffAuthToken: null,
    callApiPost: null,
    logDebug: () => {}
  };

  if (hasAuthGate) {
    mockWindow.waitForLiffAuthReady = async () => true;
  }
  if (hasIdentityGate) {
    mockWindow.waitForIdentityVerified = async () => true;
  }

  const mockLiff = {
    isLoggedIn: () => true,
    getAccessToken: () => {
      if (tokenIndex < tokens.length) {
        return tokens[tokenIndex++];
      }
      return null;
    }
  };

  const sandbox = {
    window: mockWindow,
    document: {},
    liff: mockLiff,
    logDebug: () => {},
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), // speed up retries in tests
    clearTimeout: (id) => clearTimeout(id),
    AbortController: globalThis.AbortController,
    fetch: async (url, options) => {
      fetchCallCount++;
      fetchCalls.push({ url, options });
      if (typeof fetchHandler === 'function') {
        return fetchHandler(url, options, fetchCallCount);
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { status: 'OK' } })
      };
    }
  };

  mockWindow.liff = mockLiff;

  const context = vm.createContext(sandbox);
  vm.runInContext(apiJs, context);

  if (hasAuthGate || hasIdentityGate) {
    const gates = {};
    if (hasAuthGate) {
      gates.waitForLiffAuthReady = mockWindow.waitForLiffAuthReady;
    }
    if (hasIdentityGate) {
      gates.waitForIdentityVerified = mockWindow.waitForIdentityVerified;
    }
    sandbox.setApiAuthGates(gates);
  }

  return {
    callApiPost: sandbox.window.callApiPost,
    getFetchCount: () => fetchCallCount,
    getFetchCalls: () => fetchCalls,
    sandbox
  };
}

// ============================================================================
// PART 1: ACTUAL modules/api.js VM EXECUTION CONTRACTS
// ============================================================================

test('modules/api.js [VM Real]: Mandatory Negative Test: Attempt 1 transient -> Attempt 2 token=null stops before fetch (fetch count = 1, UNAUTHORIZED)', async () => {
  // Attempt 1 provides token 'token_A', Attempt 2 provides null
  const { callApiPost, getFetchCount } = createApiVmContext({
    tokens: ['token_A', null],
    fetchHandler: async (url, options, callSeq) => {
      if (callSeq === 1) {
        // Attempt 1: network transient failure (HTTP 500 with retryable TRANSIENT)
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ success: false, code: 'INTERNAL_ERROR', retryable: true })
        };
      }
      throw new Error('Fetch MUST NOT be called for Attempt 2!');
    }
  });

  let caughtErr = null;
  try {
    await callApiPost('getStaffIdentity', {});
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr, 'Must reject with error');
  assert.equal(getFetchCount(), 1, 'Total fetch calls must be EXACTLY 1 (Attempt 2 must NOT call fetch)');
  assert.equal(caughtErr.code, 'UNAUTHORIZED', 'Error code must be UNAUTHORIZED');
  assert.equal(caughtErr.retryable, false, 'retryable must be false');
  assert.equal(caughtErr.errorType, 'PERMANENT', 'errorType must be PERMANENT');
});

test('modules/api.js [VM Real]: Non-public action with token=null stops before fetch (fetch count = 0, UNAUTHORIZED)', async () => {
  const { callApiPost, getFetchCount } = createApiVmContext({
    tokens: [null] // Token missing on attempt 1
  });

  let caughtErr = null;
  try {
    await callApiPost('getStaffIdentity', {});
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr, 'Must reject when token is null');
  assert.equal(getFetchCount(), 0, 'fetch() MUST NOT be called when token is null on protected action');
  assert.equal(caughtErr.code, 'UNAUTHORIZED');
  assert.equal(caughtErr.retryable, false);
});

test('modules/api.js [VM Real]: Public actions proceed without token (fetch count = 1)', async () => {
  const { callApiPost, getFetchCount, getFetchCalls } = createApiVmContext({
    tokens: [null] // No token
  });

  const res = await callApiPost('getMapsApiKey', {});
  assert.equal(getFetchCount(), 1, 'Public action MUST call fetch even without token');
  assert.equal(res?.status, 'OK');

  const body = JSON.parse(getFetchCalls()[0].options.body);
  assert.equal(body.liffToken, undefined, 'liffToken should not be attached when null');
});

test('modules/api.js [VM Real]: Auth gate missing strictly fails closed before fetch (fetch count = 0)', async () => {
  const { callApiPost, getFetchCount } = createApiVmContext({
    hasAuthGate: false // window.waitForLiffAuthReady is undefined
  });

  let caughtErr = null;
  try {
    await callApiPost('getStaffIdentity', {});
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr, 'Must reject when auth gate is unavailable');
  assert.equal(getFetchCount(), 0, 'fetch() MUST NOT be called when auth gate is unavailable');
  assert.equal(caughtErr.code, 'UNAUTHORIZED');
});

test('modules/api.js [VM Real]: Protected write gate missing strictly fails closed before fetch (fetch count = 0)', async () => {
  const { callApiPost, getFetchCount } = createApiVmContext({
    hasIdentityGate: false // window.waitForIdentityVerified is undefined
  });

  let caughtErr = null;
  try {
    await callApiPost('submitDistribution', { rowId: 1 });
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr, 'Must reject when identity gate is unavailable');
  assert.equal(getFetchCount(), 0, 'fetch() MUST NOT be called when identity gate is unavailable');
  assert.equal(caughtErr.code, 'UNAUTHORIZED');
});

test('modules/api.js [VM Real]: HTTP 429 response maps to RATE_LIMIT_EXCEEDED / TRANSIENT / retryable: true', async () => {
  const { callApiPost } = createApiVmContext({
    tokens: ['tok1', 'tok2', 'tok3'],
    fetchHandler: async () => ({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded"
    })
  });

  let caughtErr = null;
  try {
    await callApiPost('getStaffIdentity', {});
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr, 'Should throw after retry exhaustion');
  assert.equal(caughtErr.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(caughtErr.errorType, 'TRANSIENT');
  assert.equal(caughtErr.retryable, true);
});

// ============================================================================
// PART 2: ACTUAL active/h-app/app.js SOURCE CONTRACTS
// ============================================================================

test('app.js [Source-Bound]: waitForIdentityVerified requires _identityVerified === true even if promise resolves', async () => {
  const gateSource = extractFunction(appJs, 'waitForIdentityVerified');
  assert.ok(gateSource, 'waitForIdentityVerified must be present in app.js');

  const authModulePath = path.join(REPO_ROOT, 'active/h-app/modules/auth.js');
  const authModuleCode = fs.readFileSync(authModulePath, 'utf8');

  const authSandbox = { console, Promise, Error, Object, Boolean, module: { exports: {} } };
  vm.runInNewContext(authModuleCode, authSandbox);
  const AuthModule = authSandbox.module.exports;

  AuthModule.setIdentityVerified(false);
  AuthModule.setIdentitySyncPromise(Promise.resolve(false)); // Promise resolved to false!
  AuthModule.setIdentityLastError(Object.assign(new Error("AUTH_REJECTED"), { code: "UNAUTHORIZED", retryable: false }));

  const sandbox = {
    AuthModule,
    Error,
    Object
  };

  const gateFn = new Function(
    'sandbox',
    `with(sandbox) { return (${gateSource}); }`
  )(sandbox);

  let caughtErr = null;
  try {
    await gateFn();
  } catch (e) {
    caughtErr = e;
  }

  assert.ok(caughtErr, 'Must reject when _identityVerified is false even if promise resolved');
  assert.equal(caughtErr.code, 'UNAUTHORIZED');

  // Now verify that when _identityVerified is true, it passes
  AuthModule.setIdentityVerified(true);
  const passResult = await gateFn();
  assert.equal(passResult, true, 'Must pass when _identityVerified is true');
});

test('app.js [Source-Bound]: showIdentityErrorUI hides #app, shows #loading, and separates error actions', () => {
  const fnSource = extractFunction(appJs, 'showIdentityErrorUI');
  assert.ok(fnSource, 'showIdentityErrorUI must be present in app.js');

  function runShowUI(err, liffAuthState = 'READY') {
    let appHidden = false;
    let loadingShown = false;
    let statusText = '';
    let statusOnclick = null;
    let reloadCalled = false;
    let liffLoginCalled = false;
    let retryCalled = false;
    let sessionFlag = null;

    const mockApp = {
      classList: {
        add: (c) => { if (c === 'hidden') appHidden = true; }
      }
    };
    const mockLoading = {
      classList: {
        remove: (c) => { if (c === 'hidden') loadingShown = true; }
      }
    };
    const mockStatus = {
      set textContent(v) { statusText = v; },
      get textContent() { return statusText; },
      set onclick(fn) { statusOnclick = fn; },
      get onclick() { return statusOnclick; },
      style: {}
    };

    const mockSessionStorage = {
      setItem: (k, v) => { if (k === 'liff_initializing') sessionFlag = v; },
      getItem: (k) => (k === 'liff_initializing' ? sessionFlag : null)
    };

    const mockLiff = {
      logout: () => {},
      login: () => { liffLoginCalled = true; }
    };

    // Set on globalThis so unqualified sessionStorage and liff resolve correctly
    globalThis.sessionStorage = mockSessionStorage;
    globalThis.liff = mockLiff;

    const sandbox = {
      $: (id) => {
        if (id === 'app') return mockApp;
        if (id === 'loading') return mockLoading;
        if (id === 'loading-status') return mockStatus;
        return null;
      },
      mainAppVisible: true,
      window: {
        __contractExpired: false,
        location: { reload: () => { reloadCalled = true; }, href: 'https://kuwana.postingmap.jp' },
        retryIdentityVerification: () => { retryCalled = true; },
        sessionStorage: mockSessionStorage,
        liff: mockLiff
      },
      sessionStorage: mockSessionStorage,
      setSyncStatus: () => {},
      _liffAuthState: liffAuthState,
      AuthModule: {
        getAuthState: () => liffAuthState
      },
      liff: mockLiff
    };

    const showUiFn = new Function(
      'sandbox',
      `with(sandbox) { return (${fnSource}); }`
    )(sandbox);

    showUiFn(err);

    return {
      appHidden,
      loadingShown,
      statusText,
      statusOnclick,
      reloadCalled: () => reloadCalled,
      liffLoginCalled: () => liffLoginCalled,
      retryCalled: () => retryCalled,
      sessionFlag: () => sessionFlag,
      contractExpired: () => sandbox.window.__contractExpired
    };
  }

  // Case 1: CONTRACT_EXPIRED
  const r1 = runShowUI({ code: 'CONTRACT_EXPIRED' });
  assert.equal(r1.appHidden, true, 'App must be hidden on CONTRACT_EXPIRED');
  assert.equal(r1.loadingShown, true, 'Loading must be shown on CONTRACT_EXPIRED');
  assert.equal(r1.contractExpired(), true, '__contractExpired must be set');
  assert.equal(r1.statusOnclick, null, 'Must NOT attach retry onclick on CONTRACT_EXPIRED');

  // Case 2: UNAUTHORIZED
  const r2 = runShowUI({ code: 'UNAUTHORIZED' });
  assert.equal(r2.appHidden, true, 'App must be hidden on UNAUTHORIZED');
  assert.equal(r2.loadingShown, true, 'Loading must be shown on UNAUTHORIZED');
  assert.ok(typeof r2.statusOnclick === 'function', 'Must attach re-login handler on UNAUTHORIZED');
  r2.statusOnclick();
  assert.equal(r2.sessionFlag(), 'true', 'Must set sessionStorage liff_initializing=true before login');
  assert.equal(r2.liffLoginCalled(), true, 'Must call liff.login on UNAUTHORIZED tap');

  // Case 3: LIFF Init Failure (FAILED state or timeout) -> MUST route to reload, NOT retryIdentityVerification
  const r3 = runShowUI(new Error("LINEログインの応答がタイムアウトしました(5秒)"), 'FAILED');
  assert.equal(r3.appHidden, true, 'App must be hidden on LIFF init failure');
  assert.equal(r3.loadingShown, true, 'Loading must be shown on LIFF init failure');
  assert.ok(typeof r3.statusOnclick === 'function', 'Must attach reload handler on LIFF failure');
  r3.statusOnclick();
  assert.equal(r3.reloadCalled(), true, 'Must call window.location.reload() on LIFF failure tap');
  assert.equal(r3.retryCalled(), false, 'Must NOT call retryIdentityVerification() on LIFF failure tap');

  // Case 4: Identity API TRANSIENT -> Routes to retryIdentityVerification
  const r4 = runShowUI({ code: 'LOCK_TIMEOUT', message: 'Lock wait timeout' });
  assert.equal(r4.appHidden, true, 'App must be hidden on TRANSIENT');
  assert.equal(r4.loadingShown, true, 'Loading must be shown on TRANSIENT');
  assert.ok(typeof r4.statusOnclick === 'function', 'Must attach retry handler on TRANSIENT');
  r4.statusOnclick();
  assert.equal(r4.retryCalled(), true, 'Must call retryIdentityVerification() on TRANSIENT tap');
  assert.equal(r4.reloadCalled(), false, 'Must NOT reload on TRANSIENT tap');
});

test('app.js [Source-Bound]: safeInitApp identity sync error handling eliminated unhandled rethrows', () => {
  // Verify that _identitySyncPromise catch block invokes showIdentityErrorUI and sets _identityLastError
  assert.ok(appJs.includes('AuthModule.setIdentityLastError(err);'), 'Must record _identityLastError on failure');
  assert.ok(appJs.includes('showIdentityErrorUI(err);'), 'Must call showIdentityErrorUI on failure');

  // Verify that safeInitApp catches liff.init error and invokes showIdentityErrorUI
  assert.ok(
    appJs.includes("AuthModule.markAuthFailed(err);\n      showIdentityErrorUI(err);"),
    'LIFF init error block must call showIdentityErrorUI'
  );
});

test('app.js [Source-Bound]: REVOKED error routes to standard UNAUTHORIZED flow without direct liff.login', () => {
  // 1. Static block inspection of the actual REVOKED block in appJs
  const revokedBlockMatch = appJs.match(/if\s*\([^{]*REVOKED[^{]*\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(revokedBlockMatch, 'REVOKED error handling block must exist in app.js');

  const revokedBlock = revokedBlockMatch[0];
  assert.ok(revokedBlock.includes("err.code = 'UNAUTHORIZED'"), "REVOKED block must set err.code = 'UNAUTHORIZED'");
  assert.ok(revokedBlock.includes("err.errorType = 'PERMANENT'"), "REVOKED block must set err.errorType = 'PERMANENT'");
  assert.ok(revokedBlock.includes('err.retryable = false'), 'REVOKED block must set err.retryable = false');
  assert.ok(revokedBlock.includes('showIdentityErrorUI(err)'), 'REVOKED block must call showIdentityErrorUI(err)');
  assert.ok(!revokedBlock.includes('liff.login('), 'REVOKED block must NOT contain direct liff.login(');
  assert.ok(!revokedBlock.includes('liff.logout('), 'REVOKED block must NOT contain direct liff.logout(');

  // 2. Behavioral verification using the extracted showIdentityErrorUI
  const fnSource = extractFunction(appJs, 'showIdentityErrorUI');
  assert.ok(fnSource, 'showIdentityErrorUI must exist in app.js');

  let appHidden = false;
  let loadingShown = false;
  let statusOnclick = null;
  let loginCount = 0;
  let sessionFlag = null;

  const mockApp = { classList: { add: (c) => { if (c === 'hidden') appHidden = true; } } };
  const mockLoading = { classList: { remove: (c) => { if (c === 'hidden') loadingShown = true; } } };
  const mockStatus = {
    set textContent(_) {},
    set onclick(fn) { statusOnclick = fn; },
    style: {}
  };
  const mockSessionStorage = {
    setItem: (k, v) => { if (k === 'liff_initializing') sessionFlag = v; },
    getItem: (k) => (k === 'liff_initializing' ? sessionFlag : null)
  };
  const mockLiff = {
    logout: () => {},
    login: () => { loginCount++; }
  };

  const sandbox = {
    $: (id) => (id === 'app' ? mockApp : id === 'loading' ? mockLoading : id === 'loading-status' ? mockStatus : null),
    mainAppVisible: true,
    window: {
      location: { reload: () => {}, href: 'https://kuwana.postingmap.jp' },
      sessionStorage: mockSessionStorage,
      liff: mockLiff
    },
    sessionStorage: mockSessionStorage,
    setSyncStatus: () => {},
    _liffAuthState: 'READY',
    liff: mockLiff
  };

  const showUiFn = new Function('sandbox', `with(sandbox) { return (${fnSource}); }`)(sandbox);

  // Simulate error passed to showIdentityErrorUI after REVOKED conversion
  const revokedErr = new Error("Access token REVOKED");
  revokedErr.code = 'UNAUTHORIZED';
  revokedErr.errorType = 'PERMANENT';
  revokedErr.retryable = false;

  showUiFn(revokedErr);

  // Prior to user tapping: App must be blocked, loading visible, but NO liff.login() triggered
  assert.equal(appHidden, true, 'App must be hidden on REVOKED UNAUTHORIZED flow');
  assert.equal(loadingShown, true, 'Loading must be shown on REVOKED UNAUTHORIZED flow');
  assert.equal(loginCount, 0, 'Prior to user tap, liff.login() call count must be strictly 0');
  assert.equal(sessionFlag, null, 'Prior to user tap, liff_initializing must not be set');
  assert.ok(typeof statusOnclick === 'function', 'Must attach tap-to-relogin onclick handler');

  // Trigger user tap
  statusOnclick();

  // After user tap: sessionStorage flag set AND liff.login() triggered
  assert.equal(sessionFlag, 'true', 'After user tap, sessionStorage liff_initializing must be true');
  assert.equal(loginCount, 1, 'After user tap, liff.login() call count must be exactly 1');
});

// ============================================================================
// PART 3: tests/measure_chrome_real.mjs SOURCE CONTRACTS
// ============================================================================

test('measure_chrome_real.mjs [Source-Bound]: coldPass is strictly absent and coldStatus is SEPARATED', () => {
  assert.ok(!measureJs.includes('coldPass'), 'coldPass MUST NOT exist in measure_chrome_real.mjs');
  assert.ok(measureJs.includes("coldStatus = 'SEPARATED'"), 'Cold Start must be explicitly marked SEPARATED');
  assert.ok(!measureJs.includes('coldT2'), 'coldT2 must not be converted to benchmark metric');
});
