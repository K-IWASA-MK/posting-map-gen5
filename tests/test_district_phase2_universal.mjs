/**
 * test_district_phase2_universal.mjs
 *
 * Phase 2 Universal 8-Column Master & Census Resolution Gate Contract Tests.
 * Adhering to Supreme Principles & MASTER Directives:
 * 1. Fictitious data only (NO real district/town names).
 * 2. Dynamic census year resolution without hardcoding (uses fictitious future years like 2095, 2090).
 * 3. 1:0, 1:1, 1:N, N:1, 0:1 cardinality gates.
 * 4. Prohibition of non-numeric zeroing (Fail-Closed).
 * 5. Deterministic interior coordinates & Point-in-Polygon validation (parent copying prohibited).
 * 6. Expected e-Stat Set demographic sum diff == 0 verification.
 * 7. Re-sort determinism (diff -u == 0).
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
const TEST_TMP_DIR = path.join(REPO_ROOT, 'scratch', 'test_phase2_universal');

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

// -------------------------------------------------------------
// Binary Fixture Builders for ESRI Shapefile & DBF
// -------------------------------------------------------------
function buildMockDbf(records, fieldDefs) {
  // fieldDefs: [{ name: 'KEY_CODE', len: 11 }, ...]
  const numRecords = records.length;
  const headerLen = 32 + fieldDefs.length * 32 + 1;
  const recordLen = 1 + fieldDefs.reduce((acc, f) => acc + f.len, 0);

  const buf = Buffer.alloc(headerLen + numRecords * recordLen);
  // Header
  buf[0] = 0x03; // DBF version
  buf[1] = 95;   // Year (fictitious)
  buf[2] = 1;    // Month
  buf[3] = 1;    // Day
  buf.writeUInt32LE(numRecords, 4);
  buf.writeUInt16LE(headerLen, 8);
  buf.writeUInt16LE(recordLen, 10);

  // Field descriptors
  let offset = 32;
  for (const f of fieldDefs) {
    buf.write(f.name, offset, 11, 'ascii');
    buf[offset + 11] = 0x43; // Character type 'C'
    buf[offset + 16] = f.len;
    offset += 32;
  }
  buf[offset] = 0x0D; // Header terminator

  // Records
  let recOffset = headerLen;
  for (const rec of records) {
    buf[recOffset] = 0x20; // Valid record marker (space)
    let fOffset = recOffset + 1;
    for (const f of fieldDefs) {
      const val = (rec[f.name] !== undefined ? String(rec[f.name]) : '');
      const valBuf = Buffer.from(val, 'utf-8');
      valBuf.copy(buf, fOffset, 0, Math.min(valBuf.length, f.len));
      // Pad with spaces
      if (valBuf.length < f.len) {
        buf.fill(0x20, fOffset + valBuf.length, fOffset + f.len);
      }
      fOffset += f.len;
    }
    recOffset += recordLen;
  }
  return buf;
}

function buildMockShp(polygons) {
  // polygons: [ { bbox: [xmin, ymin, xmax, ymax], rings: [ [[x1,y1], ...], ... ] } ]
  // Calculate total file length in 16-bit words
  let totalBytes = 100;
  for (const poly of polygons) {
    const numParts = poly.rings.length;
    const numPoints = poly.rings.reduce((acc, r) => acc + r.length, 0);
    const contentBytes = 4 + 32 + 4 + 4 + numParts * 4 + numPoints * 16;
    totalBytes += 8 + contentBytes;
  }

  const buf = Buffer.alloc(totalBytes);
  // File Header (100 bytes)
  buf.writeUInt32BE(9994, 0); // File code
  buf.writeUInt32BE(totalBytes / 2, 24); // File length in words
  buf.writeUInt32LE(1000, 28); // Version
  buf.writeUInt32LE(5, 32);    // Shape type: Polygon

  let minX = 999, minY = 999, maxX = -999, maxY = -999;
  for (const poly of polygons) {
    minX = Math.min(minX, poly.bbox[0]);
    minY = Math.min(minY, poly.bbox[1]);
    maxX = Math.max(maxX, poly.bbox[2]);
    maxY = Math.max(maxY, poly.bbox[3]);
  }
  buf.writeDoubleLE(minX, 36);
  buf.writeDoubleLE(minY, 44);
  buf.writeDoubleLE(maxX, 52);
  buf.writeDoubleLE(maxY, 60);

  // Records
  let offset = 100;
  let recNum = 1;
  for (const poly of polygons) {
    const numParts = poly.rings.length;
    const numPoints = poly.rings.reduce((acc, r) => acc + r.length, 0);
    const contentBytes = 4 + 32 + 4 + 4 + numParts * 4 + numPoints * 16;

    buf.writeUInt32BE(recNum++, offset);
    buf.writeUInt32BE(contentBytes / 2, offset + 4);
    offset += 8;

    buf.writeUInt32LE(5, offset); // Shape type: Polygon
    buf.writeDoubleLE(poly.bbox[0], offset + 4);
    buf.writeDoubleLE(poly.bbox[1], offset + 12);
    buf.writeDoubleLE(poly.bbox[2], offset + 20);
    buf.writeDoubleLE(poly.bbox[3], offset + 28);
    buf.writeUInt32LE(numParts, offset + 36);
    buf.writeUInt32LE(numPoints, offset + 40);

    let partsOffset = offset + 44;
    let ptsOffset = partsOffset + numParts * 4;
    let currentPtIdx = 0;

    for (let pIdx = 0; pIdx < numParts; pIdx++) {
      buf.writeUInt32LE(currentPtIdx, partsOffset + pIdx * 4);
      for (const pt of poly.rings[pIdx]) {
        buf.writeDoubleLE(pt[0], ptsOffset);
        buf.writeDoubleLE(pt[1], ptsOffset + 8);
        ptsOffset += 16;
        currentPtIdx++;
      }
    }
    offset += contentBytes;
  }
  return buf;
}

describe('Universal Phase 2 & Latest Census Dataset Resolution Gate Contract Tests', () => {
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
  // Test 1: Latest Census Candidate Discovery (Dynamic, No Hardcoding)
  // -------------------------------------------------------------
  it('Requirement 1 & Constraint 1: Discovers census candidate years dynamically without hardcoded year array', () => {
    const mockCatalogPath = path.join(TEST_TMP_DIR, 'mock_catalog_discovery.json');
    fs.writeFileSync(mockCatalogPath, JSON.stringify({
      datasets: [
        { census_year: 2095, status: 'published', has_small_area: true, dataset_id: 'CENSUS_2095_SA' },
        { census_year: 2090, status: 'published', has_small_area: true, dataset_id: 'CENSUS_2090_SA' }
      ]
    }));

    const mockRefDir = path.join(TEST_TMP_DIR, 'mock_ref_1');
    fs.mkdirSync(mockRefDir, { recursive: true });

    // Script must run Resolution Gate using mock catalog and find 2095 without hardcoded list
    const stdout = runPython([
      path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py'),
      '--city-code', '99001',
      '--fetch-estat',
      '--estat-only',
      '--estat-catalog-mock', mockCatalogPath
    ], { stdio: 'pipe' }).toString();

    assert.match(stdout, /Discovered candidate census years: \[2095, 2090\]/);
    assert.match(stdout, /Selected Census Year 2095/);
  });

  // -------------------------------------------------------------
  // Test 2: Fallback when Latest Year is Incomplete (Partial Missing / Small Area Not Published)
  // -------------------------------------------------------------
  it('Requirement 2 & 3: Falls back to latest complete common dataset when newer year lacks small area aggregates', () => {
    const mockCatalogPath = path.join(TEST_TMP_DIR, 'mock_catalog_fallback.json');
    fs.writeFileSync(mockCatalogPath, JSON.stringify({
      datasets: [
        { census_year: 2095, status: 'basic_aggregates_only', has_small_area: false, dataset_id: 'CENSUS_2095_BASIC' },
        { census_year: 2090, status: 'published', has_small_area: true, dataset_id: 'CENSUS_2090_SA' }
      ]
    }));

    const stdout = runPython([
      path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py'),
      '--city-code', '99001',
      '--fetch-estat',
      '--estat-only',
      '--estat-catalog-mock', mockCatalogPath
    ], { stdio: 'pipe' }).toString();

    assert.match(stdout, /Skipping year 2095: Census 2095 small area boundary \/ demographic dataset is not yet published/);
    assert.match(stdout, /Selected Census Year 2090/);
    assert.match(stdout, /Selection Status: latest_complete_common_dataset/);
  });

  // -------------------------------------------------------------
  // Test 3: Municipality Coverage Gap Triggers Fallback or HARD STOP
  // -------------------------------------------------------------
  it('Requirement 3 & 4: Rejects mixed years across municipalities; falls back or halts if coverage incomplete', () => {
    const mockCatalogPath = path.join(TEST_TMP_DIR, 'mock_catalog_mixed.json');
    // Year 2095 only covers 99001, lacks 99002; Year 2090 covers both 99001 and 99002
    fs.writeFileSync(mockCatalogPath, JSON.stringify({
      datasets: [
        {
          census_year: 2095,
          status: 'published',
          has_small_area: true,
          municipalities: {
            '99001': { attributes: ['KEY_CODE', 'S_NAME', 'JINKO', 'SETAI', 'HCODE'] }
          }
        },
        {
          census_year: 2090,
          status: 'published',
          has_small_area: true,
          municipalities: {
            '99001': { attributes: ['KEY_CODE', 'S_NAME', 'JINKO', 'SETAI', 'HCODE'] },
            '99002': { attributes: ['KEY_CODE', 'S_NAME', 'JINKO', 'SETAI', 'HCODE'] }
          }
        }
      ]
    }));

    const stdout = runPython([
      path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py'),
      '--city-code', '99001',
      '--target-cities', '99002',
      '--fetch-estat',
      '--estat-only',
      '--estat-catalog-mock', mockCatalogPath
    ], { stdio: 'pipe' }).toString();

    // 2095 skipped due to missing 99002, 2090 selected for all
    assert.match(stdout, /Skipping year 2095: Census 2095 lacks complete coverage \(missing target cities: \['99002'\]\)/);
    assert.match(stdout, /Selected Census Year 2090/);
  });

  // -------------------------------------------------------------
  // Test 4: No Valid Census Dataset Available Triggers FATAL HARD STOP
  // -------------------------------------------------------------
  it('Requirement 5: FATAL HARD STOP when no census year satisfies mandatory requirements across target municipalities', () => {
    const mockCatalogPath = path.join(TEST_TMP_DIR, 'mock_catalog_empty.json');
    fs.writeFileSync(mockCatalogPath, JSON.stringify({
      datasets: [
        { census_year: 2095, status: 'scheduled', has_small_area: false }
      ]
    }));

    assert.throws(() => {
      runPython([
        path.join(REPO_ROOT, 'scripts', 'fetch-district-raw-data.py'),
        '--city-code', '99001',
        '--fetch-estat',
        '--estat-only',
        '--estat-catalog-mock', mockCatalogPath
      ], { stdio: 'pipe' });
    }, /FATAL HARD STOP \[Resolution Gate\]: No eligible census dataset/);
  });

  // -------------------------------------------------------------
  // Test 5: Cardinality 1:0 Missing e-Stat Record Triggers HARD STOP
  // -------------------------------------------------------------
  it('Requirement 6 & Cardinality 1:0: Skeleton town without matching e-Stat record triggers FATAL HARD STOP', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_1to0');
    fs.mkdirSync(testDir, { recursive: true });

    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,存在しない町\n");

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    // Empty or non-matching estat DBF
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010010', S_NAME: '別の町', JINKO: '100', SETAI: '50', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    assert.throws(() => {
      runPython([
        path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
        '--phase1-skeleton', skelCsv,
        '--estat-dir', estatDir,
        '--out-csv', path.join(testDir, 'out.csv')
      ], { stdio: 'pipe' });
    }, /FATAL HARD STOP \[Cardinality 1:0\]: Skeleton town '架空市 存在しない町' \(rowId: 1\) has NO matching e-Stat record/);
  });

  // -------------------------------------------------------------
  // Test 6: Cardinality 1:1 Normal Join & Exact Attribute Attachment
  // -------------------------------------------------------------
  it('Requirement 7 & Cardinality 1:1: Joins 1:1 skeleton town to e-Stat record and attaches demographic data', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_1to1');
    fs.mkdirSync(testDir, { recursive: true });

    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,第一町\n");

    const skelProv = path.join(testDir, 'skel_prov.json');
    fs.writeFileSync(skelProv, JSON.stringify({
      records: [
        { city_name: '架空市', town_name: '第一町', latitude: '35.000000', longitude: '136.000000', city_code: '99001' }
      ]
    }));

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010010', S_NAME: '第一町', JINKO: '350', SETAI: '120', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    const outCsv = path.join(testDir, 'out.csv');
    const outProv = path.join(testDir, 'out_prov.json');

    runPython([
      path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
      '--phase1-skeleton', skelCsv,
      '--skeleton-provenance', skelProv,
      '--estat-dir', estatDir,
      '--out-csv', outCsv,
      '--provenance-out', outProv
    ]);

    const csvContent = fs.readFileSync(outCsv, 'utf-8').trim().split('\n');
    assert.equal(csvContent.length, 2); // Header + 1 record
    assert.equal(csvContent[0], 'rowId,city_name,town_name,latitude,longitude,households,population,e_stat_code');
    assert.equal(csvContent[1], '1,架空市,第一町,35.000000,136.000000,120,350,990010010');

    const prov = JSON.parse(fs.readFileSync(outProv, 'utf-8'));
    assert.equal(prov.total_records, 1);
    assert.equal(prov.total_population, 350);
    assert.equal(prov.total_households, 120);
  });

  // -------------------------------------------------------------
  // Test 7: Cardinality 1:N Small Area Expansion with Unique Coordinates
  // -------------------------------------------------------------
  it('Requirement 8 & 12: 1:N expansion creates multiple rows with unique interior coordinates (Point-in-Polygon)', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_1toN');
    fs.mkdirSync(testDir, { recursive: true });

    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,分割町\n");

    const skelProv = path.join(testDir, 'skel_prov.json');
    fs.writeFileSync(skelProv, JSON.stringify({
      records: [
        { city_name: '架空市', town_name: '分割町', latitude: '35.100000', longitude: '136.100000', city_code: '99001' }
      ]
    }));

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    // 2 small areas belonging to 分割町
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010021', S_NAME: '分割町', JINKO: '200', SETAI: '80', HCODE: '8101' },
      { KEY_CODE: '990010022', S_NAME: '分割町', JINKO: '300', SETAI: '110', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    // Provide two distinct non-overlapping polygon geometries for the two small areas
    // Poly 1: [136.10, 35.10] to [136.20, 35.20]
    // Poly 2: [136.30, 35.30] to [136.40, 35.40]
    const shpBuf = buildMockShp([
      {
        bbox: [136.10, 35.10, 136.20, 35.20],
        rings: [[
          [136.10, 35.10], [136.20, 35.10], [136.20, 35.20], [136.10, 35.20], [136.10, 35.10]
        ]]
      },
      {
        bbox: [136.30, 35.30, 136.40, 35.40],
        rings: [[
          [136.30, 35.30], [136.40, 35.30], [136.40, 35.40], [136.30, 35.40], [136.30, 35.30]
        ]]
      }
    ]);
    fs.writeFileSync(path.join(estatDir, 'mock.shp'), shpBuf);

    const outCsv = path.join(testDir, 'out.csv');
    const outProv = path.join(testDir, 'out_prov.json');

    runPython([
      path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
      '--phase1-skeleton', skelCsv,
      '--skeleton-provenance', skelProv,
      '--estat-dir', estatDir,
      '--out-csv', outCsv,
      '--provenance-out', outProv
    ]);

    const csvContent = fs.readFileSync(outCsv, 'utf-8').trim().split('\n');
    assert.equal(csvContent.length, 3); // Header + 2 expanded records

    const r1 = csvContent[1].split(',');
    const r2 = csvContent[2].split(',');

    assert.equal(r1[0], '1');
    assert.equal(r1[2], '分割町');
    assert.equal(r1[7], '990010021');

    assert.equal(r2[0], '2');
    assert.equal(r2[2], '分割町');
    assert.equal(r2[7], '990010022');

    // Strict validation: Coordinates must NOT be identical (parent copying strictly prohibited!)
    assert.notEqual(r1[3], r2[3], 'Latitude must be distinct for 1:N small areas');
    assert.notEqual(r1[4], r2[4], 'Longitude must be distinct for 1:N small areas');

    // Check Point-in-Polygon provenance
    const prov = JSON.parse(fs.readFileSync(outProv, 'utf-8'));
    assert.equal(prov.records[0].coordinate_validation, 'point_in_polygon: pass');
    assert.equal(prov.records[1].coordinate_validation, 'point_in_polygon: pass');
  });

  // -------------------------------------------------------------
  // Test 8: Cardinality N:1 Collision Triggers FATAL HARD STOP
  // -------------------------------------------------------------
  it('Requirement 9 & Cardinality N:1: Multiple skeletons claiming same e_stat_code triggers FATAL HARD STOP', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_Nto1');
    fs.mkdirSync(testDir, { recursive: true });

    // Two distinct skeleton towns trying to map to the same town name
    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,同一町A\n2,架空市,同一町B\n");

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    // Only one e_stat_code for '同一町A', but reconciliation maps both to this single code
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010030', S_NAME: '共通町', JINKO: '500', SETAI: '200', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    const reconPath = path.join(testDir, 'recon.json');
    fs.writeFileSync(reconPath, JSON.stringify({
      '990010030': {
        reconciled_town_name: '共通町',
        skeleton_town_name: '同一町A'
      }
    }));

    // If both map to 990010030
    assert.throws(() => {
      runPython([
        path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
        '--phase1-skeleton', skelCsv,
        '--estat-dir', estatDir,
        '--estat-reconciliation', reconPath,
        '--out-csv', path.join(testDir, 'out.csv')
      ], { stdio: 'pipe' });
    });
  });

  // -------------------------------------------------------------
  // Test 9: Cardinality 0:1 Electoral District Exclusion
  // -------------------------------------------------------------
  it('Requirement 10 & Cardinality 0:1: Excludes non-target electoral district e-Stat records cleanly', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_0to1');
    fs.mkdirSync(testDir, { recursive: true });

    // Target district only has 町A
    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,分割自治体,町A\n");

    const skelProv = path.join(testDir, 'skel_prov.json');
    fs.writeFileSync(skelProv, JSON.stringify({
      records: [
        { city_name: '分割自治体', town_name: '町A', latitude: '35.0', longitude: '136.0', city_code: '99001' }
      ]
    }));

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    // e-Stat has 町A (District 3) and 町B (District 2)
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010010', S_NAME: '町A', JINKO: '100', SETAI: '40', HCODE: '8101' },
      { KEY_CODE: '990010020', S_NAME: '町B', JINKO: '999', SETAI: '400', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    // Electoral mapping assigning 町A -> 第3区, 町B -> 第2区
    const elecMap = path.join(testDir, 'electoral_mapping.csv');
    fs.writeFileSync(elecMap, "city_name,town_name,electoral_district\n分割自治体,町A,第3区\n分割自治体,町B,第2区\n");

    const outCsv = path.join(testDir, 'out.csv');
    const outProv = path.join(testDir, 'out_prov.json');

    runPython([
      path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
      '--phase1-skeleton', skelCsv,
      '--skeleton-provenance', skelProv,
      '--estat-dir', estatDir,
      '--electoral-mapping', elecMap,
      '--target-district', '第3区',
      '--out-csv', outCsv,
      '--provenance-out', outProv
    ]);

    const csvContent = fs.readFileSync(outCsv, 'utf-8').trim().split('\n');
    assert.equal(csvContent.length, 2); // Only 町A
    assert.equal(csvContent[1].split(',')[2], '町A');

    const prov = JSON.parse(fs.readFileSync(outProv, 'utf-8'));
    assert.equal(prov.total_population, 100); // Only 町A population, 町B excluded
  });

  // -------------------------------------------------------------
  // Test 10: Non-numeric Zeroing Strictly Prohibited (Fail-Closed)
  // -------------------------------------------------------------
  it('Requirement 11: Non-numeric / suppressed population/household without reconciliation triggers FATAL HARD STOP', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_non_numeric');
    fs.mkdirSync(testDir, { recursive: true });

    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,秘匿町\n");

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    // Suppressed with '*'
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010040', S_NAME: '秘匿町', JINKO: '*', SETAI: '10', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    assert.throws(() => {
      runPython([
        path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
        '--phase1-skeleton', skelCsv,
        '--estat-dir', estatDir,
        '--out-csv', path.join(testDir, 'out.csv')
      ], { stdio: 'pipe' });
    }, /FATAL HARD STOP \[Rule 4.6\]: Non-numeric population '\*' detected for KEY_CODE/);
  });

  // -------------------------------------------------------------
  // Test 11: Expected e-Stat Set Demographic Sum Diff == 0 Verification
  // -------------------------------------------------------------
  it('Requirement 13: Verifies demographic sum diff == 0 between Expected e-Stat Set and Output', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_sum_diff');
    fs.mkdirSync(testDir, { recursive: true });

    const skelCsv = path.join(testDir, 'skeleton.csv');
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,甲町\n2,架空市,乙町\n");

    const skelProv = path.join(testDir, 'skel_prov.json');
    fs.writeFileSync(skelProv, JSON.stringify({
      records: [
        { city_name: '架空市', town_name: '甲町', latitude: '35.0', longitude: '136.0', city_code: '99001' },
        { city_name: '架空市', town_name: '乙町', latitude: '35.1', longitude: '136.1', city_code: '99001' }
      ]
    }));

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010010', S_NAME: '甲町', JINKO: '150', SETAI: '60', HCODE: '8101' },
      { KEY_CODE: '990010020', S_NAME: '乙町', JINKO: '250', SETAI: '100', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    const outCsv = path.join(testDir, 'out.csv');
    const outProv = path.join(testDir, 'out_prov.json');

    const stdout = runPython([
      path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
      '--phase1-skeleton', skelCsv,
      '--skeleton-provenance', skelProv,
      '--estat-dir', estatDir,
      '--out-csv', outCsv,
      '--provenance-out', outProv
    ]).toString();

    assert.match(stdout, /Expected Population: 400 vs Output Population: 400 \(Diff: 0\)/);
    assert.match(stdout, /Expected Households: 160 vs Output Households: 160 \(Diff: 0\)/);
  });

  // -------------------------------------------------------------
  // Test 12: Re-sort diff -u == 0 Verification
  // -------------------------------------------------------------
  it('Requirement 14: Generated 8-column CSV yields diff -u == 0 when re-sorted via sort-address-master.py', () => {
    const testDir = path.join(TEST_TMP_DIR, 'case_resort');
    fs.mkdirSync(testDir, { recursive: true });

    const skelCsv = path.join(testDir, 'skeleton.csv');
    // Notice input order: B町, A町
    fs.writeFileSync(skelCsv, "rowId,city_name,town_name\n1,架空市,B町\n2,架空市,A町\n");

    const skelProv = path.join(testDir, 'skel_prov.json');
    fs.writeFileSync(skelProv, JSON.stringify({
      records: [
        { city_name: '架空市', town_name: 'B町', latitude: '35.0', longitude: '136.0', city_code: '99001' },
        { city_name: '架空市', town_name: 'A町', latitude: '35.1', longitude: '136.1', city_code: '99001' }
      ]
    }));

    const estatDir = path.join(testDir, 'estat');
    fs.mkdirSync(estatDir, { recursive: true });
    const fields = [
      { name: 'KEY_CODE', len: 11 }, { name: 'S_NAME', len: 20 },
      { name: 'JINKO', len: 10 }, { name: 'SETAI', len: 10 }, { name: 'HCODE', len: 4 }
    ];
    const dbfBuf = buildMockDbf([
      { KEY_CODE: '990010010', S_NAME: 'B町', JINKO: '150', SETAI: '60', HCODE: '8101' },
      { KEY_CODE: '990010020', S_NAME: 'A町', JINKO: '250', SETAI: '100', HCODE: '8101' }
    ], fields);
    fs.writeFileSync(path.join(estatDir, 'mock.dbf'), dbfBuf);

    const abrCsv = path.join(testDir, 'abr.csv');
    fs.writeFileSync(abrCsv, [
      "全国地方公共団体コード,市区町村名,市区町村名_カナ,町字区分コード,町字名,町字名_カナ",
      "990010,架空市,カクウシ,1,A町,エーマチ",
      "990010,架空市,カクウシ,1,B町,ビーマチ"
    ].join('\n') + '\n');

    const outCsv = path.join(testDir, 'out.csv');
    const outProv = path.join(testDir, 'out_prov.json');

    runPython([
      path.join(REPO_ROOT, 'scripts', 'build-district-master.py'),
      '--phase1-skeleton', skelCsv,
      '--skeleton-provenance', skelProv,
      '--estat-dir', estatDir,
      '--abr-file', abrCsv,
      '--out-csv', outCsv,
      '--provenance-out', outProv
    ]);

    // Re-sort using sort-address-master.py
    const sortedCsv = path.join(testDir, 'sorted.csv');
    runPython([
      path.join(REPO_ROOT, 'scripts', 'sort-address-master.py'),
      '--input', outCsv,
      '--output', sortedCsv,
      '--abr-file', abrCsv
    ]);

    const originalContent = fs.readFileSync(outCsv, 'utf-8');
    const sortedContent = fs.readFileSync(sortedCsv, 'utf-8');

    assert.equal(sortedContent, originalContent, 'Re-sorting must produce diff -u == 0');
  });
});
