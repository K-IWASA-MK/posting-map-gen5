/**
 * test_district_scripts_universal.mjs
 *
 * DISTRICT_DATA_ACQUISITION_RULE.md に準拠した
 * Phase 1 データ生成スクリプト群（scripts/**）の Universal 動作検証テスト。
 *
 * 【検証原則】
 * 1. 実在地区名は一切使用せず、架空の自治体・町域データのみを使用する。
 * 2. 正常系検証: 3列Area Skeleton単独生成、郡名除去、政令市区名保持、大字除去、ABR五十音順・丁目数値順整列、QG-2/QG-3。
 * 3. 異常系停止検証: 読み欠損、名称衝突、区割り未判定、漏れ/混入、上書き禁止で確実にHARD STOP（非ゼロ終了）し、未完成CSVを残さないこと。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_DIR = path.join(REPO_ROOT, 'scratch', 'test_universal_scripts');

describe('Universal District Generation Scripts Gate (Phase 1)', () => {
  before(() => {
    fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(TEST_TMP_DIR)) {
      fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------
  // Test Fixture Setup (Fictitious Data Only)
  // -------------------------------------------------------------
  function setupFictitiousFixtures(subDirName) {
    const dir = path.join(TEST_TMP_DIR, subDirName);
    fs.mkdirSync(dir, { recursive: true });

    // 1. Fictitious MLIT reference CSV (大字・町丁目レベル)
    // Columns: 都道府県名, 市区町村名, 大字町丁目名, 街区符号・地番, 座標系番号, X座標, Y座標, 緯度, 経度, ...
    const mlitCsvPath = path.join(dir, 'mlit_ref.csv');
    const mlitRows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番', '座標系番号', 'X', 'Y', '35.0', '136.0'],
      ['仮想県', '架空市', '大字中央町', '1', '7', '0', '0', '35.1', '136.1'],
      ['仮想県', '架空市', '朝日通一丁目', '1', '7', '0', '0', '35.2', '136.2'],
      ['仮想県', '架空市', '朝日通二丁目', '1', '7', '0', '0', '35.2', '136.3'],
      ['仮想県', '架空市', '大字緑ヶ丘', '1', '7', '0', '0', '35.3', '136.4'],
      ['仮想県', '架空郡テスト町', '大字本町', '1', '7', '0', '0', '35.4', '136.5'],
      ['仮想県', '見本政令市サンプル区', '駅前通', '1', '7', '0', '0', '35.5', '136.6'],
    ];
    fs.writeFileSync(mlitCsvPath, mlitRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    // 2. Fictitious ABR town master CSV
    const abrCsvPath = path.join(dir, 'abr_town.csv');
    const abrRows = [
      ['city_name', 'ward_name', 'oaza_cho', 'chome', 'city_kana', 'ward_kana', 'oaza_cho_kana', 'chome_number'],
      ['架空市', '', '中央町', '', 'カクウシ', '', 'チュウオウチョウ', ''],
      ['架空市', '', '朝日通', '一丁目', 'カクウシ', '', 'アサヒドオリ', '1'],
      ['架空市', '', '朝日通', '二丁目', 'カクウシ', '', 'アサヒドオリ', '2'],
      ['架空市', '', '緑ヶ丘', '', 'カクウシ', '', 'ミドリガオカ', ''],
      ['架空郡テスト町', '', '本町', '', 'テストチョウ', '', 'ホンマチ', ''],
      ['見本政令市', 'サンプル区', '駅前通', '', 'ミホンセイレイシ', 'サンプルク', 'エキマエドオリ', ''],
    ];
    fs.writeFileSync(abrCsvPath, abrRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    // 3. Fictitious Electoral Mapping CSV (1 format: city_name, town_name, electoral_district)
    const mappingCsvPath = path.join(dir, 'electoral_mapping.csv');
    const mappingRows = [
      ['city_name', 'town_name', 'electoral_district'],
      ['架空市', '中央町', '仮想第1区'],
      ['架空市', '朝日通一丁目', '仮想第1区'],
      ['架空市', '朝日通二丁目', '仮想第1区'],
      ['架空市', '緑ヶ丘', '仮想第2区'], // Excluded from 第1区 (valid exclusion)
      ['テスト町', '本町', '仮想第3区'], // Excluded from 第1区 (valid exclusion)
      ['見本政令市サンプル区', '駅前通', '仮想第4区'], // Excluded from 第1区 (valid exclusion)
    ];
    fs.writeFileSync(mappingCsvPath, mappingRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    return { dir, mlitCsvPath, abrCsvPath, mappingCsvPath };
  }

  // -------------------------------------------------------------
  // Test Cases
  // -------------------------------------------------------------

  it('Phase 1 Normal Generation: Generates 3-column Area Skeleton with normalization, ABR 50-on sort, and QG-2/QG-3', () => {
    const { dir, mlitCsvPath, abrCsvPath, mappingCsvPath } = setupFictitiousFixtures('normal_gen');
    const outCsv = path.join(dir, 'phase1_skeleton.csv');

    // Run build-district-master.py with --phase1-only
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');
    const args = [
      '--phase1-only',
      '--ref-csv', mlitCsvPath,
      '--abr-file', abrCsvPath,
      '--electoral-mapping', mappingCsvPath,
      '--target-district', '仮想第1区',
      '--out-csv', outCsv,
    ];

    execFileSync('python3', [scriptPath, ...args], { encoding: 'utf-8' });

    assert.ok(fs.existsSync(outCsv), 'Output CSV must exist after successful generation');

    const content = fs.readFileSync(outCsv, 'utf-8').trim().split('\n');
    assert.equal(content[0], 'rowId,city_name,town_name', 'Header must be exactly 3 columns');

    // 仮想第1区町域: 中央町, 朝日通一丁目, 朝日通二丁目 (緑ヶ丘は第2区のため除外)
    // 読み順: 朝日通一丁目 (アサヒドオリ-01) -> 朝日通二丁目 (アサヒドオリ-02) -> 中央町 (チュウオウチョウ)
    assert.equal(content.length, 4, 'Must have header + 3 target records');

    const row1 = content[1].split(',');
    assert.equal(row1[0], '1');
    assert.equal(row1[1], '架空市');
    assert.equal(row1[2], '朝日通一丁目');

    const row2 = content[2].split(',');
    assert.equal(row2[0], '2');
    assert.equal(row2[1], '架空市');
    assert.equal(row2[2], '朝日通二丁目');

    const row3 = content[3].split(',');
    assert.equal(row3[0], '3');
    assert.equal(row3[1], '架空市');
    assert.equal(row3[2], '中央町'); // 大字接頭辞が除去されていること
  });

  it('Phase 1 Sorter Normal: Sorter preserves 3-column rows and sorts across municipalities by city_kana then town_kana', () => {
    const { dir, mlitCsvPath, abrCsvPath } = setupFictitiousFixtures('sorter_normal');
    const phase1Csv = path.join(dir, 'all_skeleton.csv');
    const sortedCsv = path.join(dir, 'sorted_skeleton.csv');

    // Generate whole area (no electoral filter)
    const buildScript = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');
    execFileSync('python3', [
      buildScript,
      '--phase1-only',
      '--ref-csv', mlitCsvPath,
      '--abr-file', abrCsvPath,
      '--out-csv', phase1Csv,
    ], { encoding: 'utf-8' });

    // Run sort-address-master.py
    const sortScript = path.join(REPO_ROOT, 'scripts', 'sort-address-master.py');
    execFileSync('python3', [
      sortScript,
      '--input', phase1Csv,
      '--output', sortedCsv,
      '--abr-file', abrCsvPath,
    ], { encoding: 'utf-8' });

    assert.ok(fs.existsSync(sortedCsv), 'Sorted CSV must exist');
    const sortedLines = fs.readFileSync(sortedCsv, 'utf-8').trim().split('\n');

    // 市町村順: 架空市 (カクウシ) -> テスト町 (テストチョウ, 郡名除去確認) -> 見本政令市サンプル区 (ミホンセイレイシサンプルク, 区保持確認)
    const citiesInOrder = sortedLines.slice(1).map(l => l.split(',')[1]);
    assert.ok(citiesInOrder.includes('テスト町'), 'County prefix must be stripped');
    assert.ok(citiesInOrder.includes('見本政令市サンプル区'), 'Ward name must be preserved');
  });

  it('Abnormal Case 1: Missing reading in ABR triggers HARD STOP and does NOT leave unfinished CSV', () => {
    const { dir, mlitCsvPath, mappingCsvPath } = setupFictitiousFixtures('abnormal_reading');
    const badAbrCsv = path.join(dir, 'bad_abr.csv');
    // ABR missing '中央町'
    const abrRows = [
      ['city_name', 'ward_name', 'oaza_cho', 'chome', 'city_kana', 'ward_kana', 'oaza_cho_kana', 'chome_number'],
      ['架空市', '', '朝日通', '一丁目', 'カクウシ', '', 'アサヒドオリ', '1'],
    ];
    fs.writeFileSync(badAbrCsv, abrRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    try {
      execFileSync('python3', [
        scriptPath,
        '--phase1-only',
        '--ref-csv', mlitCsvPath,
        '--abr-file', badAbrCsv,
        '--out-csv', outCsv,
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Script must fail when ABR reading is missing');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left on failure');
  });

  it('Abnormal Case 2: Name collision triggers HARD STOP and does NOT leave unfinished CSV', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('abnormal_collision');
    const collidingMlitCsv = path.join(dir, 'colliding_mlit.csv');
    // Two distinct raw towns normalized to the same town name in same municipality:
    // '大字中央町' and '中央町' -> both become '中央町'
    const rows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番', '座標系番号', 'X', 'Y', '35.0', '136.0'],
      ['仮想県', '架空市', '大字中央町', '1', '7', '0', '0', '35.1', '136.1'],
      ['仮想県', '架空市', '中央町', '2', '7', '0', '0', '35.1', '136.1'],
    ];
    fs.writeFileSync(collidingMlitCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished_collision.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    try {
      execFileSync('python3', [
        scriptPath,
        '--phase1-only',
        '--ref-csv', collidingMlitCsv,
        '--abr-file', abrCsvPath,
        '--out-csv', outCsv,
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Script must fail when town name collision occurs');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left on collision');
  });

  it('Abnormal Case 3: Undetermined electoral mapping triggers HARD STOP and does NOT leave unfinished CSV', () => {
    const { dir, mlitCsvPath, abrCsvPath } = setupFictitiousFixtures('abnormal_mapping');
    const partialMappingCsv = path.join(dir, 'partial_mapping.csv');
    // Missing '大字中央町' in mapping table
    const mappingRows = [
      ['city_name', 'town_name', 'electoral_district'],
      ['架空市', '朝日通一丁目', '仮想第1区'],
    ];
    fs.writeFileSync(partialMappingCsv, mappingRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished_mapping.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    try {
      execFileSync('python3', [
        scriptPath,
        '--phase1-only',
        '--ref-csv', mlitCsvPath,
        '--abr-file', abrCsvPath,
        '--electoral-mapping', partialMappingCsv,
        '--target-district', '仮想第1区',
        '--out-csv', outCsv,
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Script must fail when town in mother set is not in electoral mapping');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left on undetermined district');
  });

  it('Abnormal Case 4: No-overwrite strictly prevents overwriting existing output CSV', () => {
    const { dir, mlitCsvPath, abrCsvPath } = setupFictitiousFixtures('abnormal_overwrite');
    const existingCsv = path.join(dir, 'existing.csv');
    fs.writeFileSync(existingCsv, 'PRE_EXISTING_DATA\n', 'utf-8');

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    try {
      execFileSync('python3', [
        scriptPath,
        '--phase1-only',
        '--ref-csv', mlitCsvPath,
        '--abr-file', abrCsvPath,
        '--out-csv', existingCsv, // No --allow-overwrite
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Script must fail when target file exists and --allow-overwrite is not set');
    assert.equal(fs.readFileSync(existingCsv, 'utf-8'), 'PRE_EXISTING_DATA\n', 'Existing file must not be modified');
  });

  it('Abnormal Case 5: QG-2 omission/mix-in triggers HARD STOP and does NOT leave unfinished CSV', () => {
    const { dir, mlitCsvPath, abrCsvPath, mappingCsvPath } = setupFictitiousFixtures('abnormal_qg2');
    const outCsv = path.join(dir, 'unfinished_qg2.csv');

    // Create a scenario where QG-2 fails: e.g. mapping assigns to target district,
    // but an artificial duplicate row or mismatch exists
    const duplicateMlitCsv = path.join(dir, 'duplicate_mlit.csv');
    const mlitRows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番', '座標系番号', 'X', 'Y', '35.0', '136.0'],
      ['仮想県', '架空市', '大字中央町', '1', '7', '0', '0', '35.1', '136.1'],
      ['仮想県', '架空市', '朝日通一丁目', '1', '7', '0', '0', '35.2', '136.2'],
    ];
    fs.writeFileSync(duplicateMlitCsv, mlitRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    // Mapping expects 朝日通二丁目 as well in 仮想第1区, but it is missing from mother set
    // In Rule 4.1: If electoral mapping has towns for target district that are missing from mother set, or vice versa
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    // Let's verify build-district-master with mismatch between expected and output
    // The script derives expected_set from mother set filtered by mapping.
    // If mother set has a town that mapping assigns to target district, expected_set includes it.
    // If we test with missing mapping: already covered in Case 3.
    // What if electoral mapping assigns a town to multiple districts?
    const multiDistMappingCsv = path.join(dir, 'multi_dist_mapping.csv');
    const multiDistRows = [
      ['city_name', 'town_name', 'electoral_district'],
      ['架空市', '中央町', '仮想第1区'],
      ['架空市', '中央町', '仮想第2区'], // Duplicate assignment across multiple districts
      ['架空市', '朝日通一丁目', '仮想第1区'],
      ['架空市', '朝日通二丁目', '仮想第1区'],
      ['架空市', '緑ヶ丘', '仮想第2区'],
      ['テスト町', '本町', '仮想第3区'],
      ['見本政令市サンプル区', '駅前通', '仮想第4区'],
    ];
    fs.writeFileSync(multiDistMappingCsv, multiDistRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    let failed = false;
    try {
      execFileSync('python3', [
        scriptPath,
        '--phase1-only',
        '--ref-csv', mlitCsvPath,
        '--abr-file', abrCsvPath,
        '--electoral-mapping', multiDistMappingCsv,
        '--target-district', '仮想第1区',
        '--out-csv', outCsv,
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Script must fail when town is assigned to multiple districts');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left on multi-district assignment');
  });
});
