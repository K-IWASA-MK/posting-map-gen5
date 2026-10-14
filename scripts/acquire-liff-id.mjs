import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();

export const DEFAULT_PROVIDER_CONFIG = {
  providerName: 'Civic Tech Inc.',
  providerId: '2005181930',
  cdpUrl: 'http://127.0.0.1:9222'
};

// Safe local secret loader from .env (gitignored)
export function loadEnvFallback(targetRootDir = rootDir) {
  const envPath = path.join(targetRootDir, '.env');
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

/**
 * CLI 引数および環境変数パーサー
 */
export function parseAcquireArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    explicitChannelId: (env.LINE_LOGIN_CHANNEL_ID || '').trim() || null,
    providerId: DEFAULT_PROVIDER_CONFIG.providerId,
    providerName: DEFAULT_PROVIDER_CONFIG.providerName,
    cdpUrl: DEFAULT_PROVIDER_CONFIG.cdpUrl,
    createIfMissing: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channel-id' && argv[i + 1]) {
      options.explicitChannelId = argv[++i].trim();
    } else if (arg === '--provider-id' && argv[i + 1]) {
      options.providerId = argv[++i].trim();
    } else if (arg === '--cdp-url' && argv[i + 1]) {
      options.cdpUrl = argv[++i].trim();
    } else if (arg === '--create-if-missing') {
      options.createIfMissing = true;
    }
  }

  return options;
}

/**
 * 1. Identity Authority & Domain/CNAME Precondition Resolution
 * - 地区 Identity の正本は data/config.js の districtId とする。
 * - Target Domain は ${districtId.toLowerCase()}.postingmap.jp から導出し、
 *   ローカル CNAME が同値であることを Precondition として検証する（CNAME を Identity の起点にはしない）。
 * - data/config.js の既存 line.liffId は比較・更新対象としてのみ保持し、Channel ID 導出には一切使用しない。
 */
