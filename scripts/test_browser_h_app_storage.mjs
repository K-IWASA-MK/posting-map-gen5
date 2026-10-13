import { chromium } from 'playwright';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8097;

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

async function runBrowserStorageTests() {
  console.log("==================================================================");
  console.log("📦 H-APP STORAGE REGISTER & LIST REAL-BROWSER AUDIT (Wave 9)");
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

  const page = await context.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[DEBUG]') || text.includes('StorageView') || text.includes('fetchFlyerStock')) {
      console.log('  [BROWSER CONSOLE]', msg.type(), text);
    }
  });
  page.on('pageerror', err => console.log('  [BROWSER ERROR]', err.message));

  // Mock LIFF SDK
  await page.route('**/sdk.js', route => {
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
  await page.route('**/maps/api/js*', route => {
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

  // Mock GAS API
  let getFlyerStockCallCount = 0;
  let mockGetFlyerStockDelay = 0;
  let mockStocksData = [
    { id: "ST001", staffId: "S002", staffName: "なお", location: "桑名市", count: 2000, updatedAt: "2026/10/06 10:00" },
    { id: "ST002", staffId: "S001", staffName: "テスト配布員", location: "桑名市", count: 500, updatedAt: "2026/10/06 12:00", isMe: true }
  ];
  let updatedStockPayload = null;

  await page.route('**/*exec*', async route => {
    const postData = route.request().postData();
    let action = '';
    try {
      const parsed = JSON.parse(postData || '{}');
      action = parsed.action;
      if (action === 'updateFlyerStock') {
        updatedStockPayload = parsed;
      }
    } catch(e) {}

    if (action === 'getFlyerStock') {
      getFlyerStockCallCount++;
      if (mockGetFlyerStockDelay > 0) {
        await new Promise(r => setTimeout(r, mockGetFlyerStockDelay));
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          stocks: mockStocksData,
          myStock: { location: "桑名市", count: mockStocksData.find(s => s.isMe)?.count || 500 }
        })
      });
      return;
    }

    if (action === 'updateFlyerStock') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: "更新完了"
        })
      });
      return;
    }

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        authorized: true,
        registered: true,
        staffId: 'S001',
        staffName: 'テスト配布員',
        staff: {
          id: 'S001',
          name: 'テスト配布員',
          branch: '桑名支部',
          registrationDate: '2025/07/01'
        },
        areas: [],
        stats: {}
      })
    });
  });

  try {
    console.log("🚀 Navigating to H-App...");
    await page.goto(`http://localhost:${PORT}/app/index.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // 認証済み配布員情報のセットアップ
    await page.evaluate(() => {
      localStorage.setItem('user_info', JSON.stringify({
        id: 'S001',
        first: '太郎',
        last: '桑名',
        branch: '桑名支部'
      }));

      // ローディングオーバーレイを除去
      const loading = document.getElementById('loading');
      if (loading) {
        loading.style.display = 'none';
        loading.remove();
      }

      // アプリメインコンテナを表示
      const appEl = document.getElementById('app');
      if (appEl) {
        appEl.classList.remove('hidden', 'opacity-0');
        appEl.style.display = 'flex';
        appEl.style.opacity = '1';
      }
    });

    // Dialog alert ハンドラ
    let lastDialogMessage = '';
    page.on('dialog', async dialog => {
      lastDialogMessage = dialog.message();
      await dialog.accept();
    });

    // ─────────────────────────────────────────────────────────
    // 👉 CASE A: 在庫登録画面への遷移 & 初期表示検証
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE A: Storage register page initialization & display");
    getFlyerStockCallCount = 0;
    mockGetFlyerStockDelay = 100;

    await page.evaluate(() => {
      if (typeof window.switchPage === 'function') {
        window.switchPage('storage-register');
      }
    });
    // 非同期 fetchStock 完了を待機
    await page.waitForTimeout(600);

    const initFormState = await page.evaluate(() => {
      const locText = document.getElementById('storage-location-text');
      const locSelect = document.getElementById('storage-register-location');
      const countInput = document.getElementById('storage-register-count');
      const countDisplay = document.getElementById('storage-register-count-text');
      const submitBtn = document.getElementById('btn-storage-register-submit');
      return {
        locText: locText ? locText.textContent.trim() : null,
        location: locSelect ? locSelect.value : null,
        count: countInput ? countInput.value : null,
        countDisplayText: countDisplay ? countDisplay.textContent.trim() : null,
        btnText: submitBtn ? submitBtn.textContent.trim() : null,
        btnDisabled: submitBtn ? submitBtn.disabled : null
      };
    });

    assert.ok(initFormState.locText, '保管場所テキストが表示されていること');
    assert.ok(initFormState.location, '保管場所が設定されていること');
    assert.equal(initFormState.count, '500', '初期枚数 500 が反映されていること');
    assert.equal(initFormState.countDisplayText, '500', '枚数表示 500 が描画されていること');
    assert.equal(initFormState.btnDisabled, false, 'ボタンが活性化されていること');
    console.log("  ✅ Case A PASSED: Storage register page initialized successfully\n");

    // ─────────────────────────────────────────────────────────
    // 👉 CASE B: 画面復帰時のキャッシュ即時表示（復元検証）
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE B: Instant cache display upon page return");
    // 設定画面へ遷移
    await page.evaluate(() => window.switchPage('settings'));
    await page.waitForTimeout(250);

    // 在庫登録へ戻る（APIを500ms遅延）
    getFlyerStockCallCount = 0;
    mockGetFlyerStockDelay = 500;
    const switchStartTime = Date.now();
    await page.evaluate(() => window.switchPage('storage-register'));

    // ★ API完了前（80ms以内）にキャッシュから即座に値が入っていることを検証
    await page.waitForTimeout(80);
    const elapsedB = Date.now() - switchStartTime;
    const cacheFormState = await page.evaluate(() => {
      const countInput = document.getElementById('storage-register-count');
      const countDisplay = document.getElementById('storage-register-count-text');
      return {
        count: countInput ? countInput.value : null,
        countDisplay: countDisplay ? countDisplay.textContent.trim() : null
      };
    });

    assert.equal(cacheFormState.count, '500', 'API通信完了を待たずキャッシュから即座に値が入ること');
    assert.equal(cacheFormState.countDisplay, '500', 'API通信完了を待たずキャッシュから即座に表示されること');
    console.log(`  ✅ Case B PASSED: Instant cache verified in ${elapsedB}ms\n`);
    await page.waitForTimeout(500); // 遅延APIの完了を待機

    // ─────────────────────────────────────────────────────────
    // 👉 CASE C: 高速往復時の通信重複防止 (In-flight共有)（復元検証）
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE C: Prevent duplicate in-flight requests during rapid switching");
    getFlyerStockCallCount = 0;
    mockGetFlyerStockDelay = 400;

    await page.evaluate(() => window.switchPage('storage-register'));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.switchPage('settings'));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.switchPage('storage-register'));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.switchPage('storage-register'));

    console.log(`  [In-flight Check] API calls during rapid switching: ${getFlyerStockCallCount}`);
    assert.ok(getFlyerStockCallCount <= 1, `In-flight共有により多重通信が防止されること (Calls: ${getFlyerStockCallCount})`);
    console.log("  ✅ Case C PASSED: Rapid switching in-flight deduplication verified\n");
    await page.waitForTimeout(400);

    // ─────────────────────────────────────────────────────────
    // 👉 CASE D: 遅延GET到着時の手入力保護（復元検証）
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE D: Protect user input against delayed GET arrival");
    mockStocksData = [
      { id: "ST001", staffId: "S002", staffName: "なお", location: "桑名市", count: 2000, updatedAt: "2026/10/06 10:00" },
      { id: "ST002", staffId: "S001", staffName: "テスト配布員", location: "桑名市", count: 9999, updatedAt: "2026/10/06 12:00", isMe: true }
    ];
    mockGetFlyerStockDelay = 400;

    // 画面を開く（API通信開始）
    await page.evaluate(() => window.switchPage('settings'));
    await page.waitForTimeout(100);
    await page.evaluate(() => window.switchPage('storage-register'));

    // ★ API通信中にユーザーが「777」と入力
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const container = document.getElementById('storage-register-count-container');
      const input = document.getElementById('storage-register-count');
      const display = document.getElementById('storage-register-count-display');
      if (input && display) {
        input.classList.remove('hidden');
        display.classList.add('hidden');
        input.dataset.userEditing = 'true';
        input.value = '777';
        input.dispatchEvent(new Event('input'));
      }
    });

    const editingVal = await page.$eval('#storage-register-count', el => el.value);
    console.log(`  [Input Lock Check] User typed during in-flight: "${editingVal}"`);

    // ★ 450ms待機し、サーバーからの遅延レスポンス（9999枚）を到着させる
    await page.waitForTimeout(450);

    // ★ 検証: レスポンス（9999枚）で上書きされず、手入力値「777」が完全保護されていること
    const postDelayedVal = await page.$eval('#storage-register-count', el => el.value);
    assert.equal(postDelayedVal, '777', `遅延APIレスポンス後も手入力値 777 が保護されること (actual: ${postDelayedVal})`);
    console.log("  ✅ Case D PASSED: User input protected from delayed GET response\n");

    // ─────────────────────────────────────────────────────────
    // 👉 CASE E: 入力フォーマッター & ボタン文言動的更新
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE E: Input formatter & button text dynamic update");
    await page.evaluate(() => {
      const countInput = document.getElementById('storage-register-count');
      countInput.value = '1500';
      countInput.dispatchEvent(new Event('input'));
      countInput.dispatchEvent(new Event('blur'));
    });
    await page.waitForTimeout(300);

    const updatedInputState = await page.evaluate(() => {
      const countDisplay = document.getElementById('storage-register-count-text');
      const submitBtn = document.getElementById('btn-storage-register-submit');
      return {
        countDisplayText: countDisplay ? countDisplay.textContent.trim() : null,
        btnText: submitBtn ? submitBtn.textContent.trim() : null
      };
    });

    assert.equal(updatedInputState.countDisplayText, '1,500', 'カンマ区切りで 1,500 とフォーマットされること');
    assert.equal(updatedInputState.btnText, 'チラシ枚数を更新する', 'ボタン文言が「更新する」になること');
    console.log("  ✅ Case E PASSED: Input formatter & button text verified\n");

    // ─────────────────────────────────────────────────────────
    // 👉 CASE F: 在庫更新の送信 & アラート & ボタン復元
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE F: Stock update submission & feedback cycle");
    await page.evaluate(() => {
      window.submitFlyerStock();
    });
    await page.waitForTimeout(800);

    assert.ok(lastDialogMessage.includes('チラシ枚数を更新しました'), '更新成功のアラートが表示されること');
    assert.ok(updatedStockPayload, 'API にペイロードが送信されたこと');
    assert.equal(updatedStockPayload.count, 1500, '更新枚数 1500 が送信されたこと');

    const postSubmitBtnState = await page.evaluate(() => {
      const btn = document.getElementById('btn-storage-register-submit');
      return {
        disabled: btn ? btn.disabled : null,
        text: btn ? btn.textContent.trim() : null
      };
    });
    assert.equal(postSubmitBtnState.disabled, false, '送信完了後にボタンが活性復元されること');
    console.log("  ✅ Case F PASSED: Stock update submitted & button state restored\n");

    // ─────────────────────────────────────────────────────────
    // 👉 CASE G: 在庫一覧画面への遷移 & 一覧描画検証
    // ─────────────────────────────────────────────────────────
    console.log("👉 CASE G: Storage list page transition & render");
    await page.evaluate(() => {
      if (typeof window.switchPage === 'function') {
        window.switchPage('storage-list');
      }
    });
    await page.waitForTimeout(600);

    const listState = await page.evaluate(() => {
      const container = document.getElementById('storage-list-container');
      const rows = container ? container.querySelectorAll('.stock-row') : [];
      const firstRow = rows[0];
      const personLabelEl = firstRow ? firstRow.querySelector('.text-left div') : null;
      const personLabelText = personLabelEl ? personLabelEl.textContent.trim() : '';
      const countEl = firstRow ? firstRow.querySelector('span.text-\\[\\#22c55e\\]') : null;
      const countText = countEl ? countEl.textContent.trim() : '';
      const dataStorageId = firstRow ? firstRow.getAttribute('data-storage-id') : null;
      return {
        hasContainer: !!container,
        rowCount: rows.length,
        hasTransferBtn: container ? container.innerHTML.includes('受渡要請') : false,
        personLabelText,
        countText,
        dataStorageId,
        hasMyStaff: container ? container.innerHTML.includes('テスト配布員') : false
      };
    });

    assert.ok(listState.hasContainer, '在庫一覧コンテナが存在すること');
    assert.ok(listState.rowCount >= 1, '他配布員の在庫行が表示されていること');
    assert.equal(listState.hasTransferBtn, true, '受渡要請ボタンが存在すること');
    assert.ok(listState.personLabelText.includes('S002'), '人物ラベルに S002 が含まれていること');
    assert.ok(listState.personLabelText.includes('なお'), '人物ラベルに なお が含まれていること');
    assert.ok(!listState.personLabelText.includes('ST001'), '人物ラベルのtextContentに ST001 が含まれないこと');
    assert.equal(listState.dataStorageId, 'ST001', 'data-storage-id には ST001 が維持されていること');
    assert.ok(listState.countText.includes('2,000枚'), '枚数表示に 2,000枚 が含まれていること');
    assert.equal(listState.hasMyStaff, false, '自分の在庫（テスト配布員）は一覧から除外されていること');
    console.log("  ✅ Case G PASSED: Storage list identity display (S002 なお, 2,000枚, ST001 excluded from person label) verified\n");

    console.log("==================================================================");
    console.log("🏆 ALL REAL-BROWSER STORAGE AUDIT CASES (A - G) PASSED!");
    console.log("==================================================================");

  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

runBrowserStorageTests().catch(err => {
  console.error("❌ Browser test failed:", err);
  process.exit(1);
});
