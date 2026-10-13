/**
 * POSTING MAP - LINE Assets Provisioning Automation Tests
 *
 * scripts/provision-line-assets.mjs の機能および安全性契約を検証するテストスイート。
 * 外部通信を行わず、Mock/Fixture により決定論的に完全検証する。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  OA_CATEGORY_CONTRACT,
  LOGIN_CREATE_CONTRACT,
  DEFAULT_CONFIG,
  parseArgs,
  resolveExitCode,
  resolveCdpEndpoint,
  maskSecret,
  sanitizeLogMessage,
  createSanitizedLogger,
  extractProviderNameFromDom,
  verifyProviderMatch,
  extractChannelsFromDom,
  extractLiffsFromDom,
  extractTokenFromDom,
  resolveLoginChannel,
  resolveMessagingChannel,
  verifyLiffConfig,
  verifyTokenIssuance,
  verifyLiffIdFormat,
  verifyBotSettings,
  verifyPagesAndCnamePrecondition,
  verifyOfficialAccountManagerLogin,
  verifyOaCreateRouteUrl,
  verifyLoginCreateRouteUrl,
  verifyLoginPreSubmitState,
  createLoginChannelViaDom,
  createMessagingChannelViaDom,
  linkMessagingBotViaDom,
  createLiffViaDom,
  issueTokenViaDom,
  reReadAndVerifyAllAssets,
  executeLineProvisioning
} from '../scripts/provision-line-assets.mjs';

console.log('====================================================');
console.log('🚀 TESTING FULL LINE ASSETS PROVISIONING SUITE');
console.log('====================================================\n');

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 1. parseArgs default
test('1. Default execution sets dryRun=true, execute=false, verifyOnly=false', () => {
  const opts = parseArgs([]);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.execute, false);
  assert.equal(opts.verifyOnly, false);
  assert.equal(opts.districtId, 'MIE-03');
  assert.equal(opts.providerName, 'Civic Tech Inc.');
});

// 2. parseArgs --verify-only
test('2. --verify-only sets verifyOnly=true, execute=false, dryRun=false', () => {
  const opts = parseArgs(['--verify-only']);
  assert.equal(opts.verifyOnly, true);
  assert.equal(opts.execute, false);
  assert.equal(opts.dryRun, false);
});

// 3. parseArgs --execute
test('3. --execute enables execute and disables dryRun', () => {
  const opts = parseArgs(['--execute']);
  assert.equal(opts.execute, true);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.verifyOnly, false);
});

// 4. parseArgs parameter overrides
test('4. parseArgs overrides custom options', () => {
  const opts = parseArgs([
    '--district-id', 'TEST-01',
    '--endpoint', 'https://test.example.com/',
    '--provider', 'Custom Provider',
    '--cdp-url', 'http://localhost:9999'
  ]);
  assert.equal(opts.districtId, 'TEST-01');
  assert.equal(opts.appName, 'POSTING MAP TEST-01');
  assert.equal(opts.endpointUrl, 'https://test.example.com/');
  assert.equal(opts.providerName, 'Custom Provider');
  assert.equal(opts.cdpUrl, 'http://localhost:9999');
});

// 5. resolveExitCode allowed zero
test('5. resolveExitCode permits Exit 0 strictly for PASS, ASSETS_VERIFIED, PRECHECK_READY, DRY_RUN_COMPLETE', () => {
  assert.equal(resolveExitCode('PASS'), 0);
  assert.equal(resolveExitCode('ASSETS_VERIFIED'), 0);
  assert.equal(resolveExitCode('PRECHECK_READY'), 0);
  assert.equal(resolveExitCode('DRY_RUN_COMPLETE'), 0);
});

// 6. resolveExitCode failure non-zero
test('6. resolveExitCode returns Exit 1 on errors and hard stops', () => {
  assert.equal(resolveExitCode('PROVIDER_MISMATCH'), 1);
  assert.equal(resolveExitCode('CONTENT_MISMATCH'), 1);
  assert.equal(resolveExitCode('TOKEN_REISSUE_BLOCKED'), 1);
  assert.equal(resolveExitCode('CDP_ERROR'), 1);
  assert.equal(resolveExitCode('UNKNOWN_STATE'), 1);
});

// 7. resolveCdpEndpoint
test('7. resolveCdpEndpoint handles ws endpoints and defaults', () => {
  assert.equal(resolveCdpEndpoint('ws://127.0.0.1:9222/custom'), 'ws://127.0.0.1:9222/custom');
  const resolved = resolveCdpEndpoint('http://127.0.0.1:9222');
  assert.ok(resolved.startsWith('ws://') || resolved.startsWith('http://'));
});

// 8. maskSecret
test('8. maskSecret masks secrets properly without raw leakage', () => {
  assert.equal(maskSecret(null), '[NONE]');
  assert.equal(maskSecret('short'), '********');
  const masked = maskSecret('long_channel_access_token_1234567890abcdef');
  assert.equal(masked, 'long...cdef');
  assert.ok(!masked.includes('channel_access_token_1234567890'));
});

// 9. sanitizeLogMessage
test('9. sanitizeLogMessage masks known secrets and long tokens', () => {
  const secret = 'super_secret_channel_access_token_999988887777';
  const rawMsg = `Created token: ${secret} for district MIE-03`;
  const sanitized = sanitizeLogMessage(rawMsg, [secret]);
  assert.ok(!sanitized.includes(secret));
  assert.ok(sanitized.includes('supe...7777'));
});

// 10. sanitizeLogMessage generic long secret pattern
test('10. sanitizeLogMessage masks generic long base64/hex tokens', () => {
  const dummyJwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
  const rawMsg = ['Bearer', dummyJwt].join(' ');
  const sanitized = sanitizeLogMessage(rawMsg);
  assert.ok(!sanitized.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'));
  assert.ok(sanitized.includes('[REDACTED_JWT]'));
});

// 11. verifyProviderMatch exact match
test('11. verifyProviderMatch passes on exact match Civic Tech Inc.', () => {
  assert.equal(verifyProviderMatch('Civic Tech Inc.', 'Civic Tech Inc.'), true);
  assert.equal(verifyProviderMatch('  Civic Tech Inc.  ', 'Civic Tech Inc.'), true);
});

// 12. verifyProviderMatch mismatch triggers HARD STOP
test('12. verifyProviderMatch throws HARD STOP on provider mismatch', () => {
  assert.throws(() => {
    verifyProviderMatch('Wrong Provider LLC', 'Civic Tech Inc.');
  }, /PROVIDER_MISMATCH/);
});

// 13. extractProviderNameFromDom passes when DOM element present
await asyncTest('13. extractProviderNameFromDom extracts provider name correctly', async () => {
  const mockPage = {
    evaluate: async () => 'Civic Tech Inc.'
  };
  const name = await extractProviderNameFromDom(mockPage);
  assert.equal(name, 'Civic Tech Inc.');
});

// 14. extractProviderNameFromDom throws Fail-Closed when missing
await asyncTest('14. extractProviderNameFromDom throws HARD STOP when Provider DOM missing', async () => {
  const mockPage = {
    evaluate: async () => null
  };
  await assert.rejects(async () => {
    await extractProviderNameFromDom(mockPage);
  }, /PROVIDER_NOT_FOUND/);
});

// 15. extractChannelsFromDom parses channel items correctly
await asyncTest('15. extractChannelsFromDom extracts channels from DOM', async () => {
  const mockPage = {
    evaluate: async () => [
      { channelId: '2010941735', name: 'POSTING MAP', type: 'LINE_LOGIN' },
      { channelId: '2010941440', name: 'POSTING MAP', type: 'MESSAGING_API' }
    ]
  };
  const channels = await extractChannelsFromDom(mockPage);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].channelId, '2010941735');
  assert.equal(channels[0].type, 'LINE_LOGIN');
  assert.equal(channels[1].channelId, '2010941440');
  assert.equal(channels[1].type, 'MESSAGING_API');
});

// 16. extractLiffsFromDom extracts LIFF items from DOM
await asyncTest('16. extractLiffsFromDom extracts LIFF list from DOM', async () => {
  const mockPage = {
    evaluate: async () => [
      { liffId: '2010941735-abcdefgh', name: 'POSTING MAP', endpointUrl: 'https://kuwana.postingmap.jp/', botPrompt: 'Aggressive', moduleModeOff: true }
    ]
  };
  const liffs = await extractLiffsFromDom(mockPage);
  assert.equal(liffs.length, 1);
  assert.equal(liffs[0].liffId, '2010941735-abcdefgh');
  assert.equal(liffs[0].botPrompt, 'Aggressive');
  assert.equal(liffs[0].moduleModeOff, true);
});

// 17. extractTokenFromDom detects unissued token when Issue button present
await asyncTest('17. extractTokenFromDom detects unissued token when Issue button present', async () => {
  const mockPage = {
    evaluate: async () => ({ isIssued: false, token: null, canRetrieve: true })
  };
  const res = await extractTokenFromDom(mockPage);
  assert.equal(res.isIssued, false);
  assert.equal(res.token, null);
});

// 18. extractTokenFromDom extracts issued token from DOM
await asyncTest('18. extractTokenFromDom extracts existing token from DOM', async () => {
  const mockPage = {
    evaluate: async () => ({ isIssued: true, token: 'existing_token_abcdef1234567890', canRetrieve: true })
  };
  const res = await extractTokenFromDom(mockPage);
  assert.equal(res.isIssued, true);
  assert.equal(res.token, 'existing_token_abcdef1234567890');
});

// 19. extractTokenFromDom detects issued but unretrievable token
await asyncTest('19. extractTokenFromDom detects token that cannot be retrieved', async () => {
  const mockPage = {
    evaluate: async () => ({ isIssued: true, token: null, canRetrieve: false })
  };
  const res = await extractTokenFromDom(mockPage);
  assert.equal(res.isIssued, true);
  assert.equal(res.canRetrieve, false);
});

// 20. resolveLoginChannel reuse
test('20. resolveLoginChannel reuses existing matching LINE Login channel', () => {
  const existing = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const res = resolveLoginChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'REUSE');
  assert.equal(res.channelId, '2010941735');
});

// 21. resolveLoginChannel create
test('21. resolveLoginChannel marks for CREATE when not found', () => {
  const existing = [
    { channelId: '2010941440', name: 'POSTING MAP KUWANA', type: 'LINE_LOGIN' }
  ];
  const res = resolveLoginChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'CREATE');
  assert.equal(res.channelName, 'POSTING MAP MIE-03');
});

// 22. resolveMessagingChannel reuse
test('22. resolveMessagingChannel reuses existing matching Messaging API channel', () => {
  const existing = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const res = resolveMessagingChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'REUSE');
  assert.equal(res.channelId, '2010941440');
});

// 23. resolveMessagingChannel create
test('23. resolveMessagingChannel marks for CREATE when not found', () => {
  const existing = [];
  const res = resolveMessagingChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'CREATE');
  assert.equal(res.channelName, 'POSTING MAP MIE-03');
});

// 24. verifyLiffConfig reuse
test('24. verifyLiffConfig reuses when name and endpoint match', () => {
  const existing = [
    { liffId: '2010941735-abcdefgh', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const res = verifyLiffConfig(existing, {
    liffName: 'POSTING MAP MIE-03',
    endpointUrl: 'https://mie-03.postingmap.jp/'
  });
  assert.equal(res.action, 'REUSE');
  assert.equal(res.liffId, '2010941735-abcdefgh');
});

// 25. verifyLiffConfig content mismatch triggers HARD STOP
test('25. verifyLiffConfig throws HARD STOP on mismatched endpoint', () => {
  const existing = [
    { liffId: '2010941735-abcdefgh', name: 'POSTING MAP MIE-03', endpointUrl: 'https://wrong-domain.example.com/' }
  ];
  assert.throws(() => {
    verifyLiffConfig(existing, {
      liffName: 'POSTING MAP MIE-03',
      endpointUrl: 'https://mie-03.postingmap.jp/'
    });
  }, /CONTENT_MISMATCH/);
});

// 26. verifyTokenIssuance issue once
test('26. verifyTokenIssuance allows initial 1-time issuance when unissued', () => {
  const res = verifyTokenIssuance({ isIssued: false, token: null });
  assert.equal(res.action, 'ISSUE_ONCE');
});

// 27. verifyTokenIssuance reuse
test('27. verifyTokenIssuance reuses token when issued and retrievable', () => {
  const res = verifyTokenIssuance({ isIssued: true, token: 'existing_valid_token_xyz', canRetrieve: true });
  assert.equal(res.action, 'REUSE');
  assert.equal(res.token, 'existing_valid_token_xyz');
});

// 28. verifyTokenIssuance reissue prohibited HARD STOP
test('28. verifyTokenIssuance throws HARD STOP when token is issued but unretrievable', () => {
  assert.throws(() => {
    verifyTokenIssuance({ isIssued: true, token: null, canRetrieve: false });
  }, /TOKEN_REISSUE_BLOCKED/);
});

// 29. verifyLiffIdFormat
test('29. verifyLiffIdFormat passes on valid format and channel ID match', () => {
  assert.equal(verifyLiffIdFormat('2010941735-abcdefgh', '2010941735'), true);
});

// 30. verifyLiffIdFormat invalid format
test('30. verifyLiffIdFormat throws on malformed LIFF ID', () => {
  assert.throws(() => {
    verifyLiffIdFormat('invalid-liff-id', '2010941735');
  }, /INVALID_LIFF_ID/);
});

// 31. verifyLiffIdFormat channel prefix mismatch
test('31. verifyLiffIdFormat throws when prefix does not match LINE Login channel', () => {
  assert.throws(() => {
    verifyLiffIdFormat('9999999999-abcdefgh', '2010941735');
  }, /CHANNEL_PREFIX_MISMATCH/);
});

// 32. verifyBotSettings aggressive & module mode OFF
test('32. verifyBotSettings passes when Bot Prompt is Aggressive and Module Mode is OFF', () => {
  assert.equal(verifyBotSettings({ botPrompt: 'Aggressive', moduleMode: false }), true);
  assert.equal(verifyBotSettings({ botPrompt: '強', moduleMode: 'OFF' }), true);
});

// 33. verifyBotSettings non-aggressive throws
test('33. verifyBotSettings throws when Bot Prompt is not Aggressive', () => {
  assert.throws(() => {
    verifyBotSettings({ botPrompt: 'normal', moduleMode: false });
  }, /Bot Prompt must be "Aggressive"/);
});

// 34. verifyBotSettings module mode ON throws
test('34. verifyBotSettings throws when Module Mode is ON', () => {
  assert.throws(() => {
    verifyBotSettings({ botPrompt: 'Aggressive', moduleMode: true });
  }, /Module Mode must be OFF/);
});

// 35. verifyPagesAndCnamePrecondition passes
test('35. verifyPagesAndCnamePrecondition passes on correct CNAME and HTTPS', () => {
  const mockExec = () => JSON.stringify({
    cname: 'mie-03.postingmap.jp',
    https_enforced: true
  });
  assert.equal(verifyPagesAndCnamePrecondition('K-IWASA-MK/posting-map-mie-03', 'mie-03.postingmap.jp', mockExec), true);
});

// 36. verifyOfficialAccountManagerLogin passes when logged in
await asyncTest('36. verifyOfficialAccountManagerLogin passes when logged in', async () => {
  const mockPage = { evaluate: async () => false };
  assert.equal(await verifyOfficialAccountManagerLogin(mockPage), true);
});

// 37. verifyOfficialAccountManagerLogin throws when logged out
await asyncTest('37. verifyOfficialAccountManagerLogin throws when logged out', async () => {
  const mockPage = { evaluate: async () => true };
  await assert.rejects(async () => {
    await verifyOfficialAccountManagerLogin(mockPage);
  }, /Official Account Manager is not logged in/);
});

// 38. Built-in real UI adapters exist
test('38. Built-in real UI adapters are defined and callable functions', () => {
  assert.equal(typeof createLoginChannelViaDom, 'function');
  assert.equal(typeof createMessagingChannelViaDom, 'function');
  assert.equal(typeof linkMessagingBotViaDom, 'function');
  assert.equal(typeof createLiffViaDom, 'function');
  assert.equal(typeof issueTokenViaDom, 'function');
  assert.equal(typeof reReadAndVerifyAllAssets, 'function');
});

// 39. executeLineProvisioning CDP failure aborts with 0 writes
await asyncTest('39. executeLineProvisioning aborts on CDP connection failure with writeCount=0', async () => {
  const fakeChromium = {
    connectOverCDP: async () => { throw new Error('ECONNREFUSED'); }
  };
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, cdpUrl: 'http://localhost:9999' },
      { chromium: fakeChromium, logger: () => {} }
    );
  }, /Preflight FAIL/);
});

// 40. executeLineProvisioning Provider mismatch aborts with 0 writes
await asyncTest('40. executeLineProvisioning aborts on Provider mismatch with writeCount=0', async () => {
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: false, dryRun: true },
      { providerName: 'Unexpected Unknown Provider', logger: () => {} }
    );
  }, /PROVIDER_MISMATCH/);
});

// 41. executeLineProvisioning throws ID_ACQUISITION_FAILED if real ID missing after creation
await asyncTest('41. executeLineProvisioning throws ID_ACQUISITION_FAILED if real ID missing after creation', async () => {
  const mockDevPage = { evaluate: async () => 'Civic Tech Inc.' };
  const mockManagerPage = { evaluate: async () => false };
  const badAdapter = async () => ({ channelId: null, writeCount: 1 });
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        page: mockDevPage,
        managerPage: mockManagerPage,
        providerName: 'Civic Tech Inc.',
        existingChannels: [],
        createLoginChannelAdapter: badAdapter,
        logger: () => {}
      }
    );
  }, /ID_ACQUISITION_FAILED/);
});

// 42. executeLineProvisioning default dry-run executes 0 writes
await asyncTest('42. executeLineProvisioning in default dry-run mode executes 0 external writes', async () => {
  const res = await executeLineProvisioning(
    {},
    { providerName: 'Civic Tech Inc.', logger: () => {} }
  );
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'DRY_RUN');
  assert.equal(res.status, 'DRY_RUN_COMPLETE');
  assert.equal(res.downstreamAllowed, false);
});

// 43. executeLineProvisioning --verify-only returns PRECHECK_READY when assets missing
await asyncTest('43. executeLineProvisioning in --verify-only returns PRECHECK_READY when assets missing', async () => {
  const mockDevPage = { evaluate: async () => 'Civic Tech Inc.' };
  const mockManagerPage = { evaluate: async () => false };
  const res = await executeLineProvisioning(
    { verifyOnly: true, execute: false, dryRun: false },
    {
      page: mockDevPage,
      managerPage: mockManagerPage,
      providerName: 'Civic Tech Inc.',
      existingChannels: [], // missing
      logger: () => {}
    }
  );
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'VERIFY_ONLY');
  assert.equal(res.status, 'PRECHECK_READY');
  assert.equal(res.downstreamAllowed, false);
});

// 44. executeLineProvisioning --verify-only returns ASSETS_VERIFIED when all assets exist
await asyncTest('44. executeLineProvisioning in --verify-only returns ASSETS_VERIFIED when all assets exist and audit passes', async () => {
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const tokenStatus = {
    isIssued: true,
    token: 'existing_token_abcdef1234567890',
    canRetrieve: true
  };
  const mockDevPage = { evaluate: async () => 'Civic Tech Inc.' };
  const mockManagerPage = { evaluate: async () => false };
  let auditCalled = false;
  const mockReReadAdapter = async () => {
    auditCalled = true;
    return {
      verified: true,
      loginChannelId: '2010941735',
      messagingChannelId: '2010941440',
      liffId: '2010941735-mie03liff',
      token: 'existing_token_abcdef1234567890'
    };
  };

  const res = await executeLineProvisioning(
    { verifyOnly: true, execute: false, dryRun: false },
    {
      page: mockDevPage,
      managerPage: mockManagerPage,
      providerName: 'Civic Tech Inc.',
      existingChannels,
      existingLiffs,
      tokenStatus,
      reReadAndVerifyAllAssets: mockReReadAdapter,
      logger: () => {}
    }
  );
  assert.equal(auditCalled, true, 'reReadAndVerifyAllAssets audit must be executed in verify-only mode');
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'VERIFY_ONLY');
  assert.equal(res.status, 'ASSETS_VERIFIED');
  assert.equal(res.downstreamAllowed, false);
});

// 45. executeLineProvisioning reuses all 3 existing assets when present in execute
await asyncTest('45. executeLineProvisioning reuses all 3 existing assets when present', async () => {
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const tokenStatus = {
    isIssued: true,
    token: 'existing_token_abcdef1234567890',
    canRetrieve: true
  };
  const mockLinkAdapter = async () => ({ writeCount: 0, verified: true });
  const mockReReadAdapter = async () => ({
    verified: true,
    loginChannelId: '2010941735',
    messagingChannelId: '2010941440',
    liffId: '2010941735-mie03liff',
    token: 'existing_token_abcdef1234567890'
  });

  const res = await executeLineProvisioning(
    { execute: true, dryRun: false },
    {
      page: { evaluate: async () => 'Civic Tech Inc.' },
      managerPage: { evaluate: async () => false },
      providerName: 'Civic Tech Inc.',
      existingChannels,
      existingLiffs,
      tokenStatus,
      linkBotAdapter: mockLinkAdapter,
      reReadAndVerifyAllAssets: mockReReadAdapter,
      logger: () => {}
    }
  );

  assert.equal(res.status, 'PASS');
  assert.equal(res.downstreamAllowed, true);
  assert.equal(res.loginChannelId, '2010941735');
  assert.equal(res.messagingChannelId, '2010941440');
  assert.equal(res.liffId, '2010941735-mie03liff');
  assert.equal(res.writeCount, 0);
});

// 46. executeLineProvisioning halts on LIFF content mismatch
await asyncTest('46. executeLineProvisioning halts on LIFF content mismatch', async () => {
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://wrong-endpoint.com/' }
  ];

  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        page: { evaluate: async () => 'Civic Tech Inc.' },
        managerPage: { evaluate: async () => false },
        providerName: 'Civic Tech Inc.',
        existingChannels,
        existingLiffs,
        linkBotAdapter: async () => ({ writeCount: 0, verified: true }),
        logger: () => {}
      }
    );
  }, /CONTENT_MISMATCH/);
});

// 47. executeLineProvisioning blocks token reissue
await asyncTest('47. executeLineProvisioning blocks token reissue and halts with HARD STOP', async () => {
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const tokenStatus = {
    isIssued: true,
    token: null,
    canRetrieve: false
  };

  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        page: { evaluate: async () => 'Civic Tech Inc.' },
        managerPage: { evaluate: async () => false },
        providerName: 'Civic Tech Inc.',
        existingChannels,
        existingLiffs,
        tokenStatus,
        linkBotAdapter: async () => ({ writeCount: 0, verified: true }),
        logger: () => {}
      }
    );
  }, /TOKEN_REISSUE_BLOCKED/);
});

// 48. executeLineProvisioning masks token in returned payload and binding plan
await asyncTest('48. executeLineProvisioning masks channel access token in returned object and binding plan', async () => {
  const rawToken = 'super_secret_channel_access_token_abcdef1234567890';
  const res = await executeLineProvisioning(
    { dryRun: true },
    {
      providerName: 'Civic Tech Inc.',
      tokenStatus: { isIssued: true, token: rawToken, canRetrieve: true },
      logger: () => {}
    }
  );

  assert.ok(!JSON.stringify(res).includes(rawToken), 'Raw secret token must not be in returned object');
  assert.equal(res.tokenMasked, maskSecret(rawToken));
  assert.equal(res.bindingPlan.gasProperties.LINE_CHANNEL_ACCESS_TOKEN, maskSecret(rawToken));
  assert.equal(res.bindingPlan.secretSaved.LINE_CHANNEL_SECRET, false);
});

// 49. Secret log test: 0 raw token instances emitted to log buffer
await asyncTest('49. Secret log test: 0 raw token instances emitted to logs', async () => {
  let logBuffer = [];
  const rawToken = 'sensitive_raw_channel_access_token_qwertyuiopasdfghjkl';
  await executeLineProvisioning(
    { dryRun: true },
    {
      providerName: 'Civic Tech Inc.',
      tokenStatus: { isIssued: true, token: rawToken, canRetrieve: true },
      knownSecrets: [rawToken],
      logger: msg => logBuffer.push(msg)
    }
  );

  const fullLogs = logBuffer.join('\n');
  assert.ok(!fullLogs.includes(rawToken), 'Raw secret token must NEVER be emitted in log outputs');
});

// 50. Zero fake/default fallback IDs
await asyncTest('50. Zero fake/default fallback IDs: uncreated assets result in null/pending IDs, never hardcoded legacy IDs', async () => {
  const res = await executeLineProvisioning(
    { dryRun: true },
    {
      providerName: 'Civic Tech Inc.',
      existingChannels: [],
      existingLiffs: [],
      tokenStatus: { isIssued: false, token: null },
      logger: () => {}
    }
  );

  assert.equal(res.loginChannelId, null, 'loginChannelId must be null in dry run when uncreated');
  assert.equal(res.messagingChannelId, null, 'messagingChannelId must be null in dry run when uncreated');
  assert.equal(res.liffId, null, 'liffId must be null in dry run when uncreated');
  assert.notEqual(res.loginChannelId, '2010941735');
  assert.notEqual(res.messagingChannelId, '2010941440');
});

/**
 * Current UI Contract A〜K を忠実に再現する LINE Login 新規作成 DOM Mock 生成ヘルパー
 */
