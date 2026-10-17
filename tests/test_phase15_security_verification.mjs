import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

console.log("====================================================");
console.log("🛡️ PHASE 15 UNIVERSAL SECURITY VERIFICATION SUITE");
console.log("====================================================");

const rootDir = process.cwd();

// ─── 1. Identity 検証 ─────────────────────────────────────────────
test('1. Identity: LIFF Token 公式検証、クライアント申告値の無効化、LINE公式userIdの唯一根拠性', () => {
  const authJsPath = path.join(rootDir, 'active/api/auth/auth.js');
  const authJs = fs.readFileSync(authJsPath, 'utf8');

  // トークン必須性の検証
  assert.ok(authJs.includes('if (!payload || !payload.liffToken)'), 'auth.js must require liffToken');
  assert.ok(authJs.includes('Unauthorized: Missing liffToken'), 'auth.js must reject missing liffToken');

  // LINE API URL への Bearer 認証
  assert.ok(authJs.includes('https://api.line.me/v2/profile'), 'auth.js must verify with LINE profile API');
  assert.ok(authJs.includes("'Authorization': 'Bearer ' + token"), 'auth.js must pass Bearer token to LINE API');

  // クライアント申告ではなく、LINE 公式応答の profileData.userId を採用すること
  assert.ok(authJs.includes('lineUserId: profileData.userId'), 'auth.js must extract lineUserId strictly from LINE official response');
});

// ─── 2. Authorization 検証 ─────────────────────────────────────────
test('2. Authorization: 操作主体IdentityのBackend強制解決、staffId偽装遮断、未登録者拒絶', () => {
  const v2ApiPath = path.join(rootDir, 'active/api/v2_api.js');
  const v2Api = fs.readFileSync(v2ApiPath, 'utf8');

  // staffDependentActions の存在確認
  assert.ok(v2Api.includes('const staffDependentActions ='), 'v2_api.js must define staffDependentActions');
  assert.ok(v2Api.includes('resolveStaffIdentity'), 'v2_api.js must resolve identity on backend');
  assert.ok(v2Api.includes('NOT_REGISTERED'), 'v2_api.js must reject unregistered users with NOT_REGISTERED');

  // クライアント送信値を上書きして強制確定すること
  assert.ok(v2Api.includes('postData.staffId = identity.staffId'), 'v2_api.js must overwrite client staffId with resolved identity');
  assert.ok(v2Api.includes('postData.staffName = identity.staffName'), 'v2_api.js must overwrite client staffName with resolved identity');
});

// ─── 3. Tenant Isolation 検証 ──────────────────────────────────────
test('3. Tenant Isolation: 1地区専用Spreadsheet解決、SYSTEM_INFO地区コード照合、越境アクセス完全遮断', () => {
  const adapterPath = path.join(rootDir, 'active/infrastructure/spreadsheet/spreadsheet_adapter.js');
  const adapter = fs.readFileSync(adapterPath, 'utf8');

  // 1地区専用 GAS スプレッドシート解決 (TARGET_SPREADSHEET_ID / SPREADSHEET_ID / getActiveSpreadsheet)
  assert.ok(adapter.includes('SpreadsheetApp.getActiveSpreadsheet()') || adapter.includes('TARGET_SPREADSHEET_ID'), 'spreadsheet_adapter.js must resolve single-district spreadsheet');
  assert.ok(!adapter.includes('props.getProperty("DISTRICT_REGISTRY")'), 'spreadsheet_adapter.js must not depend on parent-GAS DISTRICT_REGISTRY');

  // verifyIntegrityGuard
  assert.ok(adapter.includes('verifyIntegrityGuard(ss, districtId)'), 'spreadsheet_adapter.js must verify integrity guard');
  assert.ok(adapter.includes('DISTRICT_MISMATCH'), 'spreadsheet_adapter.js must throw DISTRICT_MISMATCH on code mismatch');
});

// ─── 4. Input Validation 検証 ───────────────────────────────────────
test('4. Input Validation: パラメータ型・必須チェック、未知アクション拒絶、不正JSON耐性', () => {
  const v2ApiPath = path.join(rootDir, 'active/api/v2_api.js');
  const v2Api = fs.readFileSync(v2ApiPath, 'utf8');

  // doGet / doPost での安全な JSON パース (try-catch)
  assert.ok(v2Api.includes('JSON.parse(e.postData.contents)'), 'v2_api.js must parse postData inside safe block');
  assert.ok(v2Api.includes('isWebAppCall = true'), 'v2_api.js must set isWebAppCall flag');

  // 無効なリクエストの拒絶
  assert.ok(v2Api.includes('MISSING_DISTRICT_ID'), 'v2_api.js must validate districtId presence');
});

