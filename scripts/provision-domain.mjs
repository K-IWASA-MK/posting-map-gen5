#!/usr/bin/env node
/**
 * POSTING MAP - Autonomous Domain Provisioning & Verification Engine
 *
 * 対象地区独自ドメイン (<district-id>.postingmap.jp) のプロビジョニングおよび
 * Dual-Stage 状態遷移機械による厳格検証を行う。
 *
 * 【厳格運用原則】
 * 1. デフォルト Dry Run (--execute 明示時のみ外部書込許可)
 * 2. 実行順序: Identity & CNAME Precheck ➔ CDP/XServer Preflight ➔ GitHub Pages 先行 ➔ XServer DNS CNAME 後続 ➔ Local CNAME Convergence
 * 3. Exact Match Confirmation Gate: 文字列 includes() 禁止、各フィールド・Zone の完全一致判定
 * 4. Dual-Stage 状態遷移機械 & 終了コード規程:
 *    - Exit 0: PASS (HTTP 200完全一致), DNS_PENDING, CERT_PENDING のみ
 *    - Exit 1: WRONG_TARGET, HTTP_ERROR, NETWORK_ERROR, DNS_ERROR, FETCH_ERROR
 *    - PENDING 状態時は downstreamAllowed: false (後続工程への遷移禁止)
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const DEFAULT_ZONE = 'postingmap.jp';

/**
 * data/config.js (districtId) および git remote から Target Domain / Repository を導出する。
 * CNAME は出力側 (収束対象) であるため、入力 SSOT として参照してはならない。
 */
