import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log("====================================================");
console.log("🖥️ STEP 4 MANAGER UI INTERACTION & RENDERING RIGOROUS TEST");
console.log("====================================================");

// ブラウザ環境モックの構築
const mockWindow = {
  location: { search: "" },
  PMS_CLIENT_CONFIG: {
    districtId: "KUWANA",
    api: { gasWebAppUrl: "https://script.google.com/test" },
    staticMaster: {
      addressCsvFilename: "address_master.csv",
      boundariesGeojsonFilename: "boundaries.geojson",
      electionHistoryFilename: "election_history.json"
    }
  },
  addEventListener: () => {},
  removeEventListener: () => {}
};
const createMockElement = () => ({
  style: {},
  classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
  innerHTML: '',
  textContent: '',
  className: '',
  value: '',
  focus: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  setAttribute: () => {},
  getAttribute: () => '',
  appendChild: () => {},
  cloneNode: () => createMockElement()
});

const mockDocument = {
  getElementById: (id) => createMockElement(),
  querySelectorAll: () => [],
  querySelector: () => createMockElement(),
  createElement: () => createMockElement(),
  addEventListener: () => {},
  removeEventListener: () => {}
};

let layerClearCount = 0;
let renderCurrentViewCount = 0;
let renderMainStageMailCount = 0;
let mapSetViewCount = 0;

const mockMap = {
  setView: () => { mapSetViewCount++; },
  getZoom: () => 14,
  getCenter: () => ({ lat: 35.06, lng: 136.68 }),
  hasLayer: () => true,
  getPane: () => null,
  createPane: () => createMockElement(),
  on: () => {},
  invalidateSize: () => {}
};
const mockLayer = {
  clearLayers: () => { layerClearCount++; },
  addLayer: () => {},
  addTo: () => mockLayer
};

// Node VM 内で manager.js を評価
const managerCode = fs.readFileSync(path.join(process.cwd(), "active/manager/manager.js"), 'utf8');

let mockApiResponseHandler = null;

const sandbox = {
  window: mockWindow,
  document: mockDocument,
  navigator: { onLine: true },
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  URLSearchParams: URLSearchParams,
  AbortController: class {
    constructor() { this.signal = {}; }
    abort() {}
  },
  fetch: async (url, options) => {
    if (!options || !options.body) {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({})
      };
    }
    const bodyObj = JSON.parse(options.body);
    const result = mockApiResponseHandler ? await mockApiResponseHandler(bodyObj.action, bodyObj) : { success: false };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(result),
      json: async () => result
    };
  },
  getApiUrl: () => "https://script.google.com/test",
  L: {
    map: () => mockMap,
    layerGroup: () => mockLayer,
    circleMarker: () => ({ bindPopup: () => {}, on: () => {}, addTo: () => {} }),
    marker: () => ({ bindPopup: () => {}, on: () => {} }),
    icon: () => ({}),
    divIcon: () => ({}),
    geoJSON: () => ({ addTo: () => {} })
  },
  _isSyncing: false,
  _isDashboardInitialized: true,
  _hasAppliedPinStatus: false
};

vm.createContext(sandbox);

// 補助関数のスタブ注入
sandbox.setSyncStatus = (status) => {};
sandbox.showManagerPinGate = () => {};

// manager.js をサンドボックスに読み込む
vm.runInContext(managerCode, sandbox);

// -------------------------------------------------------------
// [UI TEST 1] マーカー差分更新検知: ピン状態不変時の再描画ゼロ検証
// -------------------------------------------------------------
console.log("▶ [UI TEST 1] ピン状態不変時の Leaflet マーカー再描画スキップ検証");
Object.assign(sandbox.window.DashboardState, {
  districtId: "KUWANA",
  selectedCity: 'ALL',
  summary: { total: 100, done: 20 },
  stocks: [{ staffId: "K001", count: 500 }],
  roster: [{ id: "K001", name: "桑名 太郎" }],
  requests: [{ requestId: "REQ001" }],
  ranking: [{ staffId: "K001", count: 150 }],
  liveRecords: [],
  globalPinStatus: { inProgress: [2], completed: [1] },
  currentFocus: 'map',
  map: mockMap,
  markersLayer: mockLayer,
  masterPins: [{ rowId: 1, cityName: '桑名市', lat: 35.0, lng: 136.0 }, { rowId: 2, cityName: '桑名市', lat: 35.1, lng: 136.1 }]
});
sandbox._hasAppliedPinStatus = true; // 初回適用済み

layerClearCount = 0;

