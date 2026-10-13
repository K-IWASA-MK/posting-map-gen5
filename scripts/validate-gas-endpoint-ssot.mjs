import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const deploymentPath = path.join(rootDir, 'deployment.json');

let targetConfigJson = deploymentPath;
if (!fs.existsSync(deploymentPath)) {
  const templatePath = path.join(rootDir, 'deployment.template.json');
  if (fs.existsSync(templatePath)) {
    targetConfigJson = templatePath;
    console.log('ℹ️ [SSOT Validator] deployment.json not found, inspecting deployment.template.json...');
  } else {
    console.error('❌ Error: Neither deployment.json nor deployment.template.json found!');
    process.exit(1);
  }
}

let deploymentData;
try {
  deploymentData = JSON.parse(fs.readFileSync(targetConfigJson, 'utf8'));
} catch (e) {
  console.error(`❌ Error: Failed to parse ${targetConfigJson}: ${e.message}`);
  process.exit(1);
}

const ssotUrl = (deploymentData?.resources?.webAppUrl || '').trim();
const ssotLiffUrl = (deploymentData?.resources?.productionLiffUrl || '').trim();

const isTemplateMode = ssotUrl === '' && ssotLiffUrl === '';

let ssotLiffId = '';
if (ssotLiffUrl) {
  try {
    const parsedUrl = new URL(ssotLiffUrl);
    ssotLiffId = parsedUrl.pathname.split('/').filter(Boolean)[0] || '';
  } catch (e) {
    console.error(`❌ Error: Invalid productionLiffUrl: ${ssotLiffUrl}`);
    process.exit(1);
  }
}

console.log(`[SSOT Validator] Target SSOT WebApp URL: ${ssotUrl || '(Pure Template: Empty)'}`);
console.log(`[SSOT Validator] Target SSOT LIFF ID:    ${ssotLiffId || '(Pure Template: Empty)'}`);

let hasMismatch = false;

const activeConfigPath = path.join(rootDir, 'data', 'config.js');
if (!fs.existsSync(activeConfigPath)) {
  console.error(`❌ Missing data/config.js! Run 'npm run sync:config' first.`);
  hasMismatch = true;
} else {
  const configContent = fs.readFileSync(activeConfigPath, 'utf8');

  if (isTemplateMode) {
    const isUrlEmpty = configContent.includes('gasWebAppUrl: ""');
    const isLiffEmpty = configContent.includes('liffId: ""');
    if (!isUrlEmpty) {
      console.error(`❌ Template Violation: data/config.js gasWebAppUrl must be empty in template mode!`);
      hasMismatch = true;
    } else {
      console.log(`✅ PASS: data/config.js gasWebAppUrl is empty in template mode.`);
    }
    if (!isLiffEmpty) {
      console.error(`❌ Template Violation: data/config.js liffId must be empty in template mode!`);
      hasMismatch = true;
    } else {
      console.log(`✅ PASS: data/config.js liffId is empty in template mode.`);
    }
  } else {
    if (!configContent.includes(ssotUrl)) {
      console.error(`❌ Mismatch in data/config.js: gasWebAppUrl does not match SSOT URL!`);
      hasMismatch = true;
    } else {
      console.log(`✅ PASS: data/config.js matches SSOT WebApp URL.`);
    }

    if (!configContent.includes(ssotLiffId)) {
      console.error(`❌ Mismatch in data/config.js: liffId does not match SSOT LIFF ID!`);
      hasMismatch = true;
    } else {
      console.log(`✅ PASS: data/config.js matches SSOT LIFF ID.`);
    }
  }

  if (configContent.includes('spreadsheetId')) {
    console.error(`❌ Policy Violation: data/config.js contains spreadsheetId (must remain district-agnostic).`);
    hasMismatch = true;
  } else {
    console.log(`✅ PASS: data/config.js is free of spreadsheetId.`);
  }
}

// active/ ディレクトリ内に config.js が残存していないことの不可侵性検証
const forbiddenActiveConfig = path.join(rootDir, 'active', 'h-app', 'config.js');
if (fs.existsSync(forbiddenActiveConfig)) {
  console.error(`❌ Architecture Violation: active/h-app/config.js must be removed! Config belongs to data/config.js only.`);
  hasMismatch = true;
} else {
  console.log(`✅ PASS: active/h-app/ is clean (zero config files).`);
}

const appJsPath = path.join(rootDir, 'active', 'h-app', 'app.js');
if (fs.existsSync(appJsPath)) {
  const appContent = fs.readFileSync(appJsPath, 'utf8');
  if (appContent.includes('https://script.google.com/macros/s/')) {
    console.error(`❌ Hardcoded GAS Endpoint in active/h-app/app.js: Found script.google.com fallback!`);
    hasMismatch = true;
  } else {
    console.log(`✅ PASS: active/h-app/app.js has no hardcoded GAS fallback URL.`);
  }
}

const rootIndexPath = path.join(rootDir, 'index.html');
if (fs.existsSync(rootIndexPath)) {
  const indexContent = fs.readFileSync(rootIndexPath, 'utf8');
  if (!indexContent.includes('./data/config.js')) {
    console.error(`❌ Configuration error in index.html: Does not load ./data/config.js!`);
    hasMismatch = true;
  } else {
    console.log(`✅ PASS: index.html loads ./data/config.js.`);
  }

  if (ssotLiffId && indexContent.includes(ssotLiffId)) {
    console.error(`❌ Hardcoded LIFF ID in index.html: Found static ${ssotLiffId}!`);
    hasMismatch = true;
  } else {
    console.log(`✅ PASS: index.html has no hardcoded LIFF ID.`);
  }
}

const clientsDir = path.join(rootDir, 'clients');
if (fs.existsSync(clientsDir)) {
  const clients = fs.readdirSync(clientsDir);
  for (const client of clients) {
    const configPath = path.join(clientsDir, client, 'config.js');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      if (!content.includes(ssotUrl)) {
        console.error(`❌ Mismatch in clients/${client}/config.js: gasWebAppUrl does not match SSOT!`);
        hasMismatch = true;
      }
    }
  }
}

if (hasMismatch) {
  console.error('\n🔴 SSOT Validation FAILED: Discrepancies found.');
  process.exit(1);
} else {
  console.log('\n🟢 SSOT Validation PASSED: All active endpoints are synchronized with deployment.json SSOT.');
  process.exit(0);
}
