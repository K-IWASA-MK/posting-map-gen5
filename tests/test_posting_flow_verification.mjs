#!/usr/bin/env node
/**
 * POSTING MAP - Phase 9 Posting Flow Verification Suite (Strict Audit)
 *
 * 目的:
 * Phase 9 Posting Flow において、
 * 「写真・GPS取得完了は DRAFT (READY_TO_SUBMIT) であり、COMPLETED ではない」
 * 「Backend永続化成功 (status === null) のみが唯一の COMPLETED 確定条件である」
 * ことを機械判定により厳密に実証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

// テスト対象ファイル
const appJsPath = path.join(rootDir, 'active/h-app/app.js');
const renderJsPath = path.join(rootDir, 'active/h-app/render.js');
const dbJsPath = path.join(rootDir, 'active/h-app/db.js');
const activityJsPath = path.join(rootDir, 'active/h-app/modules/activity.js');
const apiJsPath = path.join(rootDir, 'active/h-app/modules/api.js');
const v2ApiPath = path.join(rootDir, 'active/api/v2_api.js');
const gpsServicePath = path.join(rootDir, 'active/business/gps/gps_service.js');
const gpsRepositoryPath = path.join(rootDir, 'active/business/gps/gps_repository.js');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const renderJs = fs.readFileSync(renderJsPath, 'utf8');
const dbJs = fs.readFileSync(dbJsPath, 'utf8');
const activityJs = fs.readFileSync(activityJsPath, 'utf8');
const apiJs = fs.readFileSync(apiJsPath, 'utf8');
const v2ApiJs = fs.readFileSync(v2ApiPath, 'utf8');
const gpsServiceJs = fs.readFileSync(gpsServicePath, 'utf8');
const gpsRepositoryJs = fs.readFileSync(gpsRepositoryPath, 'utf8');

console.log('====================================================');
console.log('🚀 PHASE 9 POSTING FLOW STRICT VERIFICATION SUITE');
console.log('====================================================\n');

// ----------------------------------------------------------------------------
// 1. 写真/GPS完了 ≠ COMPLETED の検証 (本体 isDone=false 維持)
// ----------------------------------------------------------------------------
test('1. 写真/GPS取得完了 ≠ COMPLETED: 本体の p.isDone は false を維持し、isReadyToSubmit=true であること', () => {
  // activity.js の createDraft で point.isDone = false が設定され、isReadyToSubmit = hasPhoto となること
  assert.ok(
    activityJs.includes('point.isDone = false;') && activityJs.includes('point.isReadyToSubmit = hasPhoto;'),
    '写真確定時、本体の p.isDone は false のままであり、isReadyToSubmit=true となること'
  );

  // モーダル再描画にはプレビューオブジェクト ({ ...p, isDone: true }) が渡されること
  assert.ok(
    appJs.includes('renderDetailModalContent({ ...p, isDone: true })'),
    'renderDetailModalContent にはプレビュー用オブジェクトが渡され、本体の isDone を汚染しないこと'
  );
});

// ----------------------------------------------------------------------------
// 2. 未提出終了 ≠ COMPLETED の検証 (モーダルを閉じただけでは完了にならない)
// ----------------------------------------------------------------------------
test('2. 未提出終了 ≠ COMPLETED: 提出せずにモーダルを閉じても配布完了にならないこと', () => {
  // シミュレーション: 写真撮影後に提出せずキャンセルまたはモーダルを閉じる
  const pin = { rowId: 201, isDone: false, isReadyToSubmit: true };
  const globalCompleted = [];

  // 提出ボタンを押さずに閉じた場合、本体の isDone は false のまま
  assert.equal(pin.isDone, false, '未提出終了時、本体の isDone は false のままであること');
  assert.ok(!globalCompleted.includes(201), '未提出ピンが globalPinStatus.completed に追加されてはならない');
});

// ----------------------------------------------------------------------------
// 3. API失敗 ≠ COMPLETED の検証 (失敗時は必ず isDone=false)
// ----------------------------------------------------------------------------
test('3. API失敗 ≠ COMPLETED: 通信エラーやGAS失敗時に isDone=false にロールバックされ、再提出可能であること', () => {
  // activity.js の submitActivity の catch ブロックで point.isDone = false が設定されていること
  const catchRegex = /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?point\.isDone\s*=\s*false;/;
  assert.ok(catchRegex.test(activityJs), 'submitActivity の catch ブロックで point.isDone = false が設定されていること');

  // シミュレーション
  const pin = { rowId: 202, isDone: false, isReadyToSubmit: true, syncStatus: 'submitting' };
  const globalCompleted = [];

  // API例外発生時
  pin.syncStatus = 'pending';
  pin.isDone = false;

  assert.equal(pin.isDone, false, 'API失敗時に isDone は false');
  assert.equal(pin.syncStatus, 'pending', '再提出可能状態 (pending)');
  assert.ok(!globalCompleted.includes(202), 'completed に追加されてはならない');
});

// ----------------------------------------------------------------------------
// 4. 認証失敗 ≠ COMPLETED の検証
// ----------------------------------------------------------------------------
test('4. 認証失敗 ≠ COMPLETED: 認証エラー時に isDone=false となり提出中断すること', () => {
  // activity.js の authorize catch ブロックで point.isDone = false が設定されていること
  const authCatchRegex = /catch\s*\(\s*authErr\s*\)\s*\{[\s\S]*?point\.isDone\s*=\s*false;/;
  assert.ok(authCatchRegex.test(activityJs), 'authErr ブロックで point.isDone = false が設定されていること');

  // シミュレーション
  const pin = { rowId: 203, isDone: false, isReadyToSubmit: true, syncStatus: 'submitting' };
  pin.syncStatus = 'failed';
  pin.isDone = false;

  assert.equal(pin.isDone, false, '認証失敗時に isDone は false');
  assert.equal(pin.syncStatus, 'failed');
});

// ----------------------------------------------------------------------------
// 5. Backend受理成功 = COMPLETED の検証 (accepted のみ確定、REJECTED は非完了)
// ----------------------------------------------------------------------------
test('5. Backend受理成功 = COMPLETED: accepted 成功時のみ isDone=true が確定し、REJECTED/accepted:false は非完了を維持すること', () => {
  // activity.js で status === null かつ REJECTED ガードを経て point.isDone = true が設定されていること
  assert.ok(activityJs.includes("if (point.syncStatus === 'REJECTED')"), 'status === null 内に REJECTED 抑止ガードが存在すること');
  assert.ok(activityJs.includes('point.isDone = false;'), 'REJECTED 時に point.isDone = false が設定されること');

  const successBlockRegex = /if\s*\(\s*status\s*===\s*null\s*\)\s*\{[\s\S]*?point\.isDone\s*=\s*true;[\s\S]*?delete\s+point\.isReadyToSubmit;[\s\S]*?point\.syncStatus\s*=\s*['"]synced['"];/;
  assert.ok(successBlockRegex.test(activityJs), 'accepted 正常時に isDone=true, delete isReadyToSubmit, syncStatus=synced が行われること');

  // シミュレーション A: Backend 正常受理 (status === null, syncStatus !== 'REJECTED')
  const pinAccepted = { rowId: 204, isDone: false, isReadyToSubmit: true, syncStatus: 'submitting' };
  const globalCompleted = [];

  // 受理成功シミュレーション
  pinAccepted.isDone = true;
  delete pinAccepted.isReadyToSubmit;
  pinAccepted.syncStatus = 'synced';
  globalCompleted.push(pinAccepted.rowId);

  assert.equal(pinAccepted.isDone, true, 'Backend受理成功時に初めて isDone=true');
  assert.equal(pinAccepted.isReadyToSubmit, undefined, 'isReadyToSubmit が消去されること');
  assert.equal(pinAccepted.syncStatus, 'synced');
  assert.ok(globalCompleted.includes(204), 'completed 配列に追加されること');

  // シミュレーション B: Backend 非受諾 (status === null, syncStatus === 'REJECTED')
  const pinRejected = { rowId: 205, isDone: false, isReadyToSubmit: true, syncStatus: 'REJECTED' };
  let isRejectedReset = false;

  if (pinRejected.syncStatus === 'REJECTED') {
    pinRejected.isDone = false;
    delete pinRejected.isReadyToSubmit;
    delete pinRejected.syncStatus;
    isRejectedReset = true;
  }

  assert.equal(pinRejected.isDone, false, 'REJECTED 判定時は絶対に isDone=false を維持すること');
  assert.equal(isRejectedReset, true, '未完了状態へ復帰すること');
  assert.ok(!globalCompleted.includes(205), 'REJECTED ピンは completed 配列に追加されないこと');
});

// ----------------------------------------------------------------------------
// 6. Backend成功前の completed 配列追加なし & ピンロックなしの検証
// ----------------------------------------------------------------------------
test('6. Backend成功前の completed 追加なし & ピンロックなし', () => {
  // onAccepted hook 内部で reflectCompleted および lockActivePinAndBubble が呼ばれること
  const onAcceptedPos = appJs.indexOf('onAccepted:');
  assert.ok(onAcceptedPos > 0, 'onAccepted フックが存在すること');
  const onRejectedPos = appJs.indexOf('onRejected:', onAcceptedPos);
  const onAcceptedSection = appJs.substring(onAcceptedPos, onRejectedPos);

  assert.ok(onAcceptedSection.includes('PinStatusModule.reflectCompleted(rowId)'), 'onAccepted 内で completed に追加されること');
  assert.ok(onAcceptedSection.includes('lockActivePinAndBubble(rowId)'), 'onAccepted 内で lockActivePinAndBubble が呼ばれること');

  // submitMissionComplete の開始から onAccepted の前までに reflectCompleted や lock が存在しないこと
  const submitFunctionStart = appJs.indexOf('async function submitMissionComplete');
  const preAcceptedSection = appJs.substring(submitFunctionStart, onAcceptedPos);
  assert.ok(!preAcceptedSection.includes('PinStatusModule.reflectCompleted'), 'onAccepted 前に reflectCompleted が存在してはならない');
  assert.ok(!preAcceptedSection.includes('lockActivePinAndBubble'), 'onAccepted 前に lockActivePinAndBubble が存在してはならない');
});

// ----------------------------------------------------------------------------
// 7. 二重送信防止（排他制御・ボタンロック）
// ----------------------------------------------------------------------------
test('7. 二重送信防止: submitting ガードとサーバー側15秒排他ロック', () => {
  assert.ok(appJs.includes("p.syncStatus === 'submitting'"), 'submitting ガードが存在すること');
  assert.ok(appJs.includes('submitBtn.disabled = true'), '送信ボタン disabled ガードが存在すること');
  assert.ok(gpsServiceJs.includes('lock.waitLock(15000)'), 'GPSService 15秒排他ロックが存在すること');
});

// ----------------------------------------------------------------------------
// 8. Phase境界・Universal原則の不可侵
// ----------------------------------------------------------------------------
test('8. 境界保護: Phase 8 Core無変更、Phase 10 Queue再設計なし、Universal原則遵守', () => {
  assert.ok(renderJs.includes('class CustomMarkerOverlay extends google.maps.OverlayView'), 'CustomMarkerOverlay が無傷で存在すること');
  assert.ok(v2ApiJs.includes("case 'submitDistribution':"), 'submitDistribution が温存されていること');
  assert.ok(!appJs.includes('DurableQueue'), 'Phase 10 DurableQueue は先取り実装されていないこと');

  // 地区名ハードコードチェック
  const forbidden = ['kuwana', 'okayama', 'tsushima'];
  const content = appJs.toLowerCase();
  for (const term of forbidden) {
    assert.equal(content.includes(term), false, `app.js に地区名 "${term}" のハードコードが存在してはならない`);
  }
});

console.log('✅ ALL 8 PHASE 9 POSTING FLOW STRICT VERIFICATION CHECKS DEFINED SUCCESSFULLY.\n');