function createCurrentUiLoginDomMock(overrides = {}) {
  const state = {
    visitedUrls: [],
    queriedSelectors: [],
    currentUrl: overrides.initialUrl || 'https://developers.line.biz/console/provider/2005181930',
    postClickFormUrl: overrides.postClickFormUrl || 'https://developers.line.biz/console/channel/new?provider=2005181930&type=line-login',
    postSubmitUrl: overrides.postSubmitUrl || 'https://developers.line.biz/console/channel/2026101301',
    providerHeaderName: overrides.providerHeaderName || 'Civic Tech Inc.',
    createCard: {
      visible: overrides.createCardVisible ?? true,
      tagName: overrides.createCardTagName || 'DIV',
      className: overrides.createCardClassName || 'channel-card-list-create',
      textContent: overrides.createCardText ?? '新規チャネル作成',
      clickCount: 0,
      classList: {
        contains(cls) {
          return (overrides.createCardClassName || 'channel-card-list-create').split(/\s+/).includes(cls);
        }
      }
    },
    modalLoginLink: {
      visible: overrides.modalLoginLinkVisible ?? true,
      tagName: overrides.modalLoginLinkTagName || 'A',
      className: overrides.modalLoginLinkClassName || 'item-link',
      href: overrides.modalLoginLinkHref ?? '/console/channel/new?provider=2005181930&type=line-login',
      clickCount: 0,
      classList: {
        contains(cls) {
          return (overrides.modalLoginLinkClassName || 'item-link').split(/\s+/).includes(cls);
        }
      },
      getAttribute(attr) {
        return attr === 'href' ? this.href : null;
      }
    },
    providerSelect: {
      value: overrides.providerIdValue ?? '2005181930',
      get selectedOptions() {
        return [{ text: overrides.providerOptionText ?? 'Civic Tech Inc.' }];
      }
    },
    serviceRegionRadios: [
      {
        checked: overrides.serviceRegionJapanInitialChecked ?? true,
        clickCount: 0,
        changeCount: 0,
        labelText: '日本',
        click() {
          this.clickCount++;
          this.checked = true;
        },
        dispatchEvent() {
          this.changeCount++;
        },
        closest() {
          return { textContent: this.labelText };
        }
      },
      {
        checked: false,
        clickCount: 0,
        changeCount: 0,
        labelText: 'タイ',
        click() {
          this.clickCount++;
          this.checked = true;
        },
        dispatchEvent() {
          this.changeCount++;
        },
        closest() {
          return { textContent: this.labelText };
        }
      }
    ],
    companyCountrySelect: {
      value: overrides.companyCountryInitialValue ?? '-1',
      changeCount: 0,
      options: overrides.companyCountryOptions || [
        { value: '-1', text: '未設定' },
        { value: '0', text: '日本' },
        { value: '1', text: '台湾' }
      ],
      get selectedOptions() {
        if (overrides.companyCountrySelectedTextOverride !== undefined) {
          return [{ text: overrides.companyCountrySelectedTextOverride }];
        }
        const found = this.options.find(o => o.value === this.value);
        return found ? [found] : [];
      },
      dispatchEvent() {
        this.changeCount++;
      }
    },
    channelNameTextarea: {
      visible: overrides.channelNameVisible ?? true,
      tagName: overrides.channelNameTagName || 'TEXTAREA',
      value: overrides.channelNameInitialValue ?? '',
      fillCount: 0
    },
    descriptionTextarea: {
      visible: overrides.descriptionVisible ?? true,
      tagName: overrides.descriptionTagName || 'TEXTAREA',
      value: overrides.descriptionInitialValue ?? '',
      fillCount: 0
    },
    webAppCheckbox: {
      checked: overrides.webAppInitialChecked ?? false,
      clickCount: 0,
      changeCount: 0,
      click() {
        this.clickCount++;
        this.checked = true;
      },
      dispatchEvent() {
        this.changeCount++;
      }
    },
    nativeAppCheckbox: {
      checked: false,
      clickCount: 0,
      changeCount: 0,
      click() {
        this.clickCount++;
        this.checked = true;
      },
      dispatchEvent() {
        this.changeCount++;
      }
    },
    force2faCheckbox: {
      name: 'force2fa',
      checked: true,
      clickCount: 0,
      changeCount: 0,
      click() {
        this.clickCount++;
        this.checked = !this.checked;
      },
      dispatchEvent() {
        this.changeCount++;
      }
    },
    emailTextarea: {
      visible: overrides.emailVisible ?? true,
      tagName: overrides.emailTagName || 'TEXTAREA',
      value: overrides.emailInitialValue ?? 'postingareamap@gmail.com',
      fillCount: 0
    },
    channelIconInput: {
      type: 'file',
      value: '',
      touched: false
    },
    privacyPolicyTextarea: {
      tagName: 'TEXTAREA',
      value: '',
      fillCount: 0,
      touched: false
    },
    termsOfServiceTextarea: {
      tagName: 'TEXTAREA',
      value: '',
      fillCount: 0,
      touched: false
    },
    termsCheckbox: {
      checked: overrides.termsInitialChecked ?? false,
      clickCount: 0,
      changeCount: 0,
      click() {
        this.clickCount++;
        this.checked = true;
      },
      dispatchEvent() {
        this.changeCount++;
      }
    },
    forceLaTimesCount: overrides.forceLaTimesCount ?? null,
    getLaTimesCount() {
      if (this.forceLaTimesCount !== null) return this.forceLaTimesCount;
      let errs = 0;
      const ccOpt = this.companyCountrySelect.selectedOptions[0];
      if (!ccOpt || ccOpt.text.trim() !== '日本') errs++;
      if (!this.channelNameTextarea.value.trim()) errs++;
      if (!this.descriptionTextarea.value.trim()) errs++;
      if (!this.webAppCheckbox.checked) errs++;
      if (!this.emailTextarea.value.trim()) errs++;
      if (!this.termsCheckbox.checked) errs++;
      return errs;
    },
    submitButton: null,
    existingChannelDomItems: overrides.existingChannelDomItems || [
      {
        tagName: 'A',
        className: 'channel-item',
        innerText: 'Admin\nPOSTING MAP KUWANA\nLINEログイン\n公開',
        textContent: 'Admin\nPOSTING MAP KUWANA\nLINEログイン\n公開',
        getAttribute(attr) {
          return attr === 'href' ? '/console/channel/2010941735' : null;
        }
      }
    ],
    formTagQueriedCount: 0
  };

  state.submitButton = {
    visible: overrides.submitVisible ?? true,
    textContent: overrides.submitText ?? '作成',
    clickCount: 0,
    forceDisabled: overrides.forceSubmitDisabled ?? null,
    get disabled() {
      if (this.forceDisabled !== null) return this.forceDisabled;
      return state.getLaTimesCount() > 0;
    },
    hasAttribute(attr) {
      return attr === 'disabled' ? this.disabled : false;
    }
  };

  const formItems = [
    {
      label: 'プロバイダー',
      querySelector(sel) {
        if (sel.includes('h4') || sel.includes('label')) return { textContent: 'プロバイダー' };
        if (sel === 'select') return state.providerSelect;
        return null;
      }
    },
    {
      label: 'サービスを提供する地域',
      querySelector(sel) {
        if (sel.includes('h4') || sel.includes('label')) return { textContent: 'サービスを提供する地域' };
        return null;
      },
      querySelectorAll(sel) {
        if (sel === 'input[type="radio"]') return state.serviceRegionRadios;
        return [];
      }
    },
    {
      label: '会社・事業者の所在国・地域',
      querySelector(sel) {
        if (sel.includes('h4') || sel.includes('label')) return { textContent: '会社・事業者の所在国・地域' };
        if (sel === 'select') return overrides.companyCountrySelectMissing ? null : state.companyCountrySelect;
        return null;
      }
    }
  ];

  const kvChoices = [
    {
      label: 'ウェブアプリ',
      querySelector(sel) {
        if (sel === 'label') return { textContent: 'ウェブアプリ' };
        if (sel === 'input[type="checkbox"]') return state.webAppCheckbox;
        return null;
      }
    },
    {
      label: 'ネイティブアプリ',
      querySelector(sel) {
        if (sel === 'label') return { textContent: 'ネイティブアプリ' };
        if (sel === 'input[type="checkbox"]') return state.nativeAppCheckbox;
        return null;
      }
    },
    {
      label: 'LINE開発者契約に同意します。',
      querySelector(sel) {
        if (sel === 'label') return { textContent: 'LINE開発者契約に同意します。' };
        if (sel === 'input[type="checkbox"]') return state.termsCheckbox;
        return null;
      }
    }
  ];

  const mockDocument = {
    querySelector(sel) {
      if (sel === 'form') {
        state.formTagQueriedCount++;
        return null; // Current UI has NO <form> tag on LINE Login creation screen!
      }
      if (sel.includes('provider-name')) {
        return { innerText: state.providerHeaderName };
      }
      if (sel === '.new-channel') {
        return {
          querySelectorAll(s) {
            if (s === 'input[type="radio"]') return state.serviceRegionRadios;
            return [];
          }
        };
      }
      if (sel === '.new-channel select[readonly]') {
        return state.providerSelect;
      }
      if (sel === LOGIN_CREATE_CONTRACT.channelNameSelector) {
        return state.channelNameTextarea;
      }
      if (sel === LOGIN_CREATE_CONTRACT.descriptionSelector) {
        return state.descriptionTextarea;
      }
      if (sel === LOGIN_CREATE_CONTRACT.emailSelector) {
        return state.emailTextarea;
      }
      if (sel === LOGIN_CREATE_CONTRACT.submitButtonSelector) {
        return state.submitButton;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.new-channel .form-item') {
        return formItems;
      }
      if (sel === '.new-channel .kv-choice') {
        return kvChoices;
      }
      if (sel === LOGIN_CREATE_CONTRACT.formErrorTimesSelector) {
        return Array.from({ length: state.getLaTimesCount() }, () => ({}));
      }
      if (sel.includes('a.channel-item')) {
        return state.existingChannelDomItems;
      }
      return [];
    }
  };

  class MockEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
    }
  }

  const devPage = {
    goto: async (url) => {
      state.visitedUrls.push(url);
      state.currentUrl = url;
    },
    waitForLoadState: async () => {},
    waitForNavigation: async () => {},
    url: () => state.currentUrl,
    evaluate: async (fn, arg) => {
      const prevDoc = globalThis.document;
      const prevWin = globalThis.window;
      const prevEvent = globalThis.Event;
      try {
        globalThis.document = mockDocument;
        globalThis.window = { location: { href: state.currentUrl } };
        globalThis.Event = MockEvent;
        return await fn(arg);
      } finally {
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        globalThis.Event = prevEvent;
      }
    },
    locator: (sel) => {
      state.queriedSelectors.push(sel);
      if (sel === LOGIN_CREATE_CONTRACT.createCardSelector) {
        return {
          first: () => ({
            isVisible: async () => state.createCard.visible,
            evaluate: async (fn) => fn(state.createCard),
            click: async () => {
              state.createCard.clickCount++;
            }
          })
        };
      }
      if (sel === LOGIN_CREATE_CONTRACT.modalLoginLinkSelector) {
        return {
          first: () => ({
            isVisible: async () => state.modalLoginLink.visible,
            evaluate: async (fn) => fn(state.modalLoginLink),
            click: async () => {
              state.modalLoginLink.clickCount++;
              state.currentUrl = state.postClickFormUrl;
            }
          })
        };
      }
      if (sel === LOGIN_CREATE_CONTRACT.channelNameSelector) {
        return {
          first: () => ({
            isVisible: async () => state.channelNameTextarea.visible,
            fill: async (val) => {
              state.channelNameTextarea.fillCount++;
              state.channelNameTextarea.value = overrides.channelNameAfterFill ?? val;
            },
            evaluate: async (fn) => fn(state.channelNameTextarea)
          })
        };
      }
      if (sel === LOGIN_CREATE_CONTRACT.descriptionSelector) {
        return {
          first: () => ({
            isVisible: async () => state.descriptionTextarea.visible,
            fill: async (val) => {
              state.descriptionTextarea.fillCount++;
              state.descriptionTextarea.value = overrides.descriptionAfterFill ?? val;
            },
            evaluate: async (fn) => fn(state.descriptionTextarea)
          })
        };
      }
      if (sel === LOGIN_CREATE_CONTRACT.emailSelector) {
        return {
          first: () => ({
            isVisible: async () => state.emailTextarea.visible,
            fill: async (val) => {
              state.emailTextarea.fillCount++;
              state.emailTextarea.value = overrides.emailAfterFill ?? val;
            },
            evaluate: async (fn) => fn(state.emailTextarea)
          })
        };
      }
      if (sel === LOGIN_CREATE_CONTRACT.submitButtonSelector) {
        return {
          first: () => ({
            isVisible: async () => state.submitButton.visible,
            evaluate: async (fn) => fn(state.submitButton),
            click: async () => {
              state.submitButton.clickCount++;
              state.currentUrl = state.postSubmitUrl;
            }
          })
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
          click: async () => {},
          fill: async () => {},
          evaluate: async () => null
        })
      };
    }
  };

  return { devPage, state };
}