export function resolveDistrictConfig({ targetRootDir = rootDir, fsModule = fs } = {}) {
  const configPath = path.join(targetRootDir, 'data', 'config.js');
  if (!fsModule.existsSync(configPath)) {
    throw new Error(`🛑 [HARD STOP: CONFIG_NOT_FOUND] data/config.js not found at ${configPath}.`);
  }
  const configContent = fsModule.readFileSync(configPath, 'utf8');
  const districtMatch = configContent.match(/districtId\s*:\s*["']([^"']+)["']/);
  const districtId = districtMatch ? districtMatch[1].trim() : '';
  if (!districtId || !/^[A-Z0-9-]+$/.test(districtId)) {
    throw new Error(`🛑 [HARD STOP: INVALID_DISTRICT_ID] Valid districtId is not declared in data/config.js (got: "${districtId}").`);
  }

  // Note: existingLiffId in data/config.js may be a stale copied value from a previous district.
  // It MUST NEVER be used to derive the Login Channel ID. It is recorded strictly as a comparison/update target.
  const liffMatch = configContent.match(/liffId\s*:\s*["']([^"']*)["']/);
  const existingConfigLiffId = liffMatch ? liffMatch[1].trim() : '';

  const domain = `${districtId.toLowerCase()}.postingmap.jp`;
  const cnamePath = path.join(targetRootDir, 'CNAME');
  if (!fsModule.existsSync(cnamePath)) {
    throw new Error(`🛑 [HARD STOP: CNAME_PRECONDITION_FAILED] Local CNAME file not found at ${cnamePath}. Complete Domain Provisioning first.`);
  }
  const cnameLines = fsModule.readFileSync(cnamePath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (cnameLines.length !== 1 || cnameLines[0].toLowerCase() !== domain) {
    throw new Error(
      `🛑 [HARD STOP: CNAME_PRECONDITION_FAILED] Local CNAME [${cnameLines.join(' ')}] does not match derived target domain [${domain}] for districtId [${districtId}]. Complete Domain Provisioning first.`
    );
  }

  const deploymentPath = path.join(targetRootDir, 'deployment.json');
  let deployment = null;
  if (fsModule.existsSync(deploymentPath)) {
    deployment = JSON.parse(fsModule.readFileSync(deploymentPath, 'utf8'));
    const depDistrictId = String(deployment.districtId || '').trim();
    if (depDistrictId && depDistrictId !== districtId) {
      throw new Error(
        `🛑 [HARD STOP: DEPLOYMENT_IDENTITY_MISMATCH] deployment.json districtId [${depDistrictId}] does not match data/config.js districtId [${districtId}].`
      );
    }
  }

  const endpointUrl = `https://${domain}/`;
  const appName = `POSTING MAP ${districtId}`;

  return {
    districtId,
    domain,
    endpointUrl,
    appName,
    existingConfigLiffId,
    configPath,
    deployment,
    deploymentPath: deployment ? deploymentPath : null
  };
}

function isLineLoginChannelType(rawType) {
  const norm = String(rawType || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return norm === 'LINE_LOGIN';
}

/**
 * 2. Own LINE Login Channel Positive Discovery
 * Provider 配下のチャネル一覧から、
 * - channel type = LINE Login
 * - channel name = POSTING MAP ${districtId}
 * を完全一致で満たす自地区チャネルのみを特定する。
 * 明示 Channel ID (--channel-id / env) が与えられた場合も無条件信用せず、Provider DOM 上で上記契約一致を検証する。
 */
export function resolveOwnLoginChannel(providerChannels = [], { districtId, expectedChannelName, explicitChannelId = null } = {}) {
  const normDistrictId = String(districtId || '').trim();
  const targetName = String(expectedChannelName || `POSTING MAP ${normDistrictId}`).trim();
  if (!normDistrictId || !targetName) {
    throw new Error('🛑 [HARD STOP: INVALID_CHANNEL_DISCOVERY_INPUT] districtId and expectedChannelName are required.');
  }

  const channels = Array.isArray(providerChannels) ? providerChannels : [];

  if (explicitChannelId) {
    const normExplicitId = String(explicitChannelId).trim();
    if (!/^\d+$/.test(normExplicitId)) {
      throw new Error(`🛑 [HARD STOP: INVALID_EXPLICIT_CHANNEL_ID] Explicit channel ID [${explicitChannelId}] is not numeric.`);
    }
    const foundById = channels.filter(ch => String(ch.channelId || '').trim() === normExplicitId);
    if (foundById.length === 0) {
      throw new Error(
        `🛑 [HARD STOP: FOREIGN_OR_MISMATCHED_CHANNEL_ID] Explicit channel ID [${normExplicitId}] was not found under Provider DOM.`
      );
    }
    const ch = foundById[0];
    if (!isLineLoginChannelType(ch.type) || String(ch.name || '').trim() !== targetName) {
      throw new Error(
        `🛑 [HARD STOP: FOREIGN_OR_MISMATCHED_CHANNEL_ID] Explicit channel ID [${normExplicitId}] on Provider DOM has name="${ch.name}" type="${ch.type}", which does not match expected own LINE Login channel "${targetName}" for district [${normDistrictId}].`
      );
    }
    return {
      channelId: normExplicitId,
      channelName: String(ch.name).trim(),
      type: 'LINE_LOGIN'
    };
  }

  const matchingOwnChannels = channels.filter(ch => {
    const id = String(ch.channelId || '').trim();
    const name = String(ch.name || '').trim();
    return /^\d+$/.test(id) && isLineLoginChannelType(ch.type) && name === targetName;
  });

  if (matchingOwnChannels.length === 0) {
    throw new Error(
      `🛑 [HARD STOP: OWN_LOGIN_CHANNEL_NOT_FOUND] Found 0 LINE Login channels matching "${targetName}" for district [${normDistrictId}]. Complete LINE Asset Provisioning first.`
    );
  }

  if (matchingOwnChannels.length > 1) {
    const ids = matchingOwnChannels.map(c => c.channelId).join(', ');
    throw new Error(
      `🛑 [HARD STOP: AMBIGUOUS_OWN_LOGIN_CHANNEL] Found ${matchingOwnChannels.length} LINE Login channels matching "${targetName}" (${ids}). Refusing to select ambiguously.`
    );
  }

  return {
    channelId: String(matchingOwnChannels[0].channelId).trim(),
    channelName: String(matchingOwnChannels[0].name).trim(),
    type: 'LINE_LOGIN'
  };
}

/**
 * 3. Own LIFF Positive Identity Closure
 * Foreign blacklist ではなく、候補 LIFF について：
 * - parent Login Channel === resolved own channel ID
 * - LIFF/App name === POSTING MAP ${districtId}
 * - endpoint URL === https://${districtId.toLowerCase()}.postingmap.jp/
 * - LIFF ID format === /^${ownChannelId}-[A-Za-z0-9_]{8}$/ (prefix === ownChannelId)
 * が同時成立する候補のみを採用する。
 * 0件 -> HARD STOP: OWN_LIFF_NOT_FOUND
 * 2件以上 -> HARD STOP: AMBIGUOUS_OWN_LIFF
 */
export function resolveOwnLiffCandidate(liffCandidates = [], { ownChannelId, expectedAppName, expectedEndpointUrl } = {}) {
  const normChannelId = String(ownChannelId || '').trim();
  const targetName = String(expectedAppName || '').trim();
  const targetEndpoint = String(expectedEndpointUrl || '').trim();

  if (!/^\d+$/.test(normChannelId) || !targetName || !targetEndpoint) {
    throw new Error('🛑 [HARD STOP: INVALID_LIFF_CLOSURE_INPUT] ownChannelId, expectedAppName, and expectedEndpointUrl are required.');
  }

  const liffFormatRegex = /^(\d+)-[A-Za-z0-9_]{8}$/;
  const candidates = Array.isArray(liffCandidates) ? liffCandidates : [];

  const validCandidates = candidates.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const liffId = String(item.liffId || '').trim();
    const name = String(item.name || '').trim();
    const endpointUrl = String(item.endpointUrl || '').trim();
    const parentChannelId = item.parentChannelId !== undefined
      ? String(item.parentChannelId).trim()
      : normChannelId;

    const formatMatch = liffId.match(liffFormatRegex);
    if (!formatMatch) return false;
    const prefixChannelId = formatMatch[1];

    return (
      parentChannelId === normChannelId &&
      prefixChannelId === normChannelId &&
      name === targetName &&
      endpointUrl === targetEndpoint
    );
  });

  if (validCandidates.length === 0) {
    throw new Error(
      `🛑 [HARD STOP: OWN_LIFF_NOT_FOUND] Found 0 valid LIFF apps under own Login Channel [${normChannelId}] matching name=[${targetName}], endpoint=[${targetEndpoint}], and prefix=[${normChannelId}-].`
    );
  }

  if (validCandidates.length > 1) {
    const ids = validCandidates.map(c => c.liffId).join(', ');
    throw new Error(
      `🛑 [HARD STOP: AMBIGUOUS_OWN_LIFF] Found ${validCandidates.length} matching LIFF apps under channel [${normChannelId}] (${ids}). Refusing to select ambiguously.`
    );
  }

  return {
    liffId: String(validCandidates[0].liffId).trim(),
    name: String(validCandidates[0].name).trim(),
    endpointUrl: String(validCandidates[0].endpointUrl).trim(),
    parentChannelId: normChannelId
  };
}

