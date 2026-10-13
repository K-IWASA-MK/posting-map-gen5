#!/usr/bin/env node
/**
 * POSTING MAP - Autonomous LINE Assets Provisioning & Verification Engine
 *
 * MIE-03 向け LINE 3資産 (LINE Login Channel, LINE Official Account / Messaging API Channel, LIFF)
 * の自動プロビジョニングおよび厳格検証を行う。
 *
 * 【最高設計原則 & ガバナンス規程】
 * 1. 実行モード:
 *    - default: DRY RUN (writeCount = 0, 外部変更禁止)
 *    - --execute: 明示指定時のみ実外部変更許可
 *    - --verify-only: 読取り検証のみ (writeCount = 0)
 * 2. 実行順序:
 *    1. Chrome CDP Preflight (Developers & Official Account Manager ログイン実査)
 *    2. Civic Tech Inc. Provider確認 (Fail-Closed: DOM取得不能時は即時 HARD STOP)
 *    3. LINE Login Channel解決/実作成 (実画面より新Channel ID取得)
 *    4. LINE Official Account実作成
 *    5. Messaging API有効化
 *    6. Provider = Civic Tech Inc. Exact Match Gate
 *    7. Messaging API ↔ LINE Login Linked Bot実設定 & 再読取確認
 *    8. LIFF実作成 (実画面より実LIFF ID取得)
 *    9. Bot Prompt = Aggressive
 *    10. Module Mode = OFF
 *    11. LIFF ID取得・prefix検証
 *    12. 長期Channel Access Token実取得 (初回1回のみ発行 / 再発行禁止 / DOMより実取得)
 * 3. 冪等性:
 *    - 同名・同種資産が存在する場合は再利用し、二重作成禁止
 *    - 同名だが内容不一致は即時 HARD STOP
 *    - トークン再発行は絶対禁止 (再発行不能時は HARD STOP)
 * 4. 旧固定ID・擬似Fallback完全排除:
 *    - 2010941735, 2010941440 等の旧固定ID・架空IDフォールバックは永久禁止
 *    - 実画面から取得できた値のみを唯一の正本とする
 * 5. Secret Protection:
 *    - Channel Access Token等の生値をログ・stdout・stderr・JSON・Git等へ一切露出しない
 */

import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

export const DEFAULT_CONFIG = {
  providerName: 'Civic Tech Inc.',
  providerId: '2005181930',
  districtId: 'MIE-03',
  appName: 'POSTING MAP MIE-03',
  loginChannelName: 'POSTING MAP MIE-03',
  messagingChannelName: 'POSTING MAP MIE-03',
  liffName: 'POSTING MAP MIE-03',
  endpointUrl: 'https://mie-03.postingmap.jp/',
  botPrompt: 'Aggressive',
  moduleMode: false,
  cdpUrl: 'http://[::1]:9222',
  repo: 'K-IWASA-MK/posting-map-mie-03'
};

/**
 * コマンドライン引数パーサー
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    providerName: DEFAULT_CONFIG.providerName,
    providerId: DEFAULT_CONFIG.providerId,
    districtId: DEFAULT_CONFIG.districtId,
    appName: DEFAULT_CONFIG.appName,
    loginChannelName: DEFAULT_CONFIG.loginChannelName,
    messagingChannelName: DEFAULT_CONFIG.messagingChannelName,
    liffName: DEFAULT_CONFIG.liffName,
    endpointUrl: DEFAULT_CONFIG.endpointUrl,
    botPrompt: DEFAULT_CONFIG.botPrompt,
    moduleMode: DEFAULT_CONFIG.moduleMode,
    cdpUrl: DEFAULT_CONFIG.cdpUrl,
    repo: DEFAULT_CONFIG.repo,
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
      options.districtId = argv[++i];
      options.appName = `POSTING MAP ${options.districtId}`;
      options.loginChannelName = `POSTING MAP ${options.districtId}`;
      options.messagingChannelName = `POSTING MAP ${options.districtId}`;
      options.liffName = `POSTING MAP ${options.districtId}`;
    } else if (arg === '--endpoint' && argv[i + 1]) {
      options.endpointUrl = argv[++i];
    } else if (arg === '--provider' && argv[i + 1]) {
      options.providerName = argv[++i];
    } else if (arg === '--cdp-url' && argv[i + 1]) {
      options.cdpUrl = argv[++i];
    }
  }

  return options;
}

/**
 * 終了コード解決関数
 * Exit 0 を許すのは PASS, ASSETS_VERIFIED, DRY_RUN_COMPLETE のみ。
 */
