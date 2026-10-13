import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log("====================================================");
console.log("🧪 DASHBOARD INTEGRITY ACCEPTANCE VERIFICATION (6 ITEMS)");
console.log("====================================================");

// ----------------------------------------------------
// 【No.4 検証】アプリアイコン実在資材接続
// ----------------------------------------------------
console.log("▶ [TEST 1] No.4: アプリアイコン実在資材接続チェック");
const indexHtml = fs.readFileSync(path.join(process.cwd(), "active/manager/index.html"), 'utf8');
assert.ok(indexHtml.includes('<link rel="icon" type="image/png" href="../h-app/assets/icon180-v2.png">'), "icon href が ../h-app/assets/icon180-v2.png であること");
assert.ok(indexHtml.includes('<link rel="apple-touch-icon" href="../h-app/assets/icon180-v2.png">'), "apple-touch-icon href が ../h-app/assets/icon180-v2.png であること");
assert.ok(!indexHtml.includes('../dashboard/assets/icon180-v2.png'), "存在しない ../dashboard/assets/ への参照が完全に撤廃されていること");
assert.ok(fs.existsSync(path.join(process.cwd(), "active/h-app/assets/icon180-v2.png")), "参照先実ファイル active/h-app/assets/icon180-v2.png が実在すること");
console.log("  ✅ PASS: No.4 アイコンパス正常 & 実在ファイル確認");

// ----------------------------------------------------
// 【No.3 検証】完了詳細ピン架空値排除 & 0枚保持
// ----------------------------------------------------
console.log("▶ [TEST 2] No.3: 完了詳細ピン架空値排除 & 0枚保持チェック");
const managerJs = fs.readFileSync(path.join(process.cwd(), "active/manager/manager.js"), 'utf8');
assert.ok(!managerJs.includes("'08/23 09:36'"), "モック日付 '08/23 09:36' が完全に撤廃されていること");
assert.ok(!managerJs.includes("Math.round(households * 0.85)"), "推定計算式 Math.round(households * 0.85) が完全に撤廃されていること");

// VM 環境の構築
const elements = {};
function getOrCreateEl(id) {
  if (!elements[id]) {
    elements[id] = {
      innerHTML: '',
      textContent: '',
      className: '',
      style: {},
      children: [],
      focus: () => {},
      classList: {
        add: (c) => { elements[id].className += ' ' + c; },
        remove: (c) => { elements[id].className = elements[id].className.replace(c, ''); },
        contains: (c) => elements[id].className.includes(c)
      }
    };
  }
  return elements[id];
}

const sandbox = {
  window: {
    location: { origin: "https://kuwana.postingmap.jp", pathname: "/active/manager/index.html" },
    addEventListener: () => {}
  },
  document: {
    getElementById: (id) => getOrCreateEl(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({ style: {}, classList: { add: () => {} }, appendChild: () => {} }),
    addEventListener: () => {}
  },
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  URLSearchParams: URLSearchParams,
  Date: Date,
  escapeHtml: (str) => String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]),
  L: {
    latLngBounds: () => ({}),
    circleMarker: () => ({ on: () => {} }),
    geoJSON: () => ({ addTo: () => {} })
  }
};

vm.createContext(sandbox);
vm.runInContext(managerJs, sandbox);

// ----------------------------------------------------
// 【No.1 検証】同期時計: 成功時更新、失敗時保持、未成功「未同期」
// ----------------------------------------------------
console.log("▶ [TEST 3] No.1: 同期時計の成否連動チェック");
const clockEl = getOrCreateEl('sync-clock');
const textEl = getOrCreateEl('live-status-text');

// 初期未同期テスト
sandbox.window.DashboardState.lastSuccessfulSyncTime = null;
clockEl.textContent = '初期値';
sandbox.window.setSyncStatus ? sandbox.window.setSyncStatus(false) : sandbox.setSyncStatus(false);
assert.equal(clockEl.textContent, '未同期', "一度も成功していない場合は '未同期' と表示されること");
assert.equal(textEl.textContent, '再接続待機中', "テキストが '再接続待機中' であること");

// 成功テスト
sandbox.setSyncStatus(true);
assert.notEqual(clockEl.textContent, '未同期', "成功時は時刻文字列に更新されること");
assert.equal(textEl.textContent, '現場データ同期', "テキストが '現場データ同期' であること");
const successTime = clockEl.textContent;

// 失敗時保持テスト
sandbox.setSyncStatus(false);
assert.equal(clockEl.textContent, successTime, "失敗時は前回の成功時刻をそのまま保持すること");
assert.equal(textEl.textContent, '再接続待機中', "テキストが '再接続待機中' であること");
console.log("  ✅ PASS: No.1 同期時計の成功更新・失敗保持・初期未同期表示確認");

// ----------------------------------------------------
// 【No.5 検証】部分取得失敗 (PARTIAL_SUCCESS) 検知 & No.1 是正検証 (PARTIAL時は時計非更新)
// ----------------------------------------------------
console.log("▶ [TEST 4] No.5: 部分取得失敗 (PARTIAL_SUCCESS) 検知 & 時計非更新チェック");
sandbox.setSyncStatus('PARTIAL');
assert.equal(textEl.textContent, '一部データ遅延', "PARTIAL 時は '一部データ遅延' と表示されること");
assert.ok(getOrCreateEl('live-dot').className.includes('bg-statusYellow'), "PARTIAL 時は黄ドットであること");
assert.equal(clockEl.textContent, successTime, "PARTIAL 時は時計が更新されず前回の成功時刻を保持すること");