/**
 * Provider 画面からチャネル一覧を DOM 抽出する
 */
export async function extractProviderChannelsFromDom(page, providerId = DEFAULT_PROVIDER_CONFIG.providerId) {
  const providerUrl = `https://developers.line.biz/console/provider/${providerId}`;
  if (!page.url().includes(`/console/provider/${providerId}`)) {
    await page.goto(providerUrl, { waitUntil: 'networkidle' });
  }
  await page.waitForLoadState('networkidle').catch(() => {});

  return await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('a[href*="/console/channel/"], .channel-item, [data-channel-id]'));
    const results = [];
    const seen = new Set();

    for (const card of cards) {
      const href = card.getAttribute('href') || card.querySelector('a[href*="/console/channel/"]')?.getAttribute('href') || '';
      const idMatch = href.match(/\/console\/channel\/(\d+)/);
      const channelId = card.getAttribute('data-channel-id') || (idMatch ? idMatch[1] : null);
      if (!channelId || seen.has(channelId)) continue;

      const rawText = (card.innerText || '').trim();
      let type = 'UNKNOWN';
      if (/LINE\s*Login/i.test(rawText)) type = 'LINE_LOGIN';
      else if (/Messaging\s*API/i.test(rawText)) type = 'MESSAGING_API';

      const titleEl = card.querySelector('h3.title, h3, h4, .channel-name, .title');
      let name = '';
      if (titleEl) {
        const clone = titleEl.cloneNode(true);
        clone.querySelectorAll('.badge, .tag, span.status, i').forEach(el => el.remove());
        name = (clone.textContent || '').trim();
      }
      if (!name) {
        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
        name = lines.find(l => !/^(LINE\s*Login|Messaging\s*API|公開|開発中|Published|Developing|新規|Admin)$/i.test(l)) || '';
      }

      seen.add(channelId);
      results.push({ channelId, name, type });
    }
    return results;
  });
}