// 51. CLI wiring: built-in real adapters selected by default when no deps adapter provided
await asyncTest('51. CLI wiring: built-in real adapters selected by default when no deps adapter provided', async () => {
  const { devPage: mockDevPage, state } = createCurrentUiLoginDomMock();
  const mockManagerPage = { evaluate: async () => false };

  // Call with execute=true and NO custom adapters -> built-in createLoginChannelViaDom will be called
  const mockLinkAdapter = async () => ({ writeCount: 0, verified: true });
  const mockReReadAdapter = async () => ({
    verified: true,
    loginChannelId: '2026101301',
    messagingChannelId: '2026101302',
    liffId: '2026101301-liffhash',
    token: 'real_issued_channel_token_1234567890'
  });
  const mockMessagingAdapter = async () => ({ channelId: '2026101302', writeCount: 1 });
  const mockLiffAdapter = async () => ({ liffId: '2026101301-liffhash', writeCount: 1 });
  const mockTokenAdapter = async () => ({ token: 'real_issued_channel_token_1234567890', writeCount: 1 });

  const res = await executeLineProvisioning(
    { execute: true, dryRun: false },
    {
      page: mockDevPage,
      managerPage: mockManagerPage,
      providerName: 'Civic Tech Inc.',
      existingChannels: [],
      // createLoginChannelAdapter omitted to test built-in default wiring!
      createMessagingChannelAdapter: mockMessagingAdapter,
      linkBotAdapter: mockLinkAdapter,
      createLiffAdapter: mockLiffAdapter,
      issueTokenAdapter: mockTokenAdapter,
      reReadAndVerifyAllAssets: mockReReadAdapter,
      logger: () => {}
    }
  );

  assert.equal(state.createCard.clickCount, 1, 'Built-in createLoginChannelViaDom must click div.channel-card-list-create');
  assert.equal(state.submitButton.clickCount, 1, 'Built-in createLoginChannelViaDom must click submit once');
  assert.equal(res.loginChannelId, '2026101301');
});

