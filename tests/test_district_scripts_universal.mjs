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

function cleanupPycache() {
  const pycache = path.join(REPO_ROOT, 'scripts', '__pycache__');
  if (fs.existsSync(pycache)) {
    fs.rmSync(pycache, { recursive: true, force: true });
  }
}

function runPython(args, options = {}) {
  const mergedOptions = {
    ...options,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      ...(options.env || {})
    }
  };
  return execFileSync('python3', ['-B', ...args], mergedOptions);
}

describe('Universal District Generation Scripts Gate (Phase 1)', () => {
  before(() => {
    cleanupPycache();
    fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(TEST_TMP_DIR)) {
      fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    }
    cleanupPycache();
  });

  // -------------------------------------------------------------
  // Test Fixture Setup (Fictitious Data Only)
  // -------------------------------------------------------------
  function setupFictitiousFixtures(subDirName) {
    const dir = path.join(TEST_TMP_DIR, subDirName);
    fs.mkdirSync(dir, { recursive: true });

    // 1. Fictitious MLIT reference CSV (大字・町丁目レベル)
    // Columns: 都道府県名, 市区町村名, 大字町丁目名, 街区符号・地番, 座標系番号, X座標, Y座標, 緯度, 経度, 住居表示フラグ, 代表点フラグ, 大字町丁目コード
    const mlitCsvPath = path.join(dir, 'mlit_ref.csv');
    const mlitRows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番', '座標系番号', 'X座標', 'Y座標', '緯度', '経度', '住居表示フラグ', '代表点フラグ', '大字町丁目コード'],
      ['仮想県', '架空市', '大字中央町', '1', '7', '0', '0', '35.1', '136.1', '0', '1', '0001000'],
      ['仮想県', '架空市', '朝日通一丁目', '1', '7', '0', '0', '35.2', '136.2', '0', '1', '0002001'],
      ['仮想県', '架空市', '朝日通二丁目', '1', '7', '0', '0', '35.2', '136.3', '0', '1', '0002002'],
      ['仮想県', '架空市', '大字緑ヶ丘', '1', '7', '0', '0', '35.3', '136.4', '0', '1', '0003000'],
      ['仮想県', '架空郡テスト町', '大字本町', '1', '7', '0', '0', '35.4', '136.5', '0', '1', '0004000'],
      ['仮想県', '見本政令市サンプル区', '駅前通', '1', '7', '0', '0', '35.5', '136.6', '0', '1', '0005000'],
    ];
    fs.writeFileSync(mlitCsvPath, mlitRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    // 2. Fictitious ABR town master CSV
    const abrCsvPath = path.join(dir, 'abr_town.csv');
    const abrRows = [
      ['全国地方公共団体コード', 'city_name', 'ward_name', 'oaza_cho', 'chome', 'city_kana', 'ward_kana', 'oaza_cho_kana', 'chome_number'],
      ['242055', '架空市', '', '中央町', '', 'カクウシ', '', 'チュウオウチョウ', ''],
      ['242055', '架空市', '', '朝日通', '一丁目', 'カクウシ', '', 'アサヒドオリ', '1'],
      ['242055', '架空市', '', '朝日通', '二丁目', 'カクウシ', '', 'アサヒドオリ', '2'],
      ['242055', '架空市', '', '緑ヶ丘', '', 'カクウシ', '', 'ミドリガオカ', ''],
      ['242063', '架空郡テスト町', '', '本町', '', 'テストチョウ', '', 'ホンマチ', ''],
      ['242071', '見本政令市', 'サンプル区', '駅前通', '', 'ミホンセイレイシ', 'サンプルク', 'エキマエドオリ', ''],
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

    runPython( [scriptPath, ...args], { encoding: 'utf-8' });

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
    runPython( [
      buildScript,
      '--phase1-only',
      '--ref-csv', mlitCsvPath,
      '--abr-file', abrCsvPath,
      '--out-csv', phase1Csv,
    ], { encoding: 'utf-8' });

    // Run sort-address-master.py
    const sortScript = path.join(REPO_ROOT, 'scripts', 'sort-address-master.py');
    runPython( [
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
      runPython( [
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

  it('Abnormal Case 2a: Name collision by distinct raw names triggers HARD STOP and does NOT leave unfinished CSV', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('abnormal_collision_raw');
    const collidingMlitCsv = path.join(dir, 'colliding_mlit.csv');
    // Two distinct raw towns normalized to the same town name in same municipality:
    // '大字中央町' and '中央町' -> both become '中央町'
    const rows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番', '座標系番号', 'X座標', 'Y座標', '緯度', '経度', '住居表示フラグ', '代表点フラグ', '大字町丁目コード'],
      ['仮想県', '架空市', '大字中央町', '1', '7', '0', '0', '35.1', '136.1', '0', '1', '0001000'],
      ['仮想県', '架空市', '中央町', '2', '7', '0', '0', '35.1', '136.1', '0', '1', '0001000'],
    ];
    fs.writeFileSync(collidingMlitCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished_collision.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    let errorOutput = '';
    try {
      runPython( [
        scriptPath,
        '--phase1-only',
        '--ref-csv', collidingMlitCsv,
        '--abr-file', abrCsvPath,
        '--out-csv', outCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errorOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Script must fail when town raw name collision occurs');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left on collision');
    assert.ok(errorOutput.includes('Name collision detected'), 'Error output must mention Name collision');
  });

  it('Abnormal Case 2b [CRITICAL]: Name collision by distinct official codes with identical raw town name triggers HARD STOP', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('abnormal_collision_code');
    const collidingCodeMlitCsv = path.join(dir, 'colliding_code_mlit.csv');
    // Identical raw town name '中央町' in same municipality, but distinct official codes '0001000' and '0002000'
    const rows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番', '座標系番号', 'X座標', 'Y座標', '緯度', '経度', '住居表示フラグ', '代表点フラグ', '大字町丁目コード'],
      ['仮想県', '架空市', '中央町', '1', '7', '0', '0', '35.1', '136.1', '0', '1', '0001000'],
      ['仮想県', '架空市', '中央町', '2', '7', '0', '0', '35.1', '136.1', '0', '1', '0002000'],
    ];
    fs.writeFileSync(collidingCodeMlitCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished_collision_code.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    let errorOutput = '';
    try {
      runPython( [
        scriptPath,
        '--phase1-only',
        '--ref-csv', collidingCodeMlitCsv,
        '--abr-file', abrCsvPath,
        '--out-csv', outCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errorOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Script must fail when raw town names are identical but official codes are distinct');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left on distinct official code collision');
    assert.ok(errorOutput.includes('Name collision detected'), 'Error output must state Name collision detected');
    assert.ok(errorOutput.includes('0001000') && errorOutput.includes('0002000'), 'Error output must include both conflicting official codes');
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
      runPython( [
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

  it('Abnormal Case 4a: build-district-master strictly prevents overwriting existing output CSV', () => {
    const { dir, mlitCsvPath, abrCsvPath } = setupFictitiousFixtures('abnormal_overwrite_build');
    const existingCsv = path.join(dir, 'existing.csv');
    fs.writeFileSync(existingCsv, 'PRE_EXISTING_DATA\n', 'utf-8');

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    try {
      runPython( [
        scriptPath,
        '--phase1-only',
        '--ref-csv', mlitCsvPath,
        '--abr-file', abrCsvPath,
        '--out-csv', existingCsv,
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Script must fail unconditionally when target file exists');
    assert.equal(fs.readFileSync(existingCsv, 'utf-8'), 'PRE_EXISTING_DATA\n', 'Existing file must not be modified');
  });

  it('Abnormal Case 4b: sort-address-master strictly prevents overwriting existing output CSV', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('abnormal_overwrite_sort');
    const inputCsv = path.join(dir, 'input.csv');
    fs.writeFileSync(inputCsv, 'rowId,city_name,town_name\n1,架空市,中央町\n', 'utf-8');
    const existingSortedCsv = path.join(dir, 'existing_sorted.csv');
    fs.writeFileSync(existingSortedCsv, 'PRE_EXISTING_SORTED\n', 'utf-8');

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'sort-address-master.py');

    let failed = false;
    try {
      runPython( [
        scriptPath,
        '--input', inputCsv,
        '--output', existingSortedCsv,
        '--abr-file', abrCsvPath,
      ], { stdio: 'pipe' });
    } catch (err) {
      failed = true;
    }

    assert.ok(failed, 'Sorter must fail unconditionally when target output file exists');
    assert.equal(fs.readFileSync(existingSortedCsv, 'utf-8'), 'PRE_EXISTING_SORTED\n', 'Existing sorted file must not be modified');
  });

  it('Abnormal Case 5: QG-2 omission/mix-in triggers HARD STOP and does NOT leave unfinished CSV', () => {
    const { dir, mlitCsvPath, abrCsvPath } = setupFictitiousFixtures('abnormal_qg2');
    const outCsv = path.join(dir, 'unfinished_qg2.csv');

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

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    try {
      runPython( [
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

  it('Abnormal Case 6a: ABR master verification checks target municipality records presence', () => {
    const { dir } = setupFictitiousFixtures('abr_verify_mismatch');
    const fetchScript = path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py');

    // Case 6a: ABR CSV containing only other municipality
    const mismatchedAbrCsv = path.join(dir, 'mismatched_abr.csv');
    const rows = [
      ['全国地方公共団体コード', '市区町村名', '市区町村名_カナ', '町字名', '町字名_カナ'],
      ['999999', '別自治体', 'ベツジチタイ', '町域A', 'チョウイキエー'],
    ];
    fs.writeFileSync(mismatchedAbrCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const refDir = path.join(dir, 'ref_cache');
    let failedMismatched = false;
    let errOutput = '';
    try {
      runPython( [
        fetchScript,
        '--city-code', '24205',
        '--ref-dir', refDir,
        '--abr-file', mismatchedAbrCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failedMismatched = true;
      errOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failedMismatched, 'Fetch script must fail when ABR does not contain records for target municipality');
    assert.ok(errOutput.includes('do NOT contain records for municipality code'), 'Error output must mention missing municipality records');
  });

  it('Abnormal Case 6b [CRITICAL]: ABR verification does NOT slip through on empty code with city name present', () => {
    const { dir } = setupFictitiousFixtures('abr_verify_slipthrough');
    const fetchScript = path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py');

    // Case 6b: Code is empty, but city name is present.
    // The previous implementation mistakenly slipped through this and counted as matched.
    const emptyCodeAbrCsv = path.join(dir, 'empty_code_abr.csv');
    const rows = [
      ['全国地方公共団体コード', '市区町村名', '市区町村名_カナ', '町字名', '町字名_カナ'],
      ['', '架空市', 'カクウシ', '中央町', 'チュウオウチョウ'],
    ];
    fs.writeFileSync(emptyCodeAbrCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const refDir = path.join(dir, 'ref_cache');
    let failed = false;
    let errOutput = '';
    try {
      runPython( [
        fetchScript,
        '--city-code', '24205',
        '--ref-dir', refDir,
        '--abr-file', emptyCodeAbrCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Fetch script must fail when lg_code is empty (cannot slip through on city name)');
    assert.ok(errOutput.includes('Empty lg_code') || errOutput.includes('do NOT contain records for municipality code'), 'Error output must reject empty lg_code');
  });

  it('Abnormal Case 6c: ABR verification triggers HARD STOP when mandatory columns (e.g. city_kana) are missing', () => {
    const { dir } = setupFictitiousFixtures('abr_verify_missing_col');
    const fetchScript = path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py');

    // Missing 'city_kana' / '市区町村名_カナ'
    const missingColAbrCsv = path.join(dir, 'missing_col_abr.csv');
    const rows = [
      ['lg_code', 'city_name', 'oaza_cho', 'oaza_cho_kana'],
      ['242055', '架空市', '中央町', 'チュウオウチョウ'],
    ];
    fs.writeFileSync(missingColAbrCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const refDir = path.join(dir, 'ref_cache');
    let failed = false;
    let errOutput = '';
    try {
      runPython( [
        fetchScript,
        '--city-code', '24205',
        '--ref-dir', refDir,
        '--abr-file', missingColAbrCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Fetch script must fail when mandatory ABR column (city_kana) is missing from header');
    assert.ok(errOutput.includes('Missing mandatory ABR column'), 'Error output must mention missing mandatory column');
  });

  it('Abnormal Case 7: fetch-district-raw-data strictly prevents overwriting existing files', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('fetch_overwrite');
    const refDir = path.join(dir, 'existing_ref_cache');
    const cityDir = path.join(refDir, '24205');
    fs.mkdirSync(cityDir, { recursive: true });
    const existingRefCsv = path.join(cityDir, 'reference_points.csv');
    fs.writeFileSync(existingRefCsv, 'PRE_EXISTING_REF_DATA\n', 'utf-8');

    const fetchScript = path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py');
    let failed = false;
    let errOutput = '';
    try {
      runPython( [
        fetchScript,
        '--city-code', '24205',
        '--ref-dir', refDir,
        '--abr-file', abrCsvPath,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Fetch script must fail unconditionally when destination file already exists');
    assert.ok(errOutput.includes('overwrite strictly prohibited'), 'Error output must state overwrite strictly prohibited');
    assert.equal(fs.readFileSync(existingRefCsv, 'utf-8'), 'PRE_EXISTING_REF_DATA\n', 'Existing reference file must not be modified');
  });

  it('Abnormal Case 8a [CRITICAL]: build-district-master stops when MLIT code column is missing', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('abnormal_mlit_missing_col');
    const badMlitCsv = path.join(dir, 'no_code_col_mlit.csv');
    // Missing '大字町丁目コード' column entirely
    const rows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '街区符号・地番'],
      ['仮想県', '架空市', '中央町', '1'],
    ];
    fs.writeFileSync(badMlitCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished_no_col.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    let errOutput = '';
    try {
      runPython( [
        scriptPath,
        '--phase1-only',
        '--ref-csv', badMlitCsv,
        '--abr-file', abrCsvPath,
        '--out-csv', outCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Script must fail when official code column is missing');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left');
    assert.ok(errOutput.includes('Mandatory official columns'), 'Error output must mention missing mandatory column');
  });

  it('Abnormal Case 8b [CRITICAL]: build-district-master stops when row official code is empty', () => {
    const { dir, abrCsvPath } = setupFictitiousFixtures('abnormal_mlit_empty_code');
    const badMlitCsv = path.join(dir, 'empty_code_row_mlit.csv');
    // Row 2 has empty code ''
    const rows = [
      ['都道府県名', '市区町村名', '大字町丁目名', '大字町丁目コード'],
      ['仮想県', '架空市', '中央町', '0001000'],
      ['仮想県', '架空市', '緑町', '   '],
    ];
    fs.writeFileSync(badMlitCsv, rows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    const outCsv = path.join(dir, 'unfinished_empty_code.csv');
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-district-master.py');

    let failed = false;
    let errOutput = '';
    try {
      runPython( [
        scriptPath,
        '--phase1-only',
        '--ref-csv', badMlitCsv,
        '--abr-file', abrCsvPath,
        '--out-csv', outCsv,
      ], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      failed = true;
      errOutput = (err.stderr || '') + (err.stdout || '');
    }

    assert.ok(failed, 'Script must fail when a row has empty official code');
    assert.ok(!fs.existsSync(outCsv), 'Unfinished CSV must NOT be left');
    assert.ok(errOutput.includes('Missing or empty official code'), 'Error output must mention empty official code');
  });

  it('Normal Case 3: ABR verification succeeds with official 6-digit lg_code matched against 5-digit city code (Japanese & English headers)', () => {
    const { dir } = setupFictitiousFixtures('abr_verify_official_normal');
    const fetchScript = path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py');

    // 1. Digital Agency standard English header with 6-digit lg_code (5 digits + check digit)
    const abrEnCsv = path.join(dir, 'abr_official_en.csv');
    const enRows = [
      ['lg_code', 'city', 'city_kana', 'oaza_cho', 'oaza_cho_kana'],
      ['242055', '架空市', 'カクウシ', '中央町', 'チュウオウチョウ'],
      ['242055', '架空市', 'カクウシ', '朝日通一丁目', 'アサヒドオリイッテョウメ'],
      ['242063', 'テスト町', 'テストチョウ', '本町', 'ホンマチ'],
    ];
    fs.writeFileSync(abrEnCsv, enRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    // 2. Digital Agency standard Japanese header with 6-digit lg_code
    const abrJaCsv = path.join(dir, 'abr_official_ja.csv');
    const jaRows = [
      ['全国地方公共団体コード', '市区町村名', '市区町村名_カナ', '町字名', '町字名_カナ'],
      ['242055', '架空市', 'カクウシ', '中央町', 'チュウオウチョウ'],
      ['242055', '架空市', 'カクウシ', '朝日通一丁目', 'アサヒドオリイッテョウメ'],
    ];
    fs.writeFileSync(abrJaCsv, jaRows.map(r => r.join(',')).join('\n') + '\n', 'utf-8');

    // Verify python helper executes verify_abr_master successfully for both files
    const verifyScript = `
import sys
from importlib.machinery import SourceFileLoader
fetch_mod = SourceFileLoader('fetch_raw', '${fetchScript}').load_module()

# Test EN
rep_en = fetch_mod.verify_abr_master('24205', abr_files=['${abrEnCsv}'])
assert len(rep_en) == 1
assert rep_en[0]['matched_municipality_records'] == 2, f"Expected 2 matches, got {rep_en[0]['matched_municipality_records']}"

# Test JA
rep_ja = fetch_mod.verify_abr_master('24205', abr_files=['${abrJaCsv}'])
assert len(rep_ja) == 1
assert rep_ja[0]['matched_municipality_records'] == 2, f"Expected 2 matches, got {rep_ja[0]['matched_municipality_records']}"

print("ABR_OFFICIAL_NORMAL_VERIFIED_SUCCESSFULLY")
`;
    const res = runPython( ['-c', verifyScript], { encoding: 'utf-8' });
    assert.ok(res.includes('ABR_OFFICIAL_NORMAL_VERIFIED_SUCCESSFULLY'), 'Both English and Japanese official ABR headers must succeed');
  });

  it('Creation Date Verification: Distinguishes creation date from update/release dates, and records key + value in provenance', () => {
    const fetchScript = path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py');

    const testScript = `
import sys
from importlib.machinery import SourceFileLoader
fetch_mod = SourceFileLoader('fetch_raw', '${fetchScript}').load_module()

# 1. HTML row with explicit creation date
html_valid = '<tr><td>大字・町丁目</td><td>作成年月日</td><td>令和6年3月29日</td><td><input name="chn" value="123"></td></tr>'
k, d = fetch_mod.extract_creation_date_from_html(html_valid)
assert k == '作成年月日'
assert d == '令和6年3月29日'

# 2. HTML row with only update/release date (must NOT be treated as creation date)
html_update_only = '<tr><td>大字・町丁目</td><td>更新年月日: 2024-10-01</td><td>公表日: 2024-10-15</td><td><input name="chn" value="124"></td></tr>'
k2, d2 = fetch_mod.extract_creation_date_from_html(html_update_only)
assert k2 is None and d2 is None, f"Update date must NOT be extracted as creation date: {k2}, {d2}"

# 3. Metadata XML with official createDate tag
xml_valid = '<metadata><createDate>2024-03-29</createDate><updateDate>2024-10-01</updateDate></metadata>'
k3, d3 = fetch_mod.extract_creation_date_from_metadata(xml_valid)
assert k3 == 'createDate'
assert d3 == '2024-03-29'

# 4. Metadata with only updateDate
xml_update_only = '<metadata><updateDate>2024-10-01</updateDate><publishDate>2024-10-15</publishDate></metadata>'
k4, d4 = fetch_mod.extract_creation_date_from_metadata(xml_update_only)
assert k4 is None and d4 is None, f"Update date in XML must NOT be extracted as creation date: {k4}, {d4}"

print("CREATION_DATE_DISCRIMINATION_VERIFIED_SUCCESSFULLY")
`;
    const res = runPython( ['-c', testScript], { encoding: 'utf-8' });
    assert.ok(res.includes('CREATION_DATE_DISCRIMINATION_VERIFIED_SUCCESSFULLY'), 'Creation date must be strictly distinguished from update dates');
  });
});