/**
 * 自地区 LINE Login Channel の LIFF タブから候補 LIFF 一覧を DOM 抽出する
 */
export async function extractChannelLiffsFromDom(page, ownChannelId) {
  const liffTabUrl = `https://developers.line.biz/console/channel/${ownChannelId}/liff`;
  if (!page.url().includes(`/console/channel/${ownChannelId}/liff`)) {
    await page.goto(liffTabUrl, { waitUntil: 'networkidle' });
  }
  await page.waitForLoadState('networkidle').catch(() => {});

  const listItems = await page.evaluate((channelId) => {
    const detailLinks = Array.from(document.querySelectorAll('a.row[href*="/liff/"], a[href*="/liff/"]'));
    const rowLinks = detailLinks
      .map(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/channel\/(\d+)\/liff\/(\d+-[A-Za-z0-9_]{8})/);
        if (!m) return null;
        const cells = Array.from(a.querySelectorAll('div, td, span')).map(el => (el.textContent || '').trim()).filter(Boolean);
        return {
          parentChannelId: m[1],
          liffId: m[2],
          href,
          rowName: cells[0] || ''
        };
      })
      .filter(Boolean);

    if (rowLinks.length > 0) {
      return { mode: 'DETAIL_LINKS', items: rowLinks };
    }

    const rows = Array.from(document.querySelectorAll('tr, .liff-item, [data-testid], li, .card'));
    const parsed = [];
    const seen = new Set();
    const idRegex = new RegExp(`\\b(${channelId}-[A-Za-z0-9_]{8})\\b`);
    for (const row of rows) {
      const text = (row.innerText || '').trim();
      const idMatch = text.match(idRegex);
      if (!idMatch) continue;
      const liffId = idMatch[1];
      if (seen.has(liffId)) continue;
      seen.add(liffId);

      const urlMatch = text.match(/https:\/\/[^\s"'<>]+\//);
      const endpointUrl = urlMatch ? urlMatch[0].trim() : '';
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const nameLine = lines.find(l => l.startsWith('POSTING MAP ')) || lines[0] || '';

      parsed.push({
        parentChannelId: String(channelId),
        liffId,
        name: nameLine,
        endpointUrl
      });
    }
    return { mode: 'INLINE_ROWS', items: parsed };
  }, ownChannelId);

  if (listItems.mode === 'INLINE_ROWS') {
    return listItems.items;
  }

  const detailed = [];
  for (const link of listItems.items) {
    const detailUrl = new URL(link.href, 'https://developers.line.biz').toString();
    await page.goto(detailUrl, { waitUntil: 'networkidle' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const info = await page.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('.liff-detail .kv-field, .kv-field'));
      const findVal = (labelPart) => {
        for (const f of fields) {
          const title = (f.querySelector('.field-title, label, dt')?.textContent || '').trim();
          if (title.includes(labelPart)) {
            return (f.querySelector('.field-value, dd, input, textarea')?.textContent || f.querySelector('input, textarea')?.value || '').trim();
          }
        }
        return '';
      };
      return {
        name: findVal('LIFFアプリ名') || findVal('App name'),
        endpointUrl: findVal('エンドポイントURL') || findVal('Endpoint URL')
      };
    });
    detailed.push({
      parentChannelId: link.parentChannelId,
      liffId: link.liffId,
      name: info.name || link.rowName,
      endpointUrl: info.endpointUrl
    });
  }
  return detailed;
}

