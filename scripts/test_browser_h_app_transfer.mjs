import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 8099;
const rootDir = process.cwd();

let transferCallCount = 0;
let transferPayloads = [];
let mockTransferDelay = 0;
let mockTransferStatus = 'SENT';
let shouldTransferFail = false;

let mockStocksData = [
  { staffId: 'U_TEST_USER_001', staffName: '自分スタッフ', location: '桑名市', count: 1200, isMe: true, storageId: 'ST_ME' },
  { staffId: 'HOLDER_001', staffName: '保管者A', location: '四日市市', count: 500, isMe: false, storageId: 'ST_001' }
];

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

async function runBrowserTransferTests() {
  console.log("==================================================================");
  console.log("📱 H-APP TRANSFER REQUEST REAL-BROWSER VERIFICATION (CASES A - H)");
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
          getOS: () => 'ios',
          getProfile: () => Promise.resolve({
            userId: 'U_TEST_USER_001',
            displayName: '自分スタッフ',
            pictureUrl: ''
          })
        };
      `
    });
  });

  // LocalStorage 初期データ
  await page.addInitScript(() => {
    localStorage.setItem('user_info', JSON.stringify({
      id: 'U_TEST_USER_001',
      first: '自分',
      last: 'スタッフ',
      phone: '09012345678'
    }));
  });

  page.on('console', msg => console.log('  [BROWSER LOG]', msg.text()));
  page.on('pageerror', err => console.log('  [BROWSER ERROR]', err.message));

  let alertMessages = [];
  page.on('dialog', async dialog => {
    alertMessages.push(dialog.message());
    await dialog.accept();
  });

  // Mock GAS backend
  await page.route('**/*exec*', async route => {
    const postData = route.request().postData() || '';
    let action = '';
    let payload = {};
    try {
      const parsed = JSON.parse(postData);
      action = parsed.action;
      payload = parsed.payload || {};
    } catch(e) {}

    if (action === 'getFlyerStock') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          stocks: mockStocksData
        })
      });
    }

    if (action === 'requestFlyerTransfer') {
      transferCallCount++;
      transferPayloads.push(payload);

      if (mockTransferDelay > 0) {
        await new Promise(r => setTimeout(r, mockTransferDelay));
      }

      if (shouldTransferFail) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: 'Simulated backend error' })
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: mockTransferStatus,
          message: 'Notification sent'
        })
      });
    }

    if (action === 'getStaffIdentity' || action === 'verifyLineUser') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          registered: true,
          staffId: 'U_TEST_USER_001',
          staffName: '自分スタッフ'
        })
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    });
  });

  try {
    console.log("Navigating to H-App...");
    await page.goto(`http://localhost:${PORT}/app/index.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => typeof window.switchPage === 'function' && typeof window.openTransferRequestDialog === 'function', { timeout: 10000 });
    console.log("H-App loaded successfully.\n");

    // ─── Case A: チラシ在庫一覧画面を開き、受渡要請ダイアログを表示 ────────
    console.log("▶ Case A: Open storage page and launch transfer dialog...");
    await page.evaluate(() => {
      if (typeof window.switchPage === 'function') {
        window.switchPage('storage-list');
      } else if (typeof window.initStorageListPage === 'function') {
        window.initStorageListPage();
      }
    });
    await page.waitForTimeout(500);

    // ダイアログ直接起動テスト
    await page.evaluate(() => {
      window.openTransferRequestDialog('保管者A', 'HOLDER_001', '四日市市', 500, 'ST_001');
    });
    await page.waitForTimeout(300);

    const dialogEl = await page.$('#dynamic-transfer-dialog');
    if (!dialogEl) throw new Error("Case A Failed: #dynamic-transfer-dialog was not created");
    const dialogHtml = await page.evaluate(() => document.getElementById('dynamic-transfer-dialog').innerHTML);
    if (!dialogHtml.includes('ST_001')) throw new Error("Case A Failed: storageId not rendered");
    console.log("  ✅ Case A PASSED: Transfer dialog displayed with sanitized storageId");

    // ─── Case B: 連絡方法ラジオボタン切り替え ──────────────────────────
    console.log("▶ Case B: Radio button changes placeholder dynamically...");
    await page.click('input[name="contact-method"][value="電話"]');
    let placeholder = await page.$eval('#transfer-contact-value', el => el.placeholder);
    if (placeholder !== '電話番号') throw new Error(`Case B Failed: Expected 電話番号, got ${placeholder}`);

    await page.click('input[name="contact-method"][value="メール"]');
    placeholder = await page.$eval('#transfer-contact-value', el => el.placeholder);
    if (placeholder !== 'メールアドレス') throw new Error(`Case B Failed: Expected メールアドレス, got ${placeholder}`);

    await page.click('input[name="contact-method"][value="LINE"]');
    placeholder = await page.$eval('#transfer-contact-value', el => el.placeholder);
    if (placeholder !== 'LINE ID') throw new Error(`Case B Failed: Expected LINE ID, got ${placeholder}`);
    console.log("  ✅ Case B PASSED: Placeholders update correctly for all methods");

    // ─── Case C: 未入力での送信抑止 ──────────────────────────────────
    console.log("▶ Case C: Empty contact value triggers validation alert without API call...");
    alertMessages = [];
    transferCallCount = 0;
    await page.click('#dyn-submit');
    await page.waitForTimeout(200);

    if (transferCallCount !== 0) throw new Error("Case C Failed: API was called despite empty input");
    if (!alertMessages.some(m => m.includes('連絡先を入力してください'))) {
      throw new Error("Case C Failed: Validation alert was not triggered");
    }
    console.log("  ✅ Case C PASSED: Empty input correctly blocked and alert shown");

    // ─── Case D: キャンセルボタンでダイアログ破棄 ─────────────────────
    console.log("▶ Case D: Cancel button safely destroys overlay...");
    await page.click('#dyn-cancel');
    await page.waitForTimeout(200);
    const closedDialog = await page.$('#dynamic-transfer-dialog');
    if (closedDialog) throw new Error("Case D Failed: Dialog still exists after cancel");
    console.log("  ✅ Case D PASSED: Dialog destroyed on cancel");

    // ─── Case E: 連打・多重送信の完全遮断 (Pre-Auth In-Flight Lock) ───
    console.log("▶ Case E: Rapid clicking submit button triggers only 1 API call...");
    await page.evaluate(() => {
      window.openTransferRequestDialog('保管者A', 'HOLDER_001', '四日市市', 500, 'ST_001');
    });
    await page.waitForTimeout(200);

    await page.fill('#transfer-contact-value', 'my_line_id');
    mockTransferDelay = 400; // API遅延設定
    transferCallCount = 0;
    alertMessages = [];

    // 高速3連打
    await Promise.all([
      page.click('#dyn-submit'),
      page.click('#dyn-submit').catch(() => {}),
      page.click('#dyn-submit').catch(() => {})
    ]);

    await page.waitForTimeout(700);
    if (transferCallCount !== 1) {
      throw new Error(`Case E Failed: Expected 1 API call, but got ${transferCallCount}`);
    }
    console.log("  ✅ Case E PASSED: In-flight lock strictly prevents duplicate API calls");

    // ─── Case F: 正常送信完了とダイアログ自動破棄 ──────────────────────
    console.log("▶ Case F: Successful submission closes dialog and alerts...");
    const dialogAfterSuccess = await page.$('#dynamic-transfer-dialog');
    if (dialogAfterSuccess) throw new Error("Case F Failed: Dialog remained open after success");
    if (!alertMessages.some(m => m.includes('受渡要請を送信しました'))) {
      throw new Error("Case F Failed: Success alert not displayed");
    }
    console.log("  ✅ Case F PASSED: Success alert shown and dialog closed");

    // ─── Case G: 通信失敗後のダイアログ保持と再試行 ────────────────────
    console.log("▶ Case G: Failure keeps dialog open and enables retry...");
    await page.evaluate(() => {
      window.openTransferRequestDialog('保管者B', 'HOLDER_002', '桑名市', 300, 'ST_002');
    });
    await page.waitForTimeout(200);

    await page.fill('#transfer-contact-value', 'test_retry_contact');
    shouldTransferFail = true;
    mockTransferDelay = 50;
    alertMessages = [];

    await page.click('#dyn-submit');
    await page.waitForTimeout(300);

    // ダイアログは閉じられていないこと
    const dialogAfterFail = await page.$('#dynamic-transfer-dialog');
    if (!dialogAfterFail) throw new Error("Case G Failed: Dialog was closed after failure");
    const isBtnDisabled = await page.$eval('#dyn-submit', b => b.disabled);
    if (isBtnDisabled) throw new Error("Case G Failed: Submit button remained disabled after failure");

    // 再試行（今度は成功させる）
    shouldTransferFail = false;
    await page.click('#dyn-submit');
    await page.waitForTimeout(300);

    const dialogAfterRetry = await page.$('#dynamic-transfer-dialog');
    if (dialogAfterRetry) throw new Error("Case G Failed: Dialog not closed after retry success");
    console.log("  ✅ Case G PASSED: Failure handled, dialog kept open, and retry succeeded");

    // ─── Case H: 閉じる→再表示時の世代遮断 (Stale Abort) ──────────────
    console.log("▶ Case H: Stale slow response does not affect newly opened dialog...");
    mockTransferDelay = 500; // 遅延
    await page.evaluate(() => {
      window.openTransferRequestDialog('旧保管者', 'OLD_ID', '南', 10, 'ST_OLD');
    });
    await page.waitForTimeout(200);
    await page.fill('#transfer-contact-value', 'old_contact');

    // 送信開始（通信中）
    page.click('#dyn-submit').catch(() => {});
    await page.waitForTimeout(100);

    // 通信中にキャンセルして別のダイアログを起動
    await page.evaluate(() => {
      window.closeTransferRequestDialog();
      window.openTransferRequestDialog('新保管者', 'NEW_ID', '北', 20, 'ST_NEW');
    });
    await page.waitForTimeout(700); // 古い通信が完了するのを待つ

    // 新しいダイアログが勝手に閉じられていないこと
    const activeDialog = await page.$('#dynamic-transfer-dialog');
    if (!activeDialog) throw new Error("Case H Failed: Stale response erroneously closed new dialog");
    const activeHtml = await page.evaluate(() => document.getElementById('dynamic-transfer-dialog').innerHTML);
    if (!activeHtml.includes('ST_NEW')) throw new Error("Case H Failed: Active dialog was corrupted");

    // クリーンアップ
    await page.evaluate(() => window.closeTransferRequestDialog());
    console.log("  ✅ Case H PASSED: Session Generation Guard completely protects against stale cross-talk");

    console.log("\n==================================================================");
    console.log("🎉 ALL CASES PASSED: REAL-BROWSER TRANSFER INTEGRATION VERIFIED");
    console.log("==================================================================");

  } finally {
    await browser.close();
    server.close();
  }
}

runBrowserTransferTests().catch(err => {
  console.error("🛑 Browser test failed:", err);
  process.exit(1);
});
