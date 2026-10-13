#!/usr/bin/env node
/**
 * tests/test_sync_status_view_lifecycle.mjs
 * H-App SyncStatusView Presentation Component Lifecycle Verification Suite
 * Wave 17 Target Architecture B'
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const syncStatusJsPath = path.join(REPO_ROOT, 'active/h-app/components/sync-status.js');
const appJsPath = path.join(REPO_ROOT, 'active/h-app/app.js');
const indexHtmlPath = path.join(REPO_ROOT, 'active/h-app/index.html');
const stampScriptPath = path.join(REPO_ROOT, 'scripts/stamp-h-app-token.mjs');

function createMockElement(id, initialClass = '', initialText = '') {
  const classes = new Set(initialClass ? initialClass.split(/\s+/).filter(Boolean) : []);
  return {
    id,
    textContent: initialText,
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val) {
      classes.clear();
      if (val) {
        val.split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      }
    },
    classList: {
      add(...tokens) {
        tokens.forEach(t => classes.add(t));
      },
      remove(...tokens) {
        tokens.forEach(t => classes.delete(t));
      },
      contains(token) {
        return classes.has(token);
      }
    }
  };
}

function createHarnessContext() {
  const elements = new Map();
  const statusEl = createMockElement('sync-status', 'w-2 h-2 bg-[#22c55e] rounded-full shadow-[0_0_8px_#22c55e] animate-soft-pulse transition-all duration-300');
  const textEl = createMockElement('sync-text', 'text-[8px] font-black uppercase tracking-[0.2em] text-[#22c55e] transition-all duration-300', 'ONLINE');

  elements.set('sync-status', statusEl);
  elements.set('sync-text', textEl);

  const sandbox = {
    document: {
      getElementById: (id) => elements.get(id) || null
    },
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };

  const context = vm.createContext(sandbox);
  const syncStatusCode = fs.readFileSync(syncStatusJsPath, 'utf8');
  vm.runInContext(syncStatusCode, context);

  return { context, elements, statusEl, textEl };
}

test('Gate 1: Exact Class & Text Parity (online)', () => {
  const { context, statusEl, textEl } = createHarnessContext();

  const res = context.window.SyncStatusView.setStatus('online');
  assert.equal(res, undefined, 'setStatus は同期実行で undefined を返すこと');

  assert.equal(
    statusEl.className,
    'w-2 h-2 rounded-full transition-all duration-300 bg-[#22c55e] shadow-[0_0_8px_#22c55e] animate-soft-pulse',
    'statusEl の className が厳密に元コードと一致すること'
  );
  assert.equal(textEl.textContent, 'ONLINE', 'textEl の textContent が ONLINE であること');
  assert.equal(
    textEl.className,
    'text-[8px] font-black uppercase tracking-[0.2em] transition-all duration-300 text-[#22c55e]',
    'textEl の className が厳密に元コードと一致すること'
  );
});

test('Gate 2: Exact Class & Text Parity (offline)', () => {
  const { context, statusEl, textEl } = createHarnessContext();

  context.window.SyncStatusView.setStatus('offline');

  assert.equal(
    statusEl.className,
    'w-2 h-2 rounded-full transition-all duration-300 bg-[#f59e0b] shadow-[0_0_8px_#f59e0b]',
    'statusEl の className が厳密に元コード(pulseなし)と一致すること'
  );
  assert.equal(textEl.textContent, 'OFFLINE', 'textEl の textContent が OFFLINE であること');
  assert.equal(
    textEl.className,
    'text-[8px] font-black uppercase tracking-[0.2em] transition-all duration-300 text-[#f59e0b]',
    'textEl の className が厳密に元コードと一致すること'
  );
});

test('Gate 3: Exact Class & Text Parity (syncing)', () => {
  const { context, statusEl, textEl } = createHarnessContext();

  context.window.SyncStatusView.setStatus('syncing');

  assert.equal(
    statusEl.className,
    'w-2 h-2 rounded-full transition-all duration-300 bg-[#2563eb] shadow-[0_0_8px_#2563eb] animate-pulse',
    'statusEl の className が厳密に元コードと一致すること'
  );
  assert.equal(textEl.textContent, 'SYNCING', 'textEl の textContent が SYNCING であること');
  assert.equal(
    textEl.className,
    'text-[8px] font-black uppercase tracking-[0.2em] transition-all duration-300 text-[#2563eb] animate-pulse',
    'textEl の className が厳密に元コードと一致すること'
  );
});

test('Gate 4: Unrecognized State Behavior', () => {
  const { context, statusEl, textEl } = createHarnessContext();
  textEl.textContent = 'PRESERVED_TEXT';

  context.window.SyncStatusView.setStatus('unknown_state');

  assert.equal(
    statusEl.className,
    'w-2 h-2 rounded-full transition-all duration-300',
    '未知の状態では初期化クラスのみが設定されること'
  );
  assert.equal(
    textEl.className,
    'text-[8px] font-black uppercase tracking-[0.2em] transition-all duration-300',
    '未知の状態では textEl に初期化クラスのみが設定されること'
  );
  assert.equal(
    textEl.textContent,
    'PRESERVED_TEXT',
    '未知の状態では textContent が変更されず維持されること'
  );
});

test('Gate 5: Null DOM Tolerance', () => {
  // Case A: statusEl is null
  const { context, elements, textEl } = createHarnessContext();
  elements.delete('sync-status');
  textEl.className = 'custom-text-class';
  textEl.textContent = 'ORIGINAL';

  assert.doesNotThrow(() => {
    context.window.SyncStatusView.setStatus('online');
  }, 'statusEl 欠損時に例外を投げないこと');
  assert.equal(textEl.className, 'custom-text-class', 'statusEl 欠損時は早期returnしてtextElに触れないこと');
  assert.equal(textEl.textContent, 'ORIGINAL', 'statusEl 欠損時はtextContentを維持すること');

  // Case B: statusEl exists but textEl is null
  const { context: ctxB, elements: elB, statusEl: stB } = createHarnessContext();
  elB.delete('sync-text');

  assert.doesNotThrow(() => {
    ctxB.window.SyncStatusView.setStatus('offline');
  }, 'textEl 欠損時に例外を投げないこと');
  assert.equal(
    stB.className,
    'w-2 h-2 rounded-full transition-all duration-300 bg-[#f59e0b] shadow-[0_0_8px_#f59e0b]',
    'textEl 欠損時でも statusEl は正常に更新されること'
  );
});

test('Gate 6: Wrapper Direct Delegation Parity', () => {
  const { context, statusEl, textEl } = createHarnessContext();
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');

  // app.js の setSyncStatus 関数のみを抽出して実体化
  const wrapperMatch = appJsCode.match(/function setSyncStatus\(state\)\s*\{[\s\S]*?^\}/m);
  assert.ok(wrapperMatch, 'app.js に function setSyncStatus(state) が存在すること');

  vm.runInContext(wrapperMatch[0], context);

  // app.js の setSyncStatus 経由で呼び出し
  context.setSyncStatus('online');
  assert.equal(statusEl.className, 'w-2 h-2 rounded-full transition-all duration-300 bg-[#22c55e] shadow-[0_0_8px_#22c55e] animate-soft-pulse');
  assert.equal(textEl.textContent, 'ONLINE');

  context.setSyncStatus('offline');
  assert.equal(statusEl.className, 'w-2 h-2 rounded-full transition-all duration-300 bg-[#f59e0b] shadow-[0_0_8px_#f59e0b]');
  assert.equal(textEl.textContent, 'OFFLINE');

  context.setSyncStatus('syncing');
  assert.equal(statusEl.className, 'w-2 h-2 rounded-full transition-all duration-300 bg-[#2563eb] shadow-[0_0_8px_#2563eb] animate-pulse');
  assert.equal(textEl.textContent, 'SYNCING');
});

test('Gate 7: Synchronous Execution & Self-Contained Guarantee', () => {
  const { context } = createHarnessContext();

  const ret = context.window.SyncStatusView.setStatus('online');
  assert.equal(ret, undefined, '戻り値は undefined であり Promise ではないこと');

  const syncStatusSource = fs.readFileSync(syncStatusJsPath, 'utf8');
  const codeWithoutComments = syncStatusSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  assert.ok(!codeWithoutComments.includes('async '), 'async キーワードを含まないこと');
  assert.ok(!codeWithoutComments.includes('await '), 'await キーワードを含まないこと');
  assert.ok(!codeWithoutComments.includes('Promise'), 'Promise を含まないこと');
  assert.ok(!codeWithoutComments.includes('setTimeout'), 'setTimeout を含まないこと');
  assert.ok(!codeWithoutComments.includes('setInterval'), 'setInterval を含まないこと');

  // 自己完結性: IIFE 内部で document.getElementById をラップし、外部 app.js の $ に依存していないこと
  assert.ok(syncStatusSource.includes('function $(id)'), '自己完結の $ ヘルパー関数を所有していること');
  assert.ok(syncStatusSource.includes('document.getElementById(id)'), 'document.getElementById を直接使用していること');
});

test('Gate 8: Static Source Integrity', () => {
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');
  const syncStatusCode = fs.readFileSync(syncStatusJsPath, 'utf8');

  // 1. app.js wrapper 検査
  const wrapperMatch = appJsCode.match(/function setSyncStatus\(state\)\s*\{([\s\S]*?)^\}/m);
  assert.ok(wrapperMatch, 'app.js に setSyncStatus 定義が存在すること');
  const wrapperBody = wrapperMatch[1].trim();
  assert.equal(
    wrapperBody,
    'window.SyncStatusView.setStatus(state);',
    'app.js wrapper は直接委譲のみであり、fallback やガードを含まないこと'
  );

  // 2. app.js に Presentation 定義が残存していないこと
  assert.ok(!appJsCode.includes("statusEl.classList.add('bg-[#22c55e]'"), 'app.js に online classList 付与が残存しないこと');
  assert.ok(!appJsCode.includes("statusEl.classList.add('bg-[#f59e0b]'"), 'app.js に offline classList 付与が残存しないこと');
  assert.ok(!appJsCode.includes("statusEl.classList.add('bg-[#2563eb]'"), 'app.js に syncing classList 付与が残存しないこと');

  // 3. components/sync-status.js 検査
  assert.ok(syncStatusCode.includes('window.SyncStatusView ='), 'window.SyncStatusView が公開されていること');
  assert.ok(syncStatusCode.includes("'ONLINE'"), 'components/sync-status.js に ONLINE 定義が存在すること');
  assert.ok(syncStatusCode.includes("'OFFLINE'"), 'components/sync-status.js に OFFLINE 定義が存在すること');
  assert.ok(syncStatusCode.includes("'SYNCING'"), 'components/sync-status.js に SYNCING 定義が存在すること');
});

test('Gate 9: Load Order & Token Allowlist Gate', () => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const stampSource = fs.readFileSync(stampScriptPath, 'utf8');

  // 1. ロード順序: components/ranking.js 直後に挿入され、app.js より前にロードされること
  const rankingPos = indexHtml.indexOf('./components/ranking.js');
  const syncStatusPos = indexHtml.indexOf('./components/sync-status.js');
  const appJsPos = indexHtml.indexOf('./app.js');

  assert.ok(rankingPos !== -1, 'index.html に components/ranking.js が存在すること');
  assert.ok(syncStatusPos !== -1, 'index.html に components/sync-status.js が存在すること');
  assert.ok(appJsPos !== -1, 'index.html に app.js が存在すること');

  assert.ok(
    rankingPos < syncStatusPos,
    'index.html で components/sync-status.js が components/ranking.js より後に位置すること'
  );
  assert.ok(
    syncStatusPos < appJsPos,
    'index.html で components/sync-status.js が app.js より物理的に前にロードされること'
  );

  // 2. stamp-h-app-token.mjs allowlist 登録検査
  assert.ok(
    stampSource.includes("'./components/sync-status.js'"),
    'stamp-h-app-token.mjs の REQUIRED_LOCAL_CODE_ASSETS に components/sync-status.js が登録されていること'
  );
});