/**
 * 4. Config Synchronization
 * Identity (districtId, domain/CNAME, ownChannelId, acquiredLiffId) がすべて確定した後にのみ実行される。
 * - data/config.js の liffId を更新
 * - deployment.json が存在する場合は resources.productionLiffUrl を更新
 * - npm run check:ssot を実行 (旧 sync:config は廃止)
 * - webAppUrl & provisioningToken が存在する場合は SYSTEM_INFO を同期
 */
export async function syncAcquiredLiffToConfigs({
  districtId,
  domain,
  acquiredLiffId,
  configPath,
  deployment,
  deploymentPath,
  fsModule = fs,
  execRunner = execSync,
  fetcher = fetch,
  env = process.env,
  logger = console.log
} = {}) {
  const productionLiffUrl = `https://liff.line.me/${acquiredLiffId}`;

  // 1. Update data/config.js line.liffId
  if (configPath && fsModule.existsSync(configPath)) {
    const rawConfig = fsModule.readFileSync(configPath, 'utf8');
    const updatedConfig = rawConfig.replace(
      /(liffId\s*:\s*["'])([^"']*)(["'])/,
      `$1${acquiredLiffId}$3`
    );
    if (updatedConfig !== rawConfig) {
      fsModule.writeFileSync(configPath, updatedConfig, 'utf8');
      logger(`✅ Synchronized data/config.js with dedicated LIFF ID (${acquiredLiffId}).`);
    } else {
      logger(`✅ data/config.js liffId already aligned (${acquiredLiffId}).`);
    }
  }

  // 2. Update deployment.json (if present in repository root)
  if (deployment && deploymentPath) {
    if (!deployment.resources || typeof deployment.resources !== 'object') {
      deployment.resources = {};
    }
    deployment.resources.productionLiffUrl = productionLiffUrl;
    fsModule.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + '\n', 'utf8');
    logger('✅ Synchronized deployment.json with dedicated LIFF URL.');
  }

  // 3. Execute Frontend SSOT Validator (check:ssot only; obsolete sync:config removed)
  logger('\n🚀 Validating client configuration SSOT (npm run check:ssot)...');
  execRunner('npm run check:ssot', { stdio: 'inherit' });

  // 4. Synchronize to human-readable inspection sheet (SYSTEM_INFO) in live Spreadsheet if configured
  const webAppUrl = deployment?.resources?.webAppUrl;
  if (webAppUrl) {
    logger('\n🚀 Synchronizing live spreadsheet SYSTEM_INFO (human inspection view)...');
    try {
      const provisioningToken = (
        env.POSTING_MAP_PROVISIONING_TOKEN ||
        env.PROVISIONING_TOKEN ||
        ''
      ).trim();

      if (!provisioningToken) {
        console.warn('⚠️ Warning: POSTING_MAP_PROVISIONING_TOKEN is not configured in environment. Skipping live SYSTEM_INFO sync.');
      } else {
        const syncPayload = {
          action: 'syncSystemInfo',
          provisioningToken,
          options: {
            baseUrl: `https://${domain}`,
            productionLiffUrl,
            liffUrl: productionLiffUrl,
            liffId: acquiredLiffId
          }
        };

        const syncRes = await fetcher(webAppUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(syncPayload),
          redirect: 'follow'
        });
        const syncJson = await syncRes.json();
        logger(`✅ SYSTEM_INFO Sync Result: ${JSON.stringify(syncJson, null, 2)}`);
      }
    } catch (e) {
      console.warn(`⚠️ Warning: SYSTEM_INFO sync encountered network issue: ${e.message}`);
    }
  }

  return {
    districtId,
    domain,
    acquiredLiffId,
    productionLiffUrl
  };
}

/**
 * LIFF Acquire / Reacquire メインパイプライン
 * Fail-Closed Ordering:
 * 1. district identity & domain/CNAME convergence
 * 2. own Login Channel positive discovery
 * 3. own LIFF positive identity closure
 * 4. config synchronization
 */
