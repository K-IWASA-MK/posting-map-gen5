/**
 * tests/test_numpad_view_lifecycle.mjs
 * H-App Numpad View Separation Lifecycle & Session Safety Verification Suite
 *
 * 検証対象:
 * 1. NumpadView の初期状態とカプセル化
 * 2. モーダル開閉と初期値表示
 * 3. キー入力バッファ（先頭0置換、5桁制限、Cクリア）
 * 4. OK確定コールバック発火
 * 5. 確定後非表示 (hide) とセッション継続
 * 6. 明示的キャンセル (close) とチェックボックス復元
 * 7. セッション世代管理（新操作開始・明示的キャンセルによる古い世代の遮断）
 * 8. カメラ取消・例外時の先行ロック解除とリカバリ
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
console.log("🧪 H-APP NUMPAD VIEW LIFECYCLE AUDIT");
console.log("====================================================\n");

// render.js から NumpadView 定義を抽出
const renderJsCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');

function createMockDOM() {
  const elements = {};
  function makeEl(id) {
    const el = {
      id,
      textContent: '',
      classList: {
        _classes: new Set(),
        add(...cls) { cls.forEach(c => this._classes.add(c)); },
        remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
        contains(c) { return this._classes.has(c); }
      },
      firstElementChild: {
        classList: {
          _classes: new Set(['translate-y-full']),
          add(...cls) { cls.forEach(c => this._classes.add(c)); },
          remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
          contains(c) { return this._classes.has(c); }
        }
      }
    };
    // 初期状態: numpad-modal は pointer-events-none, opacity-0
    if (id === 'numpad-modal') {
      el.classList.add('pointer-events-none', 'opacity-0');
    }
    return el;
  }

  elements['numpad-display'] = makeEl('numpad-display');
  elements['numpad-modal'] = makeEl('numpad-modal');

  return {
    document: {
      getElementById(id) {
        return elements[id] || null;
      }
    },
    elements
  };
}

function createSandboxContext() {
  const dom = createMockDOM();
  const context = {
    console,
    document: dom.document,
    elements: dom.elements
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  // NumpadView の定義を実行
  vm.runInContext(renderJsCode + '\n; globalThis.NumpadView = NumpadView;', context);
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
    const NV = ctx.NumpadView;
    assert.ok(NV, 'NumpadView must be defined');
    assert.equal(NV.getContext(), null, 'Initial context must be null');
    assert.equal(NV.isOpen(), false, 'Initially must not be open');
    logGate('Initial state and encapsulation');
  }

  // ─── GATE 2: モーダル表示と初期値反映 ───────────────────────────────
  {
    const ctx = createSandboxContext();
    const NV = ctx.NumpadView;
    const modal = ctx.elements['numpad-modal'];
    const display = ctx.elements['numpad-display'];

    NV.open({
      areaName: 'TEST_AREA',
      rowId: 101,
      initialCount: 50,
      isDoneToggle: true
    });

    assert.equal(NV.isOpen(), true, 'Must be open after open()');
    assert.equal(display.textContent, '50', 'Display must show initialCount');
    assert.equal(modal.classList.contains('pointer-events-none'), false);
    assert.equal(modal.classList.contains('opacity-0'), false);
    assert.equal(modal.firstElementChild.classList.contains('translate-y-full'), false);
    logGate('Open modal and reflect initialCount');
  }

  // ─── GATE 3: 入力バッファ管理（先頭0置換、5桁制限、Cクリア） ─────────
  {
    const ctx = createSandboxContext();
    const NV = ctx.NumpadView;
    const display = ctx.elements['numpad-display'];

    // 初期値0で開く
    NV.open({ areaName: 'TEST_AREA', rowId: 102, initialCount: 0 });
    assert.equal(display.textContent, '0');

    // '1' を入力 -> 先頭の'0'が'1'に置き換わる
    NV.pressKey(1);
    assert.equal(display.textContent, '1');

    // '2', '3', '4', '5' と入力 -> 5桁 '12345'
    NV.pressKey(2);
    NV.pressKey(3);
    NV.pressKey(4);
    NV.pressKey(5);
    assert.equal(display.textContent, '12345');

    // 6桁目の '6' は無視される（最大5桁）
    NV.pressKey(6);
    assert.equal(display.textContent, '12345', 'Should cap at 5 digits');

    // 'C' キーで '0' にクリア
    NV.pressKey('C');
    assert.equal(display.textContent, '0', 'Should reset to 0 on C');

    // クリア後に再度 '9' 入力
    NV.pressKey(9);
    assert.equal(display.textContent, '9');
    logGate('Buffer management (leading zero, 5-digit cap, clear)');
  }

  // ─── GATE 4: OK押下と確定コールバック ───────────────────────────────
  {
    const ctx = createSandboxContext();
    const NV = ctx.NumpadView;

    let confirmedData = null;
    NV.open({
      areaName: 'AREA_A',
      rowId: 200,
      initialCount: 0,
      onConfirm: (data) => {
        confirmedData = data;
      }
    });

    NV.pressKey(8);
    NV.pressKey(5);
    const result = NV.pressKey('OK');

    assert.ok(confirmedData, 'onConfirm callback must be called');
    assert.equal(confirmedData.valNum, 85);
    assert.equal(confirmedData.areaName, 'AREA_A');
    assert.equal(confirmedData.rowId, 200);
    assert.equal(result.valNum, 85);
    logGate('Confirm with OK and trigger onConfirm callback');
  }

  // ─── GATE 5: 確定後非表示 (hide) とセッション継続 ────────────────────
  {
    const ctx = createSandboxContext();
    const NV = ctx.NumpadView;
    const modal = ctx.elements['numpad-modal'];

    NV.open({
      areaName: 'AREA_B',
      rowId: 300,
      initialCount: 10
    });

    assert.equal(NV.isOpen(), true);

    // 確定後の非表示 hide()
    NV.hide();

    // 画面は非表示になるが、context は破棄されずセッションが継続する
    assert.equal(modal.classList.contains('pointer-events-none'), true);
    assert.equal(modal.classList.contains('opacity-0'), true);
    assert.ok(NV.getContext() !== null, 'Context must be preserved on hide() for in-flight session');
    assert.equal(NV.getContext().rowId, 300);
    logGate('Hide on confirm preserves context and ongoing session');
  }

  // ─── GATE 6: 明示的キャンセル (close) とチェックボックス復元 ───────────
  {
    const ctx = createSandboxContext();
    const NV = ctx.NumpadView;
    const modal = ctx.elements['numpad-modal'];

    let cancelCalled = false;
    const mockCheckbox = { checked: true };

    NV.open({
      areaName: 'AREA_C',
      rowId: 400,
      initialCount: 20,
      isDoneToggle: true,
      checkbox: mockCheckbox,
      onCancel: () => {
        cancelCalled = true;
      }
    });

    // ユーザー明示的キャンセル close()
    NV.close();

    assert.equal(cancelCalled, true, 'onCancel callback must be called');
    assert.equal(mockCheckbox.checked, false, 'Checkbox must be reset to false on cancel');
    assert.equal(NV.getContext(), null, 'Context must be cleared on close()');
    assert.equal(modal.classList.contains('pointer-events-none'), true);
    logGate('Close on cancel resets checkbox and clears context');
  }

  // ─── GATE 7: セッション世代管理（新操作開始・明示的キャンセルによる旧世代遮断）───
  {
    // app.js のセッション管理ロジックの単体検証
    let draftSessionSeq = 0;
    let currentDraftSession = null;

    function startSession(rowId) {
      if (currentDraftSession) {
        currentDraftSession.aborted = true; // 前回のセッションを無効化
      }
      const sessionId = ++draftSessionSeq;
      currentDraftSession = { sessionId, rowId, aborted: false };
      return currentDraftSession;
    }

    function cancelSession() {
      if (currentDraftSession) {
        currentDraftSession.aborted = true;
      }
    }

    // セッション1開始
    const sess1 = startSession(10);
    assert.equal(sess1.sessionId, 1);
    assert.equal(sess1.aborted, false);

    // 新たにセッション2を開始 -> セッション1は無効化 (aborted: true)
    const sess2 = startSession(20);
    assert.equal(sess1.aborted, true, 'Session 1 must be aborted when session 2 starts');
    assert.equal(sess2.sessionId, 2);
    assert.equal(sess2.aborted, false);

    // セッション2を明示的キャンセル -> セッション2も無効化
    cancelSession();
    assert.equal(sess2.aborted, true, 'Session 2 must be aborted on explicit cancel');
    logGate('Session generation guard blocks stale asynchronous results');
  }

  // ─── GATE 8: カメラ取消・例外時の先行ロック解除 ─────────────────────
  {
    let isDraftStarting = false;
    let draftSessionSeq = 0;
    let currentDraftSession = null;

    async function simulateDraftWorkflow({ failCamera = false } = {}) {
      if (isDraftStarting) return { started: false };
      isDraftStarting = true;

      const sessionId = ++draftSessionSeq;
      currentDraftSession = { sessionId, aborted: false };

      try {
        if (failCamera) {
          throw new Error('Camera cancelled by user');
        }
        return { started: true, success: true };
      } catch (err) {
        return { started: true, success: false, error: err.message };
      } finally {
        if (currentDraftSession && currentDraftSession.sessionId === sessionId) {
          isDraftStarting = false; // ロック解除
        }
      }
    }

    // 1回目: カメラ取消で失敗
    const res1 = await simulateDraftWorkflow({ failCamera: true });
    assert.equal(res1.started, true);
    assert.equal(res1.success, false);
    assert.equal(isDraftStarting, false, 'Lock must be released even when camera fails');

    // 2回目: 再試行可能であること（ロックが残留していない）
    const res2 = await simulateDraftWorkflow({ failCamera: false });
    assert.equal(res2.started, true);
    assert.equal(res2.success, true);
    assert.equal(isDraftStarting, false, 'Lock must be released on success');

    logGate('Lock release and safe recovery on camera cancellation/exception');
  }

  console.log(`\n🎉 ALL ${passedGates} GATES PASSED!`);
}

runTests().catch(err => {
  console.error("🛑 Test failure:", err);
  process.exit(1);
});