// 52. Post-Verification Live DOM re-reading throws on mismatch
await asyncTest('52. Live DOM post-verification throws on asset mismatch', async () => {
  const badReReadAdapter = async () => ({
    verified: false,
    loginChannelId: null,
    messagingChannelId: null,
    liffId: null,
    token: null
  });

  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const tokenStatus = {
    isIssued: true,
    token: 'existing_token_abcdef1234567890',
    canRetrieve: true
  };

  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        page: { evaluate: async () => 'Civic Tech Inc.' },
        managerPage: { evaluate: async () => false },
        providerName: 'Civic Tech Inc.',
        existingChannels,
        existingLiffs,
        tokenStatus,
        linkBotAdapter: async () => ({ writeCount: 0, verified: true }),
        reReadAndVerifyAllAssets: badReReadAdapter,
        logger: () => {}
      }
    );
  }, /Post-Verification FAIL/);
});

// 53. extractLiffsFromDom extracts Full size, profile, and openid scopes
await asyncTest('53. extractLiffsFromDom extracts Full size, profile, and openid scopes', async () => {
  const fakeDomPage = {
    evaluate: async () => [
      {
        liffId: '2010941735-mie03liff',
        name: 'POSTING MAP MIE-03',
        endpointUrl: 'https://mie-03.postingmap.jp/',
        size: 'Full',
        hasProfileScope: true,
        hasOpenidScope: true,
        botPrompt: 'Aggressive',
        moduleModeOff: true,
        rawText: 'Full profile openid 強'
      }
    ]
  };
  const extracted = await extractLiffsFromDom(fakeDomPage);
  assert.equal(extracted[0].size, 'Full');
  assert.equal(extracted[0].hasProfileScope, true);
  assert.equal(extracted[0].hasOpenidScope, true);
});

