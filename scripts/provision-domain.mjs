#!/usr/bin/env node
/**
 * POSTING MAP - Autonomous Domain Provisioning & Verification Engine
 *
 * MIE-03 独自ドメイン (mie-03.postingmap.jp) のプロビジョニングおよび
 * Dual-Stage 状態遷移機械による厳格検証を行う。
 *
 * 【厳格運用原則】
 * 1. デフォルト Dry Run (--execute 明示時のみ外部書込許可)
 * 2. 実行順序: GitHub Pages 先行 ➔ XServer DNS CNAME 後続 (DNS先行禁止)
 * 3. Dual-Stage 状態遷移機械:
 *    - DNS_PENDING / CERT_PENDING: 正常Pending (Exit 0, downstreamAllowed: false)
 *    - WRONG_TARGET: 異Target検出時 🛑 即時 HARD STOP (Exit 1)
 *    - NETWORK_ERROR: 接続拒否・ネットワーク到達不能の分離
 *    - HTTP_ERROR: HTTP 4xx/5xx エラーの分離
 *    - PASS: DNS正常 + HTTPS 200 OK (downstreamAllowed: true)
 */

import dns from 'node:dns/promises';
import { execSync } from 'node:child_process';

export const DEFAULT_CONFIG = {
  domain: 'mie-03.postingmap.jp',
  target: 'k-iwasa-mk.github.io',
  ttl: 3600,
  timeoutMs: 180000,
  intervalMs: 10000,
  cdpUrl: 'http://[::1]:9222',
  repo: 'K-IWASA-MK/posting-map-mie-03'
};

/**
 * コマンドライン引数パーサー
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    domain: DEFAULT_CONFIG.domain,
    target: DEFAULT_CONFIG.target,
    ttl: DEFAULT_CONFIG.ttl,
    timeoutMs: DEFAULT_CONFIG.timeoutMs,
    intervalMs: DEFAULT_CONFIG.intervalMs,
    execute: false,
    verifyOnly: false,
    dryRun: true
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') {
      options.execute = true;
      options.dryRun = false;
    } else if (arg === '--verify-only') {
      options.verifyOnly = true;
      options.execute = false;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.execute = false;
    } else if (arg === '--domain' && argv[i + 1]) {
      options.domain = argv[++i];
    } else if (arg === '--target' && argv[i + 1]) {
      options.target = argv[++i];
    } else if (arg === '--ttl' && argv[i + 1]) {
      options.ttl = parseInt(argv[++i], 10);
    } else if (arg === '--timeout' && argv[i + 1]) {
      options.timeoutMs = parseInt(argv[++i], 10) * 1000;
    } else if (arg === '--interval' && argv[i + 1]) {
      options.intervalMs = parseInt(argv[++i], 10) * 1000;
    }
  }

  return options;
}

/**
 * GitHub Pages source 設定の完全保持検証
 */
export function verifyPagesSourcePreservation(beforeConfig, afterConfig) {
  if (!beforeConfig || !afterConfig) {
    throw new Error('Pages configuration missing for preservation check.');
  }

  const beforeBranch = beforeConfig.source?.branch || beforeConfig.build_type || '';
  const beforePath = beforeConfig.source?.path || '/';

  const afterBranch = afterConfig.source?.branch || afterConfig.build_type || '';
  const afterPath = afterConfig.source?.path || '/';

  if (beforeBranch !== afterBranch || beforePath !== afterPath) {
    throw new Error(`GitHub Pages source was mutated! Before: [${beforeBranch}:${beforePath}] After: [${afterBranch}:${afterPath}]`);
  }

  return true;
}

/**
 * 単一 DNS 判定
 */
export async function checkDns(domain, expectedTarget, resolver = dns.resolveCname) {
  try {
    const records = await resolver(domain);
    const normalizedTarget = expectedTarget.replace(/\.$/, '').toLowerCase();
    const hasMatch = records.some(r => r.replace(/\.$/, '').toLowerCase() === normalizedTarget);

    if (hasMatch) {
      return { status: 'DNS_OK', records };
    }

    // 解決されたが別ターゲットを指している場合
    return {
      status: 'WRONG_TARGET',
      records,
      error: `DNS points to wrong target: [${records.join(', ')}]. Expected: [${expectedTarget}]`
    };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'NODATA' || err.code === 'ETIMEOUT') {
      return { status: 'DNS_PENDING', code: err.code };
    }
    return { status: 'DNS_ERROR', error: err.message, code: err.code };
  }
}

