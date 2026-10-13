import { chromium } from 'playwright';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8098;

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/' || reqPath === '/app' || reqPath === '/app/') {
        reqPath = '/active/h-app/index.html';
      } else if (reqPath.startsWith('/app/')) {
        reqPath = '/active/h-app/' + reqPath.substring(5);
      }

      const filePath = path.join(REPO_ROOT, reqPath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`File not found: ${req.url}`);
        } else {
          let contentType = 'text/html';
          if (filePath.endsWith('.js')) contentType = 'application/javascript';
          if (filePath.endsWith('.css')) contentType = 'text/css';
          if (filePath.endsWith('.json')) contentType = 'application/json';
          if (filePath.endsWith('.png')) contentType = 'image/png';
          if (filePath.endsWith('.csv')) contentType = 'text/plain; charset=utf-8';

          let responseData = data;
          if (filePath.endsWith('config.js')) {
            let configText = data.toString('utf8');
            configText = configText.replace(/gasWebAppUrl:\s*["'][^"']*["']/, `gasWebAppUrl: "http://localhost:${PORT}/mock-exec"`);
            configText = configText.replace(/liffId:\s*["'][^"']*["']/, 'liffId: "test-liff-id"');
            responseData = Buffer.from(configText, 'utf8');
          }

          res.writeHead(200, { 'Content-Type': contentType });
          res.end(responseData);
        }
      });
    });
    server.listen(PORT, () => {
      resolve(server);
    });
  });
}