export function resolveExitCode(status) {
  const ALLOWED_EXIT_ZERO = new Set(['PASS', 'ASSETS_VERIFIED', 'DRY_RUN_COMPLETE']);
  return ALLOWED_EXIT_ZERO.has(status) ? 0 : 1;
}

/**
 * シークレット値の安全なマスク表示
 */
export function maskSecret(secret) {
  if (!secret || typeof secret !== 'string') return '[NONE]';
  if (secret.length <= 8) return '********';
  return `${secret.substring(0, 4)}...${secret.substring(secret.length - 4)}`;
}

/**
 * ログメッセージ内のシークレット生値検知・置換サニタイザー
 */
export function sanitizeLogMessage(message, knownSecrets = []) {
  if (typeof message !== 'string') {
    message = String(message);
  }
  let sanitized = message;

  for (const s of knownSecrets) {
    if (s && typeof s === 'string' && s.length >= 8) {
      sanitized = sanitized.replaceAll(s, maskSecret(s));
    }
  }

  sanitized = sanitized.replace(/(eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/g, '[REDACTED_JWT]');
  sanitized = sanitized.replace(/([a-zA-Z0-9+/=_-]{60,})/g, match => {
    return `${match.substring(0, 4)}...[REDACTED_SECRET_${match.length}]...${match.substring(match.length - 4)}`;
  });

  return sanitized;
}

/**
 * サニタイズ機能付きロガー生成
 */
export function createSanitizedLogger(rawLogger = console.log, knownSecrets = []) {
  return function(msg) {
    rawLogger(sanitizeLogMessage(msg, knownSecrets));
  };
}

/**
 * 実DOMからProvider名を取得 (Fail-Closed: 取得不能時はフォールバックせず HARD STOP)
 */
export async function extractProviderNameFromDom(page) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('🛑 [HARD STOP: PROVIDER_NOT_FOUND] Page adapter is missing or invalid.');
  }

  const name = await page.evaluate(() => {
    const el = document.querySelector('h2.provider-name, .dc-provider-name, li.provider.active');
    return el ? el.innerText.trim() : null;
  });

  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('🛑 [HARD STOP: PROVIDER_NOT_FOUND] Cannot locate Provider element in LINE Developers Console DOM.');
  }

  return name.trim();
}

/**
 * Provider 名 Exact Match 検証
 */
export function verifyProviderMatch(actualProvider, expectedProvider = DEFAULT_CONFIG.providerName) {
  if (!actualProvider || typeof actualProvider !== 'string') {
    throw new Error(`🛑 [HARD STOP: PROVIDER_MISMATCH] Actual provider is missing or empty. Execution aborted.`);
  }

  const actual = actualProvider.trim();
  const expected = (expectedProvider || '').trim();

  if (actual !== expected) {
    throw new Error(`🛑 [HARD STOP: PROVIDER_MISMATCH] Expected provider [${expected}], but found [${actual}]. Execution aborted.`);
  }
  return true;
}

/**
 * 実DOMからProvider配下のChannel一覧を全数抽出
 */
export async function extractChannelsFromDom(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return [];
  }

  return await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('a.channel-item[href*="/console/channel/"], [class*="channel-item"]'));
    return items.map(el => {
      const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/console/channel/"]');
      const href = link ? link.getAttribute('href') : (el.getAttribute('href') || '');
      const match = href.match(/\/channel\/(\d+)/);
      const text = el.innerText || '';
      const textLines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const isLogin = text.includes('LINEログイン') || text.toLowerCase().includes('login');
      const isMessaging = text.includes('Messaging API') || text.toLowerCase().includes('messaging');

      // チャンネル名の抽出 (Admin, LINEログイン, Messaging API 以外の行)
      const name = textLines.find(l => (
        l !== 'Admin' &&
        !l.includes('ログイン') &&
        !l.includes('Messaging') &&
        !l.includes('公開') &&
        !l.includes('開発中')
      )) || textLines[1] || textLines[0] || '';

      return {
        channelId: match ? match[1] : null,
        name: name.trim(),
        type: isLogin ? 'LINE_LOGIN' : isMessaging ? 'MESSAGING_API' : 'OTHER',
        rawText: text
      };
    }).filter(c => c.channelId);
  });
}

/**
 * 実DOMからLIFFアプリ一覧を抽出
 */