export function resolveDomainDefaults({
  rootDir = process.cwd(),
  zone = DEFAULT_ZONE,
  gitRemoteUrl = null,
  execRunner = execSync,
  fsModule = fs
} = {}) {
  let districtId = '';
  try {
    const configPath = path.join(rootDir, 'data', 'config.js');
    if (fsModule.existsSync(configPath)) {
      const content = fsModule.readFileSync(configPath, 'utf8');
      const match = content.match(/\bdistrictId\s*:\s*['"]([^'"]+)['"]/);
      if (match && match[1]) {
        districtId = match[1].trim();
      }
    }
  } catch (_) {}

  const normalizedZone = (zone || DEFAULT_ZONE).trim().toLowerCase();
  const derivedDomain = districtId ? `${districtId.toLowerCase()}.${normalizedZone}` : '';

  let remoteRaw = gitRemoteUrl ? String(gitRemoteUrl).trim() : '';
  if (!remoteRaw) {
    try {
      remoteRaw = String(
        execRunner('git remote get-url origin', {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }) || ''
      ).trim();
    } catch (_) {}
  }

  let repo = '';
  let repoSlug = '';
  const repoMatch = remoteRaw.match(/(?:github\.com[:/]|^)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (repoMatch && repoMatch[1]) {
    repo = repoMatch[1];
  } else if (/^posting-map-[A-Za-z0-9_-]+$/i.test(remoteRaw)) {
    repo = remoteRaw;
  }

  const slugMatch = (repo || remoteRaw).match(/posting-map-([A-Za-z0-9_-]+?)(?:\.git|$)/i);
  if (slugMatch && slugMatch[1]) {
    const candidate = slugMatch[1];
    if (!/^gen\d+$/i.test(candidate) && candidate.toLowerCase() !== 'universal') {
      repoSlug = candidate;
    }
  }

  return {
    districtId,
    domain: derivedDomain,
    repo,
    repoSlug,
    zone: normalizedZone
  };
}

/**
 * 外部書込前の Identity 整合検証 (Fail-Closed)
 * data/config.js districtId と git remote repo slug の一致を検証する。
 */
export function verifyDomainIdentityAlignment({
  districtId,
  domain,
  repo,
  repoSlug = '',
  zone = DEFAULT_ZONE
} = {}) {
  const normZone = (zone || DEFAULT_ZONE).trim().toLowerCase();
  const normDomain = (domain || '').trim().toLowerCase();
  const normDistrictId = (districtId || '').trim();

  if (!normDomain || !normDomain.endsWith(`.${normZone}`)) {
    throw new Error(`🛑 [HARD STOP: INVALID_TARGET_DOMAIN] Target domain [${domain}] is missing or outside zone [${normZone}].`);
  }

  if (normDistrictId) {
    if (!/^[A-Z0-9-]+$/.test(normDistrictId)) {
      throw new Error(`🛑 [HARD STOP: INVALID_DISTRICT_ID] Invalid districtId format: [${normDistrictId}].`);
    }
    const expectedDomain = `${normDistrictId.toLowerCase()}.${normZone}`;
    if (normDomain !== expectedDomain) {
      throw new Error(`🛑 [HARD STOP: IDENTITY_MISMATCH] Target domain [${normDomain}] does not match districtId [${normDistrictId}] (expected [${expectedDomain}]).`);
    }
  }

  const resolvedSlug = repoSlug || (() => {
    const m = String(repo || '').match(/posting-map-([A-Za-z0-9_-]+?)(?:\.git|$)/i);
    if (m && m[1] && !/^gen\d+$/i.test(m[1]) && m[1].toLowerCase() !== 'universal') {
      return m[1];
    }
    return '';
  })();

  if (resolvedSlug && normDistrictId && resolvedSlug.toLowerCase() !== normDistrictId.toLowerCase()) {
    throw new Error(
      `🛑 [HARD STOP: IDENTITY_MISMATCH] District Identity mismatch between data/config.js (${normDistrictId}) and git remote slug (${resolvedSlug} in ${repo}). Aborting before external write.`
    );
  }

  if (resolvedSlug && !normDistrictId) {
    const expectedFromSlug = `${resolvedSlug.toLowerCase()}.${normZone}`;
    if (normDomain !== expectedFromSlug) {
      throw new Error(
        `🛑 [HARD STOP: IDENTITY_MISMATCH] Target domain (${normDomain}) does not match git remote slug (${resolvedSlug}). Aborting before external write.`
      );
    }
  }

  return true;
}

/**
 * ローカル CNAME ファイルの状態検証および収束計画判定 (Fail-Closed)
 * - Current CNAME === Target Domain -> NO_OP
 * - Current CNAME === 旧地区ドメイン (<old>.postingmap.jp) -> UPDATE_NEEDED
 * - 欠損・複数行・プロトコル混入・別ゾーン等の異常形式 -> Fail-Closed HARD STOP
 */
export function validateAndPlanCnameSync({
  rootDir = process.cwd(),
  domain,
  zone = DEFAULT_ZONE,
  fsModule = fs
} = {}) {
  const normZone = (zone || DEFAULT_ZONE).trim().toLowerCase();
  const escapedZone = normZone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const validDomainRegex = new RegExp(`^[a-z0-9-]+\\.${escapedZone}$`, 'i');

  const normTarget = (domain || '').trim().toLowerCase();
  if (!validDomainRegex.test(normTarget)) {
    throw new Error(`🛑 [HARD STOP: INVALID_CNAME_STATE] Target domain [${domain}] is invalid for zone [${normZone}].`);
  }

  const cnamePath = path.join(rootDir, 'CNAME');
  if (!fsModule.existsSync(cnamePath)) {
    throw new Error(`🛑 [HARD STOP: INVALID_CNAME_STATE] Local CNAME file does not exist at ${cnamePath}.`);
  }

  const rawContent = fsModule.readFileSync(cnamePath, 'utf8');
  const lines = rawContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length !== 1 || !validDomainRegex.test(lines[0])) {
    throw new Error(
      `🛑 [HARD STOP: INVALID_CNAME_STATE] Local CNAME contains unexpected or malformed content: [${rawContent.trim()}]. Expected single-line <district>.${normZone}.`
    );
  }

  const currentCname = lines[0].toLowerCase();
  if (currentCname === normTarget) {
    return {
      action: 'NO_OP',
      currentCname,
      targetCname: normTarget,
      cnamePath
    };
  }

  return {
    action: 'UPDATE_NEEDED',
    currentCname,
    targetCname: normTarget,
    cnamePath
  };
}

/**
 * ローカル CNAME ファイルを Target Domain へ収束させる
 */