// 54. reReadAndVerifyAllAssets rejects when LIFF size is not Full
await asyncTest('54. reReadAndVerifyAllAssets rejects when LIFF size is not Full', async () => {
  const mockPageWithBadLiff = {
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('provider-name')) return 'Civic Tech Inc.';
      if (src.includes('channel-item')) return [
        { name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN', channelId: '2010941735' },
        { name: 'POSTING MAP MIE-03', type: 'MESSAGING_API', channelId: '2010941440' }
      ];
      if (src.includes('liff-item')) return [
        {
          liffId: '2010941735-mie03liff',
          name: 'POSTING MAP MIE-03',
          endpointUrl: 'https://mie-03.postingmap.jp/',
          size: 'Compact', // NOT Full!
          hasProfileScope: true,
          hasOpenidScope: true,
          botPrompt: 'Aggressive',
          moduleModeOff: true
        }
      ];
      if (src.includes('textarea[readonly]')) return 'existing_token_abcdef1234567890';
      return '';
    },
    locator: () => ({
      first: () => ({
        isVisible: async () => true,
        innerText: async () => 'POSTING MAP MIE-03'
      })
    })
  };

  await assert.rejects(async () => {
    await reReadAndVerifyAllAssets(mockPageWithBadLiff, {
      providerName: 'Civic Tech Inc.',
      loginChannelName: 'POSTING MAP MIE-03',
      messagingChannelName: 'POSTING MAP MIE-03',
      liffName: 'POSTING MAP MIE-03',
      endpointUrl: 'https://mie-03.postingmap.jp/'
    });
  }, /LIFF Size mismatch/);
});

// 55. createMessagingChannelViaDom throws OA_CATEGORY_UNDEFINED when categories missing
await asyncTest('55. createMessagingChannelViaDom throws OA_CATEGORY_UNDEFINED when categories missing', async () => {
  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      categoryMain: null,
      categorySub: null,
      managerPage: {
        goto: async () => {},
        waitForLoadState: async () => {},
        locator: () => ({ first: () => ({ fill: async () => {}, isVisible: async () => false }) })
      },
      devPage: {},
      logger: () => {}
    });
  }, /OA_CATEGORY_UNDEFINED/);
});

// 56. createMessagingChannelViaDom throws PROVIDER_SELECT_NOT_FOUND when provider option missing
await asyncTest('56. createMessagingChannelViaDom throws PROVIDER_SELECT_NOT_FOUND when provider option missing', async () => {
  const mockManagerPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: (sel) => ({
      first: () => ({
        getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
        fill: async () => {},
        click: async () => {},
        isVisible: async () => {
          if (typeof sel === 'string' && sel.includes('Messaging APIを利用する')) return true;
          if (typeof sel === 'string' && (sel.includes('provider') || sel.includes('Civic Tech Inc.'))) return false;
          return true;
        },
        evaluate: async () => true
      })
    }),
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('category_group')) {
        return { mainText: 'ウェブサービス', subText: 'ウェブサービス(ビジネス)' };
      }
      if (src.includes('checkValidity')) return true;
      return '';
    },
    waitForTimeout: async () => {}
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      categoryMain: 'ウェブサービス',
      categorySub: 'ウェブサービス(ビジネス)',
      providerName: 'Civic Tech Inc.',
      managerPage: mockManagerPage,
      devPage: { goto: async () => {}, waitForLoadState: async () => {} },
      logger: () => {}
    });
  }, /PROVIDER_SELECT_NOT_FOUND/);
});

// 57. createMessagingChannelViaDom throws PROVIDER_MISMATCH_BEFORE_SUBMIT if re-read differs
await asyncTest('57. createMessagingChannelViaDom throws PROVIDER_MISMATCH_BEFORE_SUBMIT if re-read differs', async () => {
  const mockManagerPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      first: () => ({
        getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
        fill: async () => {},
        click: async () => {},
        isVisible: async () => true,
        evaluate: async () => true
      })
    }),
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('category_group')) {
        return { mainText: 'ウェブサービス', subText: 'ウェブサービス(ビジネス)' };
      }
      if (src.includes('checkValidity')) return true;
      return 'Wrong Provider Inc.'; // Mismatched provider re-read
    }
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      categoryMain: 'ウェブサービス',
      categorySub: 'ウェブサービス(ビジネス)',
      providerName: 'Civic Tech Inc.',
      managerPage: mockManagerPage,
      devPage: { goto: async () => {}, waitForLoadState: async () => {} },
      logger: () => {}
    });
  }, /PROVIDER_MISMATCH_BEFORE_SUBMIT/);
});

// 58. createLiffViaDom throws LIFF_CONFIG_FAIL when required selector missing
await asyncTest('58. createLiffViaDom throws LIFF_CONFIG_FAIL when required selector missing', async () => {
  const mockDevPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: (sel) => ({
      first: () => ({
        fill: async () => {},
        click: async () => {},
        isVisible: async () => sel.includes('liffName') ? true : false, // Size/scope selector missing!
        check: async () => {}
      })
    })
  };

  await assert.rejects(async () => {
    await createLiffViaDom({
      loginChannelId: '2010941735',
      liffName: 'POSTING MAP MIE-03',
      endpointUrl: 'https://mie-03.postingmap.jp/',
      devPage: mockDevPage,
      logger: () => {}
    });
  }, /LIFF_CONFIG_FAIL/);
});

// 59. executeLineProvisioning in --verify-only rejects if live DOM audit fails
await asyncTest('59. executeLineProvisioning in --verify-only rejects if live DOM audit fails', async () => {
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const tokenStatus = {
    isIssued: true,
    token: 'existing_token_abcdef1234567890',
    canRetrieve: true
  };
  const failingAudit = async () => ({
    verified: false,
    loginChannelId: null,
    messagingChannelId: null,
    liffId: null,
    token: null
  });

  await assert.rejects(async () => {
    await executeLineProvisioning(
      { verifyOnly: true, execute: false, dryRun: false },
      {
        page: { evaluate: async () => 'Civic Tech Inc.' },
        managerPage: { evaluate: async () => false },
        providerName: 'Civic Tech Inc.',
        existingChannels,
        existingLiffs,
        tokenStatus,
        reReadAndVerifyAllAssets: failingAudit,
        logger: () => {}
      }
    );
  }, /Full Read-Only Live DOM audit detected mismatch/);
});

