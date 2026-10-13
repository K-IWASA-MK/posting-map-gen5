import assert from 'node:assert/strict';
import {
  parseArgs,
  checkDns,
  checkHttps,
  verifyPagesSourcePreservation,
  runVerificationStateMachine,
  syncXserverDnsRecord,
  executeDomainProvisioning
} from '../scripts/provision-domain.mjs';

console.log('====================================================');
console.log('🚀 TESTING DOMAIN PROVISIONING & STATE MACHINE SUITE');
console.log('====================================================\n');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`✅ PASS: ${name}`);
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 引数パース & Default Dry Run
// ─────────────────────────────────────────────────────────────
await test('1. Default execution sets dryRun=true and execute=false', () => {
  const opts = parseArgs([]);
  assert.strictEqual(opts.dryRun, true, 'Default must be dryRun');
  assert.strictEqual(opts.execute, false, 'Default must NOT execute');
  assert.strictEqual(opts.verifyOnly, false);
  assert.strictEqual(opts.domain, 'mie-03.postingmap.jp');
});

await test('2. --verify-only sets verifyOnly=true and execute=false', () => {
  const opts = parseArgs(['--verify-only']);
  assert.strictEqual(opts.verifyOnly, true);
  assert.strictEqual(opts.execute, false);
  assert.strictEqual(opts.dryRun, false);
});

await test('3. --execute enables execute and disables dryRun', () => {
  const opts = parseArgs(['--execute']);
  assert.strictEqual(opts.execute, true);
  assert.strictEqual(opts.dryRun, false);
});

// ─────────────────────────────────────────────────────────────
// 2. GitHub Pages Source 保持検証
// ─────────────────────────────────────────────────────────────
await test('4. verifyPagesSourcePreservation passes when branch and path match', () => {
  const before = { source: { branch: 'main', path: '/' }, cname: 'kuwana.postingmap.jp' };
  const after = { source: { branch: 'main', path: '/' }, cname: 'mie-03.postingmap.jp' };
  assert.strictEqual(verifyPagesSourcePreservation(before, after), true);
});

await test('5. verifyPagesSourcePreservation throws when source branch/path mutated', () => {
  const before = { source: { branch: 'main', path: '/' } };
  const after = { source: { branch: 'gh-pages', path: '/' } };
  assert.throws(
    () => verifyPagesSourcePreservation(before, after),
    /GitHub Pages source was mutated/
  );
});

// ─────────────────────────────────────────────────────────────
// 3. DNS 解決ロジック
// ─────────────────────────────────────────────────────────────
await test('6. checkDns returns DNS_OK when target matches', async () => {
  const mockResolver = async () => ['k-iwasa-mk.github.io.'];
  const res = await checkDns('mie-03.postingmap.jp', 'k-iwasa-mk.github.io', mockResolver);
  assert.strictEqual(res.status, 'DNS_OK');
});

await test('7. checkDns returns WRONG_TARGET and HARD STOP when target differs', async () => {
  const mockResolver = async () => ['malicious-target.com'];
  const res = await checkDns('mie-03.postingmap.jp', 'k-iwasa-mk.github.io', mockResolver);
  assert.strictEqual(res.status, 'WRONG_TARGET');
  assert.ok(res.error.includes('malicious-target.com'));
});

await test('8. checkDns returns DNS_PENDING on ENOTFOUND or NODATA', async () => {
  const mockResolver = async () => {
    const err = new Error('Query ENOTFOUND');
    err.code = 'ENOTFOUND';
    throw err;
  };
  const res = await checkDns('mie-03.postingmap.jp', 'k-iwasa-mk.github.io', mockResolver);
  assert.strictEqual(res.status, 'DNS_PENDING');
  assert.strictEqual(res.code, 'ENOTFOUND');
});

// ─────────────────────────────────────────────────────────────
// 4. HTTPS & TLS / Network エラー分類
// ─────────────────────────────────────────────────────────────
await test('9. checkHttps returns PASS on HTTP 200', async () => {
  const mockFetcher = async () => ({ status: 200, ok: true });
  const res = await checkHttps('mie-03.postingmap.jp', mockFetcher);
  assert.strictEqual(res.status, 'PASS');
  assert.strictEqual(res.httpStatus, 200);
});