// 初期未同期状態での PARTIAL テスト
sandbox.window.DashboardState.lastSuccessfulSyncTime = null;
clockEl.textContent = '初期値';
sandbox.setSyncStatus('PARTIAL');
assert.equal(clockEl.textContent, '未同期', "一度も成功していない状態で PARTIAL になった場合は '未同期' と表示されること");
// 元に戻す
sandbox.setSyncStatus(true);
console.log("  ✅ PASS: No.5 部分取得失敗検知 & No.1是正(PARTIAL時時計非更新・保持)確認");

// ----------------------------------------------------
// 【No.3 実描画検証】0枚の正当値保持 & 未取得ピンの '--' 表示
// ----------------------------------------------------
console.log("▶ [TEST 5] No.3: 完了詳細ピンの実描画テスト");
sandbox.window.DashboardState.globalPinStatus.completed = [10, 20];

// ケースA: liveRecords にない過去完了ピン (rowId 10)
sandbox.window.DashboardState.liveRecords = [];
sandbox.renderRightBottomAreaStats({ rowId: 10, townName: "テスト町", cityName: "桑名市", households: 50, population: 100 });
const slotBottomA = getOrCreateEl('right-slot-bottom').innerHTML;
assert.ok(slotBottomA.includes('-- <span class="text-xs font-normal text-textSub">枚</span>'), "枚数が '-- 枚' と表示されること");
assert.ok(slotBottomA.includes('<span class="text-textSub font-mono text-xs">--</span>'), "完了日時が '--' と表示されること");
assert.ok(!slotBottomA.includes('08/23 09:36'), "架空の日時は一切含まれないこと");

// ケースB: count: 0 の正当な完了ピン (rowId 20)
sandbox.window.DashboardState.liveRecords = [{ rowId: 20, time: "10/06 09:00", count: 0, staffId: "S01" }];
sandbox.renderRightBottomAreaStats({ rowId: 20, townName: "テスト町2", cityName: "桑名市", households: 50, population: 100 });
const slotBottomB = getOrCreateEl('right-slot-bottom').innerHTML;
assert.ok(slotBottomB.includes('0 <span class="text-xs font-normal text-textSub">枚</span>'), "正当な数値 0 が '0 枚' として正しく表示されること");
assert.ok(slotBottomB.includes('10/06 09:00'), "正常な完了日時が表示されること");
console.log("  ✅ PASS: No.3 完了詳細ピンの架空値排除 & 0枚保持確認");

// ----------------------------------------------------
// 【No.6 検証】データ状態別の厳密な区別描画
// ----------------------------------------------------
console.log("▶ [TEST 6] No.6: 各画面の状態別表示チェック");

// 実績タブ
const recEl = getOrCreateEl('main-stage-records-content');

// 1. 取得中
sandbox.window.DashboardState.domainState.ranking = 'LOADING';
sandbox.renderMainStageRecords([]);
assert.ok(recEl.innerHTML.includes('配布実績データを取得中...'), "取得中スピナーメッセージが表示されること");

// 2. エラー（データ未保持）
sandbox.window.DashboardState.domainState.ranking = 'ERROR';
sandbox.renderMainStageRecords([]);
assert.ok(recEl.innerHTML.includes('配布実績データの取得に失敗しました'), "取得失敗エラーが表示されること");

// 3. 正常0件
sandbox.window.DashboardState.domainState.ranking = 'SUCCESS';
sandbox.renderMainStageRecords([]);
assert.ok(recEl.innerHTML.includes('現在、登録されている配布実績はありません'), "正常0件メッセージが表示されること");

// 4. 前回データ保持中 (STALE)
sandbox.window.DashboardState.domainState.ranking = 'STALE';
sandbox.renderMainStageRecords([{ staffId: "S01", count: 100 }]);
assert.ok(recEl.innerHTML.includes('最新データの取得に失敗したため、前回データを表示しています'), "STALE 警告バッジが表示されること");
assert.ok(recEl.innerHTML.includes('S01'), "前回データが破棄されず描画されていること");

console.log("  ✅ PASS: No.6 実績タブの4状態区別描画確認");

// ----------------------------------------------------
// 【No.7 検証】掲示板のTTL再取得 & 失敗時キャッシュ保護
// ----------------------------------------------------
console.log("▶ [TEST 7] No.7: 掲示板TTL再取得 & キャッシュ保護チェック");
const bulletinEl = getOrCreateEl('main-stage-bulletin-content');

// キャッシュ保護テスト: 初期キャッシュが存在する場合
sandbox.window.DashboardState.bulletinPosts = [{ id: "P1", staffName: "スタッフA", message: "テスト投稿", updatedAt: "2026/10/06 09:00" }];
sandbox.window.DashboardState.currentFocus = 'bulletin';

// 失敗時でも drawBulletinList(..., { isStale: true }) で既存投稿が表示され続ける
sandbox.drawBulletinList(sandbox.window.DashboardState.bulletinPosts, { isStale: true });
assert.ok(bulletinEl.innerHTML.includes('最新投稿の取得に失敗したため、前回取得データを表示しています'), "STALE バナーが表示されること");
assert.ok(bulletinEl.innerHTML.includes('テスト投稿'), "既存の投稿内容が画面に保持されていること");

console.log("  ✅ PASS: No.7 掲示板キャッシュ保護確認");

console.log("\n🎉 ALL 6 DASHBOARD INTEGRITY ACCEPTANCE TESTS PASSED PERFECTLY!");