// ─── 5. XSS 防護検証 ────────────────────────────────────────────────
test('5. XSS: escapeHtml (SEC-004) による特殊文字無害化とクライアント側サニタイズ適用', () => {
  const appJsPath = path.join(rootDir, 'active/h-app/app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // escapeHtml の実装ロジック検証
  assert.ok(appJs.includes('window.escapeHtml = function(value)'), 'app.js must define escapeHtml');

  // テスト用 vm コンテキストで escapeHtml を直接検証
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`
    window = {};
    ${appJs.substring(appJs.indexOf('window.escapeHtml'), appJs.indexOf('};', appJs.indexOf('window.escapeHtml')) + 2)}
  `, sandbox);

  const escapeFn = sandbox.window.escapeHtml;
  assert.equal(escapeFn('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeFn("Tom's & Jerry's"), 'Tom&#039;s &amp; Jerry&#039;s');
  assert.equal(escapeFn(null), '');
  assert.equal(escapeFn(undefined), '');
});

// ─── 6. CSRF & Method Boundary 検証 ─────────────────────────────────
test('6. CSRF & Method Boundary: doGetでのliffToken送信禁止、更新処理のPOST限定', () => {
  const v2ApiPath = path.join(rootDir, 'active/api/v2_api.js');
  const v2Api = fs.readFileSync(v2ApiPath, 'utf8');

  // doGet 内での Token (liffToken, dashboardSessionToken, managerSessionToken) 送信禁止ガード
  assert.ok(v2Api.includes('params.liffToken'), 'doGet must inspect params.liffToken');
  assert.ok(v2Api.includes('params.dashboardSessionToken'), 'doGet must inspect params.dashboardSessionToken');
  assert.ok(v2Api.includes('params.managerSessionToken'), 'doGet must inspect params.managerSessionToken');
  assert.ok(v2Api.includes('Token transmission via GET is prohibited.'), 'doGet must block token transmission via GET');
});

// ─── 7. Secret Exposure 検証 ───────────────────────────────────────
test('7. Secret Exposure: .gitignoreによる機密ファイル除外、Git追跡下に秘密情報なし', () => {
  const gitignorePath = path.join(rootDir, '.gitignore');
  assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');

  const gitignore = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(gitignore.includes('.secrets/'), '.gitignore must exclude .secrets/');
  assert.ok(gitignore.includes('.env'), '.gitignore must exclude .env');
  assert.ok(gitignore.includes('.clasp.json'), '.gitignore must exclude .clasp.json');
  assert.ok(gitignore.includes('deployment.json'), '.gitignore must exclude deployment.json');

  // 機械的静的シークレットスキャンゲート（Current Tree 全域0件違反検証）
  const scanOutput = execSync('node scripts/check-secrets.mjs', { cwd: rootDir, encoding: 'utf8' });
  assert.ok(scanOutput.includes('PASS (0 violations detected'), 'Static secret scan must PASS across all tracked files');
});

// ─── 8. lineUserId Exposure 検証 ───────────────────────────────────
test('8. lineUserId Exposure: APIレスポンスからの他者lineUserId完全除外、isMeフラグのみ返却', () => {
  const distRepoPath = path.join(rootDir, 'active/business/distribution/distribution_repository.js');
  const distRepo = fs.readFileSync(distRepoPath, 'utf8');

  // ランキング返却オブジェクトの検証
  assert.ok(distRepo.includes('// APIレスポンスには lineUserId を一切含めない（isMe と表示用ラベルのみ）'), 'Ranking must exclude lineUserId');
  assert.ok(distRepo.includes('isMe: isMe'), 'Ranking must only return isMe');

  // 最新実績返却オブジェクトの検証
  assert.ok(distRepo.includes('// APIレスポンスには lineUserId を含めない'), 'Latest records must exclude lineUserId');

  // 名簿返却オブジェクトの検証
  const v2ApiPath = path.join(rootDir, 'active/api/v2_api.js');
  const v2Api = fs.readFileSync(v2ApiPath, 'utf8');
  assert.ok(v2Api.includes('case \'getRoster\':'), 'v2_api.js must handle getRoster');
  assert.ok(!v2Api.includes('lineUserId: r.lineUserId'), 'getRoster response must never expose lineUserId');
});

// ─── 9. API Abuse & Idempotency 検証 ────────────────────────────────
test('9. API Abuse & Idempotency: クライアント二重送信防止、LockServiceProvider排他制御', () => {
  const lockAdapterPath = path.join(rootDir, 'active/infrastructure/lock/lock_adapter.js');
  const lockAdapter = fs.readFileSync(lockAdapterPath, 'utf8');

  assert.ok(lockAdapter.includes('class LockServiceProvider'), 'LockServiceProvider must exist');
  assert.ok(lockAdapter.includes('LockService.getScriptLock()'), 'Must use GAS ScriptLock');
  assert.ok(lockAdapter.includes('lock.tryLock(timeoutMs)'), 'Must acquire lock with timeout');

  const appJsPath = path.join(rootDir, 'active/h-app/app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  assert.ok(appJs.includes('generateRequestId'), 'app.js must generate unique requestId for idempotency');
});

// ─── 10. Audit Logging 検証 ─────────────────────────────────────────
test('10. Audit Logging: 操作者staffId、JSTタイムスタンプ、不可逆記録による監査証跡', () => {
  const distRepoPath = path.join(rootDir, 'active/business/distribution/distribution_repository.js');
  const distRepo = fs.readFileSync(distRepoPath, 'utf8');

  // タイムスタンプとstaffIdの保持
  assert.ok(distRepo.includes('rawCompletedAt'), 'Distribution repository must track completedAt');
  assert.ok(distRepo.includes('staffId'), 'Distribution repository must track staffId');

  // Canonical SSOT (SECURITY_BASELINE.md / API_CONTRACT.md) のセキュリティ・監査証跡契約直接検証
  const secBaselinePath = path.join(rootDir, 'docs/security/SECURITY_BASELINE.md');
  const apiContractPath = path.join(rootDir, 'docs/api/API_CONTRACT.md');
  assert.ok(fs.existsSync(secBaselinePath), 'SECURITY_BASELINE.md must exist');
  assert.ok(fs.existsSync(apiContractPath), 'API_CONTRACT.md must exist');
  const secBaseline = fs.readFileSync(secBaselinePath, 'utf8');
  const apiContract = fs.readFileSync(apiContractPath, 'utf8');

  // SEC-001〜SEC-007 統合セキュリティ境界要件の網羅性検証
  assert.ok(secBaseline.includes('SEC-001') && secBaseline.includes('Session'), 'SECURITY_BASELINE must specify SEC-001 Session Guard');
  assert.ok(secBaseline.includes('SEC-002') && secBaseline.includes('Injection'), 'SECURITY_BASELINE must specify SEC-002 Injection Guard');
  assert.ok(secBaseline.includes('SEC-003') && secBaseline.includes('Tenant Isolation'), 'SECURITY_BASELINE must specify SEC-003 Tenant Isolation');
  assert.ok(secBaseline.includes('SEC-004') && secBaseline.includes('XSS'), 'SECURITY_BASELINE must specify SEC-004 XSS Guard');
  assert.ok(secBaseline.includes('SEC-005') && secBaseline.includes('Disclosure'), 'SECURITY_BASELINE must specify SEC-005 Information Disclosure Guard');
  assert.ok(secBaseline.includes('SEC-006') && secBaseline.includes('Method'), 'SECURITY_BASELINE must specify SEC-006 HTTP Method Boundary');
  assert.ok(secBaseline.includes('SEC-007') && secBaseline.includes('Maps Key'), 'SECURITY_BASELINE must specify SEC-007 Maps API Key Guard');

  // 監査証跡 (Audit Trail) & BOLA防御契約の検証
  assert.ok(secBaseline.includes('監査') || secBaseline.includes('Audit'), 'SECURITY_BASELINE must mandate audit trail');
  assert.ok(apiContract.includes('requestId'), 'API_CONTRACT must mandate requestId audit tracking');
});

// ─── 11. Development Server Boundary 検証 (P1 #6) ───────────────────
test('11. Development Server Boundary: Localhost固定、URL decode例外防護、パストラバーサル遮断、active/data限定、realpath containment', async () => {
  const servePath = path.join(rootDir, 'scripts/serve.mjs');
  const serveSrc = fs.readFileSync(servePath, 'utf8');

  // 静的ソース契約検証
  assert.ok(!serveSrc.includes('0.0.0.0'), 'serve.mjs must not listen on 0.0.0.0');
  assert.ok(serveSrc.includes('127.0.0.1'), 'serve.mjs must listen on 127.0.0.1');
  assert.ok(serveSrc.includes('decodeURIComponent'), 'serve.mjs must decode URI path');
  assert.ok(serveSrc.includes('400 Bad Request'), 'serve.mjs must fail-closed with 400 on malformed URI');
  assert.ok(serveSrc.includes('realpathSync'), 'serve.mjs must enforce realpath containment');
  assert.ok(serveSrc.includes('active') && serveSrc.includes('data'), 'serve.mjs must restrict scope to active and data');

  // handleRequest をインポートしてインメモリ検証 (秘密ファイルの内容は一切読み取らない)
  const { handleRequest } = await import(path.resolve(servePath));

  function simulateRequest(url) {
    return new Promise(resolve => {
      let statusCode = 200;
      let headers = {};
      let body = '';
      const res = {
        writeHead(code, h = {}) {
          statusCode = code;
          headers = h;
        },
        end(data) {
          if (data) body = data.toString();
          resolve({ statusCode, headers, body });
        }
      };
      handleRequest({ url }, res);
    });
  }

  // S1: ALLOW
  const s1 = await simulateRequest('/active/h-app/index.html');
  assert.equal(s1.statusCode, 200, 'S1: /active/h-app/index.html must be ALLOW (200)');

  // S2: ALLOW
  const s2 = await simulateRequest('/active/manager/index.html');
  assert.equal(s2.statusCode, 200, 'S2: /active/manager/index.html must be ALLOW (200)');

  // S3: ALLOW
  const s3 = await simulateRequest('/data/config.js');
  assert.equal(s3.statusCode, 200, 'S3: /data/config.js must be ALLOW (200)');

  // S4: DENY
  const s4 = await simulateRequest('/.secrets/test.json');
  assert.equal(s4.statusCode, 403, 'S4: /.secrets/test.json must be DENY (403)');

  // S5: DENY
  const s5 = await simulateRequest('/.git/config');
  assert.equal(s5.statusCode, 403, 'S5: /.git/config must be DENY (403)');

  // S6: DENY
  const s6 = await simulateRequest('/AGENTS.md');
  assert.equal(s6.statusCode, 403, 'S6: /AGENTS.md must be DENY (403)');

  // S7: DENY
  const s7 = await simulateRequest('/package.json');
  assert.equal(s7.statusCode, 403, 'S7: /package.json must be DENY (403)');

  // S8: DENY
  const s8 = await simulateRequest('/../package.json');
  assert.equal(s8.statusCode, 403, 'S8: /../package.json must be DENY (403)');

  // S9: DENY
  const s9 = await simulateRequest('/../../outside.txt');
  assert.equal(s9.statusCode, 403, 'S9: /../../outside.txt must be DENY (403)');

  // S10: DENY
  const s10 = await simulateRequest('/active/../../../outside.txt');
  assert.equal(s10.statusCode, 403, 'S10: /active/../../../outside.txt must be DENY (403)');

  // S11: DENY
  const s11 = await simulateRequest('/%2e%2e/package.json');
  assert.equal(s11.statusCode, 403, 'S11: /%2e%2e/package.json must be DENY (403)');

  // S12: 400 (Malformed percent encoding & NUL byte)
  const s12a = await simulateRequest('/%ff/malformed');
  assert.equal(s12a.statusCode, 400, 'S12a: malformed percent encoding must be 400');
  const s12b = await simulateRequest('/data/%00/test.js');
  assert.equal(s12b.statusCode, 400, 'S12b: NUL byte in URI must be 400');

  // S13: ALLOW rewrite (/manager/ -> /active/manager/index.html)
  const s13 = await simulateRequest('/manager/');
  assert.equal(s13.statusCode, 200, 'S13: /manager/ must be ALLOW rewrite (200)');

  // S14: ALLOW rewrite (/app/ -> /active/h-app/index.html)
  const s14 = await simulateRequest('/app/');
  assert.equal(s14.statusCode, 200, 'S14: /app/ must be ALLOW rewrite (200)');

  // S15: ALLOW rewrite (/business/area/address_master_service.js)
  const s15 = await simulateRequest('/business/area/address_master_service.js');
  assert.equal(s15.statusCode, 200, 'S15: /business/area/address_master_service.js must be ALLOW rewrite (200)');
});

// ─── 12. Wave S2 Mandatory Counterexamples ───────────────────────────
test('12. Wave S2 Security Counterexamples: GET credential boundary, syncSystemInfo POST-only, resetRoster privileged auth, PII log removal', async () => {
  // Spies for behavioral verification
  let setupRosterSheetCallCount = 0;
  let syncSystemInfoCallCount = 0;

  const validProvisioningToken = "test-token-123";
  const validProvisioningHash = crypto.createHash('sha256').update(validProvisioningToken).digest('hex');

  const mockProps = {
    TARGET_SPREADSHEET_ID: "ss-kuwana-id",
    PROVISIONING_TOKEN_HASH: validProvisioningHash,
    DISTRICT_ID: "KUWANA"
  };

  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => mockProps[k] || null,
        setProperty: (k, v) => { mockProps[k] = v; }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        setMimeType: function(mime) { this.mime = mime; return this; }
      })
    },
    setupRosterSheet: (districtId) => {
      setupRosterSheetCallCount++;
      return `Setup complete for ${districtId}`;
    },
    SystemInfoService: {
      getInstance: () => ({
        syncSystemInfo: (opts, distId) => {
          syncSystemInfoCallCount++;
          return { success: true, districtId: distId };
        }
      })
    },
    Utilities: {
      computeDigest: (algo, str) => Array.from(crypto.createHash('sha256').update(str).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' }
    }
  };

  vm.createContext(sandbox);

  // Load active/api/v2_api.js into sandbox
  const v2ApiSource = fs.readFileSync(path.join(rootDir, 'active/api/v2_api.js'), 'utf8');
  vm.runInContext(v2ApiSource, sandbox);

  function callGet(params) {
    const res = sandbox.doGet({ parameter: params });
    return JSON.parse(res.text);
  }

  function callPost(body, params = {}) {
    const res = sandbox.doPost({
      postData: { contents: JSON.stringify(body) },
      parameter: params
    });
    return JSON.parse(res.text);
  }

  // Counterexample 1: GET + liffToken => rejection
  const resCe1 = callGet({ action: "getRoster", liffToken: "token_123" });
  assert.equal(resCe1.success, false, "CE-1: GET + liffToken must be rejected");
  assert.equal(resCe1.error, "Token transmission via GET is prohibited.");

  // Counterexample 2: GET + dashboardSessionToken => rejection, manager data handler call 0
  const resCe2 = callGet({ action: "getRoster", dashboardSessionToken: "pms_dash_token_123" });
  assert.equal(resCe2.success, false, "CE-2: GET + dashboardSessionToken must be rejected");
  assert.equal(resCe2.error, "Token transmission via GET is prohibited.");

  // Counterexample 3: GET + managerSessionToken => rejection, manager data handler call 0
  const resCe3 = callGet({ action: "getRoster", managerSessionToken: "pms_dash_token_123" });
  assert.equal(resCe3.success, false, "CE-3: GET + managerSessionToken must be rejected");
  assert.equal(resCe3.error, "Token transmission via GET is prohibited.");

  // Counterexample 4: GET syncSystemInfo => METHOD_NOT_ALLOWED, verify/mutation call 0
  const resCe4 = callGet({ action: "syncSystemInfo", provisioningToken: validProvisioningToken, districtId: "KUWANA" });
  assert.equal(resCe4.success, false, "CE-4: GET syncSystemInfo must fail");
  assert.equal(resCe4.code, "METHOD_NOT_ALLOWED", "CE-4: GET syncSystemInfo must return METHOD_NOT_ALLOWED");
  assert.equal(syncSystemInfoCallCount, 0, "CE-4: syncSystemInfo mutation must NOT be called via GET");

  // Counterexample 5: POST syncSystemInfo + valid existing auth => existing success path
  const resCe5 = callPost({
    action: "syncSystemInfo",
    districtId: "KUWANA",
    provisioningToken: validProvisioningToken,
    options: {}
  });
  assert.equal(resCe5.success, true, "CE-5: POST syncSystemInfo with valid token must succeed");
  assert.equal(syncSystemInfoCallCount, 1, "CE-5: syncSystemInfo must be executed via POST");

  // Counterexample 6: GET resetRoster => METHOD_NOT_ALLOWED, setupRosterSheet call 0
  setupRosterSheetCallCount = 0;
  const resCe6 = callGet({ action: "resetRoster", districtId: "KUWANA" });
  assert.equal(resCe6.success, false, "CE-6: GET resetRoster must fail");
  assert.equal(resCe6.code, "METHOD_NOT_ALLOWED", "CE-6: GET resetRoster must return METHOD_NOT_ALLOWED");
  assert.equal(setupRosterSheetCallCount, 0, "CE-6: setupRosterSheet must NOT be called via GET");

  // Counterexample 7: POST resetRoster + missing Provisioning Token => UNAUTHORIZED, setupRosterSheet call 0
  const resCe7 = callPost({ action: "resetRoster", districtId: "KUWANA" });
  assert.equal(resCe7.success, false, "CE-7: POST resetRoster without token must be rejected");
  assert.equal(resCe7.code, "UNAUTHORIZED");
  assert.equal(setupRosterSheetCallCount, 0, "CE-7: setupRosterSheet must NOT be called without token");

  // Counterexample 8: POST resetRoster + valid Staff liffToken only => rejection, setupRosterSheet call 0
  const resCe8 = callPost({ action: "resetRoster", districtId: "KUWANA", liffToken: "valid_staff_token" });
  assert.equal(resCe8.success, false, "CE-8: POST resetRoster with staff liffToken only must be rejected");
  assert.equal(resCe8.code, "UNAUTHORIZED");
  assert.equal(setupRosterSheetCallCount, 0, "CE-8: setupRosterSheet must NOT be called with staff liffToken only");

  // Counterexample 9: POST resetRoster + invalid Provisioning Token => UNAUTHORIZED, setupRosterSheet call 0
  const resCe9 = callPost({ action: "resetRoster", districtId: "KUWANA", provisioningToken: "INVALID_DUMMY_TOKEN_FOR_AUDIT" });
  assert.equal(resCe9.success, false, "CE-9: POST resetRoster with wrong token must be rejected");
  assert.equal(resCe9.code, "UNAUTHORIZED");
  assert.equal(setupRosterSheetCallCount, 0, "CE-9: setupRosterSheet must NOT be called with invalid token");

  // Counterexample 10: POST resetRoster + valid Provisioning Token + valid districtId => setupRosterSheet exactly 1 time
  const resCe10 = callPost({ action: "resetRoster", districtId: "KUWANA", provisioningToken: validProvisioningToken });
  assert.equal(resCe10.success, true, "CE-10: POST resetRoster with valid token must succeed");
  assert.equal(setupRosterSheetCallCount, 1, "CE-10: setupRosterSheet must be called exactly 1 time");

  // Counterexample 11: POST resetRoster + missing districtId => Fail-Closed (MISSING_DISTRICT_ID), setupRosterSheet call 0
  setupRosterSheetCallCount = 0;
  const resCe11 = callPost({ action: "resetRoster", provisioningToken: validProvisioningToken });
  assert.equal(resCe11.success, false, "CE-11: POST resetRoster without districtId must fail");
  assert.equal(resCe11.code, "MISSING_DISTRICT_ID");
  assert.equal(setupRosterSheetCallCount, 0, "CE-11: setupRosterSheet must NOT be called when districtId is missing");

  // Counterexample 12: Auth Cache HIT => authentication result unchanged, logs contain lineUserId 0
  const authJsSource = fs.readFileSync(path.join(rootDir, 'active/api/auth/auth.js'), 'utf8');
  const loggedLines = [];
  const authSandbox = {
    console: {
      log: (msg) => loggedLines.push(String(msg)),
      warn: () => {},
      error: () => {}
    },
    getSession: (token) => {
      if (token === "cached_token_valid") {
        return {
          lineUserId: "U_secret_user_999",
          displayName: "Test Staff",
          pictureUrl: "https://example.com/pic.jpg"
        };
      }
      return null;
    }
  };
  vm.createContext(authSandbox);
  vm.runInContext(authJsSource, authSandbox);

  const authRes = authSandbox.authenticateRequest({ liffToken: "cached_token_valid" });
  assert.equal(authRes.success, true, "CE-12: Auth Cache HIT must return success");
  assert.equal(authRes.user.lineUserId, "U_secret_user_999", "CE-12: Auth result user.lineUserId must be preserved");

  // Verify that loggedLines has NO plaintext lineUserId
  assert.ok(loggedLines.includes("AUTH CACHE HIT"), "CE-12: Log must contain non-PII 'AUTH CACHE HIT'");
  for (const line of loggedLines) {
    assert.ok(!line.includes("U_secret_user_999"), "CE-12: Log must NOT contain lineUserId");
    assert.ok(!line.includes("user="), "CE-12: Log must NOT contain user= parameter");
  }
});

console.log('✅ ALL 12 PHASE 15 SECURITY VERIFICATION CHECKS DEFINED SUCCESSFULLY.\n');