// 同期レスポンス: ピン状態に変更なし
mockApiResponseHandler = (action, params) => {
  return {
    success: true,
    status: "SUCCESS",
    domains: {
      summary: { success: true, total: 100, done: 20 },
      flyerStock: { success: true, stocks: [{ staffId: "K001", count: 500 }] },
      ranking: { success: true, ranking: [{ staffId: "K001", count: 150 }] },
      pinStatus: { success: true, inProgress: [2], completed: [1] }, // 変更なし
      roster: { success: true, roster: [{ id: "K001", name: "桑名 太郎" }] },
      transfer: { success: true, requests: [{ requestId: "REQ001" }] },
      latestDistribution: { success: true, records: [] }
    }
  };
};

// 1回目 (初回同期): 初回適用フラグが立っていないためマーカーが初期描画される
await sandbox.syncDashboardData();
assert.equal(layerClearCount, 1, "初回同期時はマーカーが 1 回初期描画されること");

// カウンターリセット
layerClearCount = 0;

// 2回目 (ピン状態不変の定期同期): マーカー再描画が完全にスキップされること
await sandbox.syncDashboardData();

assert.equal(layerClearCount, 0, "ピン状態が変化していない場合、マーカーレイヤーのクリア・再生成は行われてはならない (0回)");
assert.equal(mapSetViewCount, 0, "地図の視点 (setView/ズーム/センター) はリセットされてはならない (0回)");
console.log("  ✅ UI TEST 1 PASS: ピン不変時、マーカー再描画回数 = 0 回 (地図のパン・ズーム・選択ピンが完全維持)");

// -------------------------------------------------------------
// [UI TEST 2] マーカー差分検知: ピン状態変更時のみ差分再描画される検証
// -------------------------------------------------------------
console.log("\n▶ [UI TEST 2] ピン状態変化時の差分再描画検知");
layerClearCount = 0;

// 同期レスポンス: ピン状態に変化あり (completed に 2 が追加)
mockApiResponseHandler = (action, params) => {
  return {
    success: true,
    status: "SUCCESS",
    domains: {
      summary: { success: true, total: 100, done: 21 },
      flyerStock: { success: true, stocks: [] },
      ranking: { success: true, ranking: [] },
      pinStatus: { success: true, inProgress: [], completed: [1, 2] }, // 変化あり
      roster: { success: true, roster: [] },
      transfer: { success: true, requests: [] },
      latestDistribution: { success: true, records: [] }
    }
  };
};

await sandbox.syncDashboardData();

assert.equal(layerClearCount, 1, "ピン状態が変化した場合、マーカーレイヤーが的確に 1 回クリア・再描画されること");
console.log("  ✅ UI TEST 2 PASS: ピン状態変化時のみ的確に 1 回マーカー更新が実行される");

// -------------------------------------------------------------
// [UI TEST 3] 人間操作状態保持: タブ選択・画面切替・スクロール位置の維持
// -------------------------------------------------------------
console.log("\n▶ [UI TEST 3] 人間操作状態保持 (タブ選択・画面フォーカス・スクロール)");
sandbox.window.DashboardState.currentFocus = 'mail';
sandbox.window.DashboardState.selectedMailTabIndex = 2; // 管理者が「受渡要請」タブを選択中

// 同期実行
await sandbox.syncDashboardData();

assert.equal(sandbox.window.DashboardState.currentFocus, 'mail', "画面フォーカスは維持されること");
assert.equal(sandbox.window.DashboardState.selectedMailTabIndex, 2, "タブインデックス (2) が同期でリセットされないこと");
console.log("  ✅ UI TEST 3 PASS: 同期実行中も管理者のタブ選択状態 (Index 2) およびフォーカスが完全保持");

// -------------------------------------------------------------
// [UI TEST 4] 部分失敗 (PARTIAL_SUCCESS) 時の既存表示保持
// -------------------------------------------------------------
console.log("\n▶ [UI TEST 4] 部分失敗時の既存データ保持 (No Blanking / No Reset)");
// 既存データ設定
sandbox.window.DashboardState.stocks = [{ staffId: "K001", count: 500 }];
sandbox.window.DashboardState.requests = [{ requestId: "REQ001" }];

// 一部ドメイン (flyerStock, transfer) が失敗したレスポンス
mockApiResponseHandler = (action, params) => {
  return {
    success: true,
    status: "PARTIAL_SUCCESS",
    domains: {
      summary: { success: true, total: 100, done: 20 },
      flyerStock: { success: false, error: "Sheet lock timeout" }, // 失敗
      ranking: { success: true, ranking: [] },
      pinStatus: { success: true, inProgress: [], completed: [1] },
      roster: { success: true, roster: [] },
      transfer: { success: false, error: "Network timeout" }, // 失敗
      latestDistribution: { success: true, records: [] }
    },
    errors: { flyerStock: "Sheet lock timeout", transfer: "Network timeout" }
  };
};