await test('10. checkHttps returns CERT_PENDING on TLS/certificate error', async () => {
  const mockFetcher = async () => {
    const err = new Error('Hostname/IP does not match certificate altnames');
    err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
    throw err;
  };
  const res = await checkHttps('mie-03.postingmap.jp', mockFetcher);
  assert.strictEqual(res.status, 'CERT_PENDING');
  assert.strictEqual(res.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

await test('11. checkHttps returns NETWORK_ERROR on ECONNREFUSED/timeout (separated from CERT)', async () => {
  const mockFetcher = async () => {
    const err = new Error('connect ECONNREFUSED');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  const res = await checkHttps('mie-03.postingmap.jp', mockFetcher);
  assert.strictEqual(res.status, 'NETWORK_ERROR');
  assert.strictEqual(res.code, 'ECONNREFUSED');
});

await test('12. checkHttps returns HTTP_ERROR on 404/502 (separated from CERT)', async () => {
  const mockFetcher = async () => ({ status: 404, ok: false });
  const res = await checkHttps('mie-03.postingmap.jp', mockFetcher);
  assert.strictEqual(res.status, 'HTTP_ERROR');
  assert.strictEqual(res.httpStatus, 404);
});

// ─────────────────────────────────────────────────────────────
// 5. Dual-Stage 状態遷移機械 & 下流実行ガード (downstreamAllowed)
// ─────────────────────────────────────────────────────────────
await test('13. State machine timeout with DNS_PENDING returns downstreamAllowed=false', async () => {
  const mockResolver = async () => {
    const err = new Error('ENOTFOUND');
    err.code = 'ENOTFOUND';
    throw err;
  };
  const res = await runVerificationStateMachine({
    domain: 'mie-03.postingmap.jp',
    target: 'k-iwasa-mk.github.io',
    resolver: mockResolver,
    fetcher: async () => ({ status: 200 }),
    timeoutMs: 100,
    intervalMs: 30,
    logger: () => {}
  });

  assert.strictEqual(res.status, 'DNS_PENDING');
  assert.strictEqual(res.downstreamAllowed, false, 'PENDING must forbid downstream execution');
  assert.strictEqual(res.timeout, true);
});

await test('14. State machine timeout with CERT_PENDING returns downstreamAllowed=false', async () => {
  const mockResolver = async () => ['k-iwasa-mk.github.io'];
  const mockFetcher = async () => {
    const err = new Error('Cert not ready');
    err.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    throw err;
  };

  const res = await runVerificationStateMachine({
    domain: 'mie-03.postingmap.jp',
    target: 'k-iwasa-mk.github.io',
    resolver: mockResolver,
    fetcher: mockFetcher,
    timeoutMs: 100,
    intervalMs: 30,
    logger: () => {}
  });

  assert.strictEqual(res.status, 'CERT_PENDING');
  assert.strictEqual(res.downstreamAllowed, false, 'CERT_PENDING must forbid downstream execution');
  assert.strictEqual(res.timeout, true);
});

await test('15. State machine immediately triggers HARD STOP on WRONG_TARGET', async () => {
  const mockResolver = async () => ['wrong-server.org'];
  const res = await runVerificationStateMachine({
    domain: 'mie-03.postingmap.jp',
    target: 'k-iwasa-mk.github.io',
    resolver: mockResolver,
    fetcher: async () => ({ status: 200 }),
    timeoutMs: 100,
    intervalMs: 30,
    logger: () => {}
  });

  assert.strictEqual(res.status, 'WRONG_TARGET');
  assert.strictEqual(res.downstreamAllowed, false);
});

await test('16. State machine succeeds with PASS and downstreamAllowed=true on valid HTTPS 200', async () => {
  const mockResolver = async () => ['k-iwasa-mk.github.io'];
  const mockFetcher = async () => ({ status: 200, ok: true });

  const res = await runVerificationStateMachine({
    domain: 'mie-03.postingmap.jp',
    target: 'k-iwasa-mk.github.io',
    resolver: mockResolver,
    fetcher: mockFetcher,
    timeoutMs: 200,
    intervalMs: 20,
    logger: () => {}
  });

  assert.strictEqual(res.status, 'PASS');
  assert.strictEqual(res.downstreamAllowed, true, 'PASS must permit downstream execution');
});

// ─────────────────────────────────────────────────────────────
// 6. XServer DNS テーブル照合 & 冪等性 / KUWANA 保護
// ─────────────────────────────────────────────────────────────
await test('17. syncXserverDnsRecord detects identical existing CNAME as No-op (writeCount=0)', async () => {
  const mockPage = {
    evaluate: async () => [
      ['postingmap.jp', 'A', '185.199.108.153'],
      ['kuwana.postingmap.jp', 'CNAME', 'k-iwasa-mk.github.io'],
      ['mie-03.postingmap.jp', 'CNAME', 'k-iwasa-mk.github.io']
    ]
  };

  const res = await syncXserverDnsRecord({
    domain: 'mie-03.postingmap.jp',
    target: 'k-iwasa-mk.github.io',
    page: mockPage,
    execute: true,
    logger: () => {}
  });

  assert.strictEqual(res.action, 'NO_OP');
  assert.strictEqual(res.writeCount, 0);
});

await test('18. syncXserverDnsRecord throws HARD STOP if existing record points to wrong target', async () => {
  const mockPage = {
    evaluate: async () => [
      ['mie-03.postingmap.jp', 'CNAME', 'hijacked-target.com']
    ]
  };

  await assert.rejects(
    async () => syncXserverDnsRecord({
      domain: 'mie-03.postingmap.jp',
      target: 'k-iwasa-mk.github.io',
      page: mockPage,
      execute: true,
      logger: () => {}
    }),
    /Existing record points to different target/
  );
});

await test('19. KUWANA existing records are unmutated (read-only verification)', async () => {
  const mockPage = {
    evaluate: async () => [
      ['kuwana.postingmap.jp', 'CNAME', 'k-iwasa-mk.github.io']
    ]
  };

  const res = await syncXserverDnsRecord({
    domain: 'mie-03.postingmap.jp',
    target: 'k-iwasa-mk.github.io',
    page: mockPage,
    execute: false, // Dry run
    logger: () => {}
  });

  assert.strictEqual(res.action, 'SIMULATED_ADD');
  assert.strictEqual(res.writeCount, 0);
});

// ─────────────────────────────────────────────────────────────
// 7. executeDomainProvisioning 総合フロー
// ─────────────────────────────────────────────────────────────
await test('20. executeDomainProvisioning in default dry-run executes 0 external writes', async () => {
  const res = await executeDomainProvisioning({ dryRun: true, execute: false }, {
    resolver: async () => ['k-iwasa-mk.github.io'],
    fetcher: async () => ({ status: 200, ok: true }),
    logger: () => {}
  });

  assert.strictEqual(res.mode, 'DRY_RUN');
  assert.strictEqual(res.writeCount, 0, 'Dry run must perform 0 writes');
  assert.strictEqual(res.status, 'PASS');
});

console.log('\n====================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passedTests} / ${totalTests} PASSED`);
console.log('====================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
