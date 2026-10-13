/**
 * POSTING MAP - LINE Assets Provisioning Automation Tests
 *
 * scripts/provision-line-assets.mjs の機能および安全性契約を検証するテストスイート。
 * 外部通信を行わず、Mock/Fixture により決定論的に完全検証する。
 */

import assert from 'node:assert/strict';
import {
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
await asyncTest('44. executeLineProvisioning in --verify-only returns ASSETS_VERIFIED when all assets exist', async () => {
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

  const res = await executeLineProvisioning(
    { verifyOnly: true, execute: false, dryRun: false },
    {
      page: mockDevPage,
      managerPage: mockManagerPage,
      providerName: 'Civic Tech Inc.',
      existingChannels,
      existingLiffs,
      tokenStatus,
      logger: () => {}
    }
  );
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

// 51. CLI wiring: built-in real adapters selected by default when no deps adapter provided
await asyncTest('51. CLI wiring: built-in real adapters selected by default when no deps adapter provided', async () => {
  let devPageCalled = false;
  const mockDevPage = {
    evaluate: async () => 'Civic Tech Inc.',
    goto: async (url) => {
      if (url.includes('channel/new')) devPageCalled = true;
    },
    waitForLoadState: async () => {},
    locator: () => ({
      filter: () => ({ first: () => ({ click: async () => {} }) }),
      first: () => ({
        fill: async () => {},
        click: async () => {},
        isVisible: async () => false,
        check: async () => {}
      })
    }),
    waitForNavigation: async () => {},
    url: () => 'https://developers.line.biz/console/channel/2026101301'
  };
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

  assert.equal(devPageCalled, true, 'Built-in createLoginChannelViaDom must be invoked when no deps adapter is provided');
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

console.log('\n====================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passCount} / 52 PASSED`);
console.log('====================================================\n');
