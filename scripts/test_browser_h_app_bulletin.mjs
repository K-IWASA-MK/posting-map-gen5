/**
 * scripts/test_browser_h_app_bulletin.mjs
 * 
 * Wave 11: 掲示板（Bulletin）投稿・連絡モーダルの実ブラウザ結合テスト（Cases A〜G）
 */

import { chromium } from 'playwright';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8099;

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/' || reqPath === '/app' || reqPath === '/app/') {
        reqPath = '/active/h-app/index.html';
      } else if (reqPath.startsWith('/app/')) {
        reqPath = '/active/h-app/' + reqPath.substring(5);
      } else if (reqPath.startsWith('/business/')) {
        reqPath = '/active/business/' + reqPath.substring(10);
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

async function runBrowserBulletinTests() {
  console.log("==================================================================");
  console.log("💬 H-APP BULLETIN REAL-BROWSER AUDIT (Wave 11)");
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

  const apiCalls = [];
  let bulletinPosts = [
    { id: 'BP_1', updatedAt: '2026/10/02 10:00', staffId: 'STAFF_001', staffName: 'リーダーA', message: '雨天注意してください', isMe: false },
    { id: 'BP_2', updatedAt: '2026/10/02 11:00', staffId: 'STAFF_002', staffName: 'スタッフB', message: '南区完了しました', isMe: false }
  ];

  // 外部通信完全遮断 & API/SDKモック化
  await context.route('**/*', async (route) => {
    const reqUrl = route.request().url();

    // A. GAS WebApp API 呼び出し (mock-exec または exec)
    if (reqUrl.includes('mock-exec') || reqUrl.includes('exec') || reqUrl.includes('script.google.com')) {
      const postData = route.request().postData();
      let action = 'unknown';
      let payload = {};
      try {
        const parsed = JSON.parse(postData);
        action = parsed.action;
        payload = parsed;
      } catch (e) {
        if (postData) {
          const params = new URLSearchParams(postData);
          action = params.get('action') || 'unknown';
        }
      }

      apiCalls.push({ action, payload, time: Date.now() });

      if (action === 'getRegistrationStatus') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            registered: true,
            staff: {
              id: 'STAFF_007',
              staffId: 'STAFF_007',
              name: '桑名 太郎',
              role: 'POSTING_STAFF',
              branch: '桑名支部'
            }
          })
        });
      }

      if (action === 'getStaffIdentity') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            registered: true,
            staffId: 'STAFF_007',
            staffName: '桑名 太郎',
            branch: '桑名支部'
          })
        });
      }

      if (action === 'registerStaff') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            id: 'STAFF_007',
            staffId: 'STAFF_007',
            staffName: '桑名 太郎',
            branch: '桑名支部'
          })
        });
      }

      if (action === 'getMapsApiKey') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, key: 'mock-key' })
        });
      }

      if (action === 'getSystemSummary') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, summary: {} })
        });
      }

      if (action === 'getBulletinPosts') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            posts: bulletinPosts
          })
        });
      }

      if (action === 'createBulletinPost') {
        const newPost = {
          id: 'BP_' + Date.now(),
          updatedAt: '2026/10/02 12:00',
          staffId: payload.staffId,
          staffName: payload.staffName,
          message: payload.message,
          isMe: false
        };
        bulletinPosts.push(newPost);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            post: newPost
          })
        });
      }

      if (action === 'sendBulletinContact') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            status: 'SENT'
          })
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
    }

    // B. LIFF SDK
    if (reqUrl.includes('sdk.js') || reqUrl.includes('line-scdn.net')) {
      return route.fulfill({
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
    }

    // C. Google Maps API
    if (reqUrl.includes('maps/api/js') || reqUrl.includes('maps.googleapis.com')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.google = {
            maps: {
              Map: class {
                constructor() { this.listeners = {}; }
                setCenter() {}
                setZoom() {}
                addListener(e, cb) { this.listeners[e] = cb; }
              },
              Marker: class {
                constructor() {}
                setMap() {}
                setPosition() {}
                setIcon() {}
                addListener() {}
              },
              LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
              LatLngBounds: class { constructor() {} extend() {} },
              Size: class { constructor() {} },
              Point: class { constructor() {} },
              event: { addListener: () => ({ remove: () => {} }), trigger: () => {} }
            }
          };
        `
      });
    }

    // D. ローカル試験サーバーへの静的ファイル要求
    if (reqUrl.startsWith(`http://localhost:${PORT}`) || reqUrl.startsWith(`http://127.0.0.1:${PORT}`)) {
      return route.continue();
    }

    // E. それ以外のすべての外部通信は完全遮断 (abort)
    return route.abort('blockedbyclient');
  });

  const page = await context.newPage();

  page.on('console', msg => console.log('  [BROWSER CONSOLE]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('  [BROWSER ERROR]', err.message));

  // dialog (alert) 自動受理とログ収集
  const dialogMessages = [];
  page.on('dialog', async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept();
  });

  // 事前認証情報注入
  await page.addInitScript(() => {
    localStorage.setItem('user_info', JSON.stringify({
      id: 'STAFF_007',
      first: '太郎',
      last: '桑名',
      branch: '桑名店'
    }));
  });

  try {
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.switchPage === 'function', { timeout: 10000 });
    await page.waitForTimeout(300);

    // 掲示板ページへ切り替え
    await page.evaluate(async () => {
      await window.switchPage('bulletin');
      if (typeof window.fetchBulletinPosts === 'function') {
        await window.fetchBulletinPosts({ force: true });
      }
    });

    await page.waitForSelector('#bulletin-message-input', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(400);

    // ────────────────────────────────────────────────────────────────
    // Case A: 掲示板一覧の初期ロード・表示
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case A: 掲示板一覧の初期ロード・表示検証");
    const postRows = await page.locator('.bulletin-row').count();
    assert.strictEqual(postRows, 2, "Case A: 2 posts rendered");
    const firstRowText = await page.locator('.bulletin-row').first().textContent();
    assert.ok(firstRowText.includes('STAFF_001'), "Case A: STAFF_001 displayed");
    assert.ok(firstRowText.includes('雨天注意'), "Case A: Message text displayed");
    console.log("  ✅ Case A PASS: 掲示板一覧が正常にレンダリング完了\n");

    // ────────────────────────────────────────────────────────────────
    // Case B: 文字数カウンタ連動（入力に伴う更新 & 150文字強調）
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case B: 文字数カウンタ連動検証");
    const inputLocator = page.locator('#bulletin-message-input');
    const counterLocator = page.locator('#bulletin-char-counter');

    await inputLocator.fill('テストメッセージ10文字！');
    await page.evaluate(() => {
      const el = document.getElementById('bulletin-message-input');
      if (window.updateBulletinCharCount) window.updateBulletinCharCount(el);
    });
    assert.strictEqual(await counterLocator.textContent(), '13 / 150', "Case B: 13 chars counter updated");

    // 150文字以上で赤色クラス付与
    await inputLocator.fill('あ'.repeat(150));
    await page.evaluate(() => {
      const el = document.getElementById('bulletin-message-input');
      if (window.updateBulletinCharCount) window.updateBulletinCharCount(el);
    });
    assert.strictEqual(await counterLocator.textContent(), '150 / 150', "Case B: 150 chars counter");
    const hasRed = await counterLocator.evaluate(el => el.classList.contains('text-red-400'));
    assert.strictEqual(hasRed, true, "Case B: Red class added at 150 chars");
    console.log("  ✅ Case B PASS: 文字数カウンタおよび超過強調が正常に連動\n");

    // ────────────────────────────────────────────────────────────────
    // Case C: 投稿送信ライフサイクル（入力保護・API成功・入力クリア・一覧更新）
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case C: 投稿送信ライフサイクル検証");
    dialogMessages.length = 0;
    await inputLocator.fill('ブラウザテスト新規投稿');
    await page.evaluate(() => {
      const el = document.getElementById('bulletin-message-input');
      if (window.updateBulletinCharCount) window.updateBulletinCharCount(el);
    });

    const submitBtn = page.locator('#btn-bulletin-submit');
    await submitBtn.click();
    await page.waitForTimeout(500);

    assert.ok(dialogMessages.some(m => m.includes('完了')), "Case C: Success alert displayed");
    assert.strictEqual(await inputLocator.inputValue(), '', "Case C: Input cleared");
    assert.strictEqual(await counterLocator.textContent(), '0 / 150', "Case C: Counter reset");
    assert.strictEqual(await submitBtn.isEnabled(), true, "Case C: Submit button enabled");

    // 新規投稿が一覧に反映されているか
    const updatedPostRows = await page.locator('.bulletin-row').count();
    assert.strictEqual(updatedPostRows, 3, "Case C: Post list updated to 3 rows");
    console.log("  ✅ Case C PASS: 投稿ライフサイクル（保護・送信・クリア・再描画）完了\n");

    // ────────────────────────────────────────────────────────────────
    // Case D: 投稿バリデーション（空文字時の alert・API 0件）
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case D: 投稿バリデーション検証");
    dialogMessages.length = 0;
    const preCount = apiCalls.filter(c => c.action === 'createBulletinPost').length;

    await inputLocator.fill('   ');
    await submitBtn.click();
    await page.waitForTimeout(100);

    assert.ok(dialogMessages.some(m => m.includes('メッセージを入力')), "Case D: Empty alert displayed");
    const postCount = apiCalls.filter(c => c.action === 'createBulletinPost').length;
    assert.strictEqual(preCount, postCount, "Case D: Exactly 0 API calls for empty message");
    console.log("  ✅ Case D PASS: 空欄バリデーションで通信完全遮断\n");

    // ────────────────────────────────────────────────────────────────
    // Case E: 連絡ダイアログオープン・ラジオ切り替え（placeholder連動）
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case E: 連絡ダイアログオープン・ラジオ切り替え検証");
    // STAFF_001 の連絡ボタンをクリック
    const contactBtn = page.locator('.bulletin-row[data-staff-id="STAFF_001"] button');
    await contactBtn.click();
    await page.waitForTimeout(200);

    const dialogLocator = page.locator('#dynamic-bulletin-contact-dialog');
    assert.strictEqual(await dialogLocator.count(), 1, "Case E: Dialog opened");

    const contactValLocator = page.locator('#bulletin-contact-value');
    assert.strictEqual(await contactValLocator.getAttribute('placeholder'), 'LINE ID', "Case E: Initial placeholder is LINE ID");

    // 電話ラジオ選択
    await page.locator('input[name="bulletin-contact-method"][value="電話"]').check();
    assert.strictEqual(await contactValLocator.getAttribute('placeholder'), '電話番号', "Case E: Placeholder switched to 電話番号");

    // メールラジオ選択
    await page.locator('input[name="bulletin-contact-method"][value="メール"]').check();
    assert.strictEqual(await contactValLocator.getAttribute('placeholder'), 'メールアドレス', "Case E: Placeholder switched to メールアドレス");
    console.log("  ✅ Case E PASS: ダイアログ表示およびラジオ連動正常\n");

    // ────────────────────────────────────────────────────────────────
    // Case F: 連絡ダイアログ送信ライフサイクル（入力保護・API成功・破棄・alert）
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case F: 連絡ダイアログ送信ライフサイクル検証");
    dialogMessages.length = 0;
    await contactValLocator.fill('kuwana_staff@example.com');

    const contactSubmitBtn = page.locator('#btn-bulletin-contact-submit');
    await contactSubmitBtn.click();
    await page.waitForTimeout(400);

    assert.strictEqual(await dialogLocator.count(), 0, "Case F: Dialog removed after send");
    assert.ok(dialogMessages.some(m => m.includes('送信しました')), "Case F: Success alert shown");

    const contactCall = apiCalls.find(c => c.action === 'sendBulletinContact');
    assert.ok(contactCall !== undefined, "Case F: sendBulletinContact API issued");
    assert.strictEqual(contactCall.payload.targetStaffId, 'STAFF_001', "Case F: targetStaffId is STAFF_001");
    assert.strictEqual(contactCall.payload.contactMethod, 'メール', "Case F: contactMethod is メール");
    assert.strictEqual(contactCall.payload.contactValue, 'kuwana_staff@example.com', "Case F: contactValue matches");
    console.log("  ✅ Case F PASS: 連絡送信ライフサイクル完了（API発行・DOM破棄・通知）\n");

    // ────────────────────────────────────────────────────────────────
    // Case G: 連絡ダイアログのキャンセル・DOM破棄
    // ────────────────────────────────────────────────────────────────
    console.log("▶ Case G: 連絡ダイアログのキャンセル・DOM破棄検証");
    await contactBtn.click();
    await page.waitForTimeout(200);
    assert.strictEqual(await dialogLocator.count(), 1, "Case G: Dialog opened again");

    const cancelBtn = page.locator('#btn-bulletin-contact-cancel');
    await cancelBtn.click();
    await page.waitForTimeout(200);
    assert.strictEqual(await dialogLocator.count(), 0, "Case G: Dialog closed on cancel");
    console.log("  ✅ Case G PASS: キャンセルボタン押下によるダイアログDOM破棄正常\n");

    console.log("==================================================================");
    console.log("🎉 ALL REAL-BROWSER BULLETIN AUDIT CASES PASSED (A〜G)");
    console.log("==================================================================");

  } finally {
    await browser.close();
    server.close();
  }
}

runBrowserBulletinTests().catch(err => {
  console.error("❌ Browser Audit Failed:", err);
  process.exit(1);
});
