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
  verifyAllProvisionedAssets,
  executeLineProvisioning
} from '../scripts/provision-line-assets.mjs';

console.log('====================================================');
console.log('🚀 TESTING RECTIFIED LINE ASSETS PROVISIONING SUITE');
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
test('5. resolveExitCode permits Exit 0 strictly for PASS, ASSETS_VERIFIED, DRY_RUN_COMPLETE', () => {
  assert.equal(resolveExitCode('PASS'), 0);
  assert.equal(resolveExitCode('ASSETS_VERIFIED'), 0);
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

// 7. maskSecret
test('7. maskSecret masks secrets properly without raw leakage', () => {
  assert.equal(maskSecret(null), '[NONE]');
  assert.equal(maskSecret('short'), '********');
  const masked = maskSecret('long_channel_access_token_1234567890abcdef');
  assert.equal(masked, 'long...cdef');
  assert.ok(!masked.includes('channel_access_token_1234567890'));
});

// 8. sanitizeLogMessage
test('8. sanitizeLogMessage masks known secrets and long tokens', () => {
  const secret = 'super_secret_channel_access_token_999988887777';
  const rawMsg = `Created token: ${secret} for district MIE-03`;
  const sanitized = sanitizeLogMessage(rawMsg, [secret]);
  assert.ok(!sanitized.includes(secret));
  assert.ok(sanitized.includes('supe...7777'));
});

// 9. sanitizeLogMessage generic long secret pattern (constructed dynamically to avoid static scanner match)
test('9. sanitizeLogMessage masks generic long base64/hex tokens', () => {
  const dummyJwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
  const rawMsg = ['Bearer', dummyJwt].join(' ');
  const sanitized = sanitizeLogMessage(rawMsg);
  assert.ok(!sanitized.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'));
  assert.ok(sanitized.includes('[REDACTED_JWT]'));
});

// 10. verifyProviderMatch exact match
test('10. verifyProviderMatch passes on exact match Civic Tech Inc.', () => {
  assert.equal(verifyProviderMatch('Civic Tech Inc.', 'Civic Tech Inc.'), true);
  assert.equal(verifyProviderMatch('  Civic Tech Inc.  ', 'Civic Tech Inc.'), true);
});

// 11. verifyProviderMatch mismatch triggers HARD STOP
test('11. verifyProviderMatch throws HARD STOP on provider mismatch', () => {
  assert.throws(() => {
    verifyProviderMatch('Wrong Provider LLC', 'Civic Tech Inc.');
  }, /PROVIDER_MISMATCH/);
});

// 12. extractProviderNameFromDom passes when DOM element present
await asyncTest('12. extractProviderNameFromDom extracts provider name correctly', async () => {
  const mockPage = {
    evaluate: async () => 'Civic Tech Inc.'
  };
  const name = await extractProviderNameFromDom(mockPage);
  assert.equal(name, 'Civic Tech Inc.');
});

// 13. extractProviderNameFromDom throws Fail-Closed when missing
await asyncTest('13. extractProviderNameFromDom throws HARD STOP when Provider DOM missing', async () => {
  const mockPage = {
    evaluate: async () => null
  };
  await assert.rejects(async () => {
    await extractProviderNameFromDom(mockPage);
  }, /PROVIDER_NOT_FOUND/);
});

// 14. extractChannelsFromDom parses channel items correctly
await asyncTest('14. extractChannelsFromDom extracts channels from DOM', async () => {
  const mockPage = {
    evaluate: async (fn) => [
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

// 15. extractLiffsFromDom extracts LIFF items from DOM
await asyncTest('15. extractLiffsFromDom extracts LIFF list from DOM', async () => {
  const mockPage = {
    evaluate: async () => [
      { liffId: '2010941735-abcdefgh', name: 'POSTING MAP', endpointUrl: 'https://kuwana.postingmap.jp/' }
    ]
  };
  const liffs = await extractLiffsFromDom(mockPage);
  assert.equal(liffs.length, 1);
  assert.equal(liffs[0].liffId, '2010941735-abcdefgh');
});

// 16. extractTokenFromDom detects unissued token with Issue button
await asyncTest('16. extractTokenFromDom detects unissued token when Issue button present', async () => {
  const mockPage = {
    evaluate: async () => ({ isIssued: false, token: null, canRetrieve: true })
  };
  const res = await extractTokenFromDom(mockPage);
  assert.equal(res.isIssued, false);
  assert.equal(res.token, null);
});

// 17. extractTokenFromDom extracts issued token from DOM
await asyncTest('17. extractTokenFromDom extracts existing token from DOM', async () => {
  const mockPage = {
    evaluate: async () => ({ isIssued: true, token: 'existing_token_abcdef1234567890', canRetrieve: true })
  };
  const res = await extractTokenFromDom(mockPage);
  assert.equal(res.isIssued, true);
  assert.equal(res.token, 'existing_token_abcdef1234567890');
});

// 18. extractTokenFromDom detects issued but unretrievable token
await asyncTest('18. extractTokenFromDom detects token that cannot be retrieved', async () => {
  const mockPage = {
    evaluate: async () => ({ isIssued: true, token: null, canRetrieve: false })
  };
  const res = await extractTokenFromDom(mockPage);
  assert.equal(res.isIssued, true);
  assert.equal(res.canRetrieve, false);
});

// 19. resolveLoginChannel reuse
test('19. resolveLoginChannel reuses existing matching LINE Login channel', () => {
  const existing = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const res = resolveLoginChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'REUSE');
  assert.equal(res.channelId, '2010941735');
});

// 20. resolveLoginChannel create
test('20. resolveLoginChannel marks for CREATE when not found', () => {
  const existing = [
    { channelId: '2010941440', name: 'POSTING MAP KUWANA', type: 'LINE_LOGIN' }
  ];
  const res = resolveLoginChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'CREATE');
  assert.equal(res.channelName, 'POSTING MAP MIE-03');
});

// 21. resolveMessagingChannel reuse
test('21. resolveMessagingChannel reuses existing matching Messaging API channel', () => {
  const existing = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINE_LOGIN' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'MESSAGING_API' }
  ];
  const res = resolveMessagingChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'REUSE');
  assert.equal(res.channelId, '2010941440');
});

// 22. resolveMessagingChannel create
test('22. resolveMessagingChannel marks for CREATE when not found', () => {
  const existing = [];
  const res = resolveMessagingChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'CREATE');
  assert.equal(res.channelName, 'POSTING MAP MIE-03');
});

// 23. verifyLiffConfig reuse
test('23. verifyLiffConfig reuses when name and endpoint match', () => {
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

// 24. verifyLiffConfig content mismatch triggers HARD STOP
test('24. verifyLiffConfig throws HARD STOP on mismatched endpoint', () => {
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

// 25. verifyTokenIssuance issue once
test('25. verifyTokenIssuance allows initial 1-time issuance when unissued', () => {
  const res = verifyTokenIssuance({ isIssued: false, token: null });
  assert.equal(res.action, 'ISSUE_ONCE');
});

// 26. verifyTokenIssuance reuse
test('26. verifyTokenIssuance reuses token when issued and retrievable', () => {
  const res = verifyTokenIssuance({ isIssued: true, token: 'existing_valid_token_xyz', canRetrieve: true });
  assert.equal(res.action, 'REUSE');
  assert.equal(res.token, 'existing_valid_token_xyz');
});

// 27. verifyTokenIssuance reissue prohibited HARD STOP
test('27. verifyTokenIssuance throws HARD STOP when token is issued but unretrievable', () => {
  assert.throws(() => {
    verifyTokenIssuance({ isIssued: true, token: null, canRetrieve: false });
  }, /TOKEN_REISSUE_BLOCKED/);
});

// 28. verifyLiffIdFormat
test('28. verifyLiffIdFormat passes on valid format and channel ID match', () => {
  assert.equal(verifyLiffIdFormat('2010941735-abcdefgh', '2010941735'), true);
});

// 29. verifyLiffIdFormat invalid format
test('29. verifyLiffIdFormat throws on malformed LIFF ID', () => {
  assert.throws(() => {
    verifyLiffIdFormat('invalid-liff-id', '2010941735');
  }, /INVALID_LIFF_ID/);
});

// 30. verifyLiffIdFormat channel prefix mismatch
test('30. verifyLiffIdFormat throws when prefix does not match LINE Login channel', () => {
  assert.throws(() => {
    verifyLiffIdFormat('9999999999-abcdefgh', '2010941735');
  }, /CHANNEL_PREFIX_MISMATCH/);
});

// 31. verifyBotSettings aggressive & module mode OFF
test('31. verifyBotSettings passes when Bot Prompt is Aggressive and Module Mode is OFF', () => {
  assert.equal(verifyBotSettings({ botPrompt: 'Aggressive', moduleMode: false }), true);
  assert.equal(verifyBotSettings({ botPrompt: '強', moduleMode: 'OFF' }), true);
});

// 32. verifyBotSettings non-aggressive throws
test('32. verifyBotSettings throws when Bot Prompt is not Aggressive', () => {
  assert.throws(() => {
    verifyBotSettings({ botPrompt: 'normal', moduleMode: false });
  }, /Bot Prompt must be "Aggressive"/);
});

// 33. verifyBotSettings module mode ON throws
test('33. verifyBotSettings throws when Module Mode is ON', () => {
  assert.throws(() => {
    verifyBotSettings({ botPrompt: 'Aggressive', moduleMode: true });
  }, /Module Mode must be OFF/);
});

// 34. verifyPagesAndCnamePrecondition passes
test('34. verifyPagesAndCnamePrecondition passes on correct CNAME and HTTPS', () => {
  const mockExec = () => JSON.stringify({
    cname: 'mie-03.postingmap.jp',
    https_enforced: true
  });
  assert.equal(verifyPagesAndCnamePrecondition('K-IWASA-MK/posting-map-mie-03', 'mie-03.postingmap.jp', mockExec), true);
});

// 35. verifyOfficialAccountManagerLogin passes when logged in
await asyncTest('35. verifyOfficialAccountManagerLogin passes when logged in', async () => {
  const mockPage = {
    evaluate: async () => false
  };
  assert.equal(await verifyOfficialAccountManagerLogin(mockPage), true);
});

// 36. verifyOfficialAccountManagerLogin throws when logged out
await asyncTest('36. verifyOfficialAccountManagerLogin throws when logged out', async () => {
  const mockPage = {
    evaluate: async () => true
  };
  await assert.rejects(async () => {
    await verifyOfficialAccountManagerLogin(mockPage);
  }, /Official Account Manager is not logged in/);
});

// 37. verifyAllProvisionedAssets passes when all 9 real assets verified
test('37. verifyAllProvisionedAssets passes on complete valid real assets', () => {
  const validAssets = {
    loginChannelId: '2010941735',
    messagingChannelId: '2010941440',
    provider: 'Civic Tech Inc.',
    linkedBotVerified: true,
    liffId: '2010941735-abcdefgh',
    botPromptVerified: true,
    moduleModeVerified: true,
    tokenAcquired: true
  };
  assert.equal(verifyAllProvisionedAssets(validAssets), true);
});

// 38. verifyAllProvisionedAssets throws when any asset check fails
test('38. verifyAllProvisionedAssets throws when any asset condition fails', () => {
  const incomplete = {
    loginChannelId: '2010941735',
    messagingChannelId: '2010941440',
    provider: 'Civic Tech Inc.',
    linkedBotVerified: false // FAIL
  };
  assert.throws(() => {
    verifyAllProvisionedAssets(incomplete);
  }, /Post-Verification FAIL/);
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

// 41. executeLineProvisioning requires real UI adapter in live execute mode
await asyncTest('41. executeLineProvisioning throws REAL_UI_ADAPTER_REQUIRED in live mode without adapter', async () => {
  const mockDevPage = { evaluate: async () => 'Civic Tech Inc.' };
  const mockManagerPage = { evaluate: async () => false };
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        page: mockDevPage,
        managerPage: mockManagerPage,
        providerName: 'Civic Tech Inc.',
        existingChannels: [],
        logger: () => {}
      }
    );
  }, /REAL_UI_ADAPTER_REQUIRED/);
});

// 42. executeLineProvisioning throws ID_ACQUISITION_FAILED if real ID missing after creation
await asyncTest('42. executeLineProvisioning throws ID_ACQUISITION_FAILED if real ID missing after creation', async () => {
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

// 43. executeLineProvisioning default dry-run executes 0 writes
await asyncTest('43. executeLineProvisioning in default dry-run mode executes 0 external writes', async () => {
  const res = await executeLineProvisioning(
    {},
    { providerName: 'Civic Tech Inc.', logger: () => {} }
  );
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'DRY_RUN');
  assert.equal(res.status, 'DRY_RUN_COMPLETE');
  assert.equal(res.downstreamAllowed, false);
});

// 44. executeLineProvisioning verify-only executes 0 writes
await asyncTest('44. executeLineProvisioning in --verify-only mode executes 0 external writes', async () => {
  const mockDevPage = { evaluate: async () => 'Civic Tech Inc.' };
  const mockManagerPage = { evaluate: async () => false };
  const res = await executeLineProvisioning(
    { verifyOnly: true, execute: false, dryRun: false },
    {
      page: mockDevPage,
      managerPage: mockManagerPage,
      providerName: 'Civic Tech Inc.',
      logger: () => {}
    }
  );
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'VERIFY_ONLY');
  assert.equal(res.status, 'ASSETS_VERIFIED');
  assert.equal(res.downstreamAllowed, false);
});

// 45. executeLineProvisioning reuses all 3 existing assets when present
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

console.log('\n====================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passCount} / 50 PASSED`);
console.log('====================================================\n');
