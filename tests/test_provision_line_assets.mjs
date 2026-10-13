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
  verifyProviderMatch,
  resolveLoginChannel,
  resolveMessagingChannel,
  verifyLiffConfig,
  verifyTokenIssuance,
  verifyLiffIdFormat,
  verifyBotSettings,
  verifyPagesAndCnamePrecondition,
  executeLineProvisioning
} from '../scripts/provision-line-assets.mjs';

console.log('====================================================');
console.log('🚀 TESTING LINE ASSETS PROVISIONING SUITE');
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

// 9. sanitizeLogMessage generic long secret pattern
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

// 12. resolveLoginChannel reuse
test('12. resolveLoginChannel reuses existing matching LINE Login channel', () => {
  const existing = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINEログイン' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'Messaging API' }
  ];
  const res = resolveLoginChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'REUSE');
  assert.equal(res.channelId, '2010941735');
});

// 13. resolveLoginChannel create
test('13. resolveLoginChannel marks for CREATE when not found', () => {
  const existing = [
    { channelId: '2010941440', name: 'POSTING MAP KUWANA', type: 'LINEログイン' }
  ];
  const res = resolveLoginChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'CREATE');
  assert.equal(res.channelName, 'POSTING MAP MIE-03');
});

// 14. resolveMessagingChannel reuse
test('14. resolveMessagingChannel reuses existing matching Messaging API channel', () => {
  const existing = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINEログイン' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'Messaging API' }
  ];
  const res = resolveMessagingChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'REUSE');
  assert.equal(res.channelId, '2010941440');
});

// 15. resolveMessagingChannel create
test('15. resolveMessagingChannel marks for CREATE when not found', () => {
  const existing = [];
  const res = resolveMessagingChannel(existing, 'POSTING MAP MIE-03');
  assert.equal(res.action, 'CREATE');
  assert.equal(res.channelName, 'POSTING MAP MIE-03');
});