// 60. Browser evaluate selector safety: querySelector does NOT contain invalid :has-text syntax
await asyncTest('60. Browser evaluate selector safety: no :has-text pseudo-selectors in querySelector calls', async () => {
  const code = fs.readFileSync('scripts/provision-line-assets.mjs', 'utf8');
  const qsRegex = /querySelector(?:All)?\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let match;
  let violations = [];
  while ((match = qsRegex.exec(code)) !== null) {
    const sel = match[1];
    if (sel.includes(':has-text')) {
      violations.push({ selector: sel, match: match[0] });
    }
  }
  assert.equal(violations.length, 0, `No :has-text permitted in querySelector: ${JSON.stringify(violations)}`);
});

// 61. Do NOT use manager.line.biz/account/create direct route
await asyncTest('61. Official Account creation does NOT use deprecated manager.line.biz/account/create', async () => {
  const code = fs.readFileSync('scripts/provision-line-assets.mjs', 'utf8');
  assert.equal(code.includes('manager.line.biz/account/create'), false, 'Deprecated manager.line.biz/account/create must be completely removed');

  await assert.rejects(async () => {
    verifyOaCreateRouteUrl('https://manager.line.biz/account/create');
  }, /OA_CREATE_ROUTE_MISMATCH/);
});

// 62. Official Account creation route resolves href from manager.line.biz and enforces entry.line.biz/form/entry/unverified Exact Gate
await asyncTest('62. entry.line.biz/form/entry/unverified route gate passes on exact match and halts on unexpected URL', async () => {
  const resolved = verifyOaCreateRouteUrl('https://entry.line.biz/form/entry/unverified');
  assert.equal(resolved, 'https://entry.line.biz/form/entry/unverified');

  await assert.rejects(async () => {
    verifyOaCreateRouteUrl('https://entry.line.biz/form/entry/other');
  }, /OA_CREATE_ROUTE_MISMATCH/);

  await assert.rejects(async () => {
    verifyOaCreateRouteUrl('https://evil.example.com/form/entry/unverified');
  }, /OA_CREATE_ROUTE_MISMATCH/);

  let visitedUrls = [];
  let submitClicked = false;
  const mockBadRoutePage = {
    goto: async (u) => visitedUrls.push(u),
    waitForLoadState: async () => {},
    locator: () => ({
      first: () => ({
        getAttribute: async () => 'https://manager.line.biz/wrong/path',
        click: async () => { submitClicked = true; }
      })
    })
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      managerPage: mockBadRoutePage,
      devPage: {},
      logger: () => {}
    });
  }, /OA_CREATE_ROUTE_MISMATCH/);
  assert.deepEqual(visitedUrls, ['https://manager.line.biz/']);
  assert.equal(submitClicked, false);
});

// 63. Do NOT touch legalCountryCode or use nth(0)/nth(1) index-based category selection
await asyncTest('63. Category selection never touches legalCountryCode and never uses nth(0)/nth(1)', async () => {
  const code = fs.readFileSync('scripts/provision-line-assets.mjs', 'utf8');
  assert.equal(code.includes('.nth(0)'), false, 'nth(0) index selection is prohibited');
  assert.equal(code.includes('.nth(1)'), false, 'nth(1) index selection is prohibited');
  assert.equal(code.includes('legalCountryCode'), false, 'legalCountryCode must not be modified or targeted');

  let queriedSelectors = [];
  const mockManagerPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: (sel) => {
      queriedSelectors.push(sel);
      return {
        first: () => ({
          getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
          fill: async () => {},
          click: async () => {},
          isVisible: async () => sel.includes('Messaging APIを利用する') ? false : true,
          evaluate: async () => true
        })
      };
    },
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('category_group')) {
        return { mainText: 'ウェブサービス', subText: 'ウェブサービス(ビジネス)' };
      }
      if (src.includes('checkValidity')) return true;
      return '';
    }
  };
  const mockDevPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => [{ name: 'POSTING MAP MIE-03', type: 'MESSAGING_API', channelId: '2026101499' }]
  };

  await createMessagingChannelViaDom({
    accountName: 'POSTING MAP MIE-03',
    managerPage: mockManagerPage,
    devPage: mockDevPage,
    logger: () => {}
  });

  assert.equal(queriedSelectors.some(s => s.includes('legalCountryCode')), false, 'Must never query legalCountryCode');
  assert.equal(queriedSelectors.includes('select'), false, 'Must not query generic select without name attribute for OA categories');
});

// 64. Exact selector select[name="category_group"] required and verified
await asyncTest('64. Main category uses exact selector select[name="category_group"] and halts if missing', async () => {
  let queriedSelectors = [];
  const mockManagerPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: (sel) => {
      queriedSelectors.push(sel);
      return {
        first: () => ({
          getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
          fill: async () => {},
          isVisible: async () => sel === 'select[name="category_group"]' ? false : true
        })
      };
    }
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      managerPage: mockManagerPage,
      devPage: {},
      logger: () => {}
    });
  }, /OA_CATEGORY_SELECT_NOT_FOUND.*category_group/);
  assert.ok(queriedSelectors.includes('select[name="category_group"]'));
});

// 65. Exact selector select[name="category"] required and verified
await asyncTest('65. Sub category uses exact selector select[name="category"] and halts if missing', async () => {
  let queriedSelectors = [];
  const mockManagerPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => {
      queriedSelectors.push(sel);
      return {
        first: () => ({
          getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
          fill: async () => {},
          isVisible: async () => sel === 'select[name="category"]' ? false : true,
          evaluate: async () => true
        })
      };
    }
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      managerPage: mockManagerPage,
      devPage: {},
      logger: () => {}
    });
  }, /OA_CATEGORY_SELECT_NOT_FOUND.*select\[name="category"\]/);
  assert.ok(queriedSelectors.includes('select[name="category"]'));
});

// 66. Current Contract Exact Label match ("ウェブサービス" / "ウェブサービス(ビジネス)") by option text, not value alone
await asyncTest('66. Current Contract Exact Labels ("ウェブサービス" / "ウェブサービス(ビジネス)") matched strictly by option text', async () => {
  assert.equal(DEFAULT_CONFIG.oaCategoryMain, 'ウェブサービス');
  assert.equal(DEFAULT_CONFIG.oaCategorySub, 'ウェブサービス(ビジネス)');
  assert.equal(OA_CATEGORY_CONTRACT.categoryMain, 'ウェブサービス');
  assert.equal(OA_CATEGORY_CONTRACT.categorySub, 'ウェブサービス(ビジネス)');

  const fakeMainSelectEl = {
    name: 'category_group',
    value: '',
    options: [
      { value: '71', text: '別のラベル' }, // Same value 71, wrong text -> must NOT be selected by value alone!
      { value: '71', text: 'ウェブサービス' }
    ],
    dispatchEvent: () => {}
  };
  const fakeSubSelectEl = {
    name: 'category',
    value: '',
    options: [
      { value: '591', text: 'ウェブサービス（ビジネス）' }, // Full-width parentheses -> must NOT match half-width contract!
      { value: '591', text: 'ウェブサービス(ビジネス)' }
    ],
    dispatchEvent: () => {}
  };

  let submitClicked = false;
  const mockManagerPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => ({
      first: () => ({
        getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
        fill: async () => {},
        click: async () => {
          if (sel.includes('button[type="submit"]')) submitClicked = true;
        },
        isVisible: async () => sel.includes('Messaging APIを利用する') ? false : true,
        evaluate: async (fn, targetText) => {
          if (sel === 'select[name="category_group"]') return fn(fakeMainSelectEl, targetText);
          if (sel === 'select[name="category"]') return fn(fakeSubSelectEl, targetText);
          return true;
        }
      })
    }),
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('category_group')) {
        return { mainText: 'ウェブサービス', subText: 'ウェブサービス(ビジネス)' };
      }
      if (src.includes('checkValidity')) return true;
      return '';
    }
  };
  const mockDevPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => [{ name: 'POSTING MAP MIE-03', type: 'MESSAGING_API', channelId: '2026101488' }]
  };

  const res = await createMessagingChannelViaDom({
    accountName: 'POSTING MAP MIE-03',
    managerPage: mockManagerPage,
    devPage: mockDevPage,
    logger: () => {}
  });
  assert.equal(res.channelId, '2026101488');
  assert.equal(submitClicked, true);
});

// 67. Label mismatch or pre-submit selectedOptions[0].text re-read mismatch halts BEFORE submit (submit = 0)
await asyncTest('67. Label mismatch or pre-submit re-read mismatch halts with HARD STOP before submit (submit = 0)', async () => {
  let submitCount = 0;

  // Case A: Option text mismatch (only full-width parentheses in UI when half-width expected)
  const fakeSubSelectFullWidthOnly = {
    name: 'category',
    value: '591',
    options: [
      { value: '591', text: 'ウェブサービス（ビジネス）' } // value=591 matches, but text is full-width! Must NOT select by value!
    ],
    dispatchEvent: () => {}
  };
  const mockPageOptionMismatch = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => ({
      first: () => ({
        getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
        fill: async () => {},
        click: async () => {
          if (sel.includes('button[type="submit"]')) submitCount++;
        },
        isVisible: async () => true,
        evaluate: async (fn, targetText) => {
          if (sel === 'select[name="category_group"]') return true;
          if (sel === 'select[name="category"]') return fn(fakeSubSelectFullWidthOnly, targetText);
          return true;
        }
      })
    })
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      categoryMain: 'ウェブサービス',
      categorySub: 'ウェブサービス(ビジネス)',
      managerPage: mockPageOptionMismatch,
      devPage: {},
      logger: () => {}
    });
  }, /OA_CATEGORY_MISMATCH/);
  assert.equal(submitCount, 0, 'Submit must NEVER be clicked on option label mismatch');

  // Case B: Pre-submit re-read mismatch on selectedOptions[0].text
  const mockPageReReadMismatch = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => ({
      first: () => ({
        getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
        fill: async () => {},
        click: async () => {
          if (sel.includes('button[type="submit"]')) submitCount++;
        },
        isVisible: async () => true,
        evaluate: async () => true
      })
    }),
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('category_group')) {
        return { mainText: 'ウェブサービス', subText: 'ウェブサービス(その他)' }; // Mismatch on re-read!
      }
      return true;
    }
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      categoryMain: 'ウェブサービス',
      categorySub: 'ウェブサービス(ビジネス)',
      managerPage: mockPageReReadMismatch,
      devPage: {},
      logger: () => {}
    });
  }, /OA_CATEGORY_REREAD_MISMATCH/);
  assert.equal(submitCount, 0, 'Submit must NEVER be clicked on category re-read mismatch');
});

