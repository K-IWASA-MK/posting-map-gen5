import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const authModulePath = path.join(REPO_ROOT, 'active/h-app/modules/auth.js');
const authModuleCode = fs.readFileSync(authModulePath, 'utf8');

const appJsPath = path.join(REPO_ROOT, 'active/h-app/app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

function createIsolatedAuthModule(diProviders = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
    Object,
    Boolean,
    module: { exports: {} }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(authModuleCode, context);
  const AuthModule = sandbox.module.exports;
  AuthModule.configure(diProviders);
  return { AuthModule, sandbox, context };
}

test('AuthModule [Isolated VM]: Gate 1 - Initial State is PENDING and waitForLiffAuthReady waits', async () => {
  const { AuthModule } = createIsolatedAuthModule({
    getLiffAuthToken: () => null,
    isLiffLoggedIn: () => false
  });

  assert.equal(AuthModule.getAuthState(), 'PENDING', 'Initial auth state must be PENDING');
  assert.equal(AuthModule.getAuthError(), null, 'Initial auth error must be null');
  assert.equal(AuthModule.isLiffAuthReady(), false, 'isLiffAuthReady must be false when logged out');

  let resolved = false;
  const p = AuthModule.waitForLiffAuthReady().then(() => { resolved = true; });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(resolved, false, 'waitForLiffAuthReady must remain pending');

  AuthModule.markAuthReady();
  await p;
  assert.equal(resolved, true, 'waitForLiffAuthReady must resolve after markAuthReady');
});

test('AuthModule [Isolated VM]: Gate 2 - READY state immediately resolves when logged in with valid token', async () => {
  const { AuthModule } = createIsolatedAuthModule({
    getLiffAuthToken: () => 'valid_token_xyz',
    isLiffLoggedIn: () => true
  });

  assert.equal(AuthModule.isLiffAuthReady(), true, 'isLiffAuthReady must be true when logged in with valid token');
  const res = await AuthModule.waitForLiffAuthReady();
  assert.equal(res, true, 'waitForLiffAuthReady must resolve immediately with true');
});

test('AuthModule [Isolated VM]: Gate 3 - FAILED state immediately rejects with error', async () => {
  const { AuthModule } = createIsolatedAuthModule({
    getLiffAuthToken: () => null,
    isLiffLoggedIn: () => false
  });

  const customErr = Object.assign(new Error('CUSTOM_INIT_TIMEOUT'), { code: 'TIMEOUT' });
  AuthModule.markAuthFailed(customErr);

  assert.equal(AuthModule.getAuthState(), 'FAILED', 'State must be FAILED');
  assert.equal(AuthModule.getAuthError(), customErr, 'Auth error must be recorded');

  let caught = null;
  try {
    await AuthModule.waitForLiffAuthReady();
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, customErr, 'Must reject with recorded error');
});

test('AuthModule [Isolated VM]: Gate 4 - Token loss after READY throws LIFF_TOKEN_MISSING fail-closed', async () => {
  let token = 'initial_token';
  let loggedIn = true;
  const { AuthModule } = createIsolatedAuthModule({
    getLiffAuthToken: () => token,
    isLiffLoggedIn: () => loggedIn
  });

  AuthModule.markAuthReady();
  assert.equal(AuthModule.getAuthState(), 'READY');

  // Token vanishes / expires
  token = '';
  assert.equal(AuthModule.isLiffAuthReady(), false, 'Must be unready if token is empty');

  let caught = null;
  try {
    await AuthModule.waitForLiffAuthReady();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'Must reject on token loss');
  assert.equal(caught.message, 'LIFF_TOKEN_MISSING', 'Must throw LIFF_TOKEN_MISSING');
  assert.equal(caught.code, 'UNAUTHORIZED', 'Code must be UNAUTHORIZED');
  assert.equal(caught.retryable, false, 'Must not be retryable');
});

test('AuthModule [Isolated VM]: Gate 5 - Identity Atomic Setters & Boolean State', () => {
  const { AuthModule } = createIsolatedAuthModule();

  assert.equal(AuthModule.isIdentityVerified(), false, 'Identity must be initially unverified');

  AuthModule.setIdentityVerified(true);
  assert.equal(AuthModule.isIdentityVerified(), true, 'Must reflect true after setIdentityVerified(true)');

  AuthModule.setIdentityVerified(false);
  assert.equal(AuthModule.isIdentityVerified(), false, 'Must reflect false after setIdentityVerified(false)');
});

test('AuthModule [Isolated VM]: Gate 6 - in-flight Identity Promise synchronization', async () => {
  const { AuthModule } = createIsolatedAuthModule({
    getLiffAuthToken: () => 'token',
    isLiffLoggedIn: () => true
  });

  let resolveIdentity;
  const syncPromise = new Promise(resolve => { resolveIdentity = resolve; });

  AuthModule.setIdentitySyncPromise(syncPromise);
  assert.equal(AuthModule.getIdentitySyncPromise(), syncPromise, 'Must store in-flight promise');

  let waitFinished = false;
  let waitResult = null;
  const waitPromise = AuthModule.waitForIdentityVerified().then(r => {
    waitFinished = true;
    waitResult = r;
  });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(waitFinished, false, 'waitForIdentityVerified must wait for syncPromise');

  // Resolve sync promise and mark verified
  AuthModule.setIdentityVerified(true);
  resolveIdentity(true);
  await waitPromise;

  assert.equal(waitFinished, true, 'Must finish after sync promise resolves');
  assert.equal(waitResult, true, 'Must return true');
  assert.equal(AuthModule.isIdentityVerifiedReady(), true, 'isIdentityVerifiedReady must be true');
});

test('AuthModule [Isolated VM]: Gate 7 - Identity lastError retention and throwing', async () => {
  const { AuthModule } = createIsolatedAuthModule();

  let resolveIdentity;
  const syncPromise = new Promise(resolve => { resolveIdentity = resolve; });
  AuthModule.setIdentitySyncPromise(syncPromise);

  const errorObj = Object.assign(new Error('NETWORK_TIMEOUT'), { code: 'NETWORK_TIMEOUT', retryable: true });
  AuthModule.setIdentityLastError(errorObj);
  assert.equal(AuthModule.getIdentityLastError(), errorObj, 'Must store lastError');

  // Promise resolves, but identity remains unverified
  resolveIdentity(false);

  let caught = null;
  try {
    await AuthModule.waitForIdentityVerified();
  } catch (err) {
    caught = err;
  }

  assert.equal(caught, errorObj, 'Must throw retained _identityLastError');
});

test('AuthModule [Isolated VM]: Gate 8 - Zero Global Access (Pure DI Enforcement)', () => {
  const sandbox = {
    console,
    Promise,
    Error,
    module: { exports: {} }
    // Note: window, globalThis, liff, getLiffAuthToken are deliberately omitted
  };
  const context = vm.createContext(sandbox);
  assert.doesNotThrow(() => {
    vm.runInContext(authModuleCode, context);
  }, 'AuthModule must evaluate cleanly without window or globalThis');

  const AuthModule = sandbox.module.exports;
  assert.equal(AuthModule.isLiffAuthReady(), false, 'Defaults to false when unconfigured');
});

// ============================================================================
// PART 2: SOURCE ORDERING MACHINE VERIFICATION
// ============================================================================

test('Source Ordering [Machine Check]: safeInitApp identity sync statement sequence', () => {
  // In safeInitApp, AuthModule.setIdentityLastError(null) must precede callApiPost('getStaffIdentity')
  const safeInitAppIdx = appJsCode.indexOf('async function safeInitApp()');
  assert.ok(safeInitAppIdx !== -1, 'safeInitApp function must exist in app.js');

  const idxLastError = appJsCode.indexOf('AuthModule.setIdentityLastError(null);', safeInitAppIdx);
  assert.ok(idxLastError !== -1, 'AuthModule.setIdentityLastError(null) must exist in safeInitApp');

  const idxSyncPromise = appJsCode.indexOf('AuthModule.setIdentitySyncPromise(', idxLastError);
  assert.ok(idxSyncPromise !== -1, 'AuthModule.setIdentitySyncPromise must exist after setIdentityLastError');

  const idxCallApi = appJsCode.indexOf("callApiPost('getStaffIdentity'", idxSyncPromise);
  assert.ok(idxCallApi !== -1, "callApiPost('getStaffIdentity') must be evaluated inside setIdentitySyncPromise");

  // Verify strict ordering: idxLastError < idxSyncPromise < idxCallApi
  assert.ok(idxLastError < idxSyncPromise, 'setIdentityLastError(null) must strictly precede setIdentitySyncPromise');
  assert.ok(idxSyncPromise < idxCallApi, 'setIdentitySyncPromise wraps callApiPost');
});

test('Source Ordering [Machine Check]: retryIdentityVerification statement sequence', () => {
  const retryIdx = appJsCode.indexOf('window.retryIdentityVerification = function()');
  assert.ok(retryIdx !== -1, 'retryIdentityVerification function must exist in app.js');

  const idxLastError = appJsCode.indexOf('AuthModule.setIdentityLastError(null);', retryIdx);
  assert.ok(idxLastError !== -1, 'AuthModule.setIdentityLastError(null) must exist in retryIdentityVerification');

  const idxSyncPromise = appJsCode.indexOf('AuthModule.setIdentitySyncPromise(', idxLastError);
  assert.ok(idxSyncPromise !== -1, 'AuthModule.setIdentitySyncPromise must exist after setIdentityLastError');

  const idxCallApi = appJsCode.indexOf("callApiPost('getStaffIdentity'", idxSyncPromise);
  assert.ok(idxCallApi !== -1, "callApiPost('getStaffIdentity') must be evaluated inside setIdentitySyncPromise");

  assert.ok(idxLastError < idxSyncPromise, 'setIdentityLastError(null) must strictly precede setIdentitySyncPromise');
  assert.ok(idxSyncPromise < idxCallApi, 'setIdentitySyncPromise wraps callApiPost');
});