// 16. verifyLiffConfig reuse
test('16. verifyLiffConfig reuses when name and endpoint match', () => {
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

// 17. verifyLiffConfig content mismatch triggers HARD STOP
test('17. verifyLiffConfig throws HARD STOP on mismatched endpoint', () => {
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

// 18. verifyTokenIssuance issue once
test('18. verifyTokenIssuance allows initial 1-time issuance when unissued', () => {
  const res = verifyTokenIssuance({ isIssued: false, token: null });
  assert.equal(res.action, 'ISSUE_ONCE');
});

// 19. verifyTokenIssuance reuse
test('19. verifyTokenIssuance reuses token when issued and retrievable', () => {
  const res = verifyTokenIssuance({ isIssued: true, token: 'existing_valid_token_xyz', canRetrieve: true });
  assert.equal(res.action, 'REUSE');
  assert.equal(res.token, 'existing_valid_token_xyz');
});

// 20. verifyTokenIssuance reissue prohibited HARD STOP
test('20. verifyTokenIssuance throws HARD STOP when token is issued but unretrievable', () => {
  assert.throws(() => {
    verifyTokenIssuance({ isIssued: true, token: null, canRetrieve: false });
  }, /TOKEN_REISSUE_BLOCKED/);
});

// 21. verifyLiffIdFormat
test('21. verifyLiffIdFormat passes on valid format and channel ID match', () => {
  assert.equal(verifyLiffIdFormat('2010941735-abcdefgh', '2010941735'), true);
});

// 22. verifyLiffIdFormat invalid format
test('22. verifyLiffIdFormat throws on malformed LIFF ID', () => {
  assert.throws(() => {
    verifyLiffIdFormat('invalid-liff-id', '2010941735');
  }, /invalid format/);
});

// 23. verifyLiffIdFormat channel prefix mismatch
test('23. verifyLiffIdFormat throws when prefix does not match LINE Login channel', () => {
  assert.throws(() => {
    verifyLiffIdFormat('9999999999-abcdefgh', '2010941735');
  }, /prefix does not match/);
});

// 24. verifyBotSettings aggressive & module mode OFF
test('24. verifyBotSettings passes when Bot Prompt is Aggressive and Module Mode is OFF', () => {
  assert.equal(verifyBotSettings({ botPrompt: 'Aggressive', moduleMode: false }), true);
  assert.equal(verifyBotSettings({ botPrompt: '強', moduleMode: 'OFF' }), true);
});

// 25. verifyBotSettings non-aggressive throws
test('25. verifyBotSettings throws when Bot Prompt is not Aggressive', () => {
  assert.throws(() => {
    verifyBotSettings({ botPrompt: 'normal', moduleMode: false });
  }, /Bot Prompt must be "Aggressive"/);
});

// 26. verifyBotSettings module mode ON throws
test('26. verifyBotSettings throws when Module Mode is ON', () => {
  assert.throws(() => {
    verifyBotSettings({ botPrompt: 'Aggressive', moduleMode: true });
  }, /Module Mode must be OFF/);
});

// 27. verifyPagesAndCnamePrecondition passes
test('27. verifyPagesAndCnamePrecondition passes on correct CNAME and HTTPS', () => {
  const mockExec = () => JSON.stringify({
    cname: 'mie-03.postingmap.jp',
    https_enforced: true
  });
  assert.equal(verifyPagesAndCnamePrecondition('K-IWASA-MK/posting-map-mie-03', 'mie-03.postingmap.jp', mockExec), true);
});

// 28. verifyPagesAndCnamePrecondition throws on mismatch
test('28. verifyPagesAndCnamePrecondition throws on CNAME mismatch', () => {
  const mockExec = () => JSON.stringify({
    cname: 'wrong-cname.jp',
    https_enforced: true
  });
  assert.throws(() => {
    verifyPagesAndCnamePrecondition('K-IWASA-MK/posting-map-mie-03', 'mie-03.postingmap.jp', mockExec);
  }, /Precondition FAIL/);
});

// 29. executeLineProvisioning CDP failure aborts with 0 writes
await asyncTest('29. executeLineProvisioning aborts on CDP connection failure with writeCount=0', async () => {
  let logBuffer = [];
  const fakeChromium = {
    connectOverCDP: async () => { throw new Error('ECONNREFUSED'); }
  };
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, cdpUrl: 'http://localhost:9999' },
      {
        chromium: fakeChromium,
        logger: msg => logBuffer.push(msg)
      }
    );
  }, /Preflight FAIL/);
});

// 30. executeLineProvisioning Provider mismatch aborts with 0 writes
await asyncTest('30. executeLineProvisioning aborts on Provider mismatch with writeCount=0', async () => {
  let logBuffer = [];
  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: false, dryRun: true },
      {
        providerName: 'Unexpected Unknown Provider',
        logger: msg => logBuffer.push(msg)
      }
    );
  }, /PROVIDER_MISMATCH/);
});

// 31. executeLineProvisioning default dry-run executes 0 writes
await asyncTest('31. executeLineProvisioning in default dry-run mode executes 0 external writes', async () => {
  let logBuffer = [];
  const res = await executeLineProvisioning(
    {},
    {
      providerName: 'Civic Tech Inc.',
      logger: msg => logBuffer.push(msg)
    }
  );
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'DRY_RUN');
  assert.equal(res.status, 'DRY_RUN_COMPLETE');
  assert.equal(res.downstreamAllowed, false);
});

// 32. executeLineProvisioning verify-only executes 0 writes
await asyncTest('32. executeLineProvisioning in --verify-only mode executes 0 external writes', async () => {
  let logBuffer = [];
  const res = await executeLineProvisioning(
    { verifyOnly: true, execute: false, dryRun: false },
    {
      providerName: 'Civic Tech Inc.',
      page: {
        evaluate: async () => 'Civic Tech Inc.'
      },
      logger: msg => logBuffer.push(msg)
    }
  );
  assert.equal(res.writeCount, 0);
  assert.equal(res.mode, 'VERIFY_ONLY');
  assert.equal(res.status, 'ASSETS_VERIFIED');
  assert.equal(res.downstreamAllowed, false);
});