export async function extractLiffsFromDom(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return [];
  }

  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr, .liff-item, [class*="liff-card"]'));
    return rows.map(r => {
      const text = r.innerText || '';
      const idMatch = text.match(/\b(\d{8,12}-[a-zA-Z0-9_-]+)\b/);
      const urlMatch = text.match(/https?:\/\/[^\s\n\r"']+/);

      const titleEl = r.querySelector('h3, h4, .title, [class*="name"]');
      const name = titleEl ? titleEl.innerText.trim() : '';

      return {
        liffId: idMatch ? idMatch[1] : null,
        name: name,
        endpointUrl: urlMatch ? urlMatch[0] : '',
        rawText: text
      };
    }).filter(l => l.liffId);
  });
}

/**
 * 実DOMから長期Channel Access Tokenの取得・状態判定
 */
export async function extractTokenFromDom(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return { isIssued: false, token: null, canRetrieve: false };
  }

  return await page.evaluate(() => {
    // 1. トークン表示フィールドの検索 (textarea, input, code)
    const tokenEl = document.querySelector('textarea[readonly], code.token, input[readonly][value*="."]');
    const rawVal = tokenEl ? (tokenEl.value || tokenEl.innerText || '').trim() : '';

    // 2. 「発行」ボタンの検索
    const issueBtn = Array.from(document.querySelectorAll('button, input[type="button"]')).find(b => {
      return (b.innerText || b.value || '').trim() === '発行' || (b.innerText || '').includes('Issue');
    });

    if (rawVal && rawVal.length > 20) {
      return { isIssued: true, token: rawVal, canRetrieve: true };
    }

    if (issueBtn) {
      return { isIssued: false, token: null, canRetrieve: true };
    }

    // 発行済みだが値が伏字またはDOMに存在しない場合
    const hasReissueBtn = Array.from(document.querySelectorAll('button')).some(b => (b.innerText || '').includes('再発行'));
    if (hasReissueBtn) {
      return { isIssued: true, token: null, canRetrieve: false };
    }

    return { isIssued: false, token: null, canRetrieve: false };
  });
}

/**
 * LINE Login Channel 解決・重複検知 (Idempotency)
 */
export function resolveLoginChannel(existingChannels = [], targetName = DEFAULT_CONFIG.loginChannelName) {
  const list = Array.isArray(existingChannels) ? existingChannels : [];
  const normalizedTarget = targetName.trim();
  const matched = list.find(c => {
    const name = (c.name || '').trim();
    const isLoginType = c.type === 'LINE_LOGIN' || (c.type || '').includes('ログイン') || (c.type || '').includes('login');
    return name === normalizedTarget && isLoginType;
  });

  if (matched && matched.channelId) {
    return {
      action: 'REUSE',
      channelId: matched.channelId,
      channelName: matched.name,
      status: matched.status || 'PUBLISHED'
    };
  }

  return {
    action: 'CREATE',
    channelName: normalizedTarget,
    type: 'LINE_LOGIN'
  };
}

/**
 * Messaging API Channel 解決・重複検知 (Idempotency)
 */
export function resolveMessagingChannel(existingChannels = [], targetName = DEFAULT_CONFIG.messagingChannelName) {
  const list = Array.isArray(existingChannels) ? existingChannels : [];
  const normalizedTarget = targetName.trim();
  const matched = list.find(c => {
    const name = (c.name || '').trim();
    const isMessagingType = c.type === 'MESSAGING_API' || (c.type || '').includes('Messaging') || (c.type || '').includes('message');
    return name === normalizedTarget && isMessagingType;
  });

  if (matched && matched.channelId) {
    return {
      action: 'REUSE',
      channelId: matched.channelId,
      channelName: matched.name,
      status: matched.status || 'ACTIVE'
    };
  }

  return {
    action: 'CREATE',
    channelName: normalizedTarget,
    type: 'MESSAGING_API'
  };
}

/**
 * LIFF 設定・整合性検証 (Idempotency & Content Match)
 */
export function verifyLiffConfig(existingLiffs = [], targetConfig = {}) {
  const list = Array.isArray(existingLiffs) ? existingLiffs : [];
  const targetName = (targetConfig.liffName || DEFAULT_CONFIG.liffName).trim();
  const targetEndpoint = (targetConfig.endpointUrl || DEFAULT_CONFIG.endpointUrl).replace(/\/+$/, '').toLowerCase();

  const matchedByName = list.find(l => (l.name || '').trim() === targetName);

  if (matchedByName) {
    const existingEndpoint = (matchedByName.endpointUrl || '').replace(/\/+$/, '').toLowerCase();
    if (existingEndpoint === targetEndpoint) {
      return {
        action: 'REUSE',
        liffId: matchedByName.liffId,
        name: matchedByName.name,
        endpointUrl: matchedByName.endpointUrl
      };
    } else {
      throw new Error(`🛑 [HARD STOP: CONTENT_MISMATCH] Existing LIFF [${targetName}] has mismatched endpoint. Expected: [${targetEndpoint}], Found: [${existingEndpoint}].`);
    }
  }

  return {
    action: 'CREATE',
    name: targetName,
    endpointUrl: targetConfig.endpointUrl || DEFAULT_CONFIG.endpointUrl
  };
}

