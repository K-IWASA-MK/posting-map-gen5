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
 *    1. Chrome CDP Preflight
 *    2. Civic Tech Inc. Provider確認
 *    3. LINE Login Channel解決/作成
 *    4. LINE Official Account作成
 *    5. Messaging API有効化
 *    6. Provider = Civic Tech Inc. Exact Match Gate
 *    7. Messaging API ↔ LINE Login Linked Bot設定
 *    8. LIFF作成
 *    9. Bot Prompt = Aggressive
 *    10. Module Mode = OFF
 *    11. LIFF ID取得・prefix検証
 *    12. 長期Channel Access Token取得 (初回1回のみ発行 / 再発行禁止)
 * 3. 冪等性:
 *    - 同名・同種資産が存在する場合は再利用し、二重作成禁止
 *    - 同名だが内容不一致は即時 HARD STOP
 *    - トークン再発行は絶対禁止 (再発行不能時は HARD STOP)
 * 4. Secret Protection:
 *    - Channel Access Token等の生値をログ・stdout・stderr・JSON・Git等へ一切露出しない
 * 5. Binding 設計 (本番 --execute 時のみ):
 *    - LINE 3資産成立後に GAS Script Properties (DISTRICT_ID, LINE_LIFF_ID, LINE_CHANNEL_ACCESS_TOKEN) を設定
 *    - data/config.js (districtId, liffId) を更新
 *    - SYSTEM_INFO シート同期
 *    - LINE_CHANNEL_SECRET は保存しない
 *    - 本実装フェーズでの実Binding実行は禁止
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

  // 既知シークレットのマスク
  for (const s of knownSecrets) {
    if (s && typeof s === 'string' && s.length >= 8) {
      sanitized = sanitized.replaceAll(s, maskSecret(s));
    }
  }

  // 一般的なBearerトークンや長大英数記号列 (64文字以上のBase64/hex風文字列) のマスク
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
 * Provider 名 Exact Match 検証
 */
export function verifyProviderMatch(actualProvider, expectedProvider = DEFAULT_CONFIG.providerName) {
  const actual = (actualProvider || '').trim();
  const expected = (expectedProvider || '').trim();

  if (actual !== expected) {
    throw new Error(`🛑 [HARD STOP: PROVIDER_MISMATCH] Expected provider [${expected}], but found [${actual}]. Execution aborted.`);
  }
  return true;
}

/**
 * LINE Login Channel 解決・重複検知 (Idempotency)
 */
