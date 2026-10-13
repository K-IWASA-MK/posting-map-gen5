/**
 * tests/test_bulletin_post_contact_lifecycle.mjs
 * 
 * Wave 11: 掲示板投稿および連絡ダイアログのライフサイクル・分離前後動作一致検証
 * 全18ゲート (DOM変化順・API呼出順・通知順・認可判定位置・再取得タイミング完全照合)
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
    const classes = new Set();
    this.classList = {
      add: (...tokens) => tokens.forEach(t => classes.add(t)),
      remove: (...tokens) => tokens.forEach(t => classes.delete(t)),
      contains: (token) => classes.has(token),
      has: (token) => classes.has(token)
    };
    this.children = [];
    this.parentNode = null;
    this._eventListeners = {};
    this._checked = false;
    this.placeholder = '';
  }

  get checked() {
    return this._checked;
  }

  set checked(val) {
    this._checked = !!val;
  }

  addEventListener(event, handler) {
    if (!this._eventListeners[event]) {
      this._eventListeners[event] = [];
    }
    this._eventListeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (!this._eventListeners[event]) return;
    this._eventListeners[event] = this._eventListeners[event].filter(h => h !== handler);
  }

  dispatchEvent(eventObj) {
    const handlers = this._eventListeners[eventObj.type] || [];
    for (const h of handlers) {
      h(eventObj);
    }
  }

  focus() {
    this._focused = true;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault: () => {} });
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function matches(el, selector) {
  if (selector.startsWith('#')) {
    return el.id === selector.substring(1);
  }
  if (selector.startsWith('.')) {
    return el.classList.has(selector.substring(1));
  }
  if (selector.startsWith('input[name="') && selector.endsWith('"]')) {
    const name = selector.substring('input[name="'.length, selector.length - 2);
    return el.tagName === 'INPUT' && el.name === name;
  }
  if (selector.startsWith('input[name="') && selector.includes('"]:checked')) {
    const name = selector.substring('input[name="'.length, selector.indexOf('"]:checked'));
    return el.tagName === 'INPUT' && el.name === name && el.checked;
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function parseHtmlIntoNode(html, parentNode) {
  const inputRegex = /<input\s+([^>]+)>/gi;
  let match;
  while ((match = inputRegex.exec(html)) !== null) {
    const attrs = match[1];
    const input = new MockElement('', 'input');
    const idMatch = attrs.match(/id="([^"]+)"/);
    if (idMatch) input.id = idMatch[1];
    const typeMatch = attrs.match(/type="([^"]+)"/);
    if (typeMatch) input.type = typeMatch[1];
    const nameMatch = attrs.match(/name="([^"]+)"/);
    if (nameMatch) input.name = nameMatch[1];
    const valMatch = attrs.match(/value="([^"]+)"/);
    if (valMatch) input.value = valMatch[1];
    if (attrs.includes('checked')) input.checked = true;
    const phMatch = attrs.match(/placeholder="([^"]+)"/);
    if (phMatch) input.placeholder = phMatch[1];
    parentNode.appendChild(input);
  }

  const btnRegex = /<button\s+([^>]+)>([\s\S]*?)<\/button>/gi;
  while ((match = btnRegex.exec(html)) !== null) {
    const attrs = match[1];
    const text = match[2].trim();
    const btn = new MockElement('', 'button');
    const idMatch = attrs.match(/id="([^"]+)"/);
    if (idMatch) btn.id = idMatch[1];
    btn.textContent = text;
    parentNode.appendChild(btn);
  }
}

function createTestEnvironment(customApiHandler = null) {
  const elements = new Map();
  const body = new MockElement('body', 'body');

  function getElementById(id) {
    if (elements.has(id)) return elements.get(id);
    const search = (node) => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(body);
  }

  function querySelectorAll(selector) {
    const all = [];
    for (const el of elements.values()) {
      if (matches(el, selector)) all.push(el);
    }
    const fromBody = body.querySelectorAll(selector);
    for (const b of fromBody) {
      if (!all.includes(b)) all.push(b);
    }
    return all;
  }

  function querySelector(selector) {
    return querySelectorAll(selector)[0] || null;
  }

  const mockStorage = new Map();
  const localStorage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k),
    clear: () => mockStorage.clear()
  };

  const alerts = [];
  const alert = (msg) => alerts.push(msg);

  const apiCalls = [];
  const defaultApiHandler = async (action, payload) => {
    if (action === 'createBulletinPost') {
      return { success: true, message: 'OK' };
    }
    if (action === 'sendBulletinContact') {
      return { success: true, status: 'SENT', message: 'OK' };
    }
    return { success: true };
  };

  const callApiPost = async (action, payload) => {
    apiCalls.push({ action, payload });
    if (typeof customApiHandler === 'function') {
      return await customApiHandler(action, payload);
    }
    return await defaultApiHandler(action, payload);
  };

  const sandbox = {
    document: {
      getElementById,
      querySelector,
      querySelectorAll,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
      createElement: (tagName) => {
        const el = new MockElement('', tagName);
        let innerHtmlVal = '';
        Object.defineProperty(el, 'innerHTML', {
          get: () => innerHtmlVal,
          set: (val) => {
            innerHtmlVal = val;
            parseHtmlIntoNode(val, el);
          }
        });
        return el;
      },
      body
    },
    $: getElementById,
    escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    localStorage,
    alert,
    alerts,
    callApiPost,
    apiCalls,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    waitForIdentityVerified: async () => true,
    setQueueLifecycleGates: () => {}
  };

  sandbox.window = sandbox;
  sandbox.elements = elements;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};

  vm.createContext(sandbox);

  // bulletin.js ロード
  const bulletinCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/bulletin.js'), 'utf8');
  vm.runInContext(bulletinCode + '\n; globalThis.BulletinModule = BulletinModule;', sandbox);

  // render.js ロード
  const renderCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
  vm.runInContext(renderCode + '\n; globalThis.BulletinView = BulletinView;', sandbox);

  // app.js ロード
  const appCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/app.js'), 'utf8');
  vm.runInContext(appCode, sandbox);

  return { sandbox, elements, body, alerts, apiCalls, localStorage };
}

async function runTests() {
  console.log('--- Wave 11: Bulletin Post & Contact Lifecycle Tests (18 Gates) ---');

  // Gate 1: updateCharCount (0, 149, 150, 151)
  {
    const { sandbox } = createTestEnvironment();
    const counter = new MockElement('bulletin-char-counter', 'span');
    sandbox.elements.set('bulletin-char-counter', counter);

    const textarea = new MockElement('bulletin-message-input', 'textarea');
    
    textarea.value = '';
    sandbox.BulletinView.updateCharCount(textarea);
    assert.equal(counter.textContent, '0 / 150');
    assert.equal(counter.classList.has('text-red-400'), false);
    assert.equal(counter.classList.has('text-white/40'), true);

    textarea.value = 'a'.repeat(149);
    sandbox.BulletinView.updateCharCount(textarea);
    assert.equal(counter.textContent, '149 / 150');
    assert.equal(counter.classList.has('text-red-400'), false);
    assert.equal(counter.classList.has('text-white/40'), true);

    textarea.value = 'a'.repeat(150);
    sandbox.BulletinView.updateCharCount(textarea);
    assert.equal(counter.textContent, '150 / 150');
    assert.equal(counter.classList.has('text-red-400'), true);
    assert.equal(counter.classList.has('text-white/40'), false);

    textarea.value = 'a'.repeat(151);
    sandbox.BulletinView.updateCharCount(textarea);
    assert.equal(counter.textContent, '151 / 150');
    assert.equal(counter.classList.has('text-red-400'), true);
    assert.equal(counter.classList.has('text-white/40'), false);

    console.log('✓ Gate 1: updateCharCount correctly updates count and toggles CSS classes (>= 150)');
  }

  // Gate 2: submitPost validation empty
  {
    const { sandbox, alerts, apiCalls } = createTestEnvironment();
    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = '   ';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';
    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => ({ id: 'S1', name: 'スタッフ' }),
      authorize: async () => true
    });
    assert.equal(apiCalls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], 'メッセージを入力してください。');
    assert.equal(inputEl._focused, true);
    assert.equal(btn.textContent, '投稿する');
    assert.equal(btn.disabled, false);

    console.log('✓ Gate 2: submitPost empty validation blocks API, alerts, and focuses input');
  }

  // Gate 3: submitPost validation too long (> 150)
  {
    const { sandbox, alerts, apiCalls } = createTestEnvironment();
    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = 'a'.repeat(151);
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';
    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => ({ id: 'S1', name: 'スタッフ' }),
      authorize: async () => true
    });
    assert.equal(apiCalls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], 'メッセージは150文字以内で入力してください。');

    console.log('✓ Gate 3: submitPost > 150 validation blocks API and alerts');
  }

  // Gate 4: submitPost staffId missing (read before authorization)
  {
    const { sandbox, alerts, apiCalls } = createTestEnvironment();
    let authCalled = false;

    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = 'テスト投稿';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';
    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => ({ id: '', name: '' }),
      authorize: async () => { authCalled = true; return true; }
    });
    assert.equal(authCalled, false);
    assert.equal(apiCalls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '配布員IDが取得できませんでした。');

    console.log('✓ Gate 4: submitPost missing staffId checked before authorization blocks API and alerts');
  }

  // Gate 5: submitPost authorization failure
  {
    const { sandbox, alerts, apiCalls } = createTestEnvironment();

    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = 'テスト投稿';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';
    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => ({ id: 'STAFF_01', name: '山田 太郎' }),
      authorize: async () => { throw new Error('AUTH_FAILED'); }
    });
    assert.equal(apiCalls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '本人確認が完了していないため投稿できません。');
    assert.equal(btn.textContent, '投稿する');
    assert.equal(btn.disabled, false);

    console.log('✓ Gate 5: submitPost authorization rejection alerts and restores button state without API call');
  }

  // Gate 6: submitPost success lifecycle (DOM変化順・API呼出順・通知順・再取得順序)
  {
    const eventSequence = [];
    const customApi = async (action, payload) => {
      eventSequence.push(`api:${action}`);
      if (action === 'createBulletinPost') return { success: true };
      if (action === 'getBulletinPosts') return { success: true, posts: [] };
      return { success: true };
    };

    const { sandbox, alerts, elements } = createTestEnvironment(customApi);
    sandbox.alert = (msg) => {
      eventSequence.push(`alert:${msg}`);
      alerts.push(msg);
    };

    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = '晴天のため配布再開します';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';
    const counter = new MockElement('bulletin-char-counter', 'span');
    counter.textContent = '12 / 150';

    elements.set('bulletin-message-input', inputEl);
    elements.set('btn-bulletin-submit', btn);
    elements.set('bulletin-char-counter', counter);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => {
        eventSequence.push('getStaffInfo');
        return { id: 'STAFF_01', name: '山田 太郎' };
      },
      authorize: async () => {
        eventSequence.push(`btnText:${btn.textContent}`);
        eventSequence.push(`btnDisabled:${btn.disabled}`);
        eventSequence.push('authorize');
        return true;
      },
      refreshPosts: () => {
        eventSequence.push('refreshPosts');
        sandbox.BulletinModule.fetchPosts({ force: true });
      }
    });

    // 順序の完全照合
    assert.deepEqual(eventSequence, [
      'getStaffInfo',
      'btnText:投稿中...',
      'btnDisabled:true',
      'authorize',
      'api:createBulletinPost',
      'alert:✓ 投稿が完了しました',
      'refreshPosts',
      'api:getBulletinPosts'
    ]);

    assert.equal(inputEl.value, '');
    assert.equal(counter.textContent, '0 / 150');
    assert.equal(btn.textContent, '投稿する');
    assert.equal(btn.disabled, false);

    console.log('✓ Gate 6: submitPost matches exact sequence: staffInfo -> btnSubmitting -> authorize -> API -> alert -> refreshPosts -> btnRestored');
  }

  // Gate 7: submitPost API failure response
  {
    const customApi = async () => ({ success: false, message: 'Server rejection reason' });
    const { sandbox, alerts, apiCalls } = createTestEnvironment(customApi);

    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = '入力キープ確認';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';

    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => ({ id: 'STAFF_01', name: '山田 太郎' }),
      authorize: async () => true,
      refreshPosts: () => { throw new Error('SHOULD_NOT_REFRESH'); }
    });

    assert.equal(apiCalls.length, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '投稿に失敗しました: Server rejection reason');
    assert.equal(inputEl.value, '入力キープ確認');
    assert.equal(btn.textContent, '投稿する');
    assert.equal(btn.disabled, false);

    console.log('✓ Gate 7: submitPost API failure keeps input, alerts failure message, does not refresh, and restores button');
  }

  // Gate 8: submitPost network throw
  {
    const customApi = async () => { throw new Error('NETWORK_DOWN'); };
    const { sandbox, alerts } = createTestEnvironment(customApi);

    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = '例外時キープ';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';

    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.BulletinView.submitPost({
      getStaffInfo: () => ({ id: 'STAFF_01', name: '山田 太郎' }),
      authorize: async () => true
    });

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '通信エラー: NETWORK_DOWN');
    assert.equal(inputEl.value, '例外時キープ');
    assert.equal(btn.textContent, '投稿する');
    assert.equal(btn.disabled, false);

    console.log('✓ Gate 8: submitPost network error alerts通信エラー, keeps input, and restores button');
  }

  // Gate 9: openContactDialog DOM, placeholder change, cancel, and closeContactDialog
  {
    const { sandbox } = createTestEnvironment();
    sandbox.BulletinView.openContactDialog('STAFF_99', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U1', requestId: 'req_1' })
    });

    const overlay = sandbox.document.getElementById('dynamic-bulletin-contact-dialog');
    assert.notEqual(overlay, null);
    assert.equal(overlay.innerHTML.includes('STAFF_99さんとの'), true);
    assert.equal(overlay.innerHTML.includes('連絡'), true);

    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    assert.notEqual(contactInput, null);
    assert.equal(contactInput.placeholder, 'LINE ID');

    // ラジオボタン切替 (電話)
    const radios = sandbox.document.querySelectorAll('input[name="bulletin-contact-method"]');
    const phoneRadio = radios.find(r => r.value === '電話');
    assert.notEqual(phoneRadio, undefined);
    phoneRadio.dispatchEvent({ type: 'change', target: { value: '電話' } });
    assert.equal(contactInput.placeholder, '電話番号');

    // キャンセルボタンでDOM削除
    const cancelBtn = sandbox.document.getElementById('btn-bulletin-contact-cancel');
    assert.notEqual(cancelBtn, null);
    cancelBtn.click();
    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);

    // 再度開いて closeContactDialog() でDOM削除
    sandbox.BulletinView.openContactDialog('STAFF_99', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U1', requestId: 'req_1' })
    });
    assert.notEqual(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    sandbox.BulletinView.closeContactDialog();
    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);

    console.log('✓ Gate 9: openContactDialog creates dialog, updates placeholders on radio change, and closes on cancel / closeContactDialog');
  }

  // Gate 10: contactDialog validation empty
  {
    const { sandbox, alerts, apiCalls } = createTestEnvironment();
    sandbox.BulletinView.openContactDialog('STAFF_88', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U1', requestId: 'req_1' })
    });

    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');
    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = '   ';

    submitBtn.click();
    assert.equal(apiCalls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '連絡先を入力してください。');
    assert.equal(contactInput._focused, true);

    sandbox.BulletinView.closeContactDialog();
    console.log('✓ Gate 10: contactDialog empty input alerts, focuses input, and blocks API');
  }

  // Gate 11: contactDialog authorization failure
  {
    const { sandbox, alerts, apiCalls } = createTestEnvironment();
    let ctxCalled = false;
    sandbox.BulletinView.openContactDialog('STAFF_88', {
      authorize: async () => { throw new Error('AUTH_FAIL'); },
      getRequestContext: () => { ctxCalled = true; return { requestUserId: 'U1', requestId: 'req_1' }; }
    });

    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');
    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = '09012345678';

    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.equal(ctxCalled, false); // 認可失敗時は getRequestContext を呼ばない（元コードと同一）
    assert.equal(apiCalls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '本人確認が完了していないため連絡を送信できません。');
    assert.equal(submitBtn.textContent, '連絡する');
    assert.equal(submitBtn.disabled, false);

    sandbox.BulletinView.closeContactDialog();
    console.log('✓ Gate 11: contactDialog authorization rejection alerts, does not call getRequestContext, and restores button');
  }

  // Gate 12: contactDialog submission in-flight guard (let isSubmittingContact = false)
  {
    let resolveApi;
    const slowApi = () => new Promise(res => { resolveApi = res; });
    const { sandbox, apiCalls } = createTestEnvironment(slowApi);

    sandbox.BulletinView.openContactDialog('STAFF_88', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U1', requestId: 'req_1' })
    });

    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');
    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = 'test_line_id';

    // 1回目のクリック
    submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.equal(submitBtn.textContent, '連絡中...');
    assert.equal(submitBtn.disabled, true);

    // 2回目のクリック (通信中)
    submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    // API呼出しは1回のみ
    assert.equal(apiCalls.length, 1);

    // API完了
    resolveApi({ success: true, status: 'SENT' });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    console.log('✓ Gate 12: contactDialog prevents multiple concurrent submissions while in-flight');
  }

  // Gate 13: contactDialog successful send (DOM変化順・認可後コンテキスト解決・API発行・削除・通知)
  {
    const eventSequence = [];
    const customApi = async (action, payload) => {
      eventSequence.push(`api:${action}`);
      return { success: true, status: 'SENT' };
    };

    const { sandbox, alerts } = createTestEnvironment(customApi);
    sandbox.alert = (msg) => {
      eventSequence.push(`alert:${msg}`);
      alerts.push(msg);
    };

    sandbox.BulletinView.openContactDialog('TARGET_001', {
      authorize: async () => {
        const btn = sandbox.document.getElementById('btn-bulletin-contact-submit');
        eventSequence.push(`btnText:${btn.textContent}`);
        eventSequence.push(`btnDisabled:${btn.disabled}`);
        eventSequence.push('authorize');
        return true;
      },
      getRequestContext: () => {
        eventSequence.push('getRequestContext');
        return { requestUserId: 'MY_ID_7', requestId: 'req_bc_123' };
      }
    });

    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = 'line_id_abc';
    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');

    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.deepEqual(eventSequence, [
      'btnText:連絡中...',
      'btnDisabled:true',
      'authorize',
      'getRequestContext',
      'api:sendBulletinContact',
      'alert:✓ 連絡を送信しました'
    ]);

    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    console.log('✓ Gate 13: contactDialog success matches exact sequence: btnSubmitting -> authorize -> getRequestContext -> API -> removeDialog -> alert');
  }

  // Gate 14: contactDialog UNKNOWN status response
  {
    const customApi = async () => ({ success: true, status: 'UNKNOWN' });
    const { sandbox, alerts } = createTestEnvironment(customApi);

    sandbox.BulletinView.openContactDialog('TARGET_002', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U2', requestId: 'req_2' })
    });

    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = 'line_id_xyz';
    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');

    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].includes('送信結果を確認できませんでした'), true);

    console.log('✓ Gate 14: contactDialog UNKNOWN status closes dialog and shows warning alert');
  }

  // Gate 15: contactDialog failed response
  {
    const customApi = async () => ({ success: false, status: 'FAILED', message: 'Target not found' });
    const { sandbox, alerts } = createTestEnvironment(customApi);

    sandbox.BulletinView.openContactDialog('TARGET_003', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U3', requestId: 'req_3' })
    });

    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = 'phone_090';
    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');

    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '連絡の送信に失敗しました: Target not found');

    console.log('✓ Gate 15: contactDialog failure response closes dialog and shows failure alert');
  }

  // Gate 16: contactDialog network exception
  {
    let shouldFail = true;
    const customApi = async (action, payload) => {
      if (shouldFail) {
        throw new Error('SOCKET_TIMEOUT');
      }
      return { success: true, status: 'SENT' };
    };
    const { sandbox, alerts, apiCalls } = createTestEnvironment(customApi);

    sandbox.BulletinView.openContactDialog('TARGET_004', {
      authorize: async () => true,
      getRequestContext: () => ({ requestUserId: 'U4', requestId: 'req_4' })
    });

    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = 'retry_target';
    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');

    // 1回目 (例外)
    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.notEqual(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], '通信エラー: SOCKET_TIMEOUT');
    assert.equal(submitBtn.textContent, '連絡する');
    assert.equal(submitBtn.disabled, false);

    // 再試行
    shouldFail = false;
    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.equal(apiCalls.length, 2);
    assert.equal(sandbox.document.getElementById('dynamic-bulletin-contact-dialog'), null);
    assert.equal(alerts[1], '✓ 連絡を送信しました');

    console.log('✓ Gate 16: contactDialog network throw keeps dialog open, restores button, and allows retry');
  }

  // Gate 17: BulletinModule.createPost & BulletinModule.sendContact
  {
    const { sandbox, apiCalls } = createTestEnvironment();
    
    // createPost
    const postRes = await sandbox.BulletinModule.createPost({
      staffId: 'S1',
      staffName: 'Name1',
      message: 'Hello'
    });
    assert.equal(postRes.success, true);
    assert.equal(apiCalls[0].action, 'createBulletinPost');

    // sendContact
    const contactRes = await sandbox.BulletinModule.sendContact({
      requestId: 'req_1',
      requestUserId: 'U1',
      targetStaffId: 'T1',
      contactMethod: 'LINE',
      contactValue: 'val_1'
    });
    assert.equal(contactRes.success, true);
    assert.equal(apiCalls[1].action, 'sendBulletinContact');

    console.log('✓ Gate 17: BulletinModule exposes pure createPost and sendContact without internal locks');
  }

  // Gate 18: app.js wrappers pass getStaffInfo, authorize, refreshPosts, and getRequestContext cleanly
  {
    const { sandbox, apiCalls, localStorage } = createTestEnvironment();
    localStorage.setItem('user_info', JSON.stringify({ id: 'WRAPPER_USER', first: '一郎', last: '鈴木' }));

    let idVerifiedCalled = false;
    sandbox.waitForIdentityVerified = async () => {
      idVerifiedCalled = true;
      return true;
    };

    const inputEl = new MockElement('bulletin-message-input', 'textarea');
    inputEl.value = 'ラッパーテスト';
    const btn = new MockElement('btn-bulletin-submit', 'button');
    btn.textContent = '投稿する';
    sandbox.elements.set('bulletin-message-input', inputEl);
    sandbox.elements.set('btn-bulletin-submit', btn);

    await sandbox.submitBulletinPost();
    assert.equal(idVerifiedCalled, true);
    assert.equal(apiCalls.length, 2);
    assert.equal(apiCalls[0].action, 'createBulletinPost');
    assert.equal(apiCalls[0].payload.staffId, 'WRAPPER_USER');
    assert.equal(apiCalls[0].payload.staffName, '鈴木 一郎');
    assert.equal(apiCalls[1].action, 'getBulletinPosts');

    // openBulletinContactDialog
    idVerifiedCalled = false;
    sandbox.openBulletinContactDialog('T_STAFF');
    const submitBtn = sandbox.document.getElementById('btn-bulletin-contact-submit');
    const contactInput = sandbox.document.getElementById('bulletin-contact-value');
    contactInput.value = 'line_val';

    await submitBtn.click();
    await new Promise(r => setTimeout(r, 10));

    assert.equal(idVerifiedCalled, true);
    assert.equal(apiCalls.length, 3);
    assert.equal(apiCalls[2].action, 'sendBulletinContact');
    assert.equal(apiCalls[2].payload.requestUserId, 'WRAPPER_USER');
    assert.equal(typeof apiCalls[2].payload.requestId, 'string');

    console.log('✓ Gate 18: app.js thin wrappers wire authorize, getStaffInfo, refreshPosts, and getRequestContext matching original timings');
  }

  console.log('\n--- ALL 18 GATES PASSED SUCCESSFULLY ---');
}

runTests().catch(err => {
  console.error('\n❌ Test Failure:', err);
  process.exit(1);
});