// 68. Form Validity Gate: form.checkValidity() === false halts BEFORE submit (submit = 0, writeCount = 0)
await asyncTest('68. Form Validity Gate: form.checkValidity() === false halts with OA_FORM_INVALID before submit (submit = 0)', async () => {
  let submitCount = 0;
  const mockInvalidFormPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => ({
      first: () => ({
        getAttribute: async () => 'https://entry.line.biz/form/entry/unverified',
        fill: async () => {},
        click: async () => {
          if (sel.includes('button[type="submit"]')) submitCount++;
        },
        isVisible: async () => true,
        evaluate: async () => true
      })
    }),
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('category_group')) {
        return { mainText: 'ウェブサービス', subText: 'ウェブサービス(ビジネス)' };
      }
      if (src.includes('checkValidity')) {
        return false; // form.checkValidity() === false!
      }
      return '';
    }
  };

  await assert.rejects(async () => {
    await createMessagingChannelViaDom({
      accountName: 'POSTING MAP MIE-03',
      categoryMain: 'ウェブサービス',
      categorySub: 'ウェブサービス(ビジネス)',
      managerPage: mockInvalidFormPage,
      devPage: {},
      logger: () => {}
    });
  }, /OA_FORM_INVALID/);
  assert.equal(submitCount, 0, 'Submit must NEVER be clicked when form.checkValidity() is false');
});

// 69. Create Channel DIV exact selector & pre-click tagName/class/text verification
await asyncTest('69. Create Channel uses exact div.channel-card-list-create and verifies DIV/class/text before click', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.ok(state.queriedSelectors.includes('div.channel-card-list-create'));
  assert.equal(state.createCard.clickCount, 1);

  // Wrong tagName -> CREATE_CHANNEL_CARD_MISMATCH
  const { devPage: badTagPage, state: badTagState } = createCurrentUiLoginDomMock({ createCardTagName: 'SPAN' });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage: badTagPage, logger: () => {} });
  }, /CREATE_CHANNEL_CARD_MISMATCH/);
  assert.equal(badTagState.createCard.clickCount, 0);

  // Wrong textContent -> CREATE_CHANNEL_CARD_MISMATCH
  const { devPage: badTextPage, state: badTextState } = createCurrentUiLoginDomMock({ createCardText: '別のカード' });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage: badTextPage, logger: () => {} });
  }, /CREATE_CHANNEL_CARD_MISMATCH/);
  assert.equal(badTextState.createCard.clickCount, 0);
});

// 70. Old a/button selector & legacy input selectors are completely abolished in createLoginChannelViaDom
await asyncTest('70. Old a/button Create Channel selector and legacy input selectors are abolished', async () => {
  const fnSource = createLoginChannelViaDom.toString();
  assert.equal(fnSource.includes("locator('a, button')"), false, 'Old a, button locator must not be used in createLoginChannelViaDom');
  assert.equal(fnSource.includes('.channel-type-card'), false, 'Old .channel-type-card selector must not be used');
  assert.equal(fnSource.includes('input#channelName'), false, 'Old input#channelName selector must not be used');
  assert.equal(fnSource.includes('input#email'), false, 'Old input#email selector must not be used');
  assert.equal(fnSource.includes('.modal button:has-text("作成")'), false, 'Old confirmation modal assumption must be removed');
});

// 71. Fallback direct navigation to /console/channel/new is strictly prohibited
await asyncTest('71. Fallback direct navigation to /console/channel/new is prohibited when card is missing', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({ createCardVisible: false });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage, logger: () => {} });
  }, /CREATE_CHANNEL_CARD_MISMATCH/);

  assert.deepEqual(
    state.visitedUrls,
    ['https://developers.line.biz/console/provider/2005181930'],
    'Must NEVER navigate to fallback https://developers.line.biz/console/channel/new'
  );
  assert.equal(state.submitButton.clickCount, 0);
});

// 72. Modal LINE Login href exact gate (pathname, provider=2005181930, type=line-login)
await asyncTest('72. Modal LINE Login href exact gate verifies pathname, provider=2005181930, and type=line-login', async () => {
  const validUrl = verifyLoginCreateRouteUrl('/console/channel/new?provider=2005181930&type=line-login', '2005181930');
  assert.equal(validUrl, 'https://developers.line.biz/console/channel/new?provider=2005181930&type=line-login');

  await assert.rejects(async () => {
    verifyLoginCreateRouteUrl('/console/channel/new?provider=9999999999&type=line-login', '2005181930');
  }, /LINE_LOGIN_CREATE_ROUTE_MISMATCH/);

  await assert.rejects(async () => {
    verifyLoginCreateRouteUrl('/console/channel/new?provider=2005181930&type=messaging-api', '2005181930');
  }, /LINE_LOGIN_CREATE_ROUTE_MISMATCH/);

  await assert.rejects(async () => {
    verifyLoginCreateRouteUrl('/console/channel/new', '2005181930');
  }, /LINE_LOGIN_CREATE_ROUTE_MISMATCH/);
});

// 73. Existing a.channel-item[href="/console/channel/<numeric-id>"] is never matched and rejected
await asyncTest('73. Existing channel-item (/console/channel/2010941735) is rejected by route & class gates', async () => {
  await assert.rejects(async () => {
    verifyLoginCreateRouteUrl('/console/channel/2010941735', '2005181930');
  }, /LINE_LOGIN_CREATE_ROUTE_MISMATCH/);

  const { devPage, state } = createCurrentUiLoginDomMock({
    modalLoginLinkClassName: 'channel-item',
    modalLoginLinkHref: '/console/channel/2010941735'
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage, logger: () => {} });
  }, /LINE_LOGIN_CREATE_ROUTE_MISMATCH/);
  assert.equal(state.modalLoginLink.clickCount, 0, 'Must never click an existing channel-item');
  assert.equal(state.submitButton.clickCount, 0);
});

// 74. Post-navigation route gate halts before filling any field if landed URL mismatches
await asyncTest('74. Post-navigation URL gate halts before filling any field on unexpected landed URL', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({
    postClickFormUrl: 'https://developers.line.biz/console/channel/2010941735'
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage, logger: () => {} });
  }, /LINE_LOGIN_CREATE_ROUTE_MISMATCH/);
  assert.equal(state.channelNameTextarea.fillCount, 0, 'Must not fill Channel Name when post-navigation URL mismatches');
  assert.equal(state.descriptionTextarea.fillCount, 0, 'Must not fill Description when post-navigation URL mismatches');
  assert.equal(state.submitButton.clickCount, 0);
});

// 75. Channel Name uses TEXTAREA selector and verifies value re-read
await asyncTest('75. Channel Name uses TEXTAREA selector and verifies exact re-read value', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  await createLoginChannelViaDom({
    appName: 'POSTING MAP MIE-03',
    devPage,
    logger: () => {}
  });
  assert.ok(state.queriedSelectors.includes('.new-channel textarea.user-input[placeholder="チャネル名を入力してください"]'));
  assert.equal(state.channelNameTextarea.fillCount, 1);
  assert.equal(state.channelNameTextarea.value, 'POSTING MAP MIE-03');

  // If element is not TEXTAREA or re-read mismatches -> LINE_LOGIN_FIELD_MISMATCH
  const { devPage: badNamePage, state: badNameState } = createCurrentUiLoginDomMock({
    channelNameAfterFill: 'WRONG NAME'
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ appName: 'POSTING MAP MIE-03', devPage: badNamePage, logger: () => {} });
  }, /LINE_LOGIN_FIELD_MISMATCH/);
  assert.equal(badNameState.submitButton.clickCount, 0);
});

// 76. Channel Description uses TEXTAREA selector and verifies approved description re-read
await asyncTest('76. Channel Description uses TEXTAREA selector and verifies exact re-read value', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  await createLoginChannelViaDom({
    description: 'POSTING MAP MIE-03 配布員認証アプリ',
    devPage,
    logger: () => {}
  });
  assert.ok(state.queriedSelectors.includes('.new-channel textarea.user-input[placeholder="チャネル説明を入力してください"]'));
  assert.equal(state.descriptionTextarea.fillCount, 1);
  assert.equal(state.descriptionTextarea.value, 'POSTING MAP MIE-03 配布員認証アプリ');
});

// 77. Company Country ("会社・事業者の所在国・地域") selects option text "日本" and verifies selectedOptions[0].text
await asyncTest('77. Company Country ("会社・事業者の所在国・地域") selects "日本" by option text and verifies re-read', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  assert.equal(state.companyCountrySelect.value, '-1'); // Initially 未設定 (-1)
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.companyCountrySelect.value, '0');
  assert.equal(state.companyCountrySelect.selectedOptions[0].text.trim(), '日本');
  assert.ok(state.companyCountrySelect.changeCount >= 1);

  // When option "日本" is missing -> LINE_LOGIN_COMPANY_COUNTRY_MISMATCH before submit
  const { devPage: noJapanPage, state: noJapanState } = createCurrentUiLoginDomMock({
    companyCountryOptions: [{ value: '-1', text: '未設定' }, { value: '1', text: '台湾' }]
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage: noJapanPage, logger: () => {} });
  }, /LINE_LOGIN_COMPANY_COUNTRY_MISMATCH/);
  assert.equal(noJapanState.submitButton.clickCount, 0);
});

