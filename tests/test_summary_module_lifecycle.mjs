import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const summaryModulePath = path.join(REPO_ROOT, 'active/h-app/modules/summary.js');
const summaryModuleCode = fs.readFileSync(summaryModulePath, 'utf8');

const appJsPath = path.join(REPO_ROOT, 'active/h-app/app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

function createIsolatedSummaryModule() {
  const sandbox = {
    console,
    module: { exports: {} }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(summaryModuleCode, context);
  return sandbox.module.exports;
}

// ----------------------------------------------------------------------------
// 1. Module Unit & Atomic Setters Verification
// ----------------------------------------------------------------------------
test('SummaryModule [Isolated VM]: Gate 1 - Initial State is null for data and promise', () => {
  const mod = createIsolatedSummaryModule();
  assert.equal(mod.getLastSummaryData(), null, 'Initial lastSummaryData must be null');
  assert.equal(mod.getSystemSummaryPromise(), null, 'Initial systemSummaryPromise must be null');
});

test('SummaryModule [Isolated VM]: Gate 2 - setLastSummaryData pure assignment & identity preservation', () => {
  const mod = createIsolatedSummaryModule();
  const sampleData = { success: true, done: 42, total: 100, districtName: 'KUWANA' };

  mod.setLastSummaryData(sampleData);
  assert.equal(mod.getLastSummaryData(), sampleData, 'Must preserve exact object reference identity');

  mod.setLastSummaryData(null);
  assert.equal(mod.getLastSummaryData(), null, 'Must allow reset to null');
});

test('SummaryModule [Isolated VM]: Gate 3 - setSystemSummaryPromise pure assignment & identity preservation', () => {
  const mod = createIsolatedSummaryModule();
  const samplePromise = Promise.resolve({ success: true });

  mod.setSystemSummaryPromise(samplePromise);
  assert.equal(mod.getSystemSummaryPromise(), samplePromise, 'Must preserve exact promise reference identity');

  mod.setSystemSummaryPromise(null);
  assert.equal(mod.getSystemSummaryPromise(), null, 'Must allow reset to null');
});

test('SummaryModule [Isolated VM]: Gate 4 - Zero Global Access (Pure Module Enforcement)', () => {
  const sandbox = {
    module: { exports: {} }
    // No window, globalThis, document, liff, etc.
  };
  const context = vm.createContext(sandbox);
  assert.doesNotThrow(() => {
    vm.runInContext(summaryModuleCode, context);
  }, 'SummaryModule must evaluate cleanly without any browser or Node globals');
});

// ----------------------------------------------------------------------------
// 2. Promise Lifecycle & Caller Semantics Simulation
// ----------------------------------------------------------------------------
function createHAppSummaryContext() {
  const summarySandbox = { module: { exports: {} } };
  vm.runInNewContext(summaryModuleCode, summarySandbox);
  const SummaryModule = summarySandbox.module.exports;

  let apiCallCount = 0;
  let apiPostHandler = async (action) => ({ success: true, done: 10 });
  const appCalls = [];

  const sandbox = {
    SummaryModule,
    callApiPost: async (action, payload) => {
      apiCallCount++;
      appCalls.push({ action, payload });
      return await apiPostHandler(action, payload);
    },
    updateStats: (data) => {},
    $: () => ({ textContent: '', classList: { add: () => {}, remove: () => {} } }),
    window: {},
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout,
    clearTimeout
  };

  const context = vm.createContext(sandbox);

  // Extract fetchSystemSummary definition from app.js
  const pStart = appJsCode.indexOf('async function fetchSystemSummary(');
  const pEnd = appJsCode.indexOf('/**\n * fetchTier1()');
  assert.ok(pStart !== -1 && pEnd !== -1 && pEnd > pStart, 'fetchSystemSummary slice must exist');
  const fetchFnCode = appJsCode.slice(pStart, pEnd);

  vm.runInContext(fetchFnCode, context);

  return {
    fetchSystemSummary: context.fetchSystemSummary,
    SummaryModule,
    getApiCallCount: () => apiCallCount,
    setApiPostHandler: (fn) => { apiPostHandler = fn; }
  };
}

test('Lifecycle & Contract: Gate 5 - caller / cached Promise semantics & zero API refire', async () => {
  const env = createHAppSummaryContext();
  const summaryPayload = { success: true, done: 25 };
  env.setApiPostHandler(async () => summaryPayload);

  const callerPromise1 = env.fetchSystemSummary();
  const cached1 = env.SummaryModule.getSystemSummaryPromise();
  const callerPromise2 = env.fetchSystemSummary();

  // Specification Check: async function creates a new outer promise on each call
  assert.notEqual(callerPromise1, cached1, 'callerPromise1 is outer async wrapper and !== cached1');
  assert.notEqual(callerPromise1, callerPromise2, 'callerPromise1 and callerPromise2 are distinct activation promises');

  // Internal SSOT Check: cached Promise was reused
  assert.equal(env.SummaryModule.getSystemSummaryPromise(), cached1, 'Cached promise in SummaryModule must be reused identically');

  // Zero API Refire Check
  assert.equal(env.getApiCallCount(), 1, 'API must only be fired once for cached calls');

  const [res1, res2] = await Promise.all([callerPromise1, callerPromise2]);
  assert.equal(res1, summaryPayload, 'callerPromise1 resolves to summaryPayload');
  assert.equal(res2, summaryPayload, 'callerPromise2 resolves to identical summaryPayload');
});

test('Lifecycle & Contract: Gate 6 - Success Path retains resolved Promise in cache', async () => {
  const env = createHAppSummaryContext();
  const res = await env.fetchSystemSummary();
  assert.ok(res && res.success);

  const cachedPromise = env.SummaryModule.getSystemSummaryPromise();
  assert.ok(cachedPromise !== null, 'Success path must retain resolved promise in cache');

  // Subsequent call without forceRefresh reuses retained resolved promise
  const cachedRes = await env.fetchSystemSummary(false);
  assert.equal(cachedRes, res, 'Subsequent call reuses cached resolved value');
  assert.equal(env.getApiCallCount(), 1, 'API call count remains 1');
});

test('Lifecycle & Contract: Gate 7 - Failure Path resets cache to null for ordinary error', async () => {
  const env = createHAppSummaryContext();
  env.setApiPostHandler(async () => {
    throw new Error('NETWORK_FAILURE');
  });

  const res = await env.fetchSystemSummary();
  assert.equal(res, null, 'Failure returns null');
  assert.equal(env.SummaryModule.getSystemSummaryPromise(), null, 'Failure path resets cache to null');
});

test('Lifecycle & Contract: Gate 8 - forceRefresh = true creates new Promise and overwrites cache', async () => {
  const env = createHAppSummaryContext();
  const res1 = await env.fetchSystemSummary();
  const promise1 = env.SummaryModule.getSystemSummaryPromise();

  // forceRefresh = true
  const callerPromise2 = env.fetchSystemSummary(true);
  const promise2 = env.SummaryModule.getSystemSummaryPromise();

  assert.notEqual(promise1, promise2, 'forceRefresh = true must overwrite cached promise');
  assert.equal(env.getApiCallCount(), 2, 'API must be called a second time');
  await callerPromise2;
});

test('Lifecycle & Contract: Gate 9 [Quirk Preserved] - forceRefresh overlap race clears cache on stale failure', async () => {
  const env = createHAppSummaryContext();

  let rejectA;
  let resolveB;

  // Setup staggered API responses
  let callNum = 0;
  env.setApiPostHandler(async () => {
    callNum++;
    if (callNum === 1) {
      return new Promise((_, reject) => { rejectA = reject; });
    } else {
      return new Promise(resolve => { resolveB = resolve; });
    }
  });

  // T0: Request A starts (in-flight)
  const callerA = env.fetchSystemSummary(false);
  const promiseA = env.SummaryModule.getSystemSummaryPromise();
  assert.ok(promiseA, 'Promise A is in-flight in cache');

  // T1: Request B starts with forceRefresh = true (overwrites cache)
  const callerB = env.fetchSystemSummary(true);
  const promiseB = env.SummaryModule.getSystemSummaryPromise();
  assert.notEqual(promiseA, promiseB, 'Promise B overwrote Promise A in cache');

  // T2: Request A fails while B is still in-flight
  rejectA(new Error('TIMEOUT_A'));
  await callerA; // A finishes failure path

  // T3: Baseline Quirk Check: Request A cleared SummaryModule cache to null!
  assert.equal(env.SummaryModule.getSystemSummaryPromise(), null, 'Baseline Quirk: Stale Request A failure clears shared in-flight cache to null');

  // T4: Request B finishes successfully
  resolveB({ success: true, done: 99 });
  const resB = await callerB;
  assert.equal(resB.done, 99, 'Request B resolves successfully');
});

// ----------------------------------------------------------------------------
// 3. Source Code Contract & Zero Fallback Machine Check
// ----------------------------------------------------------------------------
test('Source Integrity: Gate 10 - app.js uses direct delegation with zero production fallbacks', () => {
  assert.ok(!appJsCode.includes("typeof SummaryModule"), 'app.js must not contain typeof SummaryModule checks (Zero Production Fallback)');
  assert.ok(!appJsCode.includes("SummaryModule ?"), 'app.js must not contain ternary SummaryModule checks');
  assert.ok(!appJsCode.includes("let lastSummaryData"), 'app.js must not declare lastSummaryData');
  assert.ok(!appJsCode.includes("let _systemSummaryPromise"), 'app.js must not declare _systemSummaryPromise');

  assert.ok(appJsCode.includes("SummaryModule.setLastSummaryData("), 'app.js must delegate setLastSummaryData');
  assert.ok(appJsCode.includes("SummaryModule.getLastSummaryData()"), 'app.js must delegate getLastSummaryData');
  assert.ok(appJsCode.includes("SummaryModule.getSystemSummaryPromise()"), 'app.js must delegate getSystemSummaryPromise');
  assert.ok(appJsCode.includes("SummaryModule.setSystemSummaryPromise("), 'app.js must delegate setSystemSummaryPromise');
});