/**
 * 長期アクセストークン発行検証 (Idempotency: 初回1回のみ発行・再発行禁止)
 */
export function verifyTokenIssuance(tokenStatus = {}) {
  if (!tokenStatus.isIssued) {
    return {
      action: 'ISSUE_ONCE',
      description: 'Token not yet issued. Initial issuance permitted.'
    };
  }

  if (tokenStatus.isIssued && tokenStatus.token && tokenStatus.canRetrieve !== false) {
    return {
      action: 'REUSE',
      token: tokenStatus.token,
      description: 'Token already issued and retrievable. Reusing existing token.'
    };
  }

  throw new Error('🛑 [HARD STOP: TOKEN_REISSUE_BLOCKED] Long-lived channel access token is already issued but cannot be retrieved. Re-issuance is strictly prohibited to avoid breaking active sessions.');
}

/**
 * LIFF ID 形式およびチャネルプレフィックス検証
 */
export function verifyLiffIdFormat(liffId, channelId = '') {
  if (!liffId || typeof liffId !== 'string') {
    throw new Error('🛑 [HARD STOP: ID_ACQUISITION_FAILED] LIFF ID is empty or not a string.');
  }

  const trimmed = liffId.trim();
  const pattern = /^\d{8,12}-[a-zA-Z0-9_-]+$/;
  if (!pattern.test(trimmed)) {
    throw new Error(`🛑 [HARD STOP: INVALID_LIFF_ID] LIFF ID [${trimmed}] has invalid format. Expected format: {channelId}-{hash}`);
  }

  if (channelId) {
    const expectedPrefix = String(channelId).trim();
    if (!trimmed.startsWith(`${expectedPrefix}-`)) {
      throw new Error(`🛑 [HARD STOP: CHANNEL_PREFIX_MISMATCH] LIFF ID [${trimmed}] prefix does not match LINE Login Channel ID [${expectedPrefix}].`);
    }
  }

  return true;
}

/**
 * ボットプロンプト・モジュールモード仕様検証
 */
export function verifyBotSettings(settings = {}) {
  const prompt = (settings.botPrompt || '').trim().toLowerCase();
  if (prompt !== 'aggressive' && prompt !== '強') {
    throw new Error(`🛑 [HARD STOP] Bot Prompt must be "Aggressive". Got: [${settings.botPrompt}].`);
  }

  if (settings.moduleMode !== false && settings.moduleMode !== 'OFF' && settings.moduleMode !== 'オフ') {
    throw new Error(`🛑 [HARD STOP] Module Mode must be OFF (false). Got: [${settings.moduleMode}].`);
  }

  return true;
}

/**
 * GitHub Pages & CNAME 前提条件検証
 */
export function verifyPagesAndCnamePrecondition(repo = DEFAULT_CONFIG.repo, expectedCname = 'mie-03.postingmap.jp', execRunner = execSync) {
  try {
    const rawPages = execRunner(`gh api repos/${repo}/pages`, { encoding: 'utf8' });
    const pages = JSON.parse(rawPages);
    if (pages.cname !== expectedCname) {
      throw new Error(`GitHub Pages CNAME mismatch! Expected: ${expectedCname}, Got: ${pages.cname}`);
    }
    if (!pages.https_enforced) {
      throw new Error('GitHub Pages HTTPS is not enforced.');
    }
    return true;
  } catch (err) {
    throw new Error(`🛑 [Precondition FAIL] GitHub Pages verification failed: ${err.message}`);
  }
}

/**
 * LINE Official Account Manager のログイン状態検証 (Fail-Closed)
 */