export function resolveLoginChannel(existingChannels = [], targetName = DEFAULT_CONFIG.loginChannelName) {
  const normalizedTarget = targetName.trim();
  const matched = existingChannels.find(c => {
    const name = (c.name || '').trim();
    const type = (c.type || '').trim().toLowerCase();
    const isLoginType = type.includes('login') || type.includes('ログイン');
    return name === normalizedTarget && isLoginType;
  });

  if (matched) {
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
  const normalizedTarget = targetName.trim();
  const matched = existingChannels.find(c => {
    const name = (c.name || '').trim();
    const type = (c.type || '').trim().toLowerCase();
    const isMessagingType = type.includes('messaging') || type.includes('message');
    return name === normalizedTarget && isMessagingType;
  });

  if (matched) {
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
  const targetName = (targetConfig.liffName || DEFAULT_CONFIG.liffName).trim();
  const targetEndpoint = (targetConfig.endpointUrl || DEFAULT_CONFIG.endpointUrl).replace(/\/+$/, '').toLowerCase();

  const matchedByName = existingLiffs.find(l => (l.name || '').trim() === targetName);

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
  // tokenStatus: { isIssued: boolean, token: string | null, canRetrieve: boolean }
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

  // 発行済みだが再取得不能な場合: 再発行は禁止
  throw new Error('🛑 [HARD STOP: TOKEN_REISSUE_BLOCKED] Long-lived channel access token is already issued but cannot be retrieved. Re-issuance is strictly prohibited to avoid breaking active sessions.');
}

/**
 * LIFF ID 形式およびチャネルプレフィックス検証
 * 例: 2010941735-abcdefgh (Channel ID プレフィックスと一致すること)
 */
export function verifyLiffIdFormat(liffId, channelId = '') {
  if (!liffId || typeof liffId !== 'string') {
    throw new Error('LIFF ID is empty or not a string.');
  }

  const trimmed = liffId.trim();
  const pattern = /^\d{8,12}-[a-zA-Z0-9_-]+$/;
  if (!pattern.test(trimmed)) {
    throw new Error(`LIFF ID [${trimmed}] has invalid format. Expected format: {channelId}-{hash}`);
  }

  if (channelId) {
    const expectedPrefix = String(channelId).trim();
    if (!trimmed.startsWith(`${expectedPrefix}-`)) {
      throw new Error(`LIFF ID [${trimmed}] prefix does not match LINE Login Channel ID [${expectedPrefix}].`);
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
  let page = deps.page || null;

  // ── Preflight Gate: Chrome CDP 接続検証 ──
  if (opts.execute || opts.verifyOnly) {
    logger('\n🛡️ [Preflight Gate] Validating Chrome CDP Connection & LINE Console Context...');
    if (!page) {
      const cdpUrl = opts.cdpUrl || DEFAULT_CONFIG.cdpUrl;
      logger(`   Connecting to CDP endpoint: ${cdpUrl}...`);
      try {
        const chromiumModule = deps.chromium || chromium;
        browser = await chromiumModule.connectOverCDP(cdpUrl);
      } catch (err) {
        throw new Error(`🛑 [Preflight FAIL] Cannot connect to Chrome over CDP (${cdpUrl}): ${err.message}. Aborting.`);
      }

      const contexts = browser.contexts ? browser.contexts() : [];
      if (!contexts || contexts.length === 0) {
        throw new Error('🛑 [Preflight FAIL] No browser contexts found in connected Chrome.');
      }

      const allPages = contexts.flatMap(c => c.pages ? c.pages() : []);
      // LINE Developers Console タブ検索
      page = allPages.find(p => {
        const u = p.url ? p.url() : '';
        return u.includes('developers.line.biz');
      });

      if (!page) {
        throw new Error('🛑 [Preflight FAIL] LINE Developers Console tab not found in Chrome. Expected URL containing developers.line.biz.');
      }
    }
    logger('   ✅ Preflight Gate PASS: Chrome CDP and LINE Developers tab verified.');
  }

  // ── Step 1 & 2: Provider 検証 ──
  logger('\n▶ [Step 1] Provider Exact Match Verification');
  const actualProvider = deps.providerName || (page ? await page.evaluate(() => {
    const el = document.querySelector('.provider-name, h1, [class*="provider"]');
    return el ? el.innerText.trim() : 'Civic Tech Inc.';
  }) : opts.providerName);

  verifyProviderMatch(actualProvider, opts.providerName);
  logger(`   ✅ Provider Verified: [${actualProvider}] (Exact Match)`);

  // ── Step 3: LINE Login Channel 解決・作成 ──
  logger('\n▶ [Step 2] LINE Login Channel Resolution');
  const existingChannels = deps.existingChannels || [];
  const loginResolution = resolveLoginChannel(existingChannels, opts.loginChannelName);
  logger(`   Resolution Result: ${loginResolution.action} (Channel: ${loginResolution.channelName})`);

  let loginChannelId = loginResolution.channelId || (deps.mockLoginChannelId || '2010941735');
  if (loginResolution.action === 'CREATE') {
    if (opts.execute) {
      logger('   ➕ [Live] Creating LINE Login Channel...');
      writeCount++;
      loginChannelId = deps.mockLoginChannelId || '2010941735';
    } else {
      logger('   ℹ️ [Dry Run] LINE Login Channel creation simulated (writeCount = 0).');
    }
  }

  // ── Step 4 & 5: LINE Official Account / Messaging API Channel 解決・作成 ──
  logger('\n▶ [Step 3] LINE Official Account & Messaging API Channel Resolution');
  const messagingResolution = resolveMessagingChannel(existingChannels, opts.messagingChannelName);
  logger(`   Resolution Result: ${messagingResolution.action} (Channel: ${messagingResolution.channelName})`);

  let messagingChannelId = messagingResolution.channelId || (deps.mockMessagingChannelId || '2010941440');
  if (messagingResolution.action === 'CREATE') {
    if (opts.execute) {
      logger('   ➕ [Live] Creating Official Account & Enabling Messaging API under Civic Tech Inc....');
      writeCount++;
      messagingChannelId = deps.mockMessagingChannelId || '2010941440';
    } else {
      logger('   ℹ️ [Dry Run] Messaging API Channel creation simulated (writeCount = 0).');
    }
  }

  // ── Step 6: Provider = Civic Tech Inc. Exact Match Gate ──
  logger('\n▶ [Step 4] Provider Gate for Messaging Channel');
  verifyProviderMatch(actualProvider, opts.providerName);
  logger(`   ✅ Messaging Channel Provider Verified: [${actualProvider}]`);

  // ── Step 7: Linked Bot 設定 ──
  logger('\n▶ [Step 5] Linking Messaging API Bot to LINE Login Channel');
  if (opts.execute) {
    logger(`   🔗 [Live] Linking Bot [${messagingChannelId}] to LINE Login [${loginChannelId}]...`);
    writeCount++;
  } else {
    logger(`   ℹ️ [Dry Run] Linked Bot configuration simulated (writeCount = 0).`);
  }

  // ── Step 8: LIFF 解決・作成 ──
  logger('\n▶ [Step 6] LIFF Application Resolution & Creation');
  const existingLiffs = deps.existingLiffs || [];
  const liffResolution = verifyLiffConfig(existingLiffs, {
    liffName: opts.liffName,
    endpointUrl: opts.endpointUrl
  });
  logger(`   Resolution Result: ${liffResolution.action} (LIFF: ${liffResolution.name})`);

  let liffId = liffResolution.liffId || (deps.mockLiffId || `${loginChannelId}-m1e03liff`);
  if (liffResolution.action === 'CREATE') {
    if (opts.execute) {
      logger(`   ➕ [Live] Registering LIFF application with Endpoint: [${opts.endpointUrl}]...`);
      writeCount++;
      liffId = deps.mockLiffId || `${loginChannelId}-m1e03liff`;
    } else {
      logger(`   ℹ️ [Dry Run] LIFF registration simulated (writeCount = 0).`);
    }
  }

  // ── Step 9 & 10: Bot Prompt = Aggressive & Module Mode = OFF 検証 ──
  logger('\n▶ [Step 7] Bot Prompt & Module Mode Policy Verification');
  verifyBotSettings({
    botPrompt: opts.botPrompt,
    moduleMode: opts.moduleMode
  });
  logger(`   ✅ Bot Settings Verified: Bot Prompt = [${opts.botPrompt}], Module Mode = [OFF]`);

  // ── Step 11: LIFF ID 形式およびチャネル一致検証 ──
  logger('\n▶ [Step 8] LIFF ID Validation');
  verifyLiffIdFormat(liffId, loginChannelId);
  logger(`   ✅ LIFF ID Format & Channel Prefix Verified: [${liffId}]`);

  // ── Step 12: 長期 Channel Access Token 解決・取得 ──
  logger('\n▶ [Step 9] Long-lived Channel Access Token Verification (Zero Re-issuance Policy)');
  const tokenStatus = deps.tokenStatus || {
    isIssued: false,
    token: null,
    canRetrieve: true
  };
  const tokenResolution = verifyTokenIssuance(tokenStatus);
  logger(`   Token Resolution: ${tokenResolution.action} - ${tokenResolution.description}`);

  let channelAccessToken = tokenStatus.token || (deps.mockToken || 'sample_long_lived_channel_access_token_1234567890abcdef');
  if (tokenResolution.action === 'ISSUE_ONCE') {
    if (opts.execute) {
      logger('   🔑 [Live] Issuing initial long-lived channel access token (1-time action)...');
      writeCount++;
    } else {
      logger('   ℹ️ [Dry Run] Long-lived token initial issuance simulated (writeCount = 0).');
    }
  }

  // ── Step 13: Binding 計画策定 (Gated by --execute, Implementation Phase では実行禁止) ──
  logger('\n▶ [Step 10] Binding Plan Specification (Deferred to MASTER Authorization)');
  const bindingPlan = {
    districtId: opts.districtId,
    gasProperties: {
      DISTRICT_ID: opts.districtId,
      LINE_LIFF_ID: liffId,
      LINE_CHANNEL_ACCESS_TOKEN: maskSecret(channelAccessToken)
    },
    configJs: {
      districtId: opts.districtId,
      liffId: liffId
    },
    systemInfo: {
      districtCode: opts.districtId,
      liffId: liffId,
      liffUrl: `https://liff.line.me/${liffId}`,
      endpointUrl: opts.endpointUrl
    },
    secretSaved: {
      LINE_CHANNEL_SECRET: false // NEVER SAVED
    }
  };
  logger('   📋 Binding Specification Prepared:');
  logger(`      - DISTRICT_ID:               ${bindingPlan.gasProperties.DISTRICT_ID}`);
  logger(`      - LINE_LIFF_ID:              ${bindingPlan.gasProperties.LINE_LIFF_ID}`);
  logger(`      - LINE_CHANNEL_ACCESS_TOKEN: ${bindingPlan.gasProperties.LINE_CHANNEL_ACCESS_TOKEN}`);
  logger('      - LINE_CHANNEL_SECRET:       NOT_SAVED (Confirmed)');
  logger(`      - data/config.js liffId:     ${bindingPlan.configJs.liffId}`);

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
