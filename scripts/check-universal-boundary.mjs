#!/usr/bin/env node
/**
 * scripts/check-universal-boundary.mjs
 *
 * Universal POSTING MAP OS — Boundary Scanner Core (A1 Final Contract)
 *
 * Responsibilities:
 * 1. Two-Axis Asset Classification:
 *    - Surface: Runtime | Tooling-Config | Governance-CurrentDocs | Verification | DistrictData | ExternalBinding
 *    - Lifecycle: CURRENT | GOVERNANCE_METADATA | HISTORICAL | OBSOLETE | UNRESOLVED
 * 2. Layer 1 — Structural Universal Contract (Rules S-01 .. S-07):
 *    - Zero real-district blacklist in scanner source.
 *    - Detects code/config/doc/test structures that embed district identity,
 *      town dictionaries, census/municipality code branches, district-suffixed
 *      env keys, concrete resource IDs, or deprecated architecture contracts.
 * 3. Layer 2 — Dynamic Token Detection (Rules D-01 .. D-03):
 *    - Schema/header-driven extraction from DistrictData (data/**) and ExternalBinding
 *      (CNAME, .clasp.json, deployment.json, git remote).
 *    - Strict separation of Tier 1 (High-Identity), Tier 2 (Context-Only),
 *      and Tier 3 (Non-Identity).
 * 4. Two-Stage Boundary Modes:
 *    - pre-build: Audits Universal Surfaces using the union of current C5 tokens
 *      plus structural rules without failing on internal C5 hybrid states.
 *    - post-build: Enforces everything in pre-build PLUS complete single-district
 *      Data & Binding Closure across DistrictData and ExternalBinding.
 * 5. Exit Code Contract (Fail-Closed):
 *    - 0: PASS (0 violations)
 *    - 1: RED (1 or more boundary violations)
 *    - 2: ERROR (Scanner execution failure, missing/corrupt input, parse error)
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class ScannerExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScannerExecutionError';
  }
}

// Generic placeholders explicitly permitted by A1 Contract
const ALLOWED_PLACEHOLDER_IDS = new Set([
  'DISTRICT-01',
  'DISTRICT-02',
  'DISTRICT_01',
  'DISTRICT_02',
  'DISTRICT_A',
  'DISTRICT_B',
  'SAMPLE-01',
  'SAMPLE-02',
  'SAMPLE-A',
  'SAMPLE-B',
  'SAMPLE-C',
  'SAMPLE-DISTRICT',
  'SAMPLE_DISTRICT',
  'TEST-01',
  'TEST-02',
  'TEST_DIST',
  'TEST_DISTRICT',
  'DUMMY_DIST',
  'MOCK_DIST',
  'NOMODE',
  'INVALIDMODE',
  'CORRUPT_DIST',
  'DISABLED_DIST',
  'UNKNOWN-99',
  '00000',
  '99999',
  'STF-00000-001',
  '9999999999-TestLiff',
  '0000000000-xxxxxxxx',
  'example.com',
  'test.example.com',
  'sub.postingmap.jp',
  'nomode.example.com',
  'invalid.example.com',
  'wrong-domain.example.com',
  'wrong-endpoint.com',
  'localhost',
  '○○市',
  '○○町',
  '○○村',
  '○○県',
  '○○区',
  'サンプル市',
  'テスト市',
  'テスト町',
  'テスト町2'
]);

const SYNTHETIC_TEST_ID_REGEX = /^(?:TEST|SAMPLE|DUMMY|MOCK|DIST|DISTRICT|REGION|CITY|AREA|VALID|INVALID|CORRUPT|DISABLED|NOMODE|UNKNOWN|OTHER|TARGET|SOURCE|NEW|OLD|ACTIVE|EXPIRED|DEFAULT|EMPTY|FAKE|WRONG|EVIL|SUB|LOCAL|DEV|STAGE|PROD|USER|STAFF|BRANCH|HOLDER|REQ|PIN|ROW|COL|SHEET|SS|FOLDER|CHANNEL|LIFF|TOKEN|KEY|ID|SENTINEL|MISMATCH|FOREIGN|UNAUTHORIZED|UNREGISTERED|MISSING|MALFORMED|A|B|C|X|Y|Z|0+|9+)(?:[-_A-Za-z0-9]*)$/i;

const SYNTHETIC_CJK_NAME_REGEX = /^(?:○○|〇〇|サンプル|テスト|ダミー|モック|架空|対象|該当|各|全|他|別|新|旧|本|当|単一|複数|構成|周辺|隣接|指定|任意|登録|未登録|自宅|事務所|倉庫|拠点|支部|本部|地区|地域|自治体|市町村|都道府県|選挙区|小選挙区|町丁目|町域|大字|字|丁目)$/;

// Tracked files classified as OBSOLETE under A1 Contract (exact 9 approved files)
const OBSOLETE_PATHS = new Set([
  ['DEPLOYMENT_REGISTRY', '.md'].join(''),
  ['docs/architecture/UNIVERSAL_PARENT_GAS_ROUTING_DESIGN', '.md'].join(''),
  ['docs/architecture/PROJECT_SCOPE', '.md'].join(''),
  ['docs/architecture/DATA_PLATFORM_GOVERNANCE', '.md'].join(''),
  ['docs/architecture/DASHBOARD_QUALITY_GATE', '.md'].join(''),
  ['docs/architecture/PROJECT_POLICY', '.md'].join(''),
  ['.agents/rules/ui-rule', '.md'].join(''),
  ['scripts/verify-gate-minus-1', '.mjs'].join(''),
  ['scripts/certify-universal-engine', '.mjs'].join('')
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
  '.shp', '.shx', '.dbf', '.prj', '.woff', '.woff2', '.ttf', '.eot'
]);

/**
 * 1. Two-Axis Classification (Surface × Lifecycle-Authority)
 */
export function classifyAsset(relPath) {
  const norm = relPath.replace(/\\/g, '/');

  // Lifecycle determination
  let lifecycle = 'CURRENT';
  if (norm === '.agents/current-scope.json') {
    lifecycle = 'GOVERNANCE_METADATA';
  } else if (
    norm.startsWith('.agents/records/') ||
    norm.startsWith('docs/architecture/decisions/') ||
    norm.startsWith('docs/research/')
  ) {
    lifecycle = 'HISTORICAL';
  } else if (
    norm.startsWith('data/raw_reference/') ||
    norm.startsWith('data/raw_estat')
  ) {
    lifecycle = 'UNRESOLVED';
  } else if (OBSOLETE_PATHS.has(norm)) {
    lifecycle = 'OBSOLETE';
  }

  // Surface determination (explicit mapping; unknown paths become UNCLASSIFIED -> Fail-Closed)
  let surface = 'UNCLASSIFIED';
  if (
    norm === 'index.html' ||
    norm.startsWith('active/') ||
    norm.startsWith('assets/')
  ) {
    surface = 'Runtime';
  } else if (
    norm.startsWith('scripts/') ||
    norm === 'package.json' ||
    norm === 'package-lock.json' ||
    norm === 'tailwind.config.js' ||
    norm === '.nojekyll' ||
    norm.startsWith('.github/') ||
    norm === '.env.example' ||
    norm === '.gitignore' ||
    norm === '.claspignore' ||
    norm === 'deployment.template.json' ||
    norm === '.clasp.json.template'
  ) {
    surface = 'Tooling-Config';
  } else if (norm.startsWith('tests/')) {
    surface = 'Verification';
  } else if (norm.startsWith('data/')) {
    surface = 'DistrictData';
  } else if (
    norm === 'CNAME' ||
    norm === '.clasp.json' ||
    norm === 'deployment.json'
  ) {
    surface = 'ExternalBinding';
  } else if (
    norm === 'AGENTS.md' ||
    norm === 'README.md' ||
    norm === ['DEPLOYMENT_REGISTRY', '.md'].join('') ||
    norm.startsWith('.agents/') ||
    norm.startsWith('docs/')
  ) {
    surface = 'Governance-CurrentDocs';
  }

  return { surface, lifecycle };
}

/**
 * CSV Parser (RFC-4180 compliant minimal parser with header resolution)
 */
function parseCsvWithHeaders(content, filePath, requiredHeaders = []) {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    throw new ScannerExecutionError(`CSV file is empty: ${filePath}`);
  }

  const parseLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0].replace(/^\uFEFF/, ''));
  for (const req of requiredHeaders) {
    if (!headers.includes(req)) {
      throw new ScannerExecutionError(
        `Missing required CSV header "${req}" in ${filePath}. Found: [${headers.join(', ')}]`
      );
    }
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const rowObj = {};
    headers.forEach((h, idx) => {
      rowObj[h] = vals[idx] !== undefined ? vals[idx] : '';
    });
    rows.push(rowObj);
  }

  return { headers, rows };
}

function isPlaceholderValue(val) {
  if (!val || typeof val !== 'string') return true;
  const trimmed = val.trim();
  if (trimmed === '') return true;
  if (ALLOWED_PLACEHOLDER_IDS.has(trimmed)) return true;
  if (/^https?:\/\/localhost(?::\d+)?\b/i.test(trimmed)) return true;
  if (/^https?:\/\/(?:[\w-]+\.)?example\.com\b/i.test(trimmed)) return true;
  if (/^https?:\/\/script\.google\.com\/macros\/s\/dummy\/exec$/i.test(trimmed)) return true;
  return false;
}