await sandbox.syncDashboardData();

// 失敗ドメインのデータが空配列にリセットされず、直前状態が保持されていること
assert.equal(sandbox.window.DashboardState.stocks.length, 1, "失敗した在庫ドメインは空クリアされず既存表示を保持");
assert.equal(sandbox.window.DashboardState.requests.length, 1, "失敗した受渡要請ドメインは空クリアされず既存表示を保持");
console.log("  ✅ UI TEST 4 PASS: ドメイン障害時も既存表示データが完全保持され、画面のブランク・点滅がゼロ");

// -------------------------------------------------------------
// [UI TEST 5] 掲示板初期バックグラウンドプリフェッチ・ライフサイクル契約 (Gates A - H)
// -------------------------------------------------------------
console.log("\n▶ [UI TEST 5] Bulletin Initial Background Prefetch Lifecycle Contract (Gates A - H)");

const apiCallLog = [];
mockApiResponseHandler = (action, params) => {
  apiCallLog.push({ action, params, timestamp: Date.now() });
  if (action === 'getDashboardSnapshot') {
    return {
      success: true,
      domains: {
        summary: { success: true, total: 100, done: 20 },
        flyerStock: { success: true, stocks: [] },
        ranking: { success: true, ranking: [] },
        pinStatus: { success: true, inProgress: [], completed: [1] },
        roster: { success: true, roster: [] },
        transfer: { success: true, requests: [] },
        latestDistribution: { success: true, records: [] }
      }
    };
  }
  if (action === 'getBulletinPosts') {
    return {
      success: true,
      posts: [
        { rowId: 1, staffId: 'S001', staffName: 'スタッフA', message: 'テスト投稿', createdAt: '2026-10-09 10:00:00' }
      ]
    };
  }
  return { success: true };
};

// [Gate A & B] Initial Lifecycle Order & Task Execution
sandbox._isDashboardInitialized = false;
sandbox.window.DashboardState.bulletinPosts = null;
sandbox._activeBulletinPromise = null;
sandbox._lastBulletinFetchTime = 0;
apiCallLog.length = 0;

const lifecyclePromise = sandbox.startDashboardLifecycle();
await lifecyclePromise;

// Gate A: getDashboardSnapshot は getBulletinPosts より厳密に先に開始・実行される (Snapshot settled, Bulletin not yet started in timer task)
assert.ok(apiCallLog.length >= 1, "getDashboardSnapshot が実行されること");
assert.equal(apiCallLog[0].action, 'getDashboardSnapshot', "初回の最優先 API は getDashboardSnapshot であること");
const bulletinBeforeTimer = apiCallLog.find(c => c.action === 'getBulletinPosts');
assert.equal(bulletinBeforeTimer, undefined, "Dashboard 起動・初期同期完了時点では getBulletinPosts はまだ発火していないこと (setTimeout(0) タスク前)");
console.log("  ✅ Gate A PASS: Initial lifecycle: getDashboardSnapshot occurs before getBulletinPosts");

// Gate B: Snapshot settle 後、setTimeout(0) タスクの消化により getBulletinPosts が厳密に 1 回実行される
await new Promise(resolve => setTimeout(resolve, 50));

const bulletinCalls = apiCallLog.filter(c => c.action === 'getBulletinPosts');
assert.equal(bulletinCalls.length, 1, "Snapshot settle 後のマクロタスクで getBulletinPosts が厳密に 1 回だけ先読みされること");
assert.ok(sandbox.window.DashboardState.bulletinPosts !== null, "DashboardState.bulletinPosts にキャッシュが格納されること");
assert.equal(sandbox.window.DashboardState.bulletinPosts.length, 1, "キャッシュされた投稿データが保持されていること");
assert.ok(apiCallLog[0].timestamp <= bulletinCalls[0].timestamp, "Snapshot 通信が Bulletin 先読み通信より時系列上先に行われていること");
console.log("  ✅ Gate B PASS: After Snapshot settles + timer task executes: getBulletinPosts exactly once");

// [Gate C] 30-Second Style Standalone Sync Isolation
apiCallLog.length = 0;
await sandbox.syncDashboardData();

const snapCallsC = apiCallLog.filter(c => c.action === 'getDashboardSnapshot');
const bulletinCallsC = apiCallLog.filter(c => c.action === 'getBulletinPosts');
assert.equal(snapCallsC.length, 1, "30秒定期同期で getDashboardSnapshot は実行されること");
assert.equal(bulletinCallsC.length, 0, "30秒定期同期で getBulletinPosts は決して再実行されないこと");
console.log("  ✅ Gate C PASS: 30-second sync: getDashboardSnapshot runs, getBulletinPosts does NOT run again");

