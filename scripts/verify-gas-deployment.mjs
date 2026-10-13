import fs from 'fs';
import path from 'path';

const deploymentPath = path.join(process.cwd(), 'deployment.json');
const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
const ssotUrl = deploymentData?.resources?.webAppUrl || deploymentData?.webAppUrl;
const districtId = String(
  deploymentData?.districtId ||
  deploymentData?.resources?.districtId ||
  ''
).trim();

if (!districtId) {
  console.error('❌ districtId is missing in deployment.json');
  process.exit(1);
}


console.log('=== GAS Endpoint Production Verification Suite ===\n');

async function runValidation() {
  console.log(`[Target Endpoint] ${ssotUrl}\n`);

  // --- Gate 1: Endpoint Health & Reachability (GET) ---
  console.log('--- Gate 1: GAS Endpoint Health & Reachability ---');
  const startTime1 = Date.now();
  try {
    const res1 = await fetch(ssotUrl, { method: 'GET', redirect: 'follow' });
    const responseTime1 = Date.now() - startTime1;
    const contentType1 = res1.headers.get('content-type') || 'unknown';
    const text1 = await res1.text();

    console.log(`HTTP Status: ${res1.status}`);
    console.log(`Response Time: ${responseTime1} ms`);
    console.log(`Content-Type: ${contentType1}`);
    console.log(`Raw Body Snippet: ${text1.substring(0, 150)}...`);

    if (res1.status === 200) {
      console.log('✅ Gate 1 Result: PASS (HTTP 200 Received)\n');
    } else {
      console.error(`❌ Gate 1 Result: FAIL (HTTP Status ${res1.status})\n`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Gate 1 Network Error: ${err.message}\n`);
    process.exit(1);
  }

  // --- Gate 2: Live Backend Execution via Maps API Key Action ---
  console.log('--- Gate 2: Live Backend Execution & Response Verification ---');
  const startTime2 = Date.now();
  try {
    const res2 = await fetch(ssotUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'getMapsApiKey',
        districtId
      }),
      redirect: 'follow'
    });
    const responseTime2 = Date.now() - startTime2;
    const text2 = await res2.text();

    console.log(`HTTP Status: ${res2.status}`);
    console.log(`Response Time: ${responseTime2} ms`);

    let isJson2 = false;
    let json2 = null;
    try {
      json2 = JSON.parse(text2);
      isJson2 = true;
    } catch(e) {}

    console.log(`JSON Parse Success: ${isJson2}`);

    const hasValidKey = json2 && json2.success === true && typeof json2.mapsApiKey === 'string' && json2.mapsApiKey.trim().length > 0;
    if (hasValidKey) {
      console.log('GOOGLE_MAPS_API_KEY: PRESENT');
      console.log('✅ Gate 2 Result: PASS (Backend Execution & Maps API Key Confirmed)\n');
    } else {
      console.error('GOOGLE_MAPS_API_KEY: MISSING');
      console.error('❌ Gate 2 Result: FAIL (GOOGLE_MAPS_API_KEY is not configured or empty in GAS Script Properties!)\n');
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Gate 2 Error: ${err.message}\n`);
    process.exit(1);
  }

  console.log('✅ All GAS Endpoint Verification Gates Passed.');
}

runValidation();