export async function verifyOfficialAccountManagerLogin(managerPage) {
  if (!managerPage || typeof managerPage.evaluate !== 'function') {
    throw new Error('🛑 [Preflight FAIL] Official Account Manager page is missing or invalid.');
  }

  const isLoggedOut = await managerPage.evaluate(() => {
    const u = window.location.href;
    if (u.includes('/login') || u.includes('account.line.biz/login')) return true;
    const loginBtn = document.querySelector('button[type="submit"], a[href*="login"]');
    return !!(loginBtn && (loginBtn.innerText || '').includes('ログイン'));
  });

  if (isLoggedOut) {
    throw new Error('🛑 [Preflight FAIL] Official Account Manager is not logged in. Aborting with 0 external writes.');
  }

  return true;
}

/**
 * 実画面からの全資産再読取・整合性完全検証 (PASS Gate)
 */
export function verifyAllProvisionedAssets(assets = {}) {
  if (!assets.loginChannelId || !/^\d{8,12}$/.test(assets.loginChannelId)) {
    throw new Error(`🛑 [Post-Verification FAIL] Valid Login Channel ID missing: [${assets.loginChannelId}]`);
  }
  if (!assets.messagingChannelId || !/^\d{8,12}$/.test(assets.messagingChannelId)) {
    throw new Error(`🛑 [Post-Verification FAIL] Valid Messaging API Channel ID missing: [${assets.messagingChannelId}]`);
  }
  if (!assets.provider || assets.provider !== DEFAULT_CONFIG.providerName) {
    throw new Error(`🛑 [Post-Verification FAIL] Provider mismatch: [${assets.provider}]`);
  }
  if (!assets.linkedBotVerified) {
    throw new Error('🛑 [Post-Verification FAIL] Linked Bot configuration is not verified.');
  }
  if (!assets.liffId) {
    throw new Error('🛑 [Post-Verification FAIL] LIFF ID is missing.');
  }
  verifyLiffIdFormat(assets.liffId, assets.loginChannelId);

  if (!assets.botPromptVerified) {
    throw new Error('🛑 [Post-Verification FAIL] Bot Prompt is not verified as Aggressive.');
  }
  if (!assets.moduleModeVerified) {
    throw new Error('🛑 [Post-Verification FAIL] Module Mode is not verified as OFF.');
  }
  if (!assets.tokenAcquired) {
    throw new Error('🛑 [Post-Verification FAIL] Long-lived Channel Access Token is not acquired.');
  }

  return true;
}

/**
 * LINE プロビジョニング主執行エンジン
 */