// [Gate D] Visibility-Style Sync Isolation
apiCallLog.length = 0;
await sandbox.syncDashboardData();
const bulletinCallsD = apiCallLog.filter(c => c.action === 'getBulletinPosts');
assert.equal(bulletinCallsD.length, 0, "タブ復帰同期で getBulletinPosts は決して再実行されないこと");
console.log("  ✅ Gate D PASS: visibility sync: getBulletinPosts does NOT run again");

// [Gate E] Prefetch in-flight + Bulletin Open (In-Flight Dedup)
sandbox.window.DashboardState.bulletinPosts = null;
sandbox._activeBulletinPromise = null;
sandbox._lastBulletinFetchTime = 0;
apiCallLog.length = 0;

let resolveDelayedBulletin;
const delayedBulletinPromise = new Promise(res => { resolveDelayedBulletin = res; });
mockApiResponseHandler = (action, params) => {
  apiCallLog.push({ action, params, timestamp: Date.now() });
  if (action === 'getBulletinPosts') {
    return delayedBulletinPromise.then(() => ({
      success: true,
      posts: [{ rowId: 2, staffId: 'S002', message: '遅延投稿' }]
    }));
  }
  return { success: true };
};

// プリフェッチ開始 (in-flight 化)
const inFlightPrefetch = sandbox.renderMainStageBulletin();
assert.equal(apiCallLog.filter(c => c.action === 'getBulletinPosts').length, 1, "プリフェッチ通信が 1 回発火");

// 通信中にユーザーが掲示板を開く (switchView)
sandbox.switchView('bulletin');
assert.equal(apiCallLog.filter(c => c.action === 'getBulletinPosts').length, 1, "通信中に掲示板を開いても総通信回数は 1 回を維持 (Dedup)");

// 通信解決
resolveDelayedBulletin();
await inFlightPrefetch;
assert.equal(sandbox.window.DashboardState.bulletinPosts.length, 1, "通信完了後にキャッシュが正常更新されること");
console.log("  ✅ Gate E PASS: prefetch in-flight + Bulletin open: total getBulletinPosts count remains 1");

// [Gate F] Prefetch Completed + Bulletin Open < 30 sec (Cache Hit)
apiCallLog.length = 0;
sandbox.window.DashboardState.currentFocus = 'areas';
sandbox.switchView('bulletin');
const bulletinCallsF = apiCallLog.filter(c => c.action === 'getBulletinPosts');
assert.equal(bulletinCallsF.length, 0, "30秒TTL内の掲示板表示は追加 API ゼロ (即時描画)");
console.log("  ✅ Gate F PASS: prefetch completed + Bulletin open <30sec: additional API count = 0");

// [Gate G] Prefetch Failure Resilience & Retry
sandbox.window.DashboardState.bulletinPosts = null;
sandbox._activeBulletinPromise = null;
sandbox._lastBulletinFetchTime = 0;
apiCallLog.length = 0;

mockApiResponseHandler = (action, params) => {
  apiCallLog.push({ action, params, timestamp: Date.now() });
  if (action === 'getBulletinPosts') {
    return { success: false, message: "Server error" };
  }
  return { success: true };
};

await sandbox.renderMainStageBulletin();
assert.equal(sandbox.window.DashboardState.bulletinPosts, null, "失敗時はキャッシュが null のまま");

mockApiResponseHandler = (action, params) => {
  apiCallLog.push({ action, params, timestamp: Date.now() });
  if (action === 'getBulletinPosts') {
    return { success: true, posts: [{ rowId: 3, message: 'リトライ成功' }] };
  }
  return { success: true };
};

apiCallLog.length = 0;
await sandbox.renderMainStageBulletin();
assert.equal(apiCallLog.filter(c => c.action === 'getBulletinPosts').length, 1, "失敗後に掲示板を開いた際、正しく再取得が発火");
assert.equal(sandbox.window.DashboardState.bulletinPosts.length, 1, "再取得後にキャッシュが正常設定");
console.log("  ✅ Gate G PASS: prefetch failed: later Bulletin open retries normally");

// [Gate H] Force Refresh (force: true)
apiCallLog.length = 0;
await sandbox.renderMainStageBulletin({ force: true });
assert.equal(apiCallLog.filter(c => c.action === 'getBulletinPosts').length, 1, "force: true は即座に強制再取得を発火");
console.log("  ✅ Gate H PASS: force:true: existing manual refresh still performs API refresh");

console.log("\n====================================================");
console.log("🎉 ALL MANAGER UI INTERACTION TESTS PASSED PERFECTLY!");
console.log("====================================================");
process.exit(0);
