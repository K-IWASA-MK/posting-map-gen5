import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const rankingModuleCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/modules/ranking.js'), 'utf8');
const rankingComponentCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/components/ranking.js'), 'utf8');
const renderCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/render.js'), 'utf8');
const appCode = fs.readFileSync(path.join(REPO_ROOT, 'active/h-app/app.js'), 'utf8');

function createTestEnvironment(options = {}) {
  let { mockApiResponse = null, mockApiError = null } = options;

  const storage = {};
  const elements = {};

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
          dataset: {}
        };
      }
      return elements[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  const windowObj = {
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  let apiCallCount = 0;
  let lastAction = null;
  let lastPayload = null;

  const callApiPost = (action, payload) => {
    apiCallCount++;
    lastAction = action;
    lastPayload = payload;

    if (mockApiError) {
      if (typeof mockApiError === 'function') {
        throw mockApiError();
      }
      throw mockApiError;
    }

    if (typeof mockApiResponse === 'function') {
      return Promise.resolve(mockApiResponse(action, payload, apiCallCount));
    }

    return Promise.resolve(mockApiResponse || {
      success: true,
      ranking: [
        { rank: 1, staffId: 'S001', count: 1500, isMe: true },
        { rank: 2, staffId: 'S002', count: 1200, isMe: false }
      ],
      mySummary: { rank: 1, count: 1500 }
    });
  };

  const sandbox = {
    window: windowObj,
    document,
    localStorage: {
      getItem: (k) => storage[k] || null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    callApiPost,
    setQueueLifecycleGates: () => {},
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    Promise,
    Array,
    Object,
    JSON,
    Error
  };

  sandbox.window.document = document;
  sandbox.window.localStorage = sandbox.localStorage;

  vm.createContext(sandbox);

  // コンポーネントおよびモジュールの評価
  vm.runInContext(rankingComponentCode, sandbox);
  sandbox.renderRankingCard = sandbox.window.renderRankingCard;
  sandbox.RankingModule = vm.runInContext(rankingModuleCode + '\n; RankingModule;', sandbox);
  sandbox.RankingView = vm.runInContext(renderCode + '\n; RankingView;', sandbox);
  vm.runInContext(appCode, sandbox);

  return {
    sandbox,
    elements,
    $: (id) => document.getElementById(id),
    getApiCallCount: () => apiCallCount,
    setMockApiResponse: (res) => { mockApiResponse = res; },
    setMockApiError: (err) => { mockApiError = err; }
  };
}

async function runTests() {
  console.log("====================================================");
  console.log("🧪 RANKING MODULE & VIEW LIFECYCLE AUDIT (Wave 10)");
  console.log("====================================================\n");

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 1: 初回取得・反映 ---");
  {
    const env = createTestEnvironment({
      mockApiResponse: {
        success: true,
        ranking: [
          { rank: 1, staffId: 'S001', count: 2000, isMe: true },
          { rank: 2, staffId: 'S002', count: 1000, isMe: false }
        ],
        mySummary: { rank: 1, count: 2000 }
      }
    });

    const rm = env.sandbox.RankingModule;
    assert.strictEqual(rm.getSnapshot().fetched, false, '取得前は fetched === false');

    const result = await rm.fetchRanking();
    assert.strictEqual(result.fetched, true, '取得後は fetched === true');
    assert.strictEqual(result.ranking.length, 2, 'ランキング2件取得');
    assert.strictEqual(result.ranking[0].staffId, 'S001');
    assert.strictEqual(result.mySummary.rank, 1);
    assert.strictEqual(env.getApiCallCount(), 1, 'API呼出しは1回');
    console.log("✅ Gate 1 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 2: キャッシュ即時復元 ---");
  {
    const env = createTestEnvironment({
      mockApiResponse: {
        success: true,
        ranking: [{ rank: 1, staffId: 'S001', count: 2000, isMe: true }],
        mySummary: { rank: 1, count: 2000 }
      }
    });

    const rm = env.sandbox.RankingModule;
    await rm.fetchRanking();
    assert.strictEqual(env.getApiCallCount(), 1);

    // 2回目呼び出し: API通信を行わず即座にキャッシュを返却
    const cachedResult = await rm.fetchRanking();
    assert.strictEqual(cachedResult.fetched, true);
    assert.strictEqual(cachedResult.ranking[0].staffId, 'S001');
    assert.strictEqual(env.getApiCallCount(), 1, 'キャッシュ利用のためAPI呼出し回数は1のまま');
    console.log("✅ Gate 2 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 3: In-flight 通信共有 (多重呼出し時にAPI1回 & 同一結果受領) ---");
  {
    let resolveApi;
    const pendingPromise = new Promise(r => { resolveApi = r; });

    const env = createTestEnvironment({
      mockApiResponse: async () => {
        return pendingPromise;
      }
    });

    const rm = env.sandbox.RankingModule;

    // 3回同時に呼出しを発火
    const p1 = rm.fetchRanking();
    const p2 = rm.fetchRanking();
    const p3 = rm.fetchRanking();

    assert.strictEqual(env.getApiCallCount(), 1, '3並行呼出しでもAPI呼出しは厳密に1回');

    // API完了を解決
    resolveApi({
      success: true,
      ranking: [{ rank: 1, staffId: 'S_SHARED', count: 888, isMe: true }],
      mySummary: { rank: 1, count: 888 }
    });

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);
    assert.strictEqual(res1.ranking[0].staffId, 'S_SHARED');
    assert.strictEqual(res2.ranking[0].staffId, 'S_SHARED');
    assert.strictEqual(res3.ranking[0].staffId, 'S_SHARED');
    assert.strictEqual(env.getApiCallCount(), 1, '完了後もAPI呼出し回数は1のまま');
    console.log("✅ Gate 3 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 4: 通信失敗時の Promise 解放 & 次回再試行保証 ---");
  {
    let shouldFail = true;
    const env = createTestEnvironment({
      mockApiResponse: async () => {
        if (shouldFail) {
          throw new Error('NETWORK_TIMEOUT');
        }
        return {
          success: true,
          ranking: [{ rank: 1, staffId: 'S_RETRY', count: 500, isMe: true }],
          mySummary: { rank: 1, count: 500 }
        };
      }
    });

    const rm = env.sandbox.RankingModule;

    // 1回目: 失敗
    let errorCaught = false;
    try {
      await rm.fetchRanking();
    } catch (e) {
      errorCaught = true;
      assert.strictEqual(e.message, 'NETWORK_TIMEOUT');
    }
    assert.strictEqual(errorCaught, true);
    assert.strictEqual(rm.getSnapshot().fetched, false, '失敗時は fetched === false のまま');

    // 2回目: 再試行（Promiseが確実に解放されているため再通信が走ること）
    shouldFail = false;
    const retryResult = await rm.fetchRanking();
    assert.strictEqual(retryResult.fetched, true, '再試行成功で fetched === true');
    assert.strictEqual(retryResult.ranking[0].staffId, 'S_RETRY');
    assert.strictEqual(env.getApiCallCount(), 2, '再試行でAPI呼出しが再度実行されたこと');

    // 同期例外時の安全性検証: callApiPost が通常関数から同期例外を投げても解放され再試行可能なこと
    let shouldSyncThrow = true;
    const syncEnv = createTestEnvironment({
      mockApiError: () => {
        if (shouldSyncThrow) {
          throw new Error('SYNC_EXCEPTION');
        }
        return null;
      }
    });
    const syncRm = syncEnv.sandbox.RankingModule;
    let syncErrorCaught = false;
    try {
      await syncRm.fetchRanking();
    } catch (e) {
      syncErrorCaught = true;
      assert.strictEqual(e.message, 'SYNC_EXCEPTION');
    }
    assert.strictEqual(syncErrorCaught, true, '同期例外が呼出し元で捕捉されること');
    assert.strictEqual(syncRm.getSnapshot().fetched, false, '同期例外時も fetched === false');
    assert.strictEqual(syncEnv.getApiCallCount(), 1, '初回呼出しは1回');

    // 再試行: 同期例外を解除して正常応答を設定
    shouldSyncThrow = false;
    syncEnv.setMockApiError(null);
    syncEnv.setMockApiResponse({
      success: true,
      ranking: [{ rank: 1, staffId: 'S_SYNC_RETRY', count: 999, isMe: true }],
      mySummary: { rank: 1, count: 999 }
    });

    const syncRetryResult = await syncRm.fetchRanking();
    assert.strictEqual(syncRetryResult.fetched, true, '同期例外後の再試行で成功し fetched === true');
    assert.strictEqual(syncRetryResult.ranking[0].staffId, 'S_SYNC_RETRY');
    assert.strictEqual(syncEnv.getApiCallCount(), 2, '通信累計2回・成功');
    console.log("✅ Gate 4 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 5: 正常0件 (Empty) と取得失敗 (Error) の厳密区別 ---");
  {
    // Case 5A: 正常空データ (success: true, ranking: []) ➔ Empty State
    const emptyEnv = createTestEnvironment({
      mockApiResponse: {
        success: true,
        ranking: [],
        mySummary: null
      }
    });

    await emptyEnv.sandbox.RankingView.initPage({
      rankingModule: emptyEnv.sandbox.RankingModule,
      getMyStaffId: () => 'S001'
    });

    const emptyContainer = emptyEnv.$('ranking-list');
    assert.ok(emptyContainer.innerHTML.includes('まだ配布ランキングがありません'), '正常空データは Empty 表示');
    assert.ok(emptyContainer.innerHTML.includes('🏆'), 'Empty表示にトロフィーアイコンを含む');
    assert.strictEqual(emptyEnv.sandbox.RankingModule.getSnapshot().fetched, true, '正常空データは取得完了として扱われる');

    // Case 5B: 応答形式不正 (success: true だが ranking が欠損/非配列) ➔ Error State & 未取得維持
    const invalidFormatEnv = createTestEnvironment({
      mockApiResponse: {
        success: true,
        ranking: null, // 非配列
        mySummary: null
      }
    });

    await invalidFormatEnv.sandbox.RankingView.initPage({
      rankingModule: invalidFormatEnv.sandbox.RankingModule,
      getMyStaffId: () => 'S001'
    });

    const errorContainer = invalidFormatEnv.$('ranking-list');
    assert.ok(errorContainer.innerHTML.includes('ランキングの取得に失敗しました'), '形式不正は Error 表示');
    assert.ok(errorContainer.innerHTML.includes('⚠️'), 'Error表示に警告アイコンを含む');
    assert.strictEqual(invalidFormatEnv.sandbox.RankingModule.getSnapshot().fetched, false, '形式不正は fetched === false のまま再試行可能');
    console.log("✅ Gate 5 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 6: Snapshot Mutation Isolation ---");
  {
    const env = createTestEnvironment({
      mockApiResponse: {
        success: true,
        ranking: [{ rank: 1, staffId: 'ORIGINAL', count: 100, isMe: true }],
        mySummary: { rank: 1, count: 100 }
      }
    });

    const rm = env.sandbox.RankingModule;
    await rm.fetchRanking();

    const snap1 = rm.getSnapshot();
    snap1.ranking.push({ rank: 2, staffId: 'HACKED', count: 0, isMe: false });
    snap1.ranking[0].staffId = 'MUTATED';
    snap1.mySummary.rank = 999;

    const snap2 = rm.getSnapshot();
    assert.strictEqual(snap2.ranking.length, 1, '外部からの push が内部キャッシュに影響しない');
    assert.strictEqual(snap2.ranking[0].staffId, 'ORIGINAL', '外部プロパティ変更が内部に影響しない');
    assert.strictEqual(snap2.mySummary.rank, 1, 'mySummaryの変更が内部に影響しない');
    console.log("✅ Gate 6 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 7: RankingView 画面表示遷移 (Loading ➔ Success) ---");
  {
    let resolveApi;
    const pendingPromise = new Promise(r => { resolveApi = r; });

    const env = createTestEnvironment({
      mockApiResponse: () => pendingPromise
    });

    const container = env.$('ranking-list');
    const initPromise = env.sandbox.RankingView.initPage({
      rankingModule: env.sandbox.RankingModule,
      getMyStaffId: () => 'S001'
    });

    // Loading 状態のアサート
    assert.ok(container.innerHTML.includes('Loading Leaderboard...'), '通信中は Loading 表示');
    assert.ok(container.innerHTML.includes('animate-spin'), 'スピナーが存在');

    // 通信完了
    resolveApi({
      success: true,
      ranking: [
        { rank: 1, staffId: 'S001', count: 2000, isMe: true },
        { rank: 2, staffId: 'S002', count: 1000, isMe: false }
      ],
      mySummary: { rank: 1, count: 2000 }
    });

    await initPromise;

    // Success 状態のアサート
    assert.ok(container.innerHTML.includes('🥇'), '1位のメダルが表示');
    assert.ok(container.innerHTML.includes('2,000枚'), '枚数がカンマフォーマットで表示');
    assert.ok(container.innerHTML.includes('現在の順位'), '順位サマリカードが表示');
    console.log("✅ Gate 7 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 8: components/ranking.js 純粋関数検証 (引数mySummaryからの描画) ---");
  {
    const env = createTestEnvironment();
    // window._myRankingSummary は未定義のまま
    assert.strictEqual(env.sandbox.window._myRankingSummary, undefined);

    const rankingData = [
      { rank: 1, staffId: 'S_ALICE', count: 3000, isMe: false },
      { rank: 2, staffId: 'S_BOB', count: 2000, isMe: true }
    ];
    const mySummary = { rank: 2, count: 2000 };

    const html = env.sandbox.window.renderRankingCard(rankingData, 'S_BOB', mySummary);
    assert.ok(html.includes('2位</span>'), '引数 mySummary の順位が正しく反映されていること');
    assert.ok(html.includes('2,000枚</span>'), '引数 mySummary の枚数が正しく反映されていること');
    assert.ok(html.includes('S_BOB'), 'スタッフIDが表示されていること');
    console.log("✅ Gate 8 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 9: 依存性注入 (DI) 検証 ---");
  {
    const env = createTestEnvironment();

    let errorWithoutModule = false;
    try {
      await env.sandbox.RankingView.initPage({});
    } catch (e) {
      errorWithoutModule = true;
      assert.ok(e.message.includes('rankingModule is required'));
    }
    assert.strictEqual(errorWithoutModule, true, 'rankingModule 未指定時に例外スロー');
    console.log("✅ Gate 9 PASS\n");
  }

  // ─────────────────────────────────────────────────────────
  console.log("--- Gate 10: 公開API限定検証 (テスト専用裏口APIの完全排除) ---");
  {
    const env = createTestEnvironment();
    const rm = env.sandbox.RankingModule;
    const publicKeys = Object.keys(rm);

    assert.deepStrictEqual(publicKeys.sort(), ['fetchRanking', 'getSnapshot'].sort(), '公開インターフェースは fetchRanking と getSnapshot の2つのみに厳格限定');
    assert.strictEqual(rm.resetForTest, undefined, 'resetForTest は露出していないこと');
    assert.strictEqual(rm.force, undefined, 'force は露出していないこと');
    assert.strictEqual(rm._reqSeq, undefined, '_reqSeq は露出していないこと');
    console.log("✅ Gate 10 PASS\n");
  }

  console.log("====================================================");
  console.log("🎉 ALL 10 GATES PASSED PERFECTLY!");
  console.log("====================================================\n");
}

runTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