async function runBrowserRankingTests() {
  console.log("==================================================================");
  console.log("🏆 H-APP RANKING REAL-BROWSER AUDIT (Wave 10)");
  console.log("==================================================================\n");

  const server = await startLocalServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.0.0'
  });

  const setupPageLogging = (p, label = 'PAGE') => {
    p.on('console', msg => {
      const text = msg.text();
      console.log(`  [${label} CONSOLE]`, msg.type(), text);
    });
    p.on('pageerror', err => console.log(`  [${label} ERROR]`, err.message));
  };

  // Mock LIFF SDK
  await context.route('**/sdk.js', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.liff = {
          init: () => Promise.resolve(),
          isLoggedIn: () => true,
          getProfile: () => Promise.resolve({
            userId: 'U1234567890abcdef',
            displayName: 'テスト配布員',
            pictureUrl: 'https://example.com/pic.jpg'
          }),
          getIDToken: () => 'mock-id-token',
          getAccessToken: () => 'mock-access-token'
        };
      `
    });
  });

  // Mock Google Maps API
  await context.route('**/maps/api/js*', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.google = {
          maps: {
            Map: class { constructor() {} setCenter() {} setZoom() {} addListener() {} panTo() {} },
            Marker: class { constructor() {} setMap() {} setPosition() {} addListener() {} },
            Polygon: class { constructor() {} setMap() {} addListener() {} },
            LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
            LatLngBounds: class { extend() {} getCenter() { return { lat: () => 0, lng: () => 0 }; } }
          }
        };
      `
    });
  });

  // Mock GAS API State
  let getRankingCallCount = 0;
  let mockGetRankingDelay = 50;
  let shouldFailRanking = false;
  let mockRankingData = [
    { rank: 1, staffId: 'S001', staffName: 'テスト配布員', count: 3200, isMe: true },
    { rank: 2, staffId: 'S002', staffName: '桑名 二郎', count: 2500, isMe: false },
    { rank: 3, staffId: 'S003', staffName: '桑名 三郎', count: 1800, isMe: false }
  ];
  let mockMySummary = { rank: 1, count: 3200 };

  await context.route('**/*exec*', async route => {
    const postData = route.request().postData();
    let action = '';
    try {
      const parsed = JSON.parse(postData);
      action = parsed.action;
    } catch (e) {}

    if (action === 'getRegistrationStatus') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          registered: true,
          staff: {
            staffId: 'S001',
            name: 'テスト配布員',
            role: 'POSTING_STAFF',
            branch: '桑名支部',
            storageLocations: ['桑名市', '四日市市']
          }
        })
      });
      return;
    }

    if (action === 'getRanking') {
      getRankingCallCount++;
      if (mockGetRankingDelay > 0) {
        await new Promise(r => setTimeout(r, mockGetRankingDelay));
      }
      if (shouldFailRanking) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: 'DATABASE_LOCKED' })
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          ranking: mockRankingData,
          mySummary: mockMySummary
        })
      });
      return;
    }

    // Default response for other actions
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    });
  });

  const page = await context.newPage();
  context.on('page', p => setupPageLogging(p, 'NEW_PAGE'));
  setupPageLogging(page, 'MAIN_PAGE');

  try {
    // ページロード
    await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.switchPage === 'function', { timeout: 10000 });
    await page.waitForTimeout(300);

    // ─────────────────────────────────────────────────────────────
    console.log("--- Case A: ランキング画面の初回取得・表示遷移 ---");
    // ─────────────────────────────────────────────────────────────
    // 初期状態確認
    assert.strictEqual(getRankingCallCount, 0, '初期ロード時はランキングAPI未呼出し');

    // ランキング画面へ遷移
    await page.evaluate(() => window.switchPage('ranking'));

    // Loading 状態または完了の確認
    const rankingList = page.locator('#ranking-list');
    await page.waitForFunction(() => {
      const el = document.getElementById('ranking-list');
      return el && el.innerHTML.includes('3,200枚');
    }, { timeout: 5000 });

    const htmlA = await rankingList.innerHTML();
    assert.ok(htmlA.includes('🥇'), '1位の金メダルが表示されていること');
    assert.ok(htmlA.includes('3,200枚'), '自分の配布枚数がカンマ区切りで表示されていること');
    assert.ok(htmlA.includes('S002'), '2位のスタッフIDが表示されていること');
    assert.strictEqual(getRankingCallCount, 1, '初回取得でAPI呼出しが厳密に1回行われたこと');
    console.log("✅ Case A PASS\n");

    // ─────────────────────────────────────────────────────────────
    console.log("--- Case B: タブ往復時のキャッシュ即座表示 ---");
    // ─────────────────────────────────────────────────────────────
    // 一度エリア画面へ切り替え
    await page.evaluate(() => window.switchPage('areas'));
    await page.waitForTimeout(100);

    // 再度ランキング画面へ切り替え
    await page.evaluate(() => window.switchPage('ranking'));
    await page.waitForTimeout(100);

    // 即座にランキングが表示されていること、API通信が増加していないこと
    const htmlB = await rankingList.innerHTML();
    assert.ok(htmlB.includes('3,200枚'), 'キャッシュから即時復元されていること');
    assert.strictEqual(getRankingCallCount, 1, 'キャッシュ利用のためAPI呼出し回数は1のまま');
    console.log("✅ Case B PASS\n");

    // ─────────────────────────────────────────────────────────────
    console.log("--- Case C: 高速往復時の通信共有 (In-flight lock) ---");
    // ─────────────────────────────────────────────────────────────
    // 新しいページを開いてキャッシュなしの状態で高速往復をテスト
    const freshPage = await context.newPage();
    await freshPage.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForFunction(() => typeof window.switchPage === 'function', { timeout: 10000 });
    await freshPage.waitForTimeout(300);

    const callCountBeforeC = getRankingCallCount;
    mockGetRankingDelay = 400; // 遅延を設定して通信中状態を維持

    // 高速でタブを切り替え往復
    await freshPage.evaluate(() => window.switchPage('ranking'));
    await freshPage.waitForTimeout(50);
    await freshPage.evaluate(() => window.switchPage('areas'));
    await freshPage.waitForTimeout(50);
    await freshPage.evaluate(() => window.switchPage('ranking'));
    await freshPage.waitForTimeout(50);
    await freshPage.evaluate(() => window.switchPage('areas'));
    await freshPage.waitForTimeout(50);
    await freshPage.evaluate(() => window.switchPage('ranking'));

    // 通信完了を待機
    const freshRankingList = freshPage.locator('#ranking-list');
    try {
      await freshPage.waitForFunction(() => {
        const el = document.getElementById('ranking-list');
        return el && el.innerHTML.includes('3,200枚');
      }, { timeout: 5000 });
    } catch (e) {
      const currentHtml = await freshRankingList.innerHTML().catch(() => 'CANNOT_GET_HTML');
      console.log('  [DEBUG Case C FAILED] Current #ranking-list innerHTML:', currentHtml);
      throw e;
    }

    const htmlC = await freshRankingList.innerHTML();
    assert.ok(htmlC.includes('3,200枚'), '高速往復後も正常に表示されること');
    assert.strictEqual(getRankingCallCount - callCountBeforeC, 1, '高速連打でもAPI通信は厳密に1回に共有されたこと');
    console.log("✅ Case C PASS\n");
    await freshPage.close();

    // ─────────────────────────────────────────────────────────────
    console.log("--- Case D: 正常0件時の表示 (Empty State) ---");
    // ─────────────────────────────────────────────────────────────
    mockGetRankingDelay = 10;
    mockRankingData = [];
    mockMySummary = null;

    const emptyPage = await context.newPage();
    await emptyPage.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded' });
    await emptyPage.waitForFunction(() => typeof window.switchPage === 'function', { timeout: 10000 });
    await emptyPage.waitForTimeout(300);

    await emptyPage.evaluate(() => window.switchPage('ranking'));
    const emptyRankingList = emptyPage.locator('#ranking-list');
    await emptyPage.waitForFunction(() => {
      const el = document.getElementById('ranking-list');
      return el && el.innerHTML.includes('まだ配布ランキングがありません');
    }, { timeout: 5000 });

    const htmlD = await emptyRankingList.innerHTML();
    assert.ok(htmlD.includes('🏆'), 'Empty表示にトロフィーアイコンが含まれること');
    assert.ok(htmlD.includes('まだ配布ランキングがありません'), '空データ時のメッセージが表示されていること');
    console.log("✅ Case D PASS\n");
    await emptyPage.close();

    // ─────────────────────────────────────────────────────────────
    console.log("--- Case E: 取得失敗時の表示 & 再訪時の再試行 ---");
    // ─────────────────────────────────────────────────────────────
    shouldFailRanking = true;

    const errorPage = await context.newPage();
    await errorPage.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded' });
    await errorPage.waitForFunction(() => typeof window.switchPage === 'function', { timeout: 10000 });
    await errorPage.waitForTimeout(300);

    // ランキング画面を開いてエラーを発生させる
    await errorPage.evaluate(() => window.switchPage('ranking'));
    const errorRankingList = errorPage.locator('#ranking-list');
    await errorPage.waitForFunction(() => {
      const el = document.getElementById('ranking-list');
      return el && el.innerHTML.includes('ランキングの取得に失敗しました');
    }, { timeout: 5000 });

    const htmlE1 = await errorRankingList.innerHTML();
    assert.ok(htmlE1.includes('⚠️'), 'Error表示に警告アイコンが含まれること');
    assert.ok(htmlE1.includes('DATABASE_LOCKED'), 'エラーメッセージが含まれること');

    // エラーが解消されたとして再訪
    shouldFailRanking = false;
    mockRankingData = [
      { rank: 1, staffId: 'S001', staffName: 'テスト配布員', count: 999, isMe: true }
    ];
    mockMySummary = { rank: 1, count: 999 };

    // 他画面に行ってから戻る
    await errorPage.evaluate(() => window.switchPage('areas'));
    await errorPage.waitForTimeout(100);
    await errorPage.evaluate(() => window.switchPage('ranking'));

    // 再試行で正常取得・表示されること
    await errorPage.waitForFunction(() => {
      const el = document.getElementById('ranking-list');
      return el && el.innerHTML.includes('999枚');
    }, { timeout: 5000 });

    const htmlE2 = await errorRankingList.innerHTML();
    assert.ok(htmlE2.includes('999枚'), '再訪時に正常に再取得・表示されたこと');
    console.log("✅ Case E PASS\n");
    await errorPage.close();

    console.log("==================================================================");
    console.log("🎉 ALL REAL-BROWSER RANKING AUDITS PASSED PERFECTLY!");
    console.log("==================================================================\n");

  } finally {
    await browser.close();
    server.close();
  }
}

runBrowserRankingTests().catch(err => {
  console.error("❌ Browser Audit Failed:", err);
  process.exit(1);
});
