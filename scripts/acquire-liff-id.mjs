import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();

// Safe local secret loader from .env (gitignored)
function loadEnvFallback() {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const k = trimmed.substring(0, eqIdx).trim();
          const v = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[k]) {
            process.env[k] = v;
          }
        }
      }
    } catch (e) {}
  }
}
loadEnvFallback();

// Canonical constants
const LINE_LOGIN_CHANNEL_ID = '2010941735';
const KNOWN_FOREIGN_DISTRICT_LIFF_IDS = [
  '2010941735-lbOXhzpJ', // MIE-KAMEYAMA
  '2010941735-8FCwjD6x', // OKAYAMA-02
  '2010941735-GRLuqPic'  // MIE-03
];

const screenshotDir = path.join(rootDir, 'data', 'screenshots');
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

// 1. Dynamically resolve district parameters from deployment.json and CNAME (Universal Engine)
function resolveDistrictConfig() {
  const deploymentPath = path.join(rootDir, 'deployment.json');
  if (!fs.existsSync(deploymentPath)) {
    throw new Error('❌ deployment.json not found in repository root.');
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  const districtId = (deployment.districtId || '').trim();
  if (!districtId) {
    throw new Error('❌ districtId is not declared in deployment.json.');
  }

  let domain = '';
  const cnamePath = path.join(rootDir, 'CNAME');
  if (fs.existsSync(cnamePath)) {
    domain = fs.readFileSync(cnamePath, 'utf8').trim();
  } else if (process.env.DISTRICT_BASE_URL) {
    try {
      domain = new URL(process.env.DISTRICT_BASE_URL).hostname;
    } catch (e) {
      domain = process.env.DISTRICT_BASE_URL.trim();
    }
  }

  if (!domain) {
    throw new Error('❌ District domain could not be resolved from CNAME or DISTRICT_BASE_URL.');
  }

  const endpointUrl = `https://${domain}/`;
  const appName = `POSTING-MAP-${districtId}`;

  return { districtId, domain, endpointUrl, appName, deployment, deploymentPath };
}

async function main() {
  console.log('====================================================');
  console.log('🚀 AUTONOMOUS LIFF PROVISIONING & EXTRACTION PIPELINE');
  console.log('====================================================\n');

  const { districtId, domain, endpointUrl, appName, deployment, deploymentPath } = resolveDistrictConfig();

  console.log(`📋 [District Context]`);
  console.log(`   District ID:  ${districtId}`);
  console.log(`   Domain:       ${domain}`);
  console.log(`   Endpoint URL: ${endpointUrl}`);
  console.log(`   LIFF Name:    ${appName}`);
  console.log(`   Channel ID:   ${LINE_LOGIN_CHANNEL_ID}\n`);

  console.log('🔌 Connecting to existing Google Chrome via CDP ([::1]:9222)...');
  const browser = await chromium.connectOverCDP('http://[::1]:9222');
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('❌ No browser contexts found in connected Chrome.');
  }

  const pages = contexts[0].pages();
  const targetConsoleUrl = `https://developers.line.biz/console/channel/${LINE_LOGIN_CHANNEL_ID}/liff`;
  let liffPage = pages.find(p => p.url().includes(`/channel/${LINE_LOGIN_CHANNEL_ID}/liff`) || p.url().includes('/liff'));

  if (!liffPage) {
    console.log(`🌐 Navigating to LIFF tab: ${targetConsoleUrl}...`);
    liffPage = pages[0] || (await contexts[0].newPage());
    await liffPage.goto(targetConsoleUrl, { waitUntil: 'networkidle' });
  }

  await liffPage.bringToFront();
  await liffPage.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  // 2. Strict Search: MUST match BOTH appName AND endpointUrl
  console.log(`🔍 Inspecting LIFF table for existing dedicated app (Name: "${appName}" AND Endpoint: "${endpointUrl}")...`);
  let acquiredLiffId = await liffPage.evaluate(({ appName, endpointUrl, foreignIds }) => {
    const rows = Array.from(document.querySelectorAll('tr, .liff-item, [data-testid], li, .card'));
    for (const row of rows) {
      const text = row.innerText || '';
      // Strict matching: row MUST contain both appName and endpointUrl
      if (text.includes(appName) && text.includes(endpointUrl)) {
        const idMatch = text.match(/2010941735-[A-Za-z0-9_]{8}/);
        if (idMatch && !foreignIds.includes(idMatch[0])) {
          return idMatch[0];
        }
      }
    }
    return null;
  }, { appName, endpointUrl, foreignIds: KNOWN_FOREIGN_DISTRICT_LIFF_IDS });

  if (acquiredLiffId) {
    console.log(`✨ Valid dedicated LIFF app verified: ${acquiredLiffId}`);
  } else {
    console.log('➕ Dedicated LIFF app not found. Creating new LIFF app...');

    // Check if form is already open, if not click "追加"
    const formAlreadyOpen = await liffPage.locator('textarea[placeholder*="LIFFアプリ名"]').isVisible();
    if (!formAlreadyOpen) {
      const addButton = liffPage.locator('button:has-text("追加"), button:has-text("Add"), a:has-text("追加"), a:has-text("Add")').first();
      await addButton.waitFor({ state: 'visible', timeout: 10000 });
      await addButton.click();
      await liffPage.waitForLoadState('networkidle').catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log('📝 Filling LIFF registration form...');
    // Name
    const nameInput = liffPage.locator('textarea[placeholder*="LIFFアプリ名"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.fill(appName);
    console.log(`   - App Name: ${appName}`);

    // Size: Full
    const fullOption = liffPage.locator('label:has-text("Full")').first();
    if (await fullOption.isVisible()) {
      await fullOption.click();
      console.log('   - Size: Full');
    }

    // Endpoint URL
    const urlInput = liffPage.locator('textarea[placeholder*="example.com"]').first();
    await urlInput.waitFor({ state: 'visible', timeout: 10000 });
    await urlInput.fill(endpointUrl);
    console.log(`   - Endpoint URL: ${endpointUrl}`);

    // Scopes (profile, openid)
    const profileLabel = liffPage.locator('label:has-text("profile")').first();
    if (await profileLabel.isVisible()) {
      const isChecked = await liffPage.evaluate(el => {
        const input = el.querySelector('input') || el.previousElementSibling;
        return input ? input.checked : false;
      }, await profileLabel.elementHandle()).catch(() => false);
      if (!isChecked) {
        await profileLabel.click();
        console.log('   - Scope checked: profile');
      }
    }

    const openidLabel = liffPage.locator('label:has-text("openid")').first();
    if (await openidLabel.isVisible()) {
      const isChecked = await liffPage.evaluate(el => {
        const input = el.querySelector('input') || el.previousElementSibling;
        return input ? input.checked : false;
      }, await openidLabel.elementHandle()).catch(() => false);
      if (!isChecked) {
        await openidLabel.click();
        console.log('   - Scope checked: openid');
      }
    }

    // Bot link feature (友だち追加オプション): Off
    const offLabel = liffPage.locator('label:has-text("Off")').last();
    if (await offLabel.isVisible()) {
      await offLabel.click();
      console.log('   - Bot link option: Off');
    }

    // Submit
    console.log('💾 Submitting form...');
    const submitBtn = liffPage.locator('button[type="submit"], button:has-text("追加")').last();
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    const isDisabled = await submitBtn.isDisabled();
    if (isDisabled) {
      await liffPage.screenshot({ path: path.join(screenshotDir, 'liff_submit_disabled.png') });
      throw new Error('❌ Form submit button is disabled. Check required fields in screenshot.');
    }

    await submitBtn.click();
    console.log('⏳ Awaiting creation response...');
    await liffPage.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    // Extract newly created LIFF ID
    acquiredLiffId = await liffPage.evaluate(({ appName, endpointUrl, foreignIds }) => {
      const rows = Array.from(document.querySelectorAll('tr, .liff-item, [data-testid], li, .card'));
      for (const row of rows) {
        const text = row.innerText || '';
        if (text.includes(appName) && text.includes(endpointUrl)) {
          const idMatch = text.match(/2010941735-[A-Za-z0-9_]{8}/);
          if (idMatch && !foreignIds.includes(idMatch[0])) {
            return idMatch[0];
          }
        }
      }
      // Fallback: search whole body near appName
      const fullText = document.body.innerText;
      const regex = new RegExp(appName + '[\\s\\S]*?(2010941735-[A-Za-z0-9_]{8})', 'i');
      const m = fullText.match(regex);
      if (m && !foreignIds.includes(m[1])) {
        return m[1];
      }
      return null;
    }, { appName, endpointUrl, foreignIds: KNOWN_FOREIGN_DISTRICT_LIFF_IDS });

    if (!acquiredLiffId) {
      await liffPage.screenshot({ path: path.join(screenshotDir, 'liff_extraction_failed.png') });
      throw new Error('❌ Failed to extract newly created dedicated LIFF ID.');
    }
    console.log(`🎉 Successfully created dedicated LIFF ID: ${acquiredLiffId}`);
  }

  await browser.close();

  // 3. Strict Validation against Foreign/Copy-source IDs
  if (!/^2010941735-[A-Za-z0-9_]{8}$/.test(acquiredLiffId)) {
    throw new Error(`❌ Extracted LIFF ID format invalid: "${acquiredLiffId}"`);
  }
  if (KNOWN_FOREIGN_DISTRICT_LIFF_IDS.includes(acquiredLiffId)) {
    throw new Error(`🛑 PROHIBITION VIOLATION: Extracted ID matches foreign district ID: "${acquiredLiffId}". Aborting.`);
  }

  const productionLiffUrl = `https://liff.line.me/${acquiredLiffId}`;
  console.log('\n====================================================');
  console.log(`✅ [DEDICATED LIFF ID CONFIRMED]`);
  console.log(`   District:  ${districtId}`);
  console.log(`   LIFF ID:   ${acquiredLiffId}`);
  console.log(`   LIFF URL:  ${productionLiffUrl}`);
  console.log('====================================================\n');

  // 4. Update deployment.json (System SSOT)
  deployment.resources.productionLiffUrl = productionLiffUrl;
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + '\n', 'utf8');
  console.log('✅ Synchronized deployment.json with dedicated LIFF URL.');

  // 5. Execute Frontend SSOT Synchronizers
  console.log('\n🚀 Synchronizing client configuration (sync:config & check:ssot)...');
  execSync('npm run sync:config && npm run check:ssot', { stdio: 'inherit' });

  // 6. Synchronize to human-readable inspection sheet (SYSTEM_INFO) in live Spreadsheet
  const webAppUrl = deployment.resources?.webAppUrl;
  if (webAppUrl) {
    console.log('\n🚀 Synchronizing live spreadsheet SYSTEM_INFO (human inspection view)...');
    try {
      const provisioningToken = (
        process.env.POSTING_MAP_PROVISIONING_TOKEN ||
        process.env.PROVISIONING_TOKEN ||
        ''
      ).trim();

      if (!provisioningToken) {
        console.warn('⚠️ Warning: POSTING_MAP_PROVISIONING_TOKEN is not configured in environment. Skipping live SYSTEM_INFO sync.');
      } else {
        const syncPayload = {
          action: 'syncSystemInfo',
          provisioningToken: provisioningToken,
          options: {
            baseUrl: `https://${domain}`,
            productionLiffUrl: productionLiffUrl,
            liffUrl: productionLiffUrl,
            liffId: acquiredLiffId
          }
        };

        const syncRes = await fetch(webAppUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(syncPayload),
          redirect: 'follow'
        });
        const syncJson = await syncRes.json();
        console.log('✅ SYSTEM_INFO Sync Result:', JSON.stringify(syncJson, null, 2));
      }
    } catch (e) {
      console.warn(`⚠️ Warning: SYSTEM_INFO sync encountered network issue: ${e.message}`);
    }
  }

  console.log('\n🎉 [COMPLETE] Autonomous LIFF provisioning executed successfully.');
}

main().catch(err => {
  console.error('\n🛑 [Autonomous LIFF Pipeline Error]:', err.message);
  process.exit(1);
});