export function syncLocalCnameFile({
  rootDir = process.cwd(),
  domain,
  zone = DEFAULT_ZONE,
  execute = false,
  fsModule = fs,
  logger = console.log
} = {}) {
  const plan = validateAndPlanCnameSync({ rootDir, domain, zone, fsModule });

  if (plan.action === 'NO_OP') {
    logger(`   ✅ [Local CNAME] Already aligned to ${plan.targetCname} (NO_OP).`);
    return {
      action: 'NO_OP',
      currentCname: plan.currentCname,
      targetCname: plan.targetCname
    };
  }

  if (!execute) {
    logger(`   ℹ️ [Dry Run] Local CNAME convergence simulated: ${plan.currentCname} -> ${plan.targetCname}.`);
    return {
      action: 'SIMULATED_UPDATE',
      currentCname: plan.currentCname,
      targetCname: plan.targetCname
    };
  }

  fsModule.writeFileSync(plan.cnamePath, `${plan.targetCname}\n`, 'utf8');
  const verified = fsModule.readFileSync(plan.cnamePath, 'utf8').trim().toLowerCase();
  if (verified !== plan.targetCname) {
    throw new Error(`🛑 [HARD STOP: CNAME_SYNC_FAILED] Local CNAME verification failed after write! Expected [${plan.targetCname}], Got [${verified}].`);
  }

  logger(`   💾 [Local CNAME] Updated local CNAME from ${plan.currentCname} to ${plan.targetCname}.`);
  return {
    action: 'UPDATED',
    currentCname: plan.currentCname,
    targetCname: plan.targetCname
  };
}

const RESOLVED_DOMAIN_DEFAULTS = resolveDomainDefaults();

export const DEFAULT_CONFIG = {
  districtId: RESOLVED_DOMAIN_DEFAULTS.districtId,
  domain: RESOLVED_DOMAIN_DEFAULTS.domain,
  target: 'k-iwasa-mk.github.io',
  ttl: 3600,
  zone: DEFAULT_ZONE,
  timeoutMs: 180000,
  intervalMs: 10000,
  cdpUrl: 'http://[::1]:9222',
  repo: RESOLVED_DOMAIN_DEFAULTS.repo,
  repoSlug: RESOLVED_DOMAIN_DEFAULTS.repoSlug
};

/**
 * コマンドライン引数パーサー
 */
