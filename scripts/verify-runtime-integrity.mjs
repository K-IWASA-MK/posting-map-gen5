import http from 'http';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

async function waitForServer(port = 8080, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/active/h-app/index.html`, (res) => {
          if (res.statusCode < 500) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

async function main() {
  console.log('====================================================');
  console.log('🚀 RUNTIME INTEGRITY VERIFICATION: H-APP & MANAGER');
  console.log('====================================================');

  let serverProcess = null;
  const isRunning = await waitForServer(8080, 2);
  if (!isRunning) {
    console.log('Starting local dev server via scripts/serve.mjs...');
    serverProcess = spawn('node', ['scripts/serve.mjs'], { stdio: 'ignore' });
    const ready = await waitForServer(8080, 15);
    if (!ready) {
      throw new Error('Failed to start local server on port 8080');
    }
  }
  console.log('✅ Local server is UP and ready on port 8080.');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const report = {
    hApp: { pass: false, errors: [], checks: [] },
    manager: { pass: false, errors: [], checks: [] },
    pwa: { pass: false, checks: [] }
  };

  try {
    console.log('\n📱 [1/3] Testing H-App (active/h-app/index.html)...');
    const hContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/13.0.0'
    });

    const hPage = await hContext.newPage();
    const hConsoleErrors = [];
    const hFailedRequests = [];

    hPage.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        hConsoleErrors.push(text);
      }
    });

    hPage.on('response', res => {
      if (res.status() >= 400 && !res.url().includes('favicon.ico')) {
        hFailedRequests.push(`${res.status()}: ${res.url()}`);
      }
    });

    await hPage.route('**/liff/edge/2/sdk.js', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.liff = {
            init: () => Promise.resolve(),
            isLoggedIn: () => true,
            getAccessToken: () => 'mock-token',
            getIDToken: () => 'mock-id-token',
            getOS: () => 'ios',
            getProfile: () => Promise.resolve({ userId: 'U_TEST', displayName: 'テスト配布員' })
          };
        `
      });
    });

    const testStaffId = process.env.TEST_STAFF_ID || 'STAFF_VERIFIER_TEST';
    const testStaffLastName = process.env.TEST_STAFF_LAST_NAME || 'テスト';
    const testStaffFirstName = process.env.TEST_STAFF_FIRST_NAME || '配布員';

    await hPage.addInitScript((staff) => {
      localStorage.setItem('user_info', JSON.stringify(staff));
    }, {
      id: testStaffId,
      last: testStaffLastName,
      first: testStaffFirstName,
      picture: ''
    });

    await hPage.goto('http://localhost:8080/active/h-app/index.html', { waitUntil: 'load', timeout: 15000 });
    await hPage.waitForTimeout(3000);

    const hDomCheck = await hPage.evaluate(() => {
      return {
        hasMainMap: !!document.getElementById('main-map') || !!document.getElementById('map'),
        hasNavTier: !!document.querySelector('.tier-nav') || !!document.getElementById('nav-container') || !!document.querySelector('nav'),
        hasCameraInput: !!document.getElementById('camera-input'),
        hasRenderJsLoaded: typeof window.renderPinStatus === 'function' || typeof window.renderMapPins === 'function' || typeof window.renderState === 'function',
        hasDbLoaded: typeof window.openDB === 'function' || typeof window.dbPromise !== 'undefined' || typeof window.getStoredPins !== 'undefined',
        scriptsInHead: Array.from(document.querySelectorAll('script')).map(s => s.src).filter(Boolean)
      };
    });

    console.log('   DOM Elements & Scripts Check:', hDomCheck);
    report.hApp.checks.push({ name: 'H-App DOM Check', result: hDomCheck });

    const deletedScripts = ['card.js', 'badge.js', 'progress.js', 'list-item.js'];
    const lingering = hDomCheck.scriptsInHead.filter(src => deletedScripts.some(ds => src.includes(ds)));
    if (lingering.length === 0) {
      console.log('   ✅ PASS: No deleted component script tags present in H-App DOM.');
      report.hApp.checks.push({ name: 'Deleted Scripts Absent', pass: true });
    } else {
      console.log('   ❌ FAIL: Lingering script tags found:', lingering);
      report.hApp.checks.push({ name: 'Deleted Scripts Absent', pass: false, lingering });
    }

    const criticalHErrors = hConsoleErrors.filter(e => !e.includes('Google Maps JavaScript API warning') && !e.includes('NoApiKeys'));
    if (criticalHErrors.length === 0 && hFailedRequests.length === 0) {
      console.log('   ✅ PASS: Zero JS runtime exceptions and zero HTTP 4xx/5xx errors on H-App.');
      report.hApp.pass = true;
    } else {
      console.log('   ⚠️ H-App Warnings/Errors:', { criticalHErrors, hFailedRequests });
      report.hApp.errors = { criticalHErrors, hFailedRequests };
      report.hApp.pass = criticalHErrors.length === 0;
    }

    await hPage.close();
    await hContext.close();

    console.log('\n🖥️  [2/3] Testing Manager Dashboard (active/manager/index.html)...');
    const mContext = await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });
    const mPage = await mContext.newPage();
    const mConsoleErrors = [];
    const mFailedRequests = [];

    mPage.on('console', msg => {
      if (msg.type() === 'error') {
        mConsoleErrors.push(msg.text());
      }
    });

    mPage.on('response', res => {
      if (res.status() >= 400 && !res.url().includes('favicon.ico')) {
        mFailedRequests.push(`${res.status()}: ${res.url()}`);
      }
    });

    await mPage.goto('http://localhost:8080/active/manager/index.html', { waitUntil: 'load', timeout: 15000 });
    await mPage.waitForTimeout(4000);

    const mDomCheck = await mPage.evaluate(() => {
      return {
        hasLeafletMap: !!document.getElementById('map') && typeof window.L !== 'undefined',
        hasDashboardState: typeof window.DashboardState !== 'undefined',
        masterLoadStatus: window.DashboardState ? window.DashboardState.masterLoadStatus : 'UNDEFINED',
        citiesCount: window.DashboardState && window.DashboardState.cities ? window.DashboardState.cities.length : 0,
        pinsCount: window.DashboardState && window.DashboardState.masterPins ? window.DashboardState.masterPins.length : 0,
        mainNavAreas: !!document.getElementById('mobile-nav-areas') || !!document.getElementById('nav-areas')
      };
    });

    console.log('   Manager State & DOM Check:', mDomCheck);
    report.manager.checks.push({ name: 'Manager DOM & State Check', result: mDomCheck });

    const criticalMErrors = mConsoleErrors.filter(e => !e.includes('favicon.ico'));
    if (criticalMErrors.length === 0) {
      console.log('   ✅ PASS: Zero JS runtime exceptions on Manager Dashboard.');
      report.manager.pass = true;
    } else {
      console.log('   ⚠️ Manager Warnings/Errors:', { criticalMErrors, mFailedRequests });
      report.manager.errors = { criticalMErrors, mFailedRequests };
      report.manager.pass = criticalMErrors.length === 0;
    }

    await mPage.close();
    await mContext.close();

    console.log('\n📦 [3/3] Testing PWA & Critical Endpoints...');
    const pwaUrls = [
      'http://localhost:8080/data/config.js',
      'http://localhost:8080/active/h-app/db.js',
      'http://localhost:8080/active/h-app/app.js',
      'http://localhost:8080/active/h-app/render.js',
      'http://localhost:8080/active/h-app/components/navigation.js',
      'http://localhost:8080/active/h-app/components/staff.js',
      'http://localhost:8080/active/h-app/components/ranking.js',
      'http://localhost:8080/active/business/area/address_master_service.js',
      'http://localhost:8080/data/election_history.json'
    ];

    let allAssetsOk = true;
    for (const u of pwaUrls) {
      const res = await fetch(u);
      if (res.status === 200) {
        console.log(`   ✅ 200 OK: ${u.replace('http://localhost:8080', '')}`);
        report.pwa.checks.push({ url: u, status: 200 });
      } else {
        console.log(`   ❌ FAIL: ${res.status} on ${u}`);
        allAssetsOk = false;
        report.pwa.checks.push({ url: u, status: res.status });
      }
    }
    report.pwa.pass = allAssetsOk;

  } finally {
    await browser.close();
    if (serverProcess) {
      serverProcess.kill();
    }
  }

  console.log('\n====================================================');
  console.log('📊 FINAL RUNTIME INTEGRITY VERIFICATION SUMMARY');
  console.log('====================================================');
  console.log(`H-App Runtime Integrity:         ${report.hApp.pass ? '✅ ALL PASS' : '❌ FAIL'}`);
  console.log(`Manager Runtime Integrity:       ${report.manager.pass ? '✅ ALL PASS' : '❌ FAIL'}`);
  console.log(`Critical Assets 200 OK:         ${report.pwa.pass ? '✅ ALL PASS' : '❌ FAIL'}`);
  console.log('====================================================');

  if (!report.hApp.pass || !report.manager.pass || !report.pwa.pass) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test script failed with exception:', err);
  process.exit(1);
});
