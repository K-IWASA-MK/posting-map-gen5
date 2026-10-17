import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract dynamic district tokens from data/** SSOT files
 */
export function extractDistrictTokens(dataDir) {
  const tokens = new Set();

  // 1. data/config.js
  const configPath = path.join(dataDir, 'config.js');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/districtId:\s*["']([^"']+)["']/);
    if (match && match[1].trim()) {
      tokens.add(match[1].trim());
    }
  }

  // 2. data/election_history.json
  const electionPath = path.join(dataDir, 'election_history.json');
  if (fs.existsSync(electionPath)) {
    try {
      const elecData = JSON.parse(fs.readFileSync(electionPath, 'utf8'));
      if (elecData.districtId && typeof elecData.districtId === 'string' && elecData.districtId.trim()) {
        tokens.add(elecData.districtId.trim());
      }
      if (elecData.districtName && typeof elecData.districtName === 'string' && elecData.districtName.trim()) {
        tokens.add(elecData.districtName.trim());
      }
    } catch (_) {}
  }

  // 3. data/municipality_master.csv
  const munPath = path.join(dataDir, 'municipality_master.csv');
  if (fs.existsSync(munPath)) {
    const lines = fs.readFileSync(munPath, 'utf8').split('\n');
    if (lines.length > 0) {
      const header = lines[0].split(',').map(h => h.trim());
      const nameIdx = header.indexOf('city_name');
      const codeIdx = header.indexOf('city_code');

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',').map(c => c.trim());
        if (nameIdx !== -1 && cols[nameIdx]) {
          tokens.add(cols[nameIdx]);
        }
        if (codeIdx !== -1 && cols[codeIdx]) {
          tokens.add(cols[codeIdx]);
        }
      }
    }
  }

  // Filter out invalid/empty/too-short tokens
  return Array.from(tokens).filter(t => typeof t === 'string' && t.trim().length >= 2);
}

/**
 * Scan target files for forbidden district tokens
 */
export function checkUniversalInvariants({
  baseCommit = null,
  targetCommit = null,
  changedFiles = null,
  baseDir = rootDir,
  dataDir = path.join(rootDir, 'data'),
  tokens = null
} = {}) {
  const dynamicTokens = tokens || extractDistrictTokens(dataDir);
  if (!dynamicTokens || dynamicTokens.length === 0) {
    return {
      pass: true,
      tokens: [],
      violations: [],
      message: 'No district tokens discovered in SSOT. Skipping check.'
    };
  }

  let filesToCheck = changedFiles;
  if (!filesToCheck) {
    filesToCheck = [];
    if (baseCommit && targetCommit) {
      try {
        const diffOut = execSync(`git diff --name-only "${baseCommit}".."${targetCommit}"`, { cwd: baseDir }).toString('utf8');
        filesToCheck = diffOut.split('\n').map(f => f.trim()).filter(Boolean);
      } catch (e) {
        return { pass: false, error: `Failed to get git diff: ${e.message}`, violations: [] };
      }
    } else {
      try {
        const diffOut = execSync('git diff --name-only HEAD', { cwd: baseDir }).toString('utf8');
        const untrackedOut = execSync('git ls-files --others --exclude-standard', { cwd: baseDir }).toString('utf8');
        const combined = diffOut.split('\n').concat(untrackedOut.split('\n'));
        filesToCheck = Array.from(new Set(combined.map(f => f.trim()).filter(Boolean)));
      } catch (e) {
        return { pass: false, error: `Failed to inspect working tree files: ${e.message}`, violations: [] };
      }
    }
  }

  // Filter for changed files outside data/**, .git/**, and scratch/**
  const candidateFiles = filesToCheck.filter(f => {
    const norm = f.replace(/\\/g, '/');
    if (norm.startsWith('data/')) return false;
    if (norm.startsWith('.git/')) return false;
    if (norm.startsWith('scratch/')) return false;
    return true;
  });

  const violations = [];

  for (const relPath of candidateFiles) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(baseDir, relPath);
    if (!fs.existsSync(absPath)) continue;

    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (_) {
      continue;
    }

    const fileLines = content.split('\n');

    for (const token of dynamicTokens) {
      const isAscii = /^[\x00-\x7F]+$/.test(token);
      let matcher;
      if (isAscii) {
        // Enforce word boundaries for ASCII / alphanumeric tokens
        matcher = new RegExp('\\b' + escapeRegex(token) + '\\b');
      }

      for (let lineNo = 1; lineNo <= fileLines.length; lineNo++) {
        const line = fileLines[lineNo - 1];
        let matched = false;
        if (isAscii) {
          matched = matcher.test(line);
        } else {
          matched = line.includes(token);
        }

        if (matched) {
          violations.push({
            file: relPath,
            line: lineNo,
            token,
            snippet: line.trim()
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    return {
      pass: false,
      tokens: dynamicTokens,
      violations,
      error: `Found ${violations.length} Universal Invariant violation(s) in changed non-data files.`
    };
  }

  return {
    pass: true,
    tokens: dynamicTokens,
    violations: [],
    message: `PASSED: No current district literals from data/** (${dynamicTokens.length} tokens) found in changed non-data files.`
  };
}

// ─────────────────────────────────────────────────────────────
// CLI エントリーポイント
// ─────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  let baseCommit = null;
  let targetCommit = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) {
      baseCommit = args[++i];
    } else if (args[i] === '--target' && args[i + 1]) {
      targetCommit = args[++i];
    }
  }

  const result = checkUniversalInvariants({
    baseCommit,
    targetCommit,
    baseDir: rootDir,
    dataDir: path.join(rootDir, 'data')
  });

  if (!result.pass) {
    console.error(`\n🛑 [Hard Stop] Universal Invariants Check FAILED: ${result.error}`);
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line} token "${v.token}": ${v.snippet}`);
    }
    process.exit(1);
  }

  console.log(`\n🟢 [Universal Invariants Check] ${result.message}`);
  process.exit(0);
}