export async function executeLiffAcquisition(options = {}, deps = {}) {
  const targetRootDir = options.rootDir || rootDir;
  const fsModule = deps.fs || fs;
  const execRunner = deps.execSync || execSync;
  const fetcher = deps.fetcher || fetch;
  const logger = deps.logger || console.log;
  const env = deps.env || process.env;

  loadEnvFallback(targetRootDir);
  const parsedArgs = parseAcquireArgs(options.argv || [], env);
  const opts = { ...parsedArgs, ...options };

  logger('====================================================');
  logger('🚀 AUTONOMOUS LIFF ACQUISITION & VERIFICATION PIPELINE');
  logger('====================================================\n');

  // Step 1: Resolve District Identity & Verify CNAME Convergence (before any external connection or write)
  const districtCtx = resolveDistrictConfig({ targetRootDir, fsModule });
  const { districtId, domain, endpointUrl, appName, configPath, deployment, deploymentPath } = districtCtx;

  logger('📋 [District Context]');
  logger(`   District ID:  ${districtId}`);
  logger(`   Domain:       ${domain}`);
  logger(`   Endpoint URL: ${endpointUrl}`);
  logger(`   Target Name:  ${appName}\n`);

  let browser = null;
  let page = deps.page || null;

  try {
    let providerChannels = deps.providerChannels;
    if (!Array.isArray(providerChannels)) {
      if (!page) {
        logger(`🔌 Connecting to existing Google Chrome via CDP (${opts.cdpUrl})...`);
        const chromiumModule = deps.chromium || chromium;
        browser = await chromiumModule.connectOverCDP(opts.cdpUrl);
        const contexts = browser.contexts();
        if (contexts.length === 0) {
          throw new Error('❌ No browser contexts found in connected Chrome.');
        }
        const pages = contexts[0].pages();
        page = pages.find(p => p.url().includes('developers.line.biz')) || pages[0] || (await contexts[0].newPage());
      }
      providerChannels = await extractProviderChannelsFromDom(page, opts.providerId);
    }

    // Step 2: Positive Own LINE Login Channel Discovery
    const ownChannel = resolveOwnLoginChannel(providerChannels, {
      districtId,
      expectedChannelName: appName,
      explicitChannelId: opts.explicitChannelId
    });
    logger(`✅ [Own LINE Login Channel Resolved]: ${ownChannel.channelName} (Channel ID: ${ownChannel.channelId})`);

    // Step 3: Positive Own LIFF Identity Closure
    let liffCandidates = deps.liffCandidates;
    if (!Array.isArray(liffCandidates)) {
      liffCandidates = await extractChannelLiffsFromDom(page, ownChannel.channelId);
    }

    const ownLiff = resolveOwnLiffCandidate(liffCandidates, {
      ownChannelId: ownChannel.channelId,
      expectedAppName: appName,
      expectedEndpointUrl: endpointUrl
    });
    logger(`✨ [Own Dedicated LIFF Verified]: ${ownLiff.liffId} (Endpoint: ${ownLiff.endpointUrl})`);

    const productionLiffUrl = `https://liff.line.me/${ownLiff.liffId}`;
    logger('\n====================================================');
    logger('✅ [DEDICATED LIFF ID CONFIRMED]');
    logger(`   District:   ${districtId}`);
    logger(`   Channel ID: ${ownChannel.channelId}`);
    logger(`   LIFF ID:    ${ownLiff.liffId}`);
    logger(`   LIFF URL:   ${productionLiffUrl}`);
    logger('====================================================\n');

    // Step 4: Config Synchronization (only after all 4 identities are positively verified)
    const syncResult = await syncAcquiredLiffToConfigs({
      districtId,
      domain,
      acquiredLiffId: ownLiff.liffId,
      configPath,
      deployment,
      deploymentPath,
      fsModule,
      execRunner,
      fetcher,
      env,
      logger
    });

    logger('\n🎉 [COMPLETE] Autonomous LIFF acquisition executed successfully.');
    return {
      status: 'PASS',
      districtId,
      domain,
      endpointUrl,
      channelId: ownChannel.channelId,
      channelName: ownChannel.channelName,
      liffId: ownLiff.liffId,
      productionLiffUrl: syncResult.productionLiffUrl
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('acquire-liff-id.mjs')) {
  executeLiffAcquisition({ argv: process.argv.slice(2) }).catch(err => {
    console.error('\n🛑 [Autonomous LIFF Pipeline Error]:', err.message);
    process.exit(1);
  });
}
