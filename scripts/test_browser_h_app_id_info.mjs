import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 8098;
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

async function runBrowserIdInfoTests() {
  console.log("==================================================================");
  console.log("📱 H-APP STAFF ID INFO VIEW REAL-BROWSER VERIFICATION (CASES A - C)");
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
          getProfile: () => Promise.resolve({
            userId: 'U1234567890abcdef',
            displayName: 'テスト配布員',
            pictureUrl: 'https://example.com/pic.jpg'
          }),
          getIDToken: () => 'mock-id-token'
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
  await page.route('**/mock-exec*', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        authorized: true,
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

    // メインアプリ表示 & デジタル配布員証ページ（settings）描画 & ローディング消去
    await page.evaluate(async () => {
      localStorage.setItem('branch_name', '桑名支部ブラウザ実測');

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

      if (typeof window.switchPage === 'function') {
        await window.switchPage('settings', true);
      }
      const pageSettings = document.getElementById('page-settings');
      if (pageSettings) {
        pageSettings.classList.remove('hidden');
        pageSettings.style.opacity = '1';
        pageSettings.style.transform = 'none';
      }
      const settingsContent = document.getElementById('settings-content');
      if (settingsContent && typeof window.renderStaffCard === 'function') {
        settingsContent.innerHTML = window.renderStaffCard({
          id: 'S001',
          last: 'テスト',
          first: '太郎',
          picture: ''
        }, {
          branchName: '桑名支部ブラウザ実測'
        });
      }
    });

    await page.waitForTimeout(500);

    // ─── CASE A: Terms モーダル表示・確認・クローズ ───
    console.log("👉 CASE A: Terms of Service modal open & close");
    const termsBtn = page.locator('text=Terms');
    await termsBtn.waitFor({ state: 'visible', timeout: 5000 });
    await termsBtn.click();

    const modal = page.locator('#id-info-modal');
    await modal.waitFor({ state: 'attached' });
    const modalClass = await modal.getAttribute('class');
    if (modalClass.includes('opacity-0') || modalClass.includes('pointer-events-none')) {
      throw new Error(`Modal should not have opacity-0 or pointer-events-none, got: ${modalClass}`);
    }

    const titleA = await page.locator('#id-info-title').textContent();
    if (titleA !== 'Terms of Service') {
      throw new Error(`Expected title 'Terms of Service', got: ${titleA}`);
    }

    const bodyA = await page.locator('#id-info-body').textContent();
    if (!bodyA.includes('FIELD OPERATIONS SYSTEM')) {
      throw new Error(`Body does not contain expected text: ${bodyA}`);
    }
    console.log("  ✅ Case A (Open): Title and content verified");

    // モーダルを閉じる
    await page.evaluate(() => window.closeIdInfoModal());
    await page.waitForTimeout(300);
    const closedClassA = await modal.getAttribute('class');
    if (!closedClassA.includes('opacity-0')) {
      throw new Error(`Modal should have opacity-0 after close, got: ${closedClassA}`);
    }
    console.log("  ✅ Case A PASSED: Terms modal open & close verified");

    // ─── CASE B: Privacy モーダル表示・確認・クローズ ───
    console.log("👉 CASE B: Privacy Policy modal open & close");
    const privacyBtn = page.locator('text=Privacy');
    await privacyBtn.click();

    const titleB = await page.locator('#id-info-title').textContent();
    if (titleB !== 'Privacy Policy') {
      throw new Error(`Expected title 'Privacy Policy', got: ${titleB}`);
    }

    const bodyB = await page.locator('#id-info-body').textContent();
    if (!bodyB.includes('FIELD OPERATIONS SYSTEM として')) {
      throw new Error(`Body does not contain expected text: ${bodyB}`);
    }

    await page.evaluate(() => window.closeIdInfoModal());
    await page.waitForTimeout(300);
    console.log("  ✅ Case B PASSED: Privacy modal open & close verified");

    // ─── CASE C: License モーダル表示・地区名置換確認・クローズ ───
    console.log("👉 CASE C: License modal open & branch name replacement");
    const licenseBtn = page.locator('text=License');
    await licenseBtn.click();

    const titleC = await page.locator('#id-info-title').textContent();
    if (titleC !== 'License') {
      throw new Error(`Expected title 'License', got: ${titleC}`);
    }

    const bodyC = await page.locator('#id-info-body').textContent();
    if (!bodyC.includes('【桑名支部ブラウザ実測】')) {
      throw new Error(`License body did not dynamically resolve branch name: ${bodyC}`);
    }
    if (bodyC.includes('__BRANCH_NAME__')) {
      throw new Error(`Placeholder __BRANCH_NAME__ still exists!`);
    }

    await page.evaluate(() => window.closeIdInfoModal());
    await page.waitForTimeout(300);
    console.log("  ✅ Case C PASSED: License modal open & branch name replacement verified");

    console.log("\n==================================================================");
    console.log("🏆 ALL CASES (A - C) REAL-BROWSER VERIFICATION PASSED!");
    console.log("==================================================================\n");

  } catch (err) {
    console.error("❌ Test failed:", err);
    process.exit(1);
  } finally {
    await browser.close();
    server.close();
  }
}

runBrowserIdInfoTests();