/**
 * 単一 HTTPS / TLS 判定
 */
export async function checkHttps(domain, fetcher = fetch) {
  const url = `https://${domain}/`;
  try {
    const res = await fetcher(url, { redirect: 'manual' });
    if (res.status >= 200 && res.status < 400) {
      return { status: 'PASS', httpStatus: res.status };
    }
    return { status: 'HTTP_ERROR', httpStatus: res.status, error: `HTTP status ${res.status}` };
  } catch (err) {
    const code = err.cause?.code || err.code || '';
    const msg = err.message || '';

    // TLS / 証明書エラーの特定
    const isTlsError = /CERT_|TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|SELF_SIGNED/i.test(code) ||
                       /certificate|ssl|tls/i.test(msg);

    if (isTlsError) {
      return { status: 'CERT_PENDING', code: code || 'TLS_CERT_PENDING', error: msg };
    }

    // ネットワーク接続拒否・到達不能の特定
    const isNetworkError = /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/i.test(code);
    if (isNetworkError) {
      return { status: 'NETWORK_ERROR', code: code || 'NETWORK_UNREACHABLE', error: msg };
    }

    return { status: 'FETCH_ERROR', code, error: msg };
  }
}

/**
 * Dual-Stage 状態遷移機械ループ
 */
export async function runVerificationStateMachine({
  domain,
  target,
  resolver = dns.resolveCname,
  fetcher = fetch,
  timeoutMs = DEFAULT_CONFIG.timeoutMs,
  intervalMs = DEFAULT_CONFIG.intervalMs,
  logger = console.log
}) {
  const startTime = Date.now();
  let currentState = 'START';
  let lastDetail = null;

  logger(`\n🔍 [Dual-Stage State Machine] Starting verification for ${domain}...`);

  while (Date.now() - startTime <= timeoutMs) {
    // ── Stage 1: DNS Resolution Check ──
    const dnsResult = await checkDns(domain, target, resolver);
    lastDetail = dnsResult;

    if (dnsResult.status === 'WRONG_TARGET') {
      logger(`🛑 [HARD STOP] WRONG_TARGET detected: ${dnsResult.error}`);
      return {
        status: 'WRONG_TARGET',
        downstreamAllowed: false,
        detail: dnsResult,
        elapsedMs: Date.now() - startTime
      };
    }

    if (dnsResult.status === 'DNS_PENDING') {
      currentState = 'DNS_PENDING';
      logger(`⏳ [DNS_PENDING] DNS not yet propagated. Retrying in ${intervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    if (dnsResult.status !== 'DNS_OK') {
      logger(`⚠️ [DNS_ERROR] ${dnsResult.error || dnsResult.code}. Retrying...`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    // ── Stage 2: HTTPS & TLS Certificate Check ──
    const httpsResult = await checkHttps(domain, fetcher);
    lastDetail = httpsResult;

    if (httpsResult.status === 'PASS') {
      logger(`🎉 [PASS] DNS OK and HTTPS ${httpsResult.httpStatus} OK. Domain verified!`);
      return {
        status: 'PASS',
        downstreamAllowed: true,
        detail: httpsResult,
        elapsedMs: Date.now() - startTime
      };
    }

    if (httpsResult.status === 'CERT_PENDING') {
      currentState = 'CERT_PENDING';
      logger(`⏳ [CERT_PENDING] TLS certificate pending (${httpsResult.code}). Retrying in ${intervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    if (httpsResult.status === 'NETWORK_ERROR') {
      currentState = 'NETWORK_ERROR';
      logger(`⚠️ [NETWORK_ERROR] Network unreachable (${httpsResult.code}). Retrying in ${intervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    if (httpsResult.status === 'HTTP_ERROR') {
      currentState = 'HTTP_ERROR';
      logger(`❌ [HTTP_ERROR] HTTP error received (${httpsResult.httpStatus}).`);
      return {
        status: 'HTTP_ERROR',
        downstreamAllowed: false,
        detail: httpsResult,
        elapsedMs: Date.now() - startTime
      };
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  // タイムアウト到達時
  logger(`\n⏳ [TIMEOUT] State machine reached ${timeoutMs / 1000}s timeout while in state: ${currentState}`);
  return {
    status: currentState === 'START' ? 'DNS_PENDING' : currentState,
    downstreamAllowed: false, // PENDING時は後続実行禁止
    timeout: true,
    detail: lastDetail,
    elapsedMs: Date.now() - startTime
  };
}

/**
 * XServer DNS テーブル照合 & CNAME追加操作 (Playwright CDP)
 */
export async function syncXserverDnsRecord({
  domain,
  target,
  ttl = 3600,
  page,
  execute = false,
  logger = console.log
}) {
  const subdomain = domain.split('.')[0];
  const normalizedTarget = target.replace(/\.$/, '').toLowerCase();

  logger(`📋 [XServer DNS Check] Inspecting existing records for ${domain}...`);

  // 1. 既存レコード全スキャン
  const existingRecords = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    return rows.map(tr => Array.from(tr.querySelectorAll('th, td')).map(td => td.innerText.trim()));
  });

  const matchingRecord = existingRecords.find(r => {
    const host = (r[0] || '').toLowerCase();
    const type = (r[1] || '').toUpperCase();
    return (host === domain.toLowerCase() || host === `${subdomain}.postingmap.jp`.toLowerCase()) && type === 'CNAME';
  });

  if (matchingRecord) {
    const existingContent = (matchingRecord[2] || '').replace(/\.$/, '').toLowerCase();
    if (existingContent === normalizedTarget) {
      logger(`✅ [No-op] Identical CNAME record already exists (${domain} -> ${target}). External write = 0.`);
      return { action: 'NO_OP', existing: matchingRecord, writeCount: 0 };
    } else {
      throw new Error(`🛑 [HARD STOP] Existing record points to different target: [${existingContent}]. Expected: [${normalizedTarget}].`);
    }
  }

  if (!execute) {
    logger(`ℹ️ [Dry Run] Record does not exist. CNAME addition simulated: ${domain} -> ${target} (writeCount = 0).`);
    return { action: 'SIMULATED_ADD', writeCount: 0 };
  }

  // 2. レコード追加画面へ遷移
  logger('➕ Clicking "DNSレコード設定を追加する"...');
  const addBtn = page.locator('input[value="DNSレコード設定を追加する"], button:has-text("DNSレコード設定を追加する")').first();
  await addBtn.click();
  await page.waitForLoadState('networkidle').catch(() => {});

  // 3. 入力フィールド判定 (サブドメインのみか FQDN か)
  const isSubdomainOnly = await page.evaluate(() => {
    const hostInput = document.querySelector('input[name*="host"], input[name*="subdomain"]');
    if (!hostInput) return true;
    const parentText = hostInput.parentElement?.innerText || '';
    return parentText.includes('.postingmap.jp');
  });

  const hostValue = isSubdomainOnly ? subdomain : domain;
  logger(`📝 Filling form: Host=[${hostValue}], Type=CNAME, Content=[${target}], TTL=[${ttl}]...`);

  // ホスト名入力
  const hostInput = page.locator('input[name*="host"], input[name*="subdomain"]').first();
  await hostInput.fill(hostValue);

  // 種別選択 (CNAME)
  const typeSelect = page.locator('select[name*="type"]').first();
  await typeSelect.selectOption('CNAME');

  // 内容入力
  const contentInput = page.locator('input[name*="content"], textarea[name*="content"]').first();
  await contentInput.fill(target);

  // TTL入力
  const ttlInput = page.locator('input[name*="ttl"]').first();
  if (await ttlInput.isVisible()) {
    await ttlInput.fill(String(ttl));
  }

  // 4. 確認画面へ進む
  logger('🔍 Proceeding to confirmation screen...');
  const confirmBtn = page.locator('input[value*="確認"], button:has-text("確認")').first();
  await confirmBtn.click();
  await page.waitForLoadState('networkidle').catch(() => {});

  // 5. 🛑【機械照合ゲート】確認画面での厳格検証
  const confirmationData = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('table th, table td')).map(el => el.innerText.trim());
    return cells.join(' | ');
  });

  const hasHost = confirmationData.includes(domain) || confirmationData.includes(subdomain);
  const hasType = confirmationData.includes('CNAME');
  const hasValue = confirmationData.includes(target);

  if (!hasHost || !hasType || !hasValue) {
    throw new Error(`🛑 [HARD STOP] Confirmation check failed! Found: "${confirmationData}". Expected Host:[${domain}], Type:[CNAME], Value:[${target}]`);
  }
  logger(`✅ [Confirmation Gate PASS] Verified Host=[${domain}], Type=[CNAME], Value=[${target}].`);

  // 6. 設定を追加する (確定)
  logger('💾 Submitting DNS record addition...');
  const submitAddBtn = page.locator('input[value*="追加する"], button:has-text("追加する")').first();
  await submitAddBtn.click();
  await page.waitForLoadState('networkidle').catch(() => {});

  logger('🎉 [XServer DNS] CNAME record successfully added.');
  return { action: 'ADDED', writeCount: 1 };
}

/**
 * メイン実行エントリーポイント
 */
export async function executeDomainProvisioning(options = {}, deps = {}) {
  const opts = { ...DEFAULT_CONFIG, ...options };
  const logger = deps.logger || console.log;

  logger('====================================================');
  logger('🚀 POSTING MAP - Autonomous Domain Provisioning');
  logger(`   Target Domain: ${opts.domain}`);
  logger(`   CNAME Target:  ${opts.target}`);
  logger(`   Mode:          ${opts.execute ? '🔴 EXECUTE (Live Mutation)' : opts.verifyOnly ? '🔍 VERIFY ONLY' : '🟡 DRY RUN (Simulation)'}`);
  logger('====================================================');

  let writeCount = 0;

  // ── Phase 1: GitHub Pages Custom Domain (先行・DNS先行禁止) ──
  if (!opts.verifyOnly) {
    logger('\n▶ [Phase 1] GitHub Pages Custom Domain Configuration (Prior to DNS)');
    if (opts.execute) {
      // 1. 更新前 GET
      logger('   Fetching current GitHub Pages configuration...');
      const beforeJson = execSync(`gh api repos/${opts.repo}/pages`, { encoding: 'utf8' });
      const beforeConfig = JSON.parse(beforeJson);

      // 2. PUT 更新 (source 保持)
      logger(`   Setting custom domain to ${opts.domain}...`);
      execSync(`gh api repos/${opts.repo}/pages -X PUT -F cname="${opts.domain}"`, { encoding: 'utf8' });
      writeCount++;

      // 3. 更新後 GET 検証
      logger('   Verifying updated GitHub Pages configuration...');
      const afterJson = execSync(`gh api repos/${opts.repo}/pages`, { encoding: 'utf8' });
      const afterConfig = JSON.parse(afterJson);

      verifyPagesSourcePreservation(beforeConfig, afterConfig);
      if (afterConfig.cname !== opts.domain) {
        throw new Error(`GitHub Pages CNAME mismatch! Expected: ${opts.domain}, Got: ${afterConfig.cname}`);
      }
      logger('   ✅ Phase 1 PASS: GitHub Pages Custom Domain verified with source intact.');
    } else {
      logger('   ℹ️ [Dry Run] GitHub Pages Custom Domain PUT simulated (writeCount = 0).');
    }
  }

  // ── Phase 2: XServer DNS CNAME Addition (後続) ──
  if (!opts.verifyOnly && deps.page) {
    logger('\n▶ [Phase 2] XServer DNS CNAME Record Addition (Secondary to Pages)');
    const dnsResult = await syncXserverDnsRecord({
      domain: opts.domain,
      target: opts.target,
      ttl: opts.ttl,
      page: deps.page,
      execute: opts.execute,
      logger
    });
    writeCount += dnsResult.writeCount;
  }

  // ── Phase 3: Dual-Stage 状態遷移機械検証 ──
  logger('\n▶ [Phase 3] Dual-Stage Verification State Machine');
  const result = await runVerificationStateMachine({
    domain: opts.domain,
    target: opts.target,
    resolver: deps.resolver || dns.resolveCname,
    fetcher: deps.fetcher || fetch,
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
    logger
  });

  return {
    ...result,
    writeCount,
    mode: opts.execute ? 'EXECUTE' : opts.verifyOnly ? 'VERIFY_ONLY' : 'DRY_RUN'
  };
}

// 直接実行時
if (process.argv[1] && process.argv[1].endsWith('provision-domain.mjs')) {
  const options = parseArgs();
  executeDomainProvisioning(options)
    .then(res => {
      console.log('\n📊 [Execution Summary]:', JSON.stringify(res, null, 2));
      if (res.status === 'WRONG_TARGET' || res.status === 'HTTP_ERROR') {
        process.exit(1);
      }
      // PENDING または PASS は正常終了
      process.exit(0);
    })
    .catch(err => {
      console.error('\n🛑 [Fatal Error]:', err.message);
      process.exit(1);
    });
}