// 78. Service Region "日本" radio: NO-OP when already checked, selects when unchecked
await asyncTest('78. Service Region "日本" radio is NO-OP when checked and selects "日本" when unchecked', async () => {
  // Case A: Already checked (default in Current UI) -> NO-OP (clickCount === 0)
  const { devPage: checkedPage, state: checkedState } = createCurrentUiLoginDomMock({
    serviceRegionJapanInitialChecked: true
  });
  await createLoginChannelViaDom({ devPage: checkedPage, logger: () => {} });
  assert.equal(checkedState.serviceRegionRadios[0].checked, true);
  assert.equal(checkedState.serviceRegionRadios[0].clickCount, 0, 'Must be NO-OP when 日本 radio is already checked');
  assert.equal(checkedState.serviceRegionRadios[1].checked, false, 'Other region radios must remain unchecked');

  // Case B: Initially unchecked -> clicks only 日本 radio
  const { devPage: uncheckedPage, state: uncheckedState } = createCurrentUiLoginDomMock({
    serviceRegionJapanInitialChecked: false
  });
  await createLoginChannelViaDom({ devPage: uncheckedPage, logger: () => {} });
  assert.equal(uncheckedState.serviceRegionRadios[0].checked, true);
  assert.equal(uncheckedState.serviceRegionRadios[0].clickCount, 1);
  assert.equal(uncheckedState.serviceRegionRadios[1].clickCount, 0);
});

// 79. App Type checks "ウェブアプリ" checkbox inside .new-channel .kv-choice
await asyncTest('79. App Type checks "ウェブアプリ" checkbox inside .new-channel .kv-choice', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({ webAppInitialChecked: false });
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.webAppCheckbox.checked, true);
  assert.equal(state.webAppCheckbox.clickCount, 1);

  // When already checked -> NO-OP
  const { devPage: preCheckedPage, state: preCheckedState } = createCurrentUiLoginDomMock({ webAppInitialChecked: true });
  await createLoginChannelViaDom({ devPage: preCheckedPage, logger: () => {} });
  assert.equal(preCheckedState.webAppCheckbox.checked, true);
  assert.equal(preCheckedState.webAppCheckbox.clickCount, 0);
});

// 80. Native App ("ネイティブアプリ") checkbox is completely untouched
await asyncTest('80. Native App ("ネイティブアプリ") checkbox is never touched', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.nativeAppCheckbox.checked, false);
  assert.equal(state.nativeAppCheckbox.clickCount, 0);
  assert.equal(state.nativeAppCheckbox.changeCount, 0);
});

// 81. 2FA (input[name="force2fa"]) is completely untouched
await asyncTest('81. 2FA (input[name="force2fa"]) is completely untouched and preserves Current UI default', async () => {
  const fnSource = createLoginChannelViaDom.toString();
  assert.equal(fnSource.includes('force2fa'), false, 'createLoginChannelViaDom must not query or mutate force2fa');

  const { devPage, state } = createCurrentUiLoginDomMock();
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.force2faCheckbox.checked, true);
  assert.equal(state.force2faCheckbox.clickCount, 0);
  assert.equal(state.force2faCheckbox.changeCount, 0);
});

// 82. Email TEXTAREA non-empty rule: preserves pre-filled email, fills only when empty
await asyncTest('82. Email TEXTAREA preserves existing non-empty value and fills only when empty', async () => {
  // Case A: Pre-filled in Current UI ("postingareamap@gmail.com") -> fillCount === 0
  const { devPage: prefilledPage, state: prefilledState } = createCurrentUiLoginDomMock({
    emailInitialValue: 'postingareamap@gmail.com'
  });
  await createLoginChannelViaDom({
    email: 'postingareamap@gmail.com',
    devPage: prefilledPage,
    logger: () => {}
  });
  assert.equal(prefilledState.emailTextarea.fillCount, 0, 'Must NOT overwrite when email is already non-empty');
  assert.equal(prefilledState.emailTextarea.value, 'postingareamap@gmail.com');

  // Case B: Empty ("") -> fills approved email
  const { devPage: emptyEmailPage, state: emptyEmailState } = createCurrentUiLoginDomMock({
    emailInitialValue: ''
  });
  await createLoginChannelViaDom({
    email: 'postingareamap@gmail.com',
    devPage: emptyEmailPage,
    logger: () => {}
  });
  assert.equal(emptyEmailState.emailTextarea.fillCount, 1, 'Must fill approved email when initially empty');
  assert.equal(emptyEmailState.emailTextarea.value, 'postingareamap@gmail.com');
});

// 83. Terms checkbox exact discovery inside .kv-choice ("LINE開発者契約" & "に同意します。")
await asyncTest('83. Terms checkbox exact discovery checks agreement checkbox and verifies checked === true', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({ termsInitialChecked: false });
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.termsCheckbox.checked, true);
  assert.equal(state.termsCheckbox.clickCount, 1);
});

// 84. Optional fields (Channel Icon, Privacy Policy URL, Terms of Service URL) are completely untouched
await asyncTest('84. Optional fields (Channel Icon, Privacy Policy URL, Terms of Service URL) remain untouched', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.channelIconInput.touched, false);
  assert.equal(state.privacyPolicyTextarea.fillCount, 0);
  assert.equal(state.privacyPolicyTextarea.value, '');
  assert.equal(state.termsOfServiceTextarea.fillCount, 0);
  assert.equal(state.termsOfServiceTextarea.value, '');
  assert.equal(state.queriedSelectors.some(s => s.includes('プライバシーポリシー') || s.includes('サービス利用規約')), false);
});

// 85. Pre-submit gate succeeds without <form> tag (form.checkValidity() not used in LINE Login flow)
await asyncTest('85. Pre-submit gate succeeds without <form> tag on LINE Login creation screen', async () => {
  const fnSource = createLoginChannelViaDom.toString();
  assert.equal(fnSource.includes('checkValidity'), false, 'createLoginChannelViaDom must not rely on form.checkValidity()');

  const { devPage, state } = createCurrentUiLoginDomMock();
  const res = await createLoginChannelViaDom({ devPage, logger: () => {} });
  assert.equal(state.formTagQueriedCount, 0, 'Must not query <form> tag in LINE Login creation flow');
  assert.equal(res.channelId, '2026101301');
});

// 86. .new-channel .form-error i.las.la-times count > 0 halts before submit (submit = 0)
await asyncTest('86. Pre-submit gate halts with submit = 0 when .form-error i.las.la-times count > 0', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({
    forceLaTimesCount: 1,
    forceSubmitDisabled: false
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage, logger: () => {} });
  }, /LINE_LOGIN_PRE_SUBMIT_GATE_FAILED.*formErrorTimesCount=\[1\]/);
  assert.equal(state.submitButton.clickCount, 0, 'Submit button must NEVER be clicked when la-times > 0');
});

// 87. Submit button disabled === true halts before submit (submit = 0)
await asyncTest('87. Pre-submit gate halts with submit = 0 when submit button is disabled', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({
    forceLaTimesCount: 0,
    forceSubmitDisabled: true
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage, logger: () => {} });
  }, /LINE_LOGIN_PRE_SUBMIT_GATE_FAILED.*submitDisabled=\[true\]/);
  assert.equal(state.submitButton.clickCount, 0, 'Submit button must NEVER be clicked when disabled === true');
});

// 88. All 11 pre-submit gates + button text "作成" PASS -> submit clicked exactly once (submit = 1, writeCount = 1)
await asyncTest('88. All gates PASS clicks .new-channel .operations button.kv-button[type="submit"] exactly once', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock();
  const res = await createLoginChannelViaDom({
    providerId: '2005181930',
    providerName: 'Civic Tech Inc.',
    appName: 'POSTING MAP MIE-03',
    description: 'POSTING MAP MIE-03 配布員認証アプリ',
    email: 'postingareamap@gmail.com',
    devPage,
    logger: () => {}
  });
  assert.ok(state.queriedSelectors.includes('.new-channel .operations button.kv-button[type="submit"]'));
  assert.equal(state.submitButton.clickCount, 1);
  assert.equal(res.writeCount, 1);
  assert.equal(res.channelId, '2026101301');
});

// 89. Pre-submit stop results in writeCount = 0 (form inputs/checkboxes do not increment writeCount)
await asyncTest('89. Form filling does not count as writeCount; pre-submit halt keeps writeCount = 0', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({
    providerOptionText: 'Wrong Provider Inc.' // Triggers pre-submit gate failure after form fields are filled
  });
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        page: devPage,
        managerPage: { evaluate: async () => false },
        providerName: 'Civic Tech Inc.',
        existingChannels: [],
        logger: () => {}
      }
    );
  }, /LINE_LOGIN_PRE_SUBMIT_GATE_FAILED/);

  // Verify fields were filled in UI, yet submit was NOT clicked (0 external asset writes)
  assert.equal(state.channelNameTextarea.fillCount, 1);
  assert.equal(state.submitButton.clickCount, 0);
});

// 90. Post-submit Channel ID missing -> halts with ID_ACQUISITION_FAILED and performs ZERO retry/re-submit
await asyncTest('90. Post-submit Channel ID missing halts with ID_ACQUISITION_FAILED and never re-submits', async () => {
  const { devPage, state } = createCurrentUiLoginDomMock({
    postSubmitUrl: 'https://developers.line.biz/console/provider/2005181930', // No /channel/<id> in URL
    existingChannelDomItems: [] // And not found in DOM
  });
  await assert.rejects(async () => {
    await createLoginChannelViaDom({ devPage, logger: () => {} });
  }, /ID_ACQUISITION_FAILED/);

  assert.equal(state.submitButton.clickCount, 1, 'Submit was clicked once, and must NEVER be retried');
  assert.equal(state.createCard.clickCount, 1, 'Create Channel card must NEVER be clicked a second time');
});

console.log('\n====================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passCount} / 90 PASSED`);
console.log('====================================================\n');