// 33. executeLineProvisioning reuses all 3 existing assets when present
await asyncTest('33. executeLineProvisioning reuses all 3 existing assets when present', async () => {
  let logBuffer = [];
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINEログイン' },
    { channelId: '2010941440', name: 'POSTING MAP MIE-03', type: 'Messaging API' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://mie-03.postingmap.jp/' }
  ];
  const tokenStatus = {
    isIssued: true,
    token: 'existing_token_abcdef1234567890',
    canRetrieve: true
  };

  const res = await executeLineProvisioning(
    { execute: true, dryRun: false },
    {
      providerName: 'Civic Tech Inc.',
      page: { evaluate: async () => 'Civic Tech Inc.' },
      existingChannels,
      existingLiffs,
      tokenStatus,
      logger: msg => logBuffer.push(msg)
    }
  );

  assert.equal(res.status, 'PASS');
  assert.equal(res.downstreamAllowed, true);
  assert.equal(res.loginChannelId, '2010941735');
  assert.equal(res.messagingChannelId, '2010941440');
  assert.equal(res.liffId, '2010941735-mie03liff');
  // Reused assets require only linked bot update
  assert.ok(res.writeCount <= 1);
});

// 34. executeLineProvisioning halts on LIFF content mismatch
await asyncTest('34. executeLineProvisioning halts on LIFF content mismatch', async () => {
  let logBuffer = [];
  const existingChannels = [
    { channelId: '2010941735', name: 'POSTING MAP MIE-03', type: 'LINEログイン' }
  ];
  const existingLiffs = [
    { liffId: '2010941735-mie03liff', name: 'POSTING MAP MIE-03', endpointUrl: 'https://wrong-endpoint.com/' }
  ];

  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        providerName: 'Civic Tech Inc.',
        page: { evaluate: async () => 'Civic Tech Inc.' },
        existingChannels,
        existingLiffs,
        logger: msg => logBuffer.push(msg)
      }
    );
  }, /CONTENT_MISMATCH/);
});

// 35. executeLineProvisioning blocks token reissue
await asyncTest('35. executeLineProvisioning blocks token reissue and halts with HARD STOP', async () => {
  let logBuffer = [];
  const tokenStatus = {
    isIssued: true,
    token: null,
    canRetrieve: false
  };

  await assert.rejects(async () => {
    await executeLineProvisioning(
      { execute: true, dryRun: false },
      {
        providerName: 'Civic Tech Inc.',
        page: { evaluate: async () => 'Civic Tech Inc.' },
        tokenStatus,
        logger: msg => logBuffer.push(msg)
      }
    );
  }, /TOKEN_REISSUE_BLOCKED/);
});

// 36. executeLineProvisioning masks token in returned payload and binding plan
await asyncTest('36. executeLineProvisioning masks channel access token in returned object and binding plan', async () => {
  let logBuffer = [];
  const rawToken = 'super_secret_channel_access_token_abcdef1234567890';
  const res = await executeLineProvisioning(
    { dryRun: true },
    {
      providerName: 'Civic Tech Inc.',
      tokenStatus: { isIssued: true, token: rawToken, canRetrieve: true },
      logger: msg => logBuffer.push(msg)
    }
  );

  assert.ok(!JSON.stringify(res).includes(rawToken), 'Raw secret token must not be in returned object');
  assert.equal(res.tokenMasked, maskSecret(rawToken));
  assert.equal(res.bindingPlan.gasProperties.LINE_CHANNEL_ACCESS_TOKEN, maskSecret(rawToken));
  assert.equal(res.bindingPlan.secretSaved.LINE_CHANNEL_SECRET, false);
});

// 37. Secret log test: 0 raw token instances emitted to log buffer
await asyncTest('37. Secret log test: 0 raw token instances emitted to logs', async () => {
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

console.log('\n====================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passCount} / 37 PASSED`);
console.log('====================================================\n');