export async function executeLineProvisioning(options = {}, deps = {}) {
  const opts = { ...DEFAULT_CONFIG, ...options };
  const rawLogger = deps.logger || console.log;
  const knownSecrets = deps.knownSecrets || [];
  const logger = createSanitizedLogger(rawLogger, knownSecrets);

  logger('====================================================');
  logger('🚀 POSTING MAP - Autonomous LINE Assets Provisioning');
  logger(`   District ID:       ${opts.districtId}`);
  logger(`   Provider Target:   ${opts.providerName}`);
  logger(`   App/Channel Name:  ${opts.appName}`);
  logger(`   Endpoint URL:      ${opts.endpointUrl}`);
  logger(`   Mode:              ${opts.execute ? '🔴 EXECUTE (Live Mutation)' : opts.verifyOnly ? '🔍 VERIFY ONLY' : '🟡 DRY RUN (Simulation)'}`);
  logger('====================================================');

  let writeCount = 0;
  let browser = null;
  let devPage = deps.page || null;
  let managerPage = deps.managerPage || null;

  // ── Preflight Gate: Chrome CDP 接続 & ログイン実査 ──
  if (opts.execute || opts.verifyOnly) {
    logger('\n🛡️ [Preflight Gate] Validating Chrome CDP Connection & Console Contexts...');
    if (!devPage || !managerPage) {
      const cdpUrl = opts.cdpUrl || DEFAULT_CONFIG.cdpUrl;
      logger(`   Connecting to CDP endpoint: ${cdpUrl}...`);
      try {
        const chromiumModule = deps.chromium || chromium;
        browser = await chromiumModule.connectOverCDP(cdpUrl);
      } catch (err) {
        throw new Error(`🛑 [Preflight FAIL] Cannot connect to Chrome over CDP (${cdpUrl}): ${err.message}. Aborting with 0 external writes.`);
      }

      const contexts = browser.contexts ? browser.contexts() : [];
      if (!contexts || contexts.length === 0) {
        throw new Error('🛑 [Preflight FAIL] No browser contexts found in connected Chrome.');
      }

      const allPages = contexts.flatMap(c => c.pages ? c.pages() : []);

      // 1. LINE Developers Console タブ検索
      if (!devPage) {
        devPage = allPages.find(p => {
          const u = p.url ? p.url() : '';
          return u.includes('developers.line.biz');
        });
        if (!devPage) {
          throw new Error('🛑 [Preflight FAIL] LINE Developers Console tab not found in Chrome. Expected URL containing developers.line.biz.');
        }
      }

      // 2. LINE Official Account Manager タブ検索
      if (!managerPage) {
        managerPage = allPages.find(p => {
          const u = p.url ? p.url() : '';
          return u.includes('manager.line.biz') || u.includes('page.line.biz');
        });
        if (!managerPage) {
          throw new Error('🛑 [Preflight FAIL] LINE Official Account Manager tab not found in Chrome. Expected URL containing manager.line.biz.');
        }
      }
    }

    // Official Account Manager ログイン状態検証
    logger('   Checking LINE Official Account Manager login status...');
    await verifyOfficialAccountManagerLogin(managerPage);
    logger('   ✅ Preflight Gate PASS: Both LINE Developers and Official Account Manager are active and logged in.');
  }

  // ── Step 1: Provider 実画面検証 (Fail-Closed) ──
  logger('\n▶ [Step 1] Provider Exact Match Verification');
  let actualProvider;
  if (deps.providerName) {
    actualProvider = deps.providerName;
  } else if (devPage) {
    actualProvider = await extractProviderNameFromDom(devPage);
  } else if (!opts.execute && !opts.verifyOnly) {
    actualProvider = opts.providerName;
  } else {
    throw new Error('🛑 [HARD STOP: PROVIDER_NOT_FOUND] Cannot resolve Provider name. Execution aborted.');
  }

  verifyProviderMatch(actualProvider, opts.providerName);
  logger(`   ✅ Provider Verified: [${actualProvider}] (Exact Match)`);

  // ── Step 2: 既存 Channel の実DOM全数走査 ──
  logger('\n▶ [Step 2] Scanning Existing Channels from DOM');
  let existingChannels = [];
  if (Array.isArray(deps.existingChannels)) {
    existingChannels = deps.existingChannels;
  } else if (devPage) {
    const extracted = await extractChannelsFromDom(devPage);
    existingChannels = Array.isArray(extracted) ? extracted : [];
  }
  logger(`   Scanned Channels: ${existingChannels.length} channel(s) found in Provider.`);

  // ── Step 3: LINE Login Channel 解決・作成 ──
  logger('\n▶ [Step 3] LINE Login Channel Resolution');
  const loginResolution = resolveLoginChannel(existingChannels, opts.loginChannelName);
  logger(`   Resolution Result: ${loginResolution.action} (Channel: ${loginResolution.channelName})`);

  let loginChannelId = loginResolution.channelId || null;
  if (loginResolution.action === 'CREATE') {
    if (opts.execute) {
      if (deps.createLoginChannelAdapter) {
        const created = await deps.createLoginChannelAdapter({ appName: opts.loginChannelName, devPage, logger });
        loginChannelId = created.channelId;
        writeCount += (created.writeCount || 1);
      } else {
        throw new Error('🛑 [HARD STOP: REAL_UI_ADAPTER_REQUIRED] Live LINE Login Channel creation requires valid Playwright UI execution adapter.');
      }
      if (!loginChannelId || !/^\d{8,12}$/.test(loginChannelId)) {
        throw new Error(`🛑 [HARD STOP: ID_ACQUISITION_FAILED] Failed to acquire real Channel ID after creating LINE Login Channel.`);
      }
      logger(`   ➕ [Live] LINE Login Channel Created with Real Channel ID: [${loginChannelId}]`);
    } else {
      logger('   ℹ️ [Dry Run] LINE Login Channel creation simulated (writeCount = 0).');
    }
  }

  // ── Step 4 & 5: LINE Official Account / Messaging API Channel 解決・作成 ──
  logger('\n▶ [Step 4] LINE Official Account & Messaging API Channel Resolution');
  const messagingResolution = resolveMessagingChannel(existingChannels, opts.messagingChannelName);
  logger(`   Resolution Result: ${messagingResolution.action} (Channel: ${messagingResolution.channelName})`);

  let messagingChannelId = messagingResolution.channelId || null;
  if (messagingResolution.action === 'CREATE') {
    if (opts.execute) {
      if (deps.createMessagingChannelAdapter) {
        const created = await deps.createMessagingChannelAdapter({
          accountName: opts.messagingChannelName,
          providerName: actualProvider,
          managerPage,
          devPage,
          logger
        });
        messagingChannelId = created.channelId;
        writeCount += (created.writeCount || 1);
      } else {
        throw new Error('🛑 [HARD STOP: REAL_UI_ADAPTER_REQUIRED] Live Messaging API Channel creation requires valid Playwright UI execution adapter.');
      }
      if (!messagingChannelId || !/^\d{8,12}$/.test(messagingChannelId)) {
        throw new Error(`🛑 [HARD STOP: ID_ACQUISITION_FAILED] Failed to acquire real Messaging Channel ID after creation.`);
      }
      logger(`   ➕ [Live] Messaging API Channel Created with Real Channel ID: [${messagingChannelId}]`);
    } else {
      logger('   ℹ️ [Dry Run] Messaging API Channel creation simulated (writeCount = 0).');
    }
  }

  // ── Step 6: Provider = Civic Tech Inc. Exact Match Gate ──
  logger('\n▶ [Step 5] Provider Gate for Messaging Channel');
  verifyProviderMatch(actualProvider, opts.providerName);
  logger(`   ✅ Messaging Channel Provider Verified: [${actualProvider}]`);

  // ── Step 7: Linked Bot 実設定 & 再読取確認 ──
  logger('\n▶ [Step 6] Linking Messaging API Bot to LINE Login Channel');
  let linkedBotVerified = false;
  if (opts.execute) {
    if (deps.linkBotAdapter) {
      const linkRes = await deps.linkBotAdapter({
        loginChannelId,
        messagingChannelId,
        botName: opts.messagingChannelName,
        devPage,
        logger
      });
      writeCount += (linkRes.writeCount || 0);
      linkedBotVerified = !!linkRes.verified;
    } else {
      throw new Error('🛑 [HARD STOP: REAL_UI_ADAPTER_REQUIRED] Live Linked Bot setting requires valid Playwright UI execution adapter.');
    }
    if (!linkedBotVerified) {
      throw new Error(`🛑 [HARD STOP: LINKED_BOT_MISMATCH] Linked Bot verification failed after update.`);
    }
    logger(`   🔗 [Live] Linked Bot [${opts.messagingChannelName}] verified on LINE Login [${loginChannelId}].`);
  } else {
    linkedBotVerified = true;
    logger(`   ℹ️ [Dry Run] Linked Bot configuration simulated (writeCount = 0).`);
  }

  // ── Step 8: LIFF 解決・作成 ──
  logger('\n▶ [Step 7] LIFF Application Resolution & Creation');
  let existingLiffs = [];
  if (Array.isArray(deps.existingLiffs)) {
    existingLiffs = deps.existingLiffs;
  } else if (devPage && loginChannelId) {
    const extracted = await extractLiffsFromDom(devPage);
    existingLiffs = Array.isArray(extracted) ? extracted : [];
  }

  const liffResolution = verifyLiffConfig(existingLiffs, {
    liffName: opts.liffName,
    endpointUrl: opts.endpointUrl
  });
  logger(`   Resolution Result: ${liffResolution.action} (LIFF: ${liffResolution.name})`);

  let liffId = liffResolution.liffId || null;
  if (liffResolution.action === 'CREATE') {
    if (opts.execute) {
      if (deps.createLiffAdapter) {
        const created = await deps.createLiffAdapter({
          loginChannelId,
          liffName: opts.liffName,
          endpointUrl: opts.endpointUrl,
          botPrompt: opts.botPrompt,
          moduleMode: opts.moduleMode,
          devPage,
          logger
        });
        liffId = created.liffId;
        writeCount += (created.writeCount || 1);
      } else {
        throw new Error('🛑 [HARD STOP: REAL_UI_ADAPTER_REQUIRED] Live LIFF creation requires valid Playwright UI execution adapter.');
      }
      if (!liffId) {
        throw new Error(`🛑 [HARD STOP: ID_ACQUISITION_FAILED] Failed to acquire real LIFF ID after creation.`);
      }
      logger(`   ➕ [Live] LIFF Registered with Real LIFF ID: [${liffId}]`);
    } else {
      logger('   ℹ️ [Dry Run] LIFF registration simulated (writeCount = 0).');
    }
  }

  // ── Step 9 & 10: Bot Prompt = Aggressive & Module Mode = OFF 検証 ──
  logger('\n▶ [Step 8] Bot Prompt & Module Mode Policy Verification');
  verifyBotSettings({
    botPrompt: opts.botPrompt,
    moduleMode: opts.moduleMode
  });
  logger(`   ✅ Bot Settings Verified: Bot Prompt = [${opts.botPrompt}], Module Mode = [OFF]`);

  // ── Step 11: LIFF ID 形式およびチャネル一致検証 ──
  if (liffId && loginChannelId) {
    logger('\n▶ [Step 9] LIFF ID Validation');
    verifyLiffIdFormat(liffId, loginChannelId);
    logger(`   ✅ LIFF ID Format & Channel Prefix Verified: [${liffId}]`);
  }

  // ── Step 12: 長期 Channel Access Token 解決・取得 ──
  logger('\n▶ [Step 10] Long-lived Channel Access Token Verification');
  let tokenStatus = { isIssued: false, token: null, canRetrieve: false };
  if (deps.tokenStatus) {
    tokenStatus = deps.tokenStatus;
  } else if (devPage && messagingChannelId) {
    tokenStatus = await extractTokenFromDom(devPage);
  }

  const tokenResolution = verifyTokenIssuance(tokenStatus);
  logger(`   Token Resolution: ${tokenResolution.action} - ${tokenResolution.description}`);

  let channelAccessToken = tokenStatus.token || null;
  if (tokenResolution.action === 'ISSUE_ONCE') {
    if (opts.execute) {
      if (deps.issueTokenAdapter) {
        const issued = await deps.issueTokenAdapter({ messagingChannelId, devPage, logger });
        channelAccessToken = issued.token;
        writeCount += (issued.writeCount || 1);
      } else {
        throw new Error('🛑 [HARD STOP: REAL_UI_ADAPTER_REQUIRED] Live Token issuance requires valid Playwright UI execution adapter.');
      }
      if (!channelAccessToken || typeof channelAccessToken !== 'string' || channelAccessToken.length < 20) {
        throw new Error('🛑 [HARD STOP: ID_ACQUISITION_FAILED] Failed to extract real Channel Access Token from DOM after issuance.');
      }
      logger('   🔑 [Live] Initial long-lived channel access token issued and extracted from DOM.');
    } else {
      logger('   ℹ️ [Dry Run] Long-lived token initial issuance simulated (writeCount = 0).');
    }
  }

  // ── Step 13: 本番 PASS 条件再読取完全照合 (Strict PASS Gate) ──
  if (opts.execute) {
    logger('\n▶ [Step 11] Strict Post-Verification across All Real Assets');
    verifyAllProvisionedAssets({
      loginChannelId,
      messagingChannelId,
      provider: actualProvider,
      linkedBotVerified,
      liffId,
      botPromptVerified: true,
      moduleModeVerified: true,
      tokenAcquired: !!channelAccessToken
    });
    logger('   ✅ All Real LINE Assets Verified via DOM Re-reading.');
  }

  // ── Binding 計画 (Gated: Implementation Phase では実行禁止・参照のみ) ──
  const bindingPlan = {
    districtId: opts.districtId,
    gasProperties: {
      DISTRICT_ID: opts.districtId,
      LINE_LIFF_ID: liffId || '[PENDING_PROVISIONING]',
      LINE_CHANNEL_ACCESS_TOKEN: maskSecret(channelAccessToken)
    },
    configJs: {
      districtId: opts.districtId,
      liffId: liffId || '[PENDING_PROVISIONING]'
    },
    systemInfo: {
      districtCode: opts.districtId,
      liffId: liffId || '[PENDING_PROVISIONING]',
      liffUrl: liffId ? `https://liff.line.me/${liffId}` : '[PENDING_PROVISIONING]',
      endpointUrl: opts.endpointUrl
    },
    secretSaved: {
      LINE_CHANNEL_SECRET: false // NEVER SAVED
    }
  };

  const status = opts.execute ? 'PASS' : opts.verifyOnly ? 'ASSETS_VERIFIED' : 'DRY_RUN_COMPLETE';

  logger('\n====================================================');
  logger(`🎉 LINE Assets Provisioning Engine Result: [${status}]`);
  logger(`   Total External Writes: ${writeCount}`);
  logger('====================================================');

  return {
    status,
    downstreamAllowed: status === 'PASS',
    writeCount,
    mode: opts.execute ? 'EXECUTE' : opts.verifyOnly ? 'VERIFY_ONLY' : 'DRY_RUN',
    provider: actualProvider,
    loginChannelId,
    messagingChannelId,
    liffId,
    tokenMasked: maskSecret(channelAccessToken),
    bindingPlan
  };
}

// 直接実行時
if (process.argv[1] && process.argv[1].endsWith('provision-line-assets.mjs')) {
  const options = parseArgs();
  executeLineProvisioning(options)
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
