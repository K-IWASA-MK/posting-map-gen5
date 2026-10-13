import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 8097;
const rootDir = process.cwd();

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let relativePath = req.url.split('?')[0];
      if (relativePath.startsWith('/app/')) {
        relativePath = relativePath.replace('/app/', '/active/h-app/');
      } else if (relativePath === '/app') {
        relativePath = '/active/h-app/index.html';
      } else if (relativePath.startsWith('/business/')) {
        relativePath = relativePath.replace('/business/', '/active/business/');
      }
      let filePath = path.join(rootDir, relativePath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
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
            if (configText.includes('gasWebAppUrl: ""')) {
              configText = configText.replace('gasWebAppUrl: ""', `gasWebAppUrl: "http://localhost:${PORT}/mock-exec"`);
            }
            if (configText.includes('liffId: ""')) {
              configText = configText.replace('liffId: ""', 'liffId: "test-liff-id"');
            }
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

async function runBrowserNumpadTests() {
  console.log("==================================================================");
  console.log("📱 H-APP NUMPAD VIEW REAL-BROWSER VERIFICATION (CASES A - G)");
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

  // Mock LIFF SDK
  await page.route('**/sdk.js', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.liff = {
          init: () => Promise.resolve(),
          isLoggedIn: () => true,
          getAccessToken: () => 'stub-access-token',
          getIDToken: () => 'stub-id-token',
          getDecodedIDToken: () => ({ sub: 'U_TEST_USER_NUMPAD' }),
          getProfile: () => Promise.resolve({ userId: 'U_TEST_USER_NUMPAD', displayName: 'テスト配布員' })
        };
      `
    });
  });

  // Mock API requests
  await page.route('**/mock-exec', route => {
    const postData = route.request().postData() || '';
    let parsed = {};
    try {
      parsed = JSON.parse(postData);
    } catch (e) {}

    const action = parsed.action || '';
    if (action === 'getStaff') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'SUCCESS',
          staff: { id: 'ST_001', name: 'テスト配布員', branch: '本部' },
          role: 'STAFF'
        })
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'SUCCESS' })
      });
    }
  });

  try {
    await page.goto(`http://localhost:${PORT}/app/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // モックの注入（カメラ・GPS・画像変換）
    await page.evaluate(() => {
      window.mockCameraCalls = 0;
      window.mockGpsCalls = 0;

      // capturePhoto モック
      window.capturePhoto = function() {
        window.mockCameraCalls++;
        const dummyBlob = new Blob(['dummy-image-data'], { type: 'image/jpeg' });
        return Promise.resolve(dummyBlob);
      };

      // getGPSLocation モック
      window.getGPSLocation = function() {
        window.mockGpsCalls++;
        return Promise.resolve({ latitude: 35.06, longitude: 136.68, accuracy: 10 });
      };

      // blobToBase64 モック
      window.blobToBase64 = function(blob) {
        return Promise.resolve('data:image/jpeg;base64,DUMMY_BASE64_DATA');
      };

      // allPoints にテストポイントをセット
      window.allPoints = [
        {
          rowId: 101,
          areaName: '中央町一丁目',
          count: 100,
          isDone: false,
          syncStatus: null
        },
        {
          rowId: 102,
          areaName: '中央町二丁目',
          count: 200,
          isDone: false,
          syncStatus: null
        }
      ];
    });

    console.log("🚀 Page initialized with mocks. Running test cases...\n");

    // ─────────────────────────────────────────────────────────────
    // CASE A: openNumpad によるモーダル表示と初期値反映
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE A: openNumpad modal open and initial value");
    await page.evaluate(() => {
      window.openNumpad('中央町一丁目', 101, 100);
    });

    const isModalVisibleA = await page.evaluate(() => {
      const modal = document.getElementById('numpad-modal');
      return modal && !modal.classList.contains('pointer-events-none') && !modal.classList.contains('opacity-0');
    });
    const displayValA = await page.textContent('#numpad-display');

    if (!isModalVisibleA || displayValA.trim() !== '100') {
      throw new Error(`Case A Failed: isVisible=${isModalVisibleA}, displayVal=${displayValA}`);
    }
    console.log("  ✅ Case A PASSED: Modal visible, display = '100'");

    // ─────────────────────────────────────────────────────────────
    // CASE B: キー入力・5桁上限・クリア
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE B: Key press, 5-digit cap, 'C' clear");
    // 'C' を押してクリア
    await page.click('button:has-text("C")');
    let displayValB = await page.textContent('#numpad-display');
    if (displayValB.trim() !== '0') throw new Error(`Case B Failed at Clear: ${displayValB}`);

    // '1', '2', '3', '4', '5' を入力
    for (const d of ['1', '2', '3', '4', '5']) {
      await page.click(`div.grid button:has-text("${d}")`);
    }
    displayValB = await page.textContent('#numpad-display');
    if (displayValB.trim() !== '12345') throw new Error(`Case B Failed at 5 digits: ${displayValB}`);

    // 6桁目の '6' は無視される
    await page.click('div.grid button:has-text("6")');
    displayValB = await page.textContent('#numpad-display');
    if (displayValB.trim() !== '12345') throw new Error(`Case B Failed at 6th digit cap: ${displayValB}`);

    console.log("  ✅ Case B PASSED: Input buffer, 5-digit cap, and 'C' clear verified");

    // ─────────────────────────────────────────────────────────────
    // CASE C: キャンセル押下時の非表示とチェックボックス復元
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE C: Cancel close and checkbox rollback");
    await page.evaluate(() => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.id = 'test-mock-cb';
      document.body.appendChild(cb);
      window.openNumpad('中央町一丁目', 101, 100, true, cb);
    });

    await page.click('#numpad-close');
    const isModalHiddenC = await page.evaluate(() => {
      const modal = document.getElementById('numpad-modal');
      const cb = document.getElementById('test-mock-cb');
      return modal.classList.contains('pointer-events-none') && cb.checked === false;
    });
    if (!isModalHiddenC) throw new Error("Case C Failed: Modal not hidden or checkbox not reset");
    console.log("  ✅ Case C PASSED: Cancel hides modal and resets checkbox");

    // ─────────────────────────────────────────────────────────────
    // CASE D: OK押下時の確定後テンキー非表示 (hide) とモック連携
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE D: OK confirm hides numpad and executes workflow");
    await page.evaluate(() => {
      window.openNumpad('中央町一丁目', 101, 0);
    });
    await page.click('div.grid button:has-text("5")');
    await page.click('div.grid button:has-text("0")');

    // OKボタン押下
    await page.click('button:has-text("OK")');

    // 即座にテンキーが非表示になっていること
    const isModalHiddenD = await page.evaluate(() => {
      const modal = document.getElementById('numpad-modal');
      return modal.classList.contains('pointer-events-none') && modal.classList.contains('opacity-0');
    });
    if (!isModalHiddenD) throw new Error("Case D Failed: Numpad modal did not hide on OK");

    // 非同期バックグラウンド処理の完了を待機
    await page.waitForTimeout(300);

    const workflowExecutedD = await page.evaluate(() => {
      const p = window.allPoints.find(point => point.rowId === 101);
      return {
        cameraCalls: window.mockCameraCalls,
        gpsCalls: window.mockGpsCalls,
        draftCreated: p && p.count === 50 && p.photoBase64 === 'data:image/jpeg;base64,DUMMY_BASE64_DATA'
      };
    });

    if (workflowExecutedD.cameraCalls !== 1 || !workflowExecutedD.draftCreated) {
      throw new Error(`Case D Failed: ${JSON.stringify(workflowExecutedD)}`);
    }
    console.log("  ✅ Case D PASSED: Modal hidden immediately, Draft created with 50 sheets");

    // ─────────────────────────────────────────────────────────────
    // CASE E: OK連打抑止（先行ロック）
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE E: Rapid click prevention on OK");
    await page.evaluate(() => {
      window.mockCameraCalls = 0;
      window.openNumpad('中央町二丁目', 102, 30);
    });

    // OKを素早く3回連続クリック
    await Promise.all([
      page.click('button:has-text("OK")'),
      page.click('button:has-text("OK")').catch(() => {}),
      page.click('button:has-text("OK")').catch(() => {})
    ]);

    await page.waitForTimeout(300);
    const cameraCallsE = await page.evaluate(() => window.mockCameraCalls);
    if (cameraCallsE !== 1) {
      throw new Error(`Case E Failed: cameraCalls expected 1 but got ${cameraCallsE}`);
    }
    console.log("  ✅ Case E PASSED: In-flight lock prevented duplicate camera/GPS activations");

    // ─────────────────────────────────────────────────────────────
    // CASE F: 詳細モーダル再描画プレビュー
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE F: Detail modal preview updated with MISSION COMPLETED");
    await page.evaluate(() => {
      // 詳細モーダルコンテナをDOMに準備
      let detailContent = document.getElementById('detail-modal-content');
      if (!detailContent) {
        detailContent = document.createElement('div');
        detailContent.id = 'detail-modal-content';
        document.body.appendChild(detailContent);
      }
      window.currentPointDetailRowId = 101;
      // 101 の再描画をテスト
      const p = window.allPoints.find(point => point.rowId === 101);
      detailContent.innerHTML = window.renderDetailModalContent({ ...p, isDone: true });
    });

    const hasMissionCompletedF = await page.evaluate(() => {
      const content = document.getElementById('detail-modal-content');
      return content && content.textContent.includes('MISSION COMPLETED');
    });
    if (!hasMissionCompletedF) {
      throw new Error("Case F Failed: Detail modal does not contain MISSION COMPLETED");
    }
    console.log("  ✅ Case F PASSED: Detail modal preview successfully renders MISSION COMPLETED");

    // ─────────────────────────────────────────────────────────────
    // CASE G: 画面切替時の安全性（Draft保存維持と誤描画防止）
    // ─────────────────────────────────────────────────────────────
    console.log("👉 CASE G: Screen switch safety (Draft persistence without corrupting another modal)");
    await page.evaluate(() => {
      // 現在開いている画面を 102 に切り替える
      window.currentPointDetailRowId = 102;
      const detailContent = document.getElementById('detail-modal-content');
      detailContent.innerHTML = '<div>ROW 102 INITIAL MODAL</div>';

      // 101 のテンキーを開いて OK を実行
      window.openNumpad('中央町一丁目', 101, 88);
      window.pressNum('OK');
    });

    await page.waitForTimeout(300);

    const screenSwitchResultG = await page.evaluate(() => {
      const p101 = window.allPoints.find(point => point.rowId === 101);
      const detailContent = document.getElementById('detail-modal-content');
      return {
        p101Count: p101 ? p101.count : null,
        detailContentText: detailContent ? detailContent.textContent : ''
      };
    });

    // 101 の Draft は 88 枚として保存されていること
    if (screenSwitchResultG.p101Count !== 88) {
      throw new Error(`Case G Failed: p101 count expected 88 but got ${screenSwitchResultG.p101Count}`);
    }
    // 現在表示中の 102 の画面は 101 の完了画面で上書きされていないこと
    if (screenSwitchResultG.detailContentText.includes('MISSION COMPLETED')) {
      throw new Error("Case G Failed: Detail modal for row 102 was incorrectly overwritten by row 101!");
    }
    console.log("  ✅ Case G PASSED: Draft preserved on 101 without overwriting row 102 modal");

    console.log("\n==================================================================");
    console.log("🏆 ALL CASES (A - G) REAL-BROWSER VERIFICATION PASSED!");
    console.log("==================================================================\n");

  } finally {
    await browser.close();
    server.close();
  }
}

runBrowserNumpadTests().catch(err => {
  console.error("🛑 Test failure:", err);
  process.exit(1);
});