export function parseArgs(argv = process.argv.slice(2), context = {}) {
  const base = (context.rootDir || context.gitRemoteUrl)
    ? { ...DEFAULT_CONFIG, ...resolveDomainDefaults(context) }
    : DEFAULT_CONFIG;

  const options = {
    districtId: base.districtId,
    domain: base.domain,
    target: base.target,
    ttl: base.ttl,
    zone: base.zone,
    timeoutMs: base.timeoutMs,
    intervalMs: base.intervalMs,
    repo: base.repo,
    repoSlug: base.repoSlug,
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
    } else if (arg === '--district-id' && argv[i + 1]) {
      options.districtId = argv[++i].trim();
      options.domain = `${options.districtId.toLowerCase()}.${options.zone}`;
    } else if (arg === '--domain' && argv[i + 1]) {
      options.domain = argv[++i];
      if (!argv.includes('--district-id')) {
        options.districtId = '';
      }
    } else if (arg === '--repo' && argv[i + 1]) {
      options.repo = argv[++i];
      options.repoSlug = '';
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
 * 終了コード解決関数 (MASTER Specification)
 * Exit 0 を許すのは PASS, DNS_PENDING, CERT_PENDING のみ。
 * その他 (WRONG_TARGET, HTTP_ERROR, NETWORK_ERROR, DNS_ERROR, FETCH_ERROR 等) は Exit 1。
 */
export function resolveExitCode(status) {
  const ALLOWED_EXIT_ZERO = new Set(['PASS', 'DNS_PENDING', 'CERT_PENDING']);
  return ALLOWED_EXIT_ZERO.has(status) ? 0 : 1;
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
 * 単一 HTTPS / TLS 判定 (HTTP 200 完全一致契約)
 */
export async function checkHttps(domain, fetcher = fetch) {
  const url = `https://${domain}/`;
  try {
    const res = await fetcher(url, { redirect: 'manual' });
    if (res.status === 200) {
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
 * XServer ゾーン完全一致検証
 */
export async function verifyXserverZone(page, expectedZone = 'postingmap.jp', logger = console.log) {
  if (!page) {
    throw new Error('🛑 [verifyXserverZone] Page reference is missing.');
  }

  const zoneFound = await page.evaluate(() => {
    // 1. <dl><dt>ドメイン</dt><dd>postingmap.jp</dd></dl>
    const dls = Array.from(document.querySelectorAll('dl'));
    for (const dl of dls) {
      const dtText = dl.querySelector('dt')?.innerText.trim() || '';
      const ddText = dl.querySelector('dd')?.innerText.trim() || '';
      if (dtText.includes('ドメイン') || dtText.toLowerCase().includes('domain')) {
        return ddText.toLowerCase();
      }
    }

    // 2. <dd> または .domain-name
    const dds = Array.from(document.querySelectorAll('dd, .domain-name, [data-domain]'));
    for (const dd of dds) {
      const t = dd.innerText.trim().toLowerCase();
      if (t.includes('.')) return t;
    }

    return '';
  });

  const normalizedExpected = expectedZone.toLowerCase();
  if (zoneFound !== normalizedExpected) {
    throw new Error(`🛑 [HARD STOP] XServer Zone verification failed! Expected zone [${normalizedExpected}], found [${zoneFound}].`);
  }
  return true;
}

/**
 * 確認画面各フィールドの Exact Match Gate
 * 文字列 includes() は完全禁止。
 */
export function verifyConfirmationFields(fields, { domain, target, ttl = 3600, zone = 'postingmap.jp' }) {
  const subdomain = domain.split('.')[0].toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  const normalizedTarget = target.replace(/\.$/, '').toLowerCase();

  // Zone exact check
  const actualZone = (fields.zone || '').trim().toLowerCase();
  if (!actualZone || actualZone !== zone.toLowerCase()) {
    throw new Error(`🛑 [HARD STOP] Confirmation Gate FAIL: Zone mismatch! Expected exact [${zone}], Got [${fields.zone}].`);
  }

  // Host exact check (subdomain または FQDN の完全一致)
  const actualHost = (fields.host || '').trim().toLowerCase();
  if (actualHost !== normalizedDomain && actualHost !== subdomain) {
    throw new Error(`🛑 [HARD STOP] Confirmation Gate FAIL: Host mismatch! Expected exact [${normalizedDomain}] or [${subdomain}], Got [${fields.host}].`);
  }

  // Type exact check
  const actualType = (fields.type || '').trim().toUpperCase();
  if (actualType !== 'CNAME') {
    throw new Error(`🛑 [HARD STOP] Confirmation Gate FAIL: Type mismatch! Expected exact [CNAME], Got [${fields.type}].`);
  }

  // Content exact check
  const actualContent = (fields.content || '').trim().replace(/\.$/, '').toLowerCase();
  if (actualContent !== normalizedTarget) {
    throw new Error(`🛑 [HARD STOP] Confirmation Gate FAIL: Content mismatch! Expected exact [${normalizedTarget}], Got [${fields.content}].`);
  }

  // TTL exact check (設定値が存在する場合)
  if (fields.ttl !== undefined && fields.ttl !== null && String(fields.ttl).trim() !== '') {
    const actualTtl = Number(String(fields.ttl).trim());
    if (actualTtl !== Number(ttl)) {
      throw new Error(`🛑 [HARD STOP] Confirmation Gate FAIL: TTL mismatch! Expected exact [${ttl}], Got [${fields.ttl}].`);
    }
  }

  return true;
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
      currentState = dnsResult.status;
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
    downstreamAllowed: false, // PENDING または エラー時は後続実行禁止
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

  // 1. 既存レコード全スキャン (Exact Column Matching)
  const existingRecords = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    return rows.map(tr => Array.from(tr.querySelectorAll('th, td')).map(td => td.innerText.trim()));
  });

  const matchingRecord = existingRecords.find(r => {
    const host = (r[0] || '').trim().toLowerCase();
    const type = (r[1] || '').trim().toUpperCase();
    const isHostMatch = (host === domain.toLowerCase() || host === `${subdomain}.postingmap.jp`.toLowerCase());
    return isHostMatch && type === 'CNAME';
  });

  if (matchingRecord) {
    const existingContent = (matchingRecord[2] || '').trim().replace(/\.$/, '').toLowerCase();
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

  // 5. 🛑【機械照合ゲート】確認画面での厳格検証 (Exact Match Gate)
  logger('🔍 [Confirmation Gate] Extracting fields for exact verification...');
  const confirmationFields = await page.evaluate(() => {
    const fields = { zone: '', host: '', type: '', content: '', ttl: '' };

    // 1. Extract zone from dl
    const dls = Array.from(document.querySelectorAll('dl'));
    for (const dl of dls) {
      const dtText = dl.querySelector('dt')?.innerText.trim() || '';
      const ddText = dl.querySelector('dd')?.innerText.trim() || '';
      if (dtText.includes('ドメイン') || dtText.toLowerCase().includes('domain')) {
        fields.zone = ddText;
      }
    }

    // 2. Extract key-value rows from confirmation table
    const rows = Array.from(document.querySelectorAll('table tr'));
    for (const tr of rows) {
      const th = tr.querySelector('th')?.innerText.trim() || '';
      const td = tr.querySelector('td')?.innerText.trim() || '';
      if (!th && !td) continue;

      if (th.includes('ドメイン')) fields.zone = td || fields.zone;
      if (th.includes('ホスト名') || th.toLowerCase().includes('host')) fields.host = td;
      if (th.includes('種別') || th.toLowerCase().includes('type')) fields.type = td;
      if (th.includes('内容') || th.toLowerCase().includes('content') || th.includes('値')) fields.content = td;
      if (th.includes('TTL') || th.toLowerCase().includes('ttl')) fields.ttl = td;
    }

    // If confirmation is a row in a table (e.g. Host | Type | Content | TTL)
    if (!fields.host || !fields.type || !fields.content) {
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (tds.length >= 3) {
          if (['CNAME', 'A', 'TXT', 'MX', 'NS'].includes(tds[1]?.toUpperCase())) {
            fields.host = fields.host || tds[0];
            fields.type = fields.type || tds[1];
            fields.content = fields.content || tds[2];
            if (tds[3]) fields.ttl = fields.ttl || tds[3];
          }
        }
      }
    }

    return fields;
  });

  // Run exact match gate
  verifyConfirmationFields(confirmationFields, { domain, target, ttl, zone: 'postingmap.jp' });
  logger(`✅ [Confirmation Gate PASS] Exact match verified: Zone=[${confirmationFields.zone}], Host=[${confirmationFields.host}], Type=[${confirmationFields.type}], Content=[${confirmationFields.content}], TTL=[${confirmationFields.ttl || ttl}].`);

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
  const baseDefaults = (options.rootDir || options.gitRemoteUrl)
    ? {
        ...DEFAULT_CONFIG,
        ...resolveDomainDefaults({
          rootDir: options.rootDir,
          zone: options.zone || DEFAULT_CONFIG.zone,
          gitRemoteUrl: options.gitRemoteUrl,
          fsModule: deps.fs || fs
        })
      }
    : DEFAULT_CONFIG;
  const opts = { ...baseDefaults, ...options };
  const logger = deps.logger || console.log;
  const fsModule = deps.fs || fs;
  const rootDir = opts.rootDir || process.cwd();

  logger('====================================================');
  logger('🚀 POSTING MAP - Autonomous Domain Provisioning');
  logger(`   Target Domain: ${opts.domain}`);
  logger(`   CNAME Target:  ${opts.target}`);
  logger(`   Mode:          ${opts.execute ? '🔴 EXECUTE (Live Mutation)' : opts.verifyOnly ? '🔍 VERIFY ONLY' : '🟡 DRY RUN (Simulation)'}`);
  logger('====================================================');

  let writeCount = 0;
  let cnameSync = null;
  let page = deps.page || null;
  let browser = null;

  // ── Pre-Execution Identity & CNAME Precheck Gate (MUST PASS BEFORE ANY EXTERNAL OR LOCAL WRITE) ──
  if (!opts.verifyOnly) {
    verifyDomainIdentityAlignment({
      districtId: opts.districtId,
      domain: opts.domain,
      repo: opts.repo,
      repoSlug: opts.repoSlug,
      zone: opts.zone
    });

    const cnamePlan = validateAndPlanCnameSync({
      rootDir,
      domain: opts.domain,
      zone: opts.zone,
      fsModule
    });
    if (opts.execute && cnamePlan.action === 'UPDATE_NEEDED' && typeof fsModule.accessSync === 'function') {
      fsModule.accessSync(cnamePlan.cnamePath, fs.constants.W_OK);
    }
  }

  // ── Preflight Gate: CDP & XServer Tab Validation (MUST PASS BEFORE GITHUB PAGES) ──
  // In execute mode, we MUST acquire and validate the XServer tab BEFORE any mutation to GitHub Pages.
  if (opts.execute) {
    logger('\n🛡️ [Preflight Gate] Connecting to Chrome CDP & Validating XServer DNS Context...');
    if (!page) {
      const cdpUrl = opts.cdpUrl || DEFAULT_CONFIG.cdpUrl;
      logger(`   Connecting to CDP endpoint: ${cdpUrl}...`);
      try {
        const chromiumModule = deps.chromium || chromium;
        browser = await chromiumModule.connectOverCDP(cdpUrl);
      } catch (err) {
        throw new Error(`🛑 [Preflight FAIL] Cannot connect to Chrome over CDP (${cdpUrl}): ${err.message}. Aborting before GitHub Pages mutation.`);
      }

      const contexts = browser.contexts ? browser.contexts() : [];
      if (!contexts || contexts.length === 0) {
        throw new Error(`🛑 [Preflight FAIL] No browser contexts found in connected Chrome. Aborting before GitHub Pages mutation.`);
      }

      const allPages = contexts.flatMap(c => c.pages ? c.pages() : []);
      // Locate XServer tab: secure.xserver.ne.jp with /dns/index
      page = allPages.find(p => {
        const u = p.url ? p.url() : '';
        return u.includes('secure.xserver.ne.jp') && (u.includes('/dns/index') || u.includes('id_domain=22788581'));
      });

      if (!page) {
        throw new Error(`🛑 [Preflight FAIL] XServer DNS settings tab not found in Chrome. Expected URL containing secure.xserver.ne.jp/.../dns/index. Aborting before GitHub Pages mutation.`);
      }
    }

    // Verify Zone = postingmap.jp on page
    logger(`   Validating XServer Zone context (expected apex: postingmap.jp)...`);
    await verifyXserverZone(page, opts.zone || 'postingmap.jp', logger);
    logger(`   ✅ Preflight Gate PASS: Chrome CDP & XServer postingmap.jp tab verified. GitHub Pages modification permitted.`);
  }

  // ── Phase 1: GitHub Pages Custom Domain (先行・DNS先行禁止) ──
  if (!opts.verifyOnly) {
    logger('\n▶ [Phase 1] GitHub Pages Custom Domain Configuration (Prior to DNS)');
    if (opts.execute) {
      const ghRunner = deps.execSync || execSync;
      // 1. 更新前 GET
      logger('   Fetching current GitHub Pages configuration...');
      const beforeJson = ghRunner(`gh api repos/${opts.repo}/pages`, { encoding: 'utf8' });
      const beforeConfig = JSON.parse(beforeJson);

      // 2. PUT 更新 (source 保持)
      logger(`   Setting custom domain to ${opts.domain}...`);
      ghRunner(`gh api repos/${opts.repo}/pages -X PUT -F cname="${opts.domain}"`, { encoding: 'utf8' });
      writeCount++;

      // 3. 更新後 GET 検証
      logger('   Verifying updated GitHub Pages configuration...');
      const afterJson = ghRunner(`gh api repos/${opts.repo}/pages`, { encoding: 'utf8' });
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
  if (!opts.verifyOnly) {
    logger('\n▶ [Phase 2] XServer DNS CNAME Record Addition (Secondary to Pages)');
    if (opts.execute || page) {
      const dnsResult = await syncXserverDnsRecord({
        domain: opts.domain,
        target: opts.target,
        ttl: opts.ttl,
        page,
        execute: opts.execute,
        logger
      });
      writeCount += dnsResult.writeCount;
    } else {
      logger('   ℹ️ [Dry Run] No page attached; XServer DNS CNAME simulated (writeCount = 0).');
    }

    // ── Phase 2b: Local Repository CNAME Convergence ──
    logger('\n▶ [Phase 2b] Local Repository CNAME Convergence');
    cnameSync = syncLocalCnameFile({
      rootDir,
      domain: opts.domain,
      zone: opts.zone,
      execute: opts.execute,
      fsModule,
      logger
    });
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
    cnameSync,
    mode: opts.execute ? 'EXECUTE' : opts.verifyOnly ? 'VERIFY_ONLY' : 'DRY_RUN'
  };
}

// 直接実行時
if (process.argv[1] && process.argv[1].endsWith('provision-domain.mjs')) {
  const options = parseArgs();
  executeDomainProvisioning(options)
    .then(res => {
      console.log('\n📊 [Execution Summary]:', JSON.stringify(res, null, 2));
      const code = resolveExitCode(res.status);
      process.exit(code);
    })
    .catch(err => {
      console.error('\n🛑 [Fatal Error]:', err.message);
      process.exit(1);
    });
}