function extractMunicipalityStem(fullMuniName) {
  if (!fullMuniName || typeof fullMuniName !== 'string') return null;
  const trimmed = fullMuniName.trim();
  const stem = trimmed.replace(/(?:市|町|村)$/, '');
  if (stem && stem !== trimmed && stem.length >= 2 && !SYNTHETIC_CJK_NAME_REGEX.test(stem)) {
    return stem;
  }
  return null;
}

/**
 * 2. Dynamic Token Extraction (Schema / Header Driven)
 */
export function extractDynamicTokens(rootDir) {
  const tier1HighIdentity = new Map(); // token -> Set<sourceLabel>
  const tier2MunicipalityStems = new Map(); // stem -> Set<sourceLabel>
  const tier2TotalTowns = new Map(); // numberString -> Set<sourceLabel>
  const tier2TownNames = new Set();
  const tier2EstatCodes = new Set();

  const closureData = {
    configDistrictId: null,
    configGasUrl: null,
    configLiffId: null,
    electionDistrictId: null,
    electionDistrictName: null,
    electionMunicipalities: [],
    storageMunicipalities: [],
    masterMunicipalities: [],
    masterTotalTownsSum: 0,
    addressMasterRowCount: 0,
    addressMasterCities: new Set(),
    boundariesFeatureCount: null,
    cnameDomain: null,
    cnameSubdomain: null,
    claspJsonPresent: false,
    claspScriptId: null,
    deploymentJsonPresent: false,
    deploymentDistrictId: null,
    deploymentWebAppUrl: null,
    deploymentLiffUrl: null
  };

  const addTier1 = (token, source) => {
    if (!token || typeof token !== 'string') return;
    const t = token.trim();
    if (t.length < 2 || isPlaceholderValue(t)) return;
    if (!tier1HighIdentity.has(t)) tier1HighIdentity.set(t, new Set());
    tier1HighIdentity.get(t).add(source);
  };

  const addTier2Stem = (stem, source) => {
    if (!stem || typeof stem !== 'string') return;
    const s = stem.trim();
    if (s.length < 2 || isPlaceholderValue(s)) return;
    if (!tier2MunicipalityStems.has(s)) tier2MunicipalityStems.set(s, new Set());
    tier2MunicipalityStems.get(s).add(source);
  };

  const addTier2Count = (countVal, source) => {
    const str = String(countVal).trim();
    if (!/^\d+$/.test(str) || Number(str) <= 10) return;
    if (!tier2TotalTowns.has(str)) tier2TotalTowns.set(str, new Set());
    tier2TotalTowns.get(str).add(source);
  };

  // (A) data/config.js
  const configPath = path.join(rootDir, 'data', 'config.js');
  if (!fs.existsSync(configPath)) {
    throw new ScannerExecutionError('Required DistrictData file missing: data/config.js');
  }
  try {
    const configCode = fs.readFileSync(configPath, 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(configCode, sandbox, { timeout: 1000 });
    const cfg = sandbox.window?.PMS_CLIENT_CONFIG;
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('window.PMS_CLIENT_CONFIG is not defined as an object');
    }
    if (cfg.districtId) {
      closureData.configDistrictId = String(cfg.districtId).trim();
      addTier1(closureData.configDistrictId, 'data/config.js:districtId');
      addTier1(closureData.configDistrictId.toLowerCase(), 'data/config.js:districtId(lower)');
    }
    const gasUrl = cfg.api?.gasWebAppUrl ? String(cfg.api.gasWebAppUrl).trim() : '';
    closureData.configGasUrl = gasUrl;
    if (gasUrl && !isPlaceholderValue(gasUrl)) {
      addTier1(gasUrl, 'data/config.js:api.gasWebAppUrl');
      const depMatch = gasUrl.match(/\/macros\/s\/([A-Za-z0-9_-]{20,})\//);
      if (depMatch) {
        addTier1(depMatch[1], 'data/config.js:deploymentId');
      }
    }
    const liffId = cfg.line?.liffId ? String(cfg.line.liffId).trim() : '';
    closureData.configLiffId = liffId;
    if (liffId && !isPlaceholderValue(liffId)) {
      addTier1(liffId, 'data/config.js:line.liffId');
      const chanMatch = liffId.match(/^(\d{10})-/);
      if (chanMatch) {
        addTier1(chanMatch[1], 'data/config.js:lineChannelId');
      }
    }
  } catch (err) {
    throw new ScannerExecutionError(`Failed to parse data/config.js: ${err.message}`);
  }

  // (B) data/municipality_master.csv (Header-driven: city_name, city_code, total_towns)
  const muniPath = path.join(rootDir, 'data', 'municipality_master.csv');
  if (!fs.existsSync(muniPath)) {
    throw new ScannerExecutionError('Required DistrictData file missing: data/municipality_master.csv');
  }
  const muniCsv = parseCsvWithHeaders(
    fs.readFileSync(muniPath, 'utf8'),
    'data/municipality_master.csv',
    ['city_name', 'city_code', 'total_towns']
  );
  for (const row of muniCsv.rows) {
    const cityName = row.city_name;
    const cityCode = row.city_code;
    const totalTowns = row.total_towns;
    closureData.masterMunicipalities.push({ cityName, cityCode, totalTowns: Number(totalTowns) });
    closureData.masterTotalTownsSum += Number(totalTowns) || 0;

    addTier1(cityName, 'data/municipality_master.csv:city_name');
    addTier1(cityCode, 'data/municipality_master.csv:city_code');
    const stem = extractMunicipalityStem(cityName);
    if (stem) addTier2Stem(stem, 'data/municipality_master.csv:stem');
    addTier2Count(totalTowns, 'data/municipality_master.csv:total_towns');
  }

  // (C) data/address_master.csv (Header-driven)
  const addrPath = path.join(rootDir, 'data', 'address_master.csv');
  if (!fs.existsSync(addrPath)) {
    throw new ScannerExecutionError('Required DistrictData file missing: data/address_master.csv');
  }
  const addrCsv = parseCsvWithHeaders(
    fs.readFileSync(addrPath, 'utf8'),
    'data/address_master.csv',
    ['rowId', 'city_name', 'town_name', 'e_stat_code']
  );
  closureData.addressMasterRowCount = addrCsv.rows.length;
  addTier2Count(addrCsv.rows.length, 'data/address_master.csv:rowCount');
  addTier2Count(addrCsv.rows.length + 1, 'data/address_master.csv:lineCountWithHeader');
  for (const row of addrCsv.rows) {
    if (row.city_name) {
      closureData.addressMasterCities.add(row.city_name);
      addTier1(row.city_name, 'data/address_master.csv:city_name');
      const stem = extractMunicipalityStem(row.city_name);
      if (stem) addTier2Stem(stem, 'data/address_master.csv:stem');
    }
    if (row.town_name) tier2TownNames.add(row.town_name);
    if (row.e_stat_code) tier2EstatCodes.add(row.e_stat_code);
  }

  // (D) data/election_history.json (Identity-bearing fields only: districtId, districtName, elections[].municipalities keys)
  const electionPath = path.join(rootDir, 'data', 'election_history.json');
  if (!fs.existsSync(electionPath)) {
    throw new ScannerExecutionError('Required DistrictData file missing: data/election_history.json');
  }
  try {
    const elec = JSON.parse(fs.readFileSync(electionPath, 'utf8'));
    if (!elec || typeof elec !== 'object' || !Array.isArray(elec.elections)) {
      throw new Error('election_history.json must contain an "elections" array');
    }
    if (elec.districtId) {
      closureData.electionDistrictId = String(elec.districtId).trim();
      addTier1(closureData.electionDistrictId, 'data/election_history.json:districtId');
      addTier1(closureData.electionDistrictId.toLowerCase(), 'data/election_history.json:districtId(lower)');
    }
    if (elec.districtName) {
      closureData.electionDistrictName = String(elec.districtName).trim();
      addTier1(closureData.electionDistrictName, 'data/election_history.json:districtName');
    }
    for (const eItem of elec.elections) {
      if (eItem && eItem.municipalities && typeof eItem.municipalities === 'object' && !Array.isArray(eItem.municipalities)) {
        for (const muniKey of Object.keys(eItem.municipalities)) {
          closureData.electionMunicipalities.push(muniKey);
          addTier1(muniKey, 'data/election_history.json:elections[].municipalities');
          const stem = extractMunicipalityStem(muniKey);
          if (stem) addTier2Stem(stem, 'data/election_history.json:elections[].municipalities(stem)');
        }
      }
    }
  } catch (err) {
    throw new ScannerExecutionError(`Failed to parse data/election_history.json: ${err.message}`);
  }

  // (E) data/storage_locations.json
  const storageLocPath = path.join(rootDir, 'data', 'storage_locations.json');
  if (fs.existsSync(storageLocPath)) {
    try {
      const locs = JSON.parse(fs.readFileSync(storageLocPath, 'utf8'));
      if (Array.isArray(locs)) {
        for (const loc of locs) {
          if (typeof loc === 'string') {
            closureData.storageMunicipalities.push(loc.trim());
            addTier1(loc, 'data/storage_locations.json');
            const stem = extractMunicipalityStem(loc);
            if (stem) addTier2Stem(stem, 'data/storage_locations.json:stem');
          }
        }
      }
    } catch (err) {
      throw new ScannerExecutionError(`Failed to parse data/storage_locations.json: ${err.message}`);
    }
  }

  // (F) data/boundaries.geojson (verify valid JSON for closure check)
  const boundariesPath = path.join(rootDir, 'data', 'boundaries.geojson');
  if (!fs.existsSync(boundariesPath)) {
    throw new ScannerExecutionError('Required DistrictData file missing: data/boundaries.geojson');
  }
  try {
    const geo = JSON.parse(fs.readFileSync(boundariesPath, 'utf8'));
    if (!Array.isArray(geo.features)) {
      throw new Error('boundaries.geojson missing features array');
    }
    closureData.boundariesFeatureCount = geo.features.length;
  } catch (err) {
    throw new ScannerExecutionError(`Failed to parse data/boundaries.geojson: ${err.message}`);
  }

  // (G) CNAME
  const cnamePath = path.join(rootDir, 'CNAME');
  if (fs.existsSync(cnamePath)) {
    const domain = fs.readFileSync(cnamePath, 'utf8').trim();
    if (domain) {
      closureData.cnameDomain = domain;
      addTier1(domain, 'CNAME:domain');
      const sub = domain.split('.')[0];
      if (sub && sub !== 'www' && sub !== 'example') {
        closureData.cnameSubdomain = sub;
        if (sub.includes('-')) {
          addTier1(sub, 'CNAME:subdomain');
          addTier1(sub.toUpperCase(), 'CNAME:subdomain(UPPER)');
        } else {
          addTier2Stem(sub, 'CNAME:subdomain');
        }
      }
    }
  }

  // (H) git remote (if available)
  try {
    const remotes = execSync('git remote -v', { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (remotes) {
      const repoMatch = remotes.match(/posting-map-([A-Za-z0-9_-]+?)(?:\.git|\s|$)/);
      if (repoMatch && repoMatch[1]) {
        const slug = repoMatch[1];
        if (!/^gen\d+$/i.test(slug) && slug.toLowerCase() !== 'universal') {
          addTier1(slug, 'git-remote:slug');
          addTier1(slug.toUpperCase(), 'git-remote:slug(UPPER)');
        }
      }
    }
  } catch (_) {
    // git remote is optional in isolated test directories
  }

  // (I) .clasp.json (Optional local binding)
  const claspPath = path.join(rootDir, '.clasp.json');
  if (fs.existsSync(claspPath)) {
    try {
      const claspObj = JSON.parse(fs.readFileSync(claspPath, 'utf8'));
      closureData.claspJsonPresent = true;
      if (claspObj.scriptId && String(claspObj.scriptId).trim()) {
        closureData.claspScriptId = String(claspObj.scriptId).trim();
        addTier1(closureData.claspScriptId, '.clasp.json:scriptId');
      }
    } catch (err) {
      throw new ScannerExecutionError(`Failed to parse .clasp.json: ${err.message}`);
    }
  }

  // (J) deployment.json (Optional local binding on Boundary)
  const depPath = path.join(rootDir, 'deployment.json');
  if (fs.existsSync(depPath)) {
    try {
      const depObj = JSON.parse(fs.readFileSync(depPath, 'utf8'));
      closureData.deploymentJsonPresent = true;
      if (depObj.districtId) {
        closureData.deploymentDistrictId = String(depObj.districtId).trim();
        addTier1(closureData.deploymentDistrictId, 'deployment.json:districtId');
      }
      const res = depObj.resources || {};
      if (res.scriptId) addTier1(String(res.scriptId).trim(), 'deployment.json:scriptId');
      if (res.deploymentId) addTier1(String(res.deploymentId).trim(), 'deployment.json:deploymentId');
      if (res.webAppUrl) {
        closureData.deploymentWebAppUrl = String(res.webAppUrl).trim();
        addTier1(closureData.deploymentWebAppUrl, 'deployment.json:webAppUrl');
      }
      if (res.productionLiffUrl) {
        closureData.deploymentLiffUrl = String(res.productionLiffUrl).trim();
        addTier1(closureData.deploymentLiffUrl, 'deployment.json:productionLiffUrl');
      }
    } catch (err) {
      throw new ScannerExecutionError(`Failed to parse deployment.json: ${err.message}`);
    }
  }

  return {
    tier1HighIdentity,
    tier2MunicipalityStems,
    tier2TotalTowns,
    tier2TownNames,
    tier2EstatCodes,
    closureData
  };
}

/**
 * Helper to check if a line is in a negation/prohibition/deprecation context
 */
function isNegationOrDeprecationContext(line) {
  return /(?:廃止|撤廃|禁止|不要|不可|旧|過去|移行前|してはならない|参照[^\n]*しない|探索[^\n]*しない|読み取り[^\n]*しない|他地区を例示するための値|強制遮断|地区コードなし|ハードコードされていない|!\s*[A-Za-z0-9_$.]+\.includes\s*\(|forbiddenDistricts|MUST\s+NOT|must\s+not|not\s+merely|deprecated|obsolete|prohibited|forbidden|never)/i.test(
    line
  );
}

// Construct structural rule patterns dynamically so scanner self-scan stays 0 without path exemptions
const MAPS_KEY_PREFIX = 'GOOGLE_MAPS_API' + '_KEY_';
const MAPS_KEY_SUFFIX_REGEX = new RegExp(
  `(?:\\b(?:DUMMY_)?${MAPS_KEY_PREFIX}(?:\\$\\{[^}]+\\}|<[^>]+>|[A-Za-z0-9_-]+)|(['"\`])${MAPS_KEY_PREFIX}\\1\\s*\\+\\s*[A-Za-z0-9_$.()[\\]]+)`
);

const OBSOLETE_REF_PATTERNS = [
  { label: 'DEPLOYMENT_REGISTRY' + '.md', re: new RegExp('DEPLOYMENT_REGISTRY' + '\\.md') },
  { label: 'verify-gate-minus-1' + '.mjs', re: new RegExp('verify-gate-minus-1' + '\\.mjs') },
  { label: 'certify-universal-engine' + '.mjs', re: new RegExp('certify-universal-engine' + '\\.mjs') },
  { label: 'gate:' + 'minus-1', re: new RegExp('gate:' + 'minus-?1\\b') },
  { label: 'certify:' + 'universal', re: new RegExp('certify:' + 'universal\\b') },
  {
    label: 'UNIVERSAL_PARENT_GAS_ROUTING_DESIGN' + '.md',
    re: new RegExp('UNIVERSAL_PARENT_GAS_ROUTING_DESIGN' + '\\.md')
  }
];

const DEPRECATED_PARENT_GAS_REGEX = new RegExp(
  '(?:単一' +
    '親\\s*(?:Standalone\\s*)?GAS|親\\s*Standalone\\s*GAS\\s*1本|親GAS\\s*(?:Registry|Gateway|Script\\s*Properties)|新地区追加時に\\s*GAS\\s*プロジェクトを複製することを永久に禁止)'
);

const PERSON_FIELD_LINE_REGEX =
  /\b(?:staffName|displayName|holderName|requesterName|receiverName|userName|memberName|first|last|author|posterName)\s*:/;

/**
 * Determine if a line in a Municipality Stem check is a person-name context rather than a geographic context
 */
function isPersonNameContext(line, stem) {
  if (PERSON_FIELD_LINE_REGEX.test(line)) {
    const geoFieldWithStem = new RegExp(
      `\\b(?:district|districtId|districtCode|districtName|city|cityName|city_name|cityCode|city_code|municipality|branch|branchName|location|region|area|areaName|targetCity|defaultCity)\\s*:\\s*['"\`][^'"\`]*${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'i'
    );
    if (!geoFieldWithStem.test(line)) return true;
  }
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Person full-name literal such as "<Stem> 太郎", "<Stem> 花子", "<Stem> 二郎", "<Stem> 三郎", "<Stem> 四郎"
  if (new RegExp(`['"\`]${escaped}\\s+(?:太郎|一郎|二郎|次郎|三郎|四郎|五郎|花子|様|さん|氏)['"\`]`).test(line)) {
    return true;
  }
  return false;
}

/**
 * 3. Scan a single file across Structural Rules (S-01..S-07) and Dynamic Rules (D-01..D-02)
 */
function scanSingleFile(relPath, content, classification, dynamicTokens, stage) {
  const { surface, lifecycle } = classification;
  const findings = [];

  const pushFinding = (ruleId, lineNum, findingType, conciseReason) => {
    findings.push({
      ruleId,
      stage,
      surface,
      lifecycle,
      file: relPath,
      location: `${lineNum}:1`,
      line: lineNum,
      findingType,
      conciseReason
    });
  };

  // Check S-05 (1): Tracked OBSOLETE files
  if (lifecycle === 'OBSOLETE') {
    pushFinding(
      'S-05',
      1,
      'STRUCTURAL',
      `Tracked file is classified as OBSOLETE under A1 Contract and must be removed in Cleanup (${relPath})`
    );
  }

  // DistrictData and ExternalBinding are C5 sources, not Universal Surfaces
  if (surface === 'DistrictData' || surface === 'ExternalBinding') {
    return findings;
  }

  // HISTORICAL records/ADRs/research are permitted to retain historical district values
  if (lifecycle === 'HISTORICAL') {
    return findings;
  }

  // GOVERNANCE_METADATA (.agents/current-scope.json)
  if (lifecycle === 'GOVERNANCE_METADATA') {
    return findings;
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const isCodeFile = /\.(?:js|mjs|cjs|py|ts)$/.test(relPath);
  const isMarkdownFile = /\.md$/i.test(relPath);
  const isBrowserTestScript = /^scripts\/test_browser_[A-Za-z0-9_]+\.mjs$/.test(relPath);
  const isTestFile = surface === 'Verification' || isBrowserTestScript;

  // Determine whether a test file has a closed fixture harness (MockSpreadsheet / MockSheet / MockDOM / VM sandbox / Playwright route mock / synthetic unit mock)
  const hasClosedFixtureHarness =
    isTestFile &&
    /(?:MockSpreadsheet|MockSheet|MockRange|createMockDOM|vm\.createContext|vm\.runIn(?:New|This)?Context|context\.route|page\.route|addInitScript|window\.liff\s*=|mockResolver|mockExec|mockRunner|simulateRequest|simulateMigrationResolve|parseCsvWithHeaders|createTemp|mkdtempSync)/.test(
      content
    );
  const readsLiveAddressMaster =
    isTestFile &&
    /['"`](?:[^'"`]*\/)?data\/address_master\.csv['"`]/.test(content) &&
    /\breadFileSync\b/.test(content) &&
    !/mkdtempSync/.test(content);
  const readsLiveDeploymentJson =
    isTestFile &&
    /readFileSync\s*\([^)]*['"`](?:[^'"`]*\/)?deployment\.json['"`]/.test(content) &&
    !/deployment\.json not found, skipping/.test(content);
  const servesUnmockedStorageLocations =
    isBrowserTestScript &&
    /switchPage\s*\(\s*['"`]storage-register['"`]\s*\)/.test(content) &&
    !/storage_locations\.json/.test(content);

  // Special check for .agents/os-registry.json canonicalSources referencing HISTORICAL or OBSOLETE files
  if (relPath === '.agents/os-registry.json') {
    try {
      const reg = JSON.parse(content);
      const packs = reg.capabilityPacks || {};
      for (const [packName, packDef] of Object.entries(packs)) {
        for (const src of packDef.canonicalSources || []) {
          if (src && src.path) {
            const srcClass = classifyAsset(src.path);
            if (srcClass.lifecycle === 'HISTORICAL' || srcClass.lifecycle === 'OBSOLETE') {
              pushFinding(
                'S-05',
                1,
                'STRUCTURAL',
                `os-registry.json capabilityPack "${packName}" references ${srcClass.lifecycle} file "${src.path}" in canonicalSources`
              );
            }
          }
        }
      }
      for (const opSurface of reg.operationalKnowledgeSurfaces || []) {
        const opClass = classifyAsset(opSurface);
        if (opClass.lifecycle === 'HISTORICAL' || opClass.lifecycle === 'OBSOLETE') {
          pushFinding(
            'S-05',
            1,
            'STRUCTURAL',
            `os-registry.json operationalKnowledgeSurfaces references ${opClass.lifecycle} file "${opSurface}"`
          );
        }
      }
    } catch (err) {
      throw new ScannerExecutionError(`Failed to parse .agents/os-registry.json: ${err.message}`);
    }
  }

  // State tracking for multi-line structures
  let inMarkdownFence = false;
  let inCodeDictionaryName = null;
  let inTestFunctionBlock = false;
  let inEmptyParseArgsTestBlock = false;
  let inLiveCsvAssertionSection = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];
    const trimmed = line.trim();
    const findingsCountBeforeLine = findings.length;

    if (isMarkdownFile && /^```/.test(trimmed)) {
      inMarkdownFence = !inMarkdownFence;
      continue;
    }

    // Track test blocks that call parseArgs([]) with empty CLI args or read live data/address_master.csv
    if (isTestFile) {
      if (/^(?:await\s+)?(?:asyncTest|test)\s*\(/.test(trimmed)) {
        inTestFunctionBlock = true;
        inEmptyParseArgsTestBlock = false;
        inLiveCsvAssertionSection = false;
      }
      if (/\bparseArgs\s*\(\s*\[\s*\]\s*\)/.test(line)) {
        inEmptyParseArgsTestBlock = true;
      }
      if (
        readsLiveAddressMaster &&
        inTestFunctionBlock &&
        (/['"`](?:[^'"`]*\/)?data\/address_master\.csv['"`]/.test(line) || /\bmasterCsv\b/.test(line))
      ) {
        inLiveCsvAssertionSection = true;
      }
    }

    // -------------------------------------------------------------------------
    // RULE S-01: Config / CLI Non-Generic District / Domain / CityCode Default
    // -------------------------------------------------------------------------
    if ((surface === 'Runtime' || surface === 'Tooling-Config') && !isBrowserTestScript) {
      // (a) JS/MJS DEFAULT_CONFIG or option fallback for districtId / domain / cityCode
      const configPropMatch = line.match(
        /\b(districtId|domain|targetCity|cityCode|defaultCity|appName|loginChannelName|messagingChannelName|liffName|endpointUrl|repo|expectedCname)\s*[:=]\s*(['"`])([^'"`]+)\2/
      );
      if (configPropMatch) {
        const propName = configPropMatch[1];
        const quoteChar = configPropMatch[2];
        const propVal = configPropMatch[3].trim();
        // Dynamic template interpolation (e.g. `https://${domain}/` or `POSTING MAP ${options.districtId}`)
        // is NOT a static district default unless the static portion itself embeds a concrete domain or 5-digit code
        const isDynamicTemplate =
          quoteChar === '`' &&
          /\$\{[^}]+\}/.test(propVal) &&
          !/\b[a-z0-9-]+\.postingmap\.jp\b/i.test(propVal) &&
          !/\b\d{5}\b/.test(propVal);

        if (
          !isDynamicTemplate &&
          !isPlaceholderValue(propVal) &&
          !SYNTHETIC_TEST_ID_REGEX.test(propVal)
        ) {
          pushFinding(
            'S-01',
            lineNum,
            'STRUCTURAL',
            `Non-generic default literal assigned to "${propName}": "${propVal}"`
          );
        }
      }

      // (b) CLI argument fallback to 5-6 digit municipality code in scripts (JS/Python)
      const cliCodeFallbackMatch = line.match(
        /(?:sys\.argv|process\.argv|args|else|or|\|\||\?\?)\s*[^#\n]*?(['"])(\d{5,6})\1/
      );
      if (cliCodeFallbackMatch) {
        const fallbackCode = cliCodeFallbackMatch[2];
        if (!ALLOWED_PLACEHOLDER_IDS.has(fallbackCode)) {
          pushFinding(
            'S-01',
            lineNum,
            'STRUCTURAL',
            `Hardcoded 5/6-digit municipality code CLI fallback detected: "${fallbackCode}"`
          );
        }
      }

      // (c) Python argparse add_argument non-generic default for district/municipality/raw-path flags
      const argparseDefaultMatch = line.match(
        /add_argument\s*\(\s*(['"])(--(?:city-code|city-name|district-id|ref-csv|estat-dir))\1[^)]*?default\s*=\s*(['"])([^'"]+)\3/
      );
      if (argparseDefaultMatch) {
        const flagName = argparseDefaultMatch[2];
        const defVal = argparseDefaultMatch[4].trim();
        // Generic directory/path default (e.g. data/raw_estat_r2) without municipality code or Tier 1 token is PASS
        const isGenericPathDefault =
          (flagName === '--estat-dir' || flagName === '--ref-csv') &&
          !/\b\d{5}\b/.test(defVal) &&
          !Array.from(dynamicTokens.tier1HighIdentity.keys()).some(t => defVal.includes(t)) &&
          !Array.from(dynamicTokens.tier2MunicipalityStems.keys()).some(s => defVal.toLowerCase().includes(s.toLowerCase()));

        if (!isGenericPathDefault && !isPlaceholderValue(defVal) && !SYNTHETIC_TEST_ID_REGEX.test(defVal)) {
          pushFinding(
            'S-01',
            lineNum,
            'STRUCTURAL',
            `CLI flag "${flagName}" defines non-generic district default "${defVal}"`
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // RULE S-02: Town-Name / Kana Dictionary or Census KEY_CODE / Municipality Branch
    // -------------------------------------------------------------------------
    if ((surface === 'Runtime' || surface === 'Tooling-Config') && isCodeFile && !isBrowserTestScript) {
      // Track start/end of KANA_MAP / reading / specific resolutions dictionary at statement start (not inside f-string `town_name={...}`)
      const dictStartMatch = line.match(
        /^\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z0-9_]*(?:KANA|TOWN|READING|EXCEPT|RESOLUTIONS)[A-Za-z0-9_]*)\s*=\s*\{(?!\s*\})/i
      );
      if (dictStartMatch) {
        inCodeDictionaryName = dictStartMatch[1];
        pushFinding(
          'S-02',
          lineNum,
          'STRUCTURAL',
          `Hardcoded town/reading dictionary structure "${inCodeDictionaryName}" in Universal Code`
        );
      } else if (inCodeDictionaryName && /^\s*\}/.test(line)) {
        inCodeDictionaryName = null;
      }

      // Detect direct town-to-katakana reading map entry in code (structural dictionary key -> katakana reading)
      const townKanaEntryMatches = line.matchAll(
        /(['"])([一-龠々ヶノツ・]+(?:町|丁目|新田|大字|字|通|台|ケ丘|の丘)?)\1\s*:\s*(['"])([ァ-ヶー][ァ-ヶー0-9０-９・_]*)\3/g
      );
      for (const tkm of townKanaEntryMatches) {
        const townKey = tkm[2];
        if (!ALLOWED_PLACEHOLDER_IDS.has(townKey) && !SYNTHETIC_CJK_NAME_REGEX.test(townKey)) {
          pushFinding(
            'S-02',
            lineNum,
            'STRUCTURAL',
            `Hardcoded town reading map entry "${townKey}" embedded in Universal Code`
          );
        }
      }

      // Detect specific 8-11 digit JIS / e-Stat census KEY_CODE literal in code
      const keyCodeBranchMatch = line.match(/(['"`])((?:0[1-9]|[1-3]\d|4[0-7])[1-7]\d{5,8})\1/);
      if (keyCodeBranchMatch) {
        const codeLiteral = keyCodeBranchMatch[2];
        const isSyntheticEstat =
          /^24999\d+$/.test(codeLiteral) || /^0+$/.test(codeLiteral) || /^9+$/.test(codeLiteral);
        const isLineChannel = /^20\d{8}$/.test(codeLiteral); // Handled by S-04
        if (!isSyntheticEstat && !isLineChannel) {
          pushFinding(
            'S-02',
            lineNum,
            'STRUCTURAL',
            `Hardcoded census KEY_CODE / e_stat_code literal "${codeLiteral}" in Universal Code`
          );
        }
      }

      // Detect variable/identifier named after specific sub-area code (special_<digits>)
      const specialAreaVarMatch = line.match(/\b(special[_-]?\d{3,5})\b/i);
      if (specialAreaVarMatch) {
        pushFinding(
          'S-02',
          lineNum,
          'STRUCTURAL',
          `Area-specific branch identifier "${specialAreaVarMatch[1]}" in Universal Code`
        );
      }
    }

    // -------------------------------------------------------------------------
    // RULE S-03: District-Suffixed Env Var Keys & Quarantine Snapshot Paths
    // -------------------------------------------------------------------------
    // (a) Static, concatenated, template, or placeholder district suffix on Maps API key
    const envKeySuffixMatch = line.match(MAPS_KEY_SUFFIX_REGEX);
    if (envKeySuffixMatch) {
      const matchedExpr = envKeySuffixMatch[0].trim();
      pushFinding(
        'S-03',
        lineNum,
        'STRUCTURAL',
        `District-suffixed Maps API key expression "${matchedExpr}" violates single-key GOOGLE_MAPS_API_KEY contract`
      );
    }

    // (b) District-specific quarantine snapshot path (.quarantine_<slug>_snapshot)
    const quarantineMatch = line.match(/(\.quarantine_[A-Za-z0-9_-]+?_snapshot)/);
    if (quarantineMatch && !line.includes('<') && !line.includes('{')) {
      pushFinding(
        'S-03',
        lineNum,
        'STRUCTURAL',
        `District-specific quarantine path "${quarantineMatch[1]}" embedded in Universal Surface`
      );
    }

    // -------------------------------------------------------------------------
    // RULE S-04: Concrete External Resource IDs (GAS, Spreadsheet, Drive, LIFF, Channel)
    // -------------------------------------------------------------------------
    // (a) GAS Deployment ID (AKfycb...)
    const akfyMatch = line.match(/\b(AKfycb[A-Za-z0-9_-]{30,})\b/);
    if (akfyMatch) {
      pushFinding(
        'S-04',
        lineNum,
        'STRUCTURAL',
        `Concrete GAS Deployment ID "${akfyMatch[1].slice(0, 16)}..." embedded in Universal Surface`
      );
    }

    // (b) Concrete LINE LIFF ID (20xxxxxxxx-xxxxxxxx)
    const liffMatch = line.match(/\b(20\d{8}-[A-Za-z0-9_]{8})\b/);
    if (liffMatch) {
      const liffVal = liffMatch[1];
      const isSyntheticTestLiff =
        ALLOWED_PLACEHOLDER_IDS.has(liffVal) ||
        (isTestFile && hasClosedFixtureHarness && !dynamicTokens.tier1HighIdentity.has(liffVal));
      if (!isSyntheticTestLiff) {
        pushFinding(
          'S-04',
          lineNum,
          'STRUCTURAL',
          `Concrete LINE LIFF ID "${liffVal}" embedded in Universal Surface`
        );
      }
    }

    // (c) Concrete 10-digit LINE Channel ID in positive Channel contexts
    const channelPropMatch = line.match(
      /\b[A-Za-z0-9_]*channel[A-Za-z0-9_]*\b[^\n]*?(['"`])(20\d{8})\1/i
    );
    const channelUrlMatch = line.match(/\/console\/channel\/(20\d{8})\b/i);
    const detectedChanId = channelPropMatch
      ? channelPropMatch[2]
      : channelUrlMatch
        ? channelUrlMatch[1]
        : null;
    if (
      detectedChanId &&
      detectedChanId !== '2000000000' &&
      !(isTestFile && hasClosedFixtureHarness)
    ) {
      pushFinding(
        'S-04',
        lineNum,
        'STRUCTURAL',
        `Concrete 10-digit LINE Channel ID "${detectedChanId}" embedded in Universal Surface`
      );
    }

    // (d) Hardcoded foreign district LIFF ID array identifier
    const foreignLiffIdentMatch = line.match(/\b(KNOWN_FOREIGN_[A-Z0-9_]*LIFF_IDS)\b/);
    if (foreignLiffIdentMatch) {
      pushFinding(
        'S-04',
        lineNum,
        'STRUCTURAL',
        `Hardcoded foreign district LIFF ID blacklist structure (${foreignLiffIdentMatch[1]})`
      );
    }

    // (e) Concrete Google Script / Spreadsheet / Drive ID (starts with 1, length 32..58, non-hex)
    const googleIdMatches = line.matchAll(/(['"`])(1[A-Za-z0-9_-]{31,58})\1/g);
    for (const m of googleIdMatches) {
      const candidateId = m[2];
      const isHexHash = /^[0-9a-f]+$/i.test(candidateId);
      const hasUpperAndLowerAndDigit =
        /[A-Z]/.test(candidateId) && /[a-z]/.test(candidateId) && /\d/.test(candidateId);
      if (!isHexHash && hasUpperAndLowerAndDigit && !/dummy|test|sample|mock/i.test(candidateId)) {
        pushFinding(
          'S-04',
          lineNum,
          'STRUCTURAL',
          `Concrete Google Resource ID "${candidateId.slice(0, 16)}..." embedded in Universal Surface`
        );
      }
    }

    // -------------------------------------------------------------------------
    // RULE S-05: Deprecated Single-Parent Shared GAS / Obsolete Contract Assertions
    // -------------------------------------------------------------------------
    if (lifecycle === 'CURRENT') {
      // (a) References to A1 OBSOLETE files or obsolete npm commands in CURRENT files
      for (const obsPat of OBSOLETE_REF_PATTERNS) {
        if (obsPat.re.test(line) && !isNegationOrDeprecationContext(line)) {
          pushFinding(
            'S-05',
            lineNum,
            'STRUCTURAL',
            `Current asset references OBSOLETE artifact/command "${obsPat.label}"`
          );
        }
      }

      // (b) UNIVERSAL_BASE / deprecated single-parent GAS topology in active contract or test assertions
      if (/\bUNIVERSAL_[A-Z]*BASE\b/.test(line) && !isNegationOrDeprecationContext(line)) {
        pushFinding(
          'S-05',
          lineNum,
          'STRUCTURAL',
          'Deprecated single-parent GAS identifier referenced as active contract'
        );
      }

      const isCodeCommentLine = isCodeFile && /^(?:\/\/|\/\*|\*|\s*#)/.test(trimmed);
      if (
        DEPRECATED_PARENT_GAS_REGEX.test(line) &&
        !isNegationOrDeprecationContext(line) &&
        !(isTestFile && isCodeCommentLine)
      ) {
        pushFinding(
          'S-05',
          lineNum,
          'STRUCTURAL',
          'Deprecated Single-Parent Shared GAS topology asserted/instructed as active contract'
        );
      }

      if (/npm\s+run\s+sync:config/.test(line) || /clients\/(?:\$\{client\}|[a-z0-9_-]+)\/config\.js/.test(line)) {
        pushFinding(
          'S-05',
          lineNum,
          'STRUCTURAL',
          'Obsolete multi-client / sync:config tooling reference in active script'
        );
      }
    }

    // -------------------------------------------------------------------------
    // RULE S-06: Verification (Tests) Hardcoded Area Counts & Real-District Contract Debt
    // -------------------------------------------------------------------------
    if (surface === 'Verification') {
      // (a) Hardcoded row/area count assertion against live CSV lines (both `lines.length, 338` and `lines.length - 1, 337`)
      const countAssertMatch = line.match(
        /assert\.(?:equal|strictEqual)\s*\(\s*lines\.length(?:\s*-\s*1)?\s*,\s*(\d+)/
      );
      if (countAssertMatch && readsLiveAddressMaster) {
        pushFinding(
          'S-06',
          lineNum,
          'STRUCTURAL',
          `Test locks live data/address_master.csv row/line count to district-specific constant (${countAssertMatch[1]})`
        );
      }

      // (b) Live data/address_master.csv content assertion locking specific municipality/town/code
      if (inLiveCsvAssertionSection && /assert\.\w+\s*\(\s*lines\[\d+\]\.includes\s*\(/.test(line)) {
        pushFinding(
          'S-06',
          lineNum,
          'STRUCTURAL',
          'Test locks live data/address_master.csv row content to a specific district/municipality literal'
        );
      }

      // (c) Assertion that a production CLI `parseArgs([])` (empty args) defaults to a non-generic district/domain
      if (inEmptyParseArgsTestBlock) {
        const defaultOptAssertMatch = line.match(
          /assert\.(?:equal|strictEqual)\s*\(\s*opts\.(districtId|domain|repo|endpointUrl|appName|cityCode|cityName)\s*,\s*(['"`])([^'"`]+)\2/
        );
        if (defaultOptAssertMatch) {
          const optField = defaultOptAssertMatch[1];
          const optVal = defaultOptAssertMatch[3].trim();
          if (!isPlaceholderValue(optVal) && !SYNTHETIC_TEST_ID_REGEX.test(optVal)) {
            pushFinding(
              'S-06',
              lineNum,
              'STRUCTURAL',
              `Test asserts non-generic CLI default "${optVal}" on opts.${optField} for empty parseArgs([])`
            );
          }
        }
      }

      // (d) In non-closed-fixture tests (e.g. live deployment smoke tests), flag concrete district fields and domains
      if (!hasClosedFixtureHarness && readsLiveDeploymentJson) {
        const testDistFieldMatch = line.match(
          /\b(?:districtId|DISTRICT_ID|TEST_DISTRICT)\s*[:=]\s*(['"`])([^'"`]+)\1/
        );
        if (testDistFieldMatch) {
          const distVal = testDistFieldMatch[2].trim();
          if (!isPlaceholderValue(distVal) && !SYNTHETIC_TEST_ID_REGEX.test(distVal)) {
            pushFinding(
              'S-06',
              lineNum,
              'STRUCTURAL',
              `Live-coupled test embeds non-synthetic district identifier "${distVal}"`
            );
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // RULE S-07: Current Docs Structured Block / Example Placeholder Contract
    // -------------------------------------------------------------------------
    let s07ClaimedLine = false;
    if (surface === 'Governance-CurrentDocs' && lifecycle === 'CURRENT' && isMarkdownFile) {
      const isTableLine = trimmed.startsWith('|') && trimmed.endsWith('|');
      const isDocExampleLine =
        !isNegationOrDeprecationContext(line) &&
        /(?:例\s*[:：]|（例|e\.g\.|実行例|--district|--city-code|--city-name|--domain|"districtId"\s*:|'districtId'\s*:)/i.test(
          line
        );
      const isStructuredOrExampleDocLine = inMarkdownFence || isTableLine || isDocExampleLine;

      // (a) Concrete subdomain on postingmap.jp in Current Docs
      const docDomainMatch = line.match(/\b([a-z0-9-]+)\.postingmap\.jp\b/i);
      if (docDomainMatch) {
        const fullDom = `${docDomainMatch[1]}.postingmap.jp`;
        const subDom = docDomainMatch[1];
        if (!ALLOWED_PLACEHOLDER_IDS.has(fullDom) && !SYNTHETIC_TEST_ID_REGEX.test(subDom)) {
          pushFinding(
            'S-07',
            lineNum,
            'STRUCTURAL',
            `Current Doc embeds concrete district domain "${fullDom}" instead of generic placeholder`
          );
          s07ClaimedLine = true;
        }
      }

      // (b) Concrete Staff ID (STF-xxxxx-xxx where xxxxx != 00000 and != 99999)
      const staffIdMatch = line.match(/\b(STF-(\d{5})-\d{3,4})\b/);
      if (staffIdMatch) {
        const fullStaffId = staffIdMatch[1];
        const jisPart = staffIdMatch[2];
        if (jisPart !== '00000' && jisPart !== '99999') {
          pushFinding(
            'S-07',
            lineNum,
            'STRUCTURAL',
            `Current Doc embeds district-specific Staff ID "${fullStaffId}" (use STF-00000-001)`
          );
          s07ClaimedLine = true;
        }
      }

      // (c) Non-placeholder district code (e.g. XXX-01) inside structured code block, table, or positive example
      if (isStructuredOrExampleDocLine) {
        const distCodeMatches = line.matchAll(/\b([A-Z]{3,10}-\d{2})\b/g);
        for (const dm of distCodeMatches) {
          const codeCandidate = dm[1];
          const isDocIdentifier =
            /^(?:REQ|ADR|SEC|GAP|STEP|GATE|PHASE|WAVE|RULE|TC|UTF|ISO|SHA|ERR|SYS|API|APP|CSV|DOM|URL|DNS|TLS|CDP|CLI|GUI|SDK|JWT|OTP|PWA|SLA|SOP)-\d{2}$/.test(
              codeCandidate
            );
          if (
            !isDocIdentifier &&
            !ALLOWED_PLACEHOLDER_IDS.has(codeCandidate) &&
            !SYNTHETIC_TEST_ID_REGEX.test(codeCandidate)
          ) {
            pushFinding(
              'S-07',
              lineNum,
              'STRUCTURAL',
              `Current Doc structured/example block uses concrete district code "${codeCandidate}" (use DISTRICT-01 or SAMPLE-01)`
            );
            s07ClaimedLine = true;
          }
        }

        // (d) Tier 1 High-Identity token inside structured code block, table, or config/API/CLI example
        const lineWithoutHistPath = line.replace(
          /(?:\.agents\/records|docs\/architecture\/decisions|docs\/research)\/[A-Za-z0-9_./-]+|evidence_[A-Za-z0-9_]+_historical_lessons\.md/g,
          '__HISTORICAL_PATH_REF__'
        );
        for (const [token] of dynamicTokens.tier1HighIdentity.entries()) {
          let matched = false;
          if (/^[A-Za-z0-9_.-]+$/.test(token)) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const boundaryRegex = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
            matched = boundaryRegex.test(lineWithoutHistPath);
          } else {
            matched = lineWithoutHistPath.includes(token);
          }
          if (matched) {
            pushFinding(
              'S-07',
              lineNum,
              'STRUCTURAL',
              `Current Doc structured/example block embeds concrete district token "${token}" instead of generic placeholder`
            );
            s07ClaimedLine = true;
          }
        }
      }
    }

    // Mask legitimate path references to HISTORICAL directories/files before running Dynamic Token checks
    const lineForDynamic = line.replace(
      /(?:\.agents\/records|docs\/architecture\/decisions|docs\/research)\/[A-Za-z0-9_./-]+|evidence_[A-Za-z0-9_]+_historical_lessons\.md/g,
      '__HISTORICAL_PATH_REF__'
    );

    // Verification Context-Pass evaluation (Requirement 6):
    // A line in a test file is Context-Pass ONLY IF:
    //   1. The test file uses a closed fixture harness (hasClosedFixtureHarness === true), AND
    //   2. The line has NOT triggered any prohibited product contract rule (S-03, S-04, S-05, S-06), AND
    //   3. The line is NOT in a live data/binding assertion section (inLiveCsvAssertionSection / readsLiveDeploymentJson / inEmptyParseArgsTestBlock / servesUnmockedStorageLocations)
    const isLiveCsvHeaderComment =
      readsLiveAddressMaster && /(?:テストデータ|address_master\.csv|マスターCSV)/.test(line);
    const isLiveStorageLocationCoupledLine =
      servesUnmockedStorageLocations && /\blocation\s*:\s*['"`]/.test(line);
    const structuralFindingsAddedOnLine = findings.length > findingsCountBeforeLine;
    const isVerificationClosedFixtureContextPass =
      isTestFile &&
      (hasClosedFixtureHarness || readsLiveAddressMaster) &&
      !structuralFindingsAddedOnLine &&
      !inLiveCsvAssertionSection &&
      !isLiveCsvHeaderComment &&
      !isLiveStorageLocationCoupledLine &&
      !readsLiveDeploymentJson &&
      !inEmptyParseArgsTestBlock;

    if (isVerificationClosedFixtureContextPass) {
      continue;
    }

    // -------------------------------------------------------------------------
    // RULE D-01: Tier 1 High-Identity Dynamic Token Leak
    // -------------------------------------------------------------------------
    // If S-07 already claimed this Current Doc structured/example line, do not emit duplicate D-01
    // Also apply isNegationOrDeprecationContext to prose/comment lines (never exempting structured doc blocks)
    const isStructuredDocLine =
      surface === 'Governance-CurrentDocs' &&
      isMarkdownFile &&
      (inMarkdownFence || (trimmed.startsWith('|') && trimmed.endsWith('|')));
    const isD01NegationContextPass =
      !isStructuredDocLine && isNegationOrDeprecationContext(lineForDynamic);

    if (!s07ClaimedLine && !isD01NegationContextPass) {
      for (const [token, sources] of dynamicTokens.tier1HighIdentity.entries()) {
        let matched = false;
        if (/^[A-Za-z0-9_.-]+$/.test(token)) {
          const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const boundaryRegex = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
          matched = boundaryRegex.test(lineForDynamic);
        } else {
          matched = lineForDynamic.includes(token);
        }
        if (matched) {
          const srcList = Array.from(sources).slice(0, 2).join(', ');
          pushFinding(
            'D-01',
            lineNum,
            'DYNAMIC',
            `Tier 1 High-Identity token "${token}" (from ${srcList}) leaked into ${surface}`
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // RULE D-02: Tier 2 Context-Only Dynamic Token Leak (Strictly Context-Aware)
    // -------------------------------------------------------------------------
    // (a) Municipality Stem in the 5 A1-approved structural contexts:
    //     1. config/CLI default, 2. dictionary/map key, 3. district/city/municipality/branch/location field,
    //     4. specific branch condition, 5. repo/domain/path identifier
    //     (Strictly excluding person name fields: staffName, displayName, first, last, author, posterName)
    for (const [stem, sources] of dynamicTokens.tier2MunicipalityStems.entries()) {
      if (!lineForDynamic.includes(stem)) continue;
      if (isPersonNameContext(lineForDynamic, stem)) continue;

      // Skip if the full municipality name is on this line (already reported by D-01 or S-07)
      let coveredByTier1 = false;
      for (const t1 of dynamicTokens.tier1HighIdentity.keys()) {
        if (t1.startsWith(stem) && t1 !== stem && lineForDynamic.includes(t1)) {
          coveredByTier1 = true;
          break;
        }
      }
      if (coveredByTier1) continue;

      const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inApprovedStemContext =
        // Context 1 & 3: Config/CLI default or district/city/municipality/branch/location/region/area field
        new RegExp(
          `\\b(?:district|districtId|districtCode|districtName|city|cityName|city_name|cityCode|city_code|municipality|municipalityName|branch|branchId|branchName|location|region|area|areaName|targetCity|defaultCity|default)\\s*[:=]\\s*['"\`][^'"\`]*${escapedStem}`,
          'i'
        ).test(lineForDynamic) ||
        // Context 2: Dictionary/map key
        new RegExp(`['"\`][^'"\`]*${escapedStem}[^'"\`]*['"\`]\\s*:`).test(lineForDynamic) ||
        // Context 4: Specific branch condition
        new RegExp(`(?:if|switch|includes|startsWith|endsWith|match|test|regex)\\s*\\(?[^\\n]*${escapedStem}`).test(
          lineForDynamic
        ) ||
        // Context 5: Repo / domain / path identifier
        new RegExp(`[./_-]${escapedStem}[./_-]`, 'i').test(lineForDynamic);

      if (inApprovedStemContext) {
        const srcList = Array.from(sources).slice(0, 2).join(', ');
        pushFinding(
          'D-02',
          lineNum,
          'DYNAMIC',
          `Tier 2 Municipality stem "${stem}" (from ${srcList}) used in district/city structural context`
        );
      }
    }

    // (b) Tier 2 total_towns / rowCount in count assertion or hardcoded area count context
    for (const [countStr, sources] of dynamicTokens.tier2TotalTowns.entries()) {
      const escapedCount = countStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inCountContext = new RegExp(
        `(?:assert\\.(?:equal|strictEqual)[^\\n]*\\b${escapedCount}\\b|\\b${escapedCount}\\s*(?:町丁目|エリア|件|行|レコード)\\b|length\\s*:\\s*${escapedCount}\\b)`
      ).test(lineForDynamic);
      if (inCountContext && !isNegationOrDeprecationContext(lineForDynamic)) {
        const srcList = Array.from(sources).slice(0, 2).join(', ');
        pushFinding(
          'D-02',
          lineNum,
          'DYNAMIC',
          `Tier 2 area/town count "${countStr}" (from ${srcList}) locked in ${surface}`
        );
      }
    }
  }

  return findings;
}

/**
 * 4. POST-BUILD Closure Audit (Rule D-03)
 * Verifies that DistrictData (data/**) and ExternalBinding (CNAME, etc.)
 * are 100% mutually consistent for a single Target District (zero Hybrid state).
 */
function runPostBuildClosureChecks(closureData, stage) {
  const findings = [];
  if (stage !== 'post-build') return findings;

  const pushClosureFinding = (file, conciseReason) => {
    findings.push({
      ruleId: 'D-03',
      stage,
      surface: file === 'CNAME' || file === 'deployment.json' ? 'ExternalBinding' : 'DistrictData',
      lifecycle: 'CURRENT',
      file,
      location: '1:1',
      line: 1,
      findingType: 'CLOSURE',
      conciseReason
    });
  };

  // 1. data/config.js vs data/election_history.json districtId alignment
  if (!closureData.configDistrictId || isPlaceholderValue(closureData.configDistrictId)) {
    pushClosureFinding('data/config.js', 'POST-BUILD Closure: data/config.js districtId is missing or placeholder');
  }
  if (!closureData.electionDistrictId || isPlaceholderValue(closureData.electionDistrictId)) {
    pushClosureFinding('data/election_history.json', 'POST-BUILD Closure: data/election_history.json districtId is missing or placeholder');
  }
  if (
    closureData.configDistrictId &&
    closureData.electionDistrictId &&
    closureData.configDistrictId !== closureData.electionDistrictId
  ) {
    pushClosureFinding(
      'data/election_history.json',
      `POST-BUILD Hybrid Mismatch: data/config.js districtId ("${closureData.configDistrictId}") !== data/election_history.json districtId ("${closureData.electionDistrictId}")`
    );
  }

  // 2. CNAME subdomain vs data/config.js districtId alignment
  if (closureData.cnameSubdomain && closureData.configDistrictId) {
    if (closureData.cnameSubdomain.toLowerCase() !== closureData.configDistrictId.toLowerCase()) {
      pushClosureFinding(
        'CNAME',
        `POST-BUILD Hybrid Mismatch: CNAME subdomain ("${closureData.cnameSubdomain}") does not match data/config.js districtId ("${closureData.configDistrictId}")`
      );
    }
  }

  // 3. municipality_master.csv total_towns sum vs address_master.csv row count vs boundaries.geojson feature count
  if (closureData.masterTotalTownsSum !== closureData.addressMasterRowCount) {
    pushClosureFinding(
      'data/municipality_master.csv',
      `POST-BUILD Triad Mismatch: sum of total_towns (${closureData.masterTotalTownsSum}) !== address_master.csv rows (${closureData.addressMasterRowCount})`
    );
  }
  if (
    closureData.boundariesFeatureCount !== null &&
    closureData.boundariesFeatureCount !== closureData.addressMasterRowCount
  ) {
    pushClosureFinding(
      'data/boundaries.geojson',
      `POST-BUILD Triad Mismatch: boundaries.geojson features (${closureData.boundariesFeatureCount}) !== address_master.csv rows (${closureData.addressMasterRowCount})`
    );
  }

  // 4. municipality_master.csv city_name set vs address_master.csv / election_history.json / storage_locations.json
  const masterCitySet = new Set(closureData.masterMunicipalities.map(m => m.cityName));
  for (const masterCity of masterCitySet) {
    if (!closureData.addressMasterCities.has(masterCity)) {
      pushClosureFinding(
        'data/municipality_master.csv',
        `POST-BUILD Triad Mismatch: municipality_master.csv declares "${masterCity}" which has 0 rows in address_master.csv`
      );
    }
  }
  for (const addrCity of closureData.addressMasterCities) {
    if (!masterCitySet.has(addrCity)) {
      pushClosureFinding(
        'data/address_master.csv',
        `POST-BUILD Triad Mismatch: address_master.csv contains city_name "${addrCity}" not declared in municipality_master.csv`
      );
    }
  }
  for (const elecCity of new Set(closureData.electionMunicipalities)) {
    if (!masterCitySet.has(elecCity)) {
      pushClosureFinding(
        'data/election_history.json',
        `POST-BUILD Triad Mismatch: election_history.json contains municipality "${elecCity}" not declared in municipality_master.csv`
      );
    }
  }
  for (const storageCity of new Set(closureData.storageMunicipalities)) {
    if (!masterCitySet.has(storageCity)) {
      pushClosureFinding(
        'data/storage_locations.json',
        `POST-BUILD Hybrid Mismatch: storage_locations.json contains municipality "${storageCity}" not declared in municipality_master.csv`
      );
    }
  }

  // 5. deployment.json (if present) vs data/config.js alignment
  if (closureData.deploymentJsonPresent) {
    if (
      closureData.deploymentDistrictId &&
      closureData.configDistrictId &&
      closureData.deploymentDistrictId !== closureData.configDistrictId
    ) {
      pushClosureFinding(
        'deployment.json',
        `POST-BUILD Hybrid Mismatch: deployment.json districtId ("${closureData.deploymentDistrictId}") !== data/config.js districtId ("${closureData.configDistrictId}")`
      );
    }
    if (
      closureData.deploymentWebAppUrl &&
      closureData.configGasUrl &&
      closureData.deploymentWebAppUrl !== closureData.configGasUrl
    ) {
      pushClosureFinding(
        'deployment.json',
        'POST-BUILD Hybrid Mismatch: deployment.json webAppUrl !== data/config.js api.gasWebAppUrl'
      );
    }
  }

  return findings;
}

/**
 * Collect all files to inspect in rootDir (tracked + untracked non-ignored files)
 */
function listRepositoryFiles(rootDir) {
  try {
    const out = execSync('git ls-files -z --cached --others --exclude-standard', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return out
      .split('\0')
      .map(s => s.trim())
      .filter(Boolean)
      .sort();
  } catch (_) {
    // Fallback recursive directory walk when running in a non-git temp directory
    const results = [];
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'scratch') continue;
        const abs = path.join(dir, entry.name);
        const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.isFile()) {
          results.push(rel);
        }
      }
    };
    walk(rootDir);
    return results.sort();
  }
}

/**
 * 5. Main Exported Entry Point (Single Canonical Scanner Logic)
 */
export function runUniversalBoundaryScan(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd();
  const stage = (options.stage || 'pre-build').toLowerCase();

  if (stage !== 'pre-build' && stage !== 'post-build') {
    throw new ScannerExecutionError(`Invalid --stage "${stage}". Expected "pre-build" or "post-build".`);
  }

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new ScannerExecutionError(`Target root directory does not exist: ${rootDir}`);
  }

  const dynamicTokens = extractDynamicTokens(rootDir);
  const files = listRepositoryFiles(rootDir);
  if (files.length === 0) {
    throw new ScannerExecutionError(`Zero files found to scan in ${rootDir}`);
  }

  const allFindings = [];
  const surfaceCounts = {};
  const lifecycleCounts = {};

  for (const relPath of files) {
    const classification = classifyAsset(relPath);
    if (classification.surface === 'UNCLASSIFIED') {
      throw new ScannerExecutionError(
        `Unclassified file in Repository Scan Set (Fail-Closed): "${relPath}"`
      );
    }
    surfaceCounts[classification.surface] = (surfaceCounts[classification.surface] || 0) + 1;
    lifecycleCounts[classification.lifecycle] = (lifecycleCounts[classification.lifecycle] || 0) + 1;

    const ext = path.extname(relPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      continue;
    }

    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath)) {
      throw new ScannerExecutionError(`Tracked file missing on disk: ${relPath}`);
    }

    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new ScannerExecutionError(`Failed to read file ${relPath}: ${err.message}`);
    }

    const fileFindings = scanSingleFile(relPath, content, classification, dynamicTokens, stage);
    allFindings.push(...fileFindings);
  }

  const closureFindings = runPostBuildClosureChecks(dynamicTokens.closureData, stage);
  allFindings.push(...closureFindings);

  // Deduplicate identical (file, line, ruleId, conciseReason) and sort deterministically
  const seen = new Set();
  const dedupedFindings = [];
  for (const f of allFindings) {
    const key = `${f.file}:${f.line}:${f.ruleId}:${f.conciseReason}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedFindings.push(f);
    }
  }

  dedupedFindings.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return a.conciseReason < b.conciseReason ? -1 : a.conciseReason > b.conciseReason ? 1 : 0;
  });

  const findingsByRule = {};
  const findingsByFile = new Map();
  for (const f of dedupedFindings) {
    findingsByRule[f.ruleId] = (findingsByRule[f.ruleId] || 0) + 1;
    if (!findingsByFile.has(f.file)) findingsByFile.set(f.file, []);
    findingsByFile.get(f.file).push(f);
  }

  const tier1Provenance = {};
  for (const k of Array.from(dynamicTokens.tier1HighIdentity.keys()).sort()) {
    tier1Provenance[k] = Array.from(dynamicTokens.tier1HighIdentity.get(k)).sort();
  }
  const tier2StemProvenance = {};
  for (const k of Array.from(dynamicTokens.tier2MunicipalityStems.keys()).sort()) {
    tier2StemProvenance[k] = Array.from(dynamicTokens.tier2MunicipalityStems.get(k)).sort();
  }
  const tier2TotalTownsProvenance = {};
  for (const k of Array.from(dynamicTokens.tier2TotalTowns.keys()).sort()) {
    tier2TotalTownsProvenance[k] = Array.from(dynamicTokens.tier2TotalTowns.get(k)).sort();
  }

  const localBindingSources = {
    claspJson: dynamicTokens.closureData.claspJsonPresent ? 'present' : 'absent',
    deploymentJson: dynamicTokens.closureData.deploymentJsonPresent ? 'present' : 'absent',
    activeCount:
      (dynamicTokens.closureData.claspJsonPresent ? 1 : 0) +
      (dynamicTokens.closureData.deploymentJsonPresent ? 1 : 0)
  };

  return {
    stage,
    rootDir,
    scannedFileCount: files.length,
    localBindingSources,
    surfaceCounts,
    lifecycleCounts,
    dynamicSummary: {
      tier1HighIdentityCount: dynamicTokens.tier1HighIdentity.size,
      tier1Tokens: Array.from(dynamicTokens.tier1HighIdentity.keys()).sort(),
      tier1Provenance,
      tier2MunicipalityStemCount: dynamicTokens.tier2MunicipalityStems.size,
      tier2Stems: Array.from(dynamicTokens.tier2MunicipalityStems.keys()).sort(),
      tier2StemProvenance,
      tier2TotalTowns: Array.from(dynamicTokens.tier2TotalTowns.keys()).sort(),
      tier2TotalTownsProvenance,
      tier2TownNameCount: dynamicTokens.tier2TownNames.size,
      tier2EstatCodeCount: dynamicTokens.tier2EstatCodes.size
    },
    status: dedupedFindings.length === 0 ? 'PASS' : 'RED',
    exitCode: dedupedFindings.length === 0 ? 0 : 1,
    totalFindings: dedupedFindings.length,
    violatingFileCount: findingsByFile.size,
    findingsByRule,
    findings: dedupedFindings
  };
}

/**
 * CLI Runner
 */
function parseCliArgs(argv) {
  let stage = 'pre-build';
  let rootDir = process.cwd();
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stage') {
      if (!argv[i + 1]) {
        throw new ScannerExecutionError('Missing value for --stage (expected pre-build or post-build)');
      }
      stage = argv[++i];
    } else if (arg.startsWith('--stage=')) {
      stage = arg.slice('--stage='.length);
    } else if (arg === '--root') {
      if (!argv[i + 1]) {
        throw new ScannerExecutionError('Missing value for --root');
      }
      rootDir = argv[++i];
    } else if (arg.startsWith('--root=')) {
      rootDir = arg.slice('--root='.length);
    } else if (arg === '--json') {
      jsonOutput = true;
    } else {
      throw new ScannerExecutionError(`Unknown CLI argument: ${arg}`);
    }
  }

  return { stage, rootDir, jsonOutput };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    const { stage, rootDir, jsonOutput } = parseCliArgs(process.argv.slice(2));
    const report = runUniversalBoundaryScan({ rootDir, stage });

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.exitCode);
    }

    console.log('================================================================');
    console.log(`🛡️  UNIVERSAL BOUNDARY SCANNER (${report.stage.toUpperCase()})`);
    console.log('================================================================');
    console.log(`Scanned Files       : ${report.scannedFileCount} (Repository Scan Set)`);
    console.log(
      `Local Bindings      : ${report.localBindingSources.activeCount} active (.clasp.json=${report.localBindingSources.claspJson}, deployment.json=${report.localBindingSources.deploymentJson})`
    );
    console.log(`Surface Breakdown   : ${JSON.stringify(report.surfaceCounts)}`);
    console.log(`Lifecycle Breakdown : ${JSON.stringify(report.lifecycleCounts)}`);
    console.log(`Dynamic Tier 1 IDs  : ${report.dynamicSummary.tier1HighIdentityCount} token(s) [${report.dynamicSummary.tier1Tokens.join(', ')}]`);
    console.log(`Dynamic Tier 2 Stems: ${report.dynamicSummary.tier2MunicipalityStemCount} stem(s) [${report.dynamicSummary.tier2Stems.join(', ')}], TownCount=${report.dynamicSummary.tier2TownNameCount}, EstatCount=${report.dynamicSummary.tier2EstatCodeCount}`);
    console.log('----------------------------------------------------------------');

    if (report.totalFindings === 0) {
      console.log(`✅ [BOUNDARY PASS] 0 violations detected in ${report.stage.toUpperCase()} mode.`);
      process.exit(0);
    }

    console.error(`❌ [BOUNDARY RED] ${report.totalFindings} finding(s) across ${report.violatingFileCount} file(s).`);
    console.error(`Findings by Rule ID : ${JSON.stringify(report.findingsByRule)}`);
    console.error('----------------------------------------------------------------');

    for (const f of report.findings) {
      console.error(
        `[${f.ruleId}][${f.findingType}][${f.surface}/${f.lifecycle}] ${f.file}:${f.location} — ${f.conciseReason}`
      );
    }
    console.error('================================================================');
    process.exit(1);
  } catch (err) {
    console.error(`\n🛑 [SCANNER FAIL-CLOSED: EXIT 2] ${err.message}`);
    process.exit(2);
  }
}
