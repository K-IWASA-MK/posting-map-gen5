import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const rootDir = process.cwd();

// --- 1. Targeted Lexical Scanner ---
export function tokenize(code) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let jsDepth = 0;
  
  const stack = [];
  let inTpl = false;
  let tplBraceDepth = 0;

  const isAlphaNum = (c) => /[a-zA-Z0-9_$]/.test(c);
  const isAlpha = (c) => /[a-zA-Z_$]/.test(c);
  const isDigit = (c) => /[0-9]/.test(c);
  const isSpace = (c) => /\s/.test(c);

  let lastTokenType = null;
  let lastTokenValue = null;

  while (i < code.length) {
    const char = code[i];

    if (inTpl) {
      if (char === '\\') {
        if (code[i+1] === '\n') line++;
        i += 2;
        continue;
      }
      if (char === '`') {
        inTpl = false;
        i++;
        continue;
      }
      if (char === '$' && code[i+1] === '{') {
        stack.push({ braceDepth: tplBraceDepth });
        inTpl = false;
        tplBraceDepth = 0;
        i += 2;
        tokens.push({ type: 'punctuator', value: '{', line, depth: jsDepth });
        jsDepth++;
        continue;
      }
      if (char === '\n') line++;
      i++;
      continue;
    }

    if (char === '\n') { line++; i++; continue; }
    if (isSpace(char)) { i++; continue; }

    if (char === '/' && code[i+1] === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && code[i+1] === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i+1] === '/')) {
        if (code[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (char === '/') {
      const isRegexContext = !lastTokenType || ['punctuator', 'keyword'].includes(lastTokenType);
      const invalidRegexPrev = new Set([']', ')', '}']);
      if (isRegexContext && (!lastTokenValue || !invalidRegexPrev.has(lastTokenValue))) {
        let regexVal = '/';
        i++;
        let inClass = false;
        while (i < code.length) {
          if (code[i] === '\\') { regexVal += code[i] + code[i+1]; i+=2; continue; }
          if (code[i] === '[') inClass = true;
          if (code[i] === ']') inClass = false;
          if (code[i] === '/' && !inClass) { regexVal += '/'; i++; break; }
          if (code[i] === '\n') break;
          regexVal += code[i];
          i++;
        }
        tokens.push({ type: 'regex', value: regexVal, line, depth: jsDepth });
        lastTokenType = 'regex';
        lastTokenValue = regexVal;
        continue;
      }
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let strVal = quote;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { strVal += code[i] + code[i+1]; if (code[i+1] === '\n') line++; i+=2; continue; }
        if (code[i] === quote) { strVal += quote; i++; break; }
        if (code[i] === '\n') line++;
        strVal += code[i];
        i++;
      }
      tokens.push({ type: 'string', value: strVal, line, depth: jsDepth });
      lastTokenType = 'string';
      lastTokenValue = strVal;
      continue;
    }

    if (char === '`') {
      inTpl = true;
      i++;
      continue;
    }

    if (isDigit(char)) {
      let numVal = '';
      while (i < code.length && isDigit(code[i])) numVal += code[i++];
      tokens.push({ type: 'number', value: numVal, line, depth: jsDepth });
      lastTokenType = 'number';
      lastTokenValue = numVal;
      continue;
    }

    if (isAlpha(char)) {
      let idVal = '';
      while (i < code.length && isAlphaNum(code[i])) idVal += code[i++];
      const keywords = ['let', 'const', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'import', 'export'];
      const type = keywords.includes(idVal) ? 'keyword' : 'identifier';
      tokens.push({ type, value: idVal, line, depth: jsDepth });
      lastTokenType = type;
      lastTokenValue = idVal;
      continue;
    }

    const doublePuncts = ['===', '!==', '??=', '||=', '&&=', '==', '!=', '<=', '>=', '=>', '++', '--', '&&', '||', '??', '+=', '-=', '*=', '/='];
    let pVal = char;
    if (i + 2 < code.length && doublePuncts.includes(code.substring(i, i+3))) {
      pVal = code.substring(i, i+3);
      i += 3;
    } else if (i + 1 < code.length && doublePuncts.includes(code.substring(i, i+2))) {
      pVal = code.substring(i, i+2);
      i += 2;
    } else {
      i++;
    }

    if (pVal === '}') {
      if (stack.length > 0 && tplBraceDepth === 0) {
        const state = stack.pop();
        inTpl = true;
        tplBraceDepth = state.braceDepth;
        jsDepth = Math.max(0, jsDepth - 1);
        tokens.push({ type: 'punctuator', value: '}', line, depth: jsDepth });
        continue;
      } else {
        if (stack.length > 0) tplBraceDepth--;
        jsDepth = Math.max(0, jsDepth - 1);
      }
    }
    
    tokens.push({ type: 'punctuator', value: pVal, line, depth: jsDepth });
    lastTokenType = 'punctuator';
    lastTokenValue = pVal;

    if (pVal === '{') {
      jsDepth++;
      if (stack.length > 0) tplBraceDepth++;
    }
  }
  return tokens;
}

// --- 2. Findings Extractor ---
function getContextFingerprint(tokens, index) {
  let start = index;
  while (start > 0 && tokens[start].value !== ';' && tokens[start].value !== '{' && tokens[start].value !== '}') {
    start--;
  }
  let end = index;
  while (end < tokens.length - 1 && tokens[end].value !== ';' && tokens[end].value !== '{' && tokens[end].value !== '}') {
    end++;
  }
  return tokens.slice(start + 1, end).map(t => t.value).join('');
}

export function analyzeTokens(tokens, filePath) {
  const findings = [];
  const isAppJs = filePath.endsWith('app.js');
  const isModule = filePath.includes('modules/') || filePath.endsWith('render.js');

  const assignmentOps = ['=', '+=', '-=', '*=', '/=', '??=', '||=', '&&=', '++', '--'];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const next2 = tokens[i + 2];
    const next3 = tokens[i + 3];

    if (isAppJs) {
      if (t.type === 'identifier' && (t.value === 'innerHTML' || t.value === 'outerHTML')) {
        if (prev && prev.value === '.' && next && assignmentOps.includes(next.value)) {
          findings.push({ kind: 'HARD_FAIL:DOM_STRING', file: filePath, symbol: t.value, fingerprint: getContextFingerprint(tokens, i) });
        }
      }
      if (t.type === 'string' && (t.value === "'innerHTML'" || t.value === '"innerHTML"' || t.value === '`innerHTML`')) {
        if (prev && prev.value === '[' && next && next.value === ']' && next2 && assignmentOps.includes(next2.value)) {
          findings.push({ kind: 'HARD_FAIL:DOM_STRING', file: filePath, symbol: 'innerHTML_bracket', fingerprint: getContextFingerprint(tokens, i) });
        }
      }
      if (t.type === 'identifier' && t.value === 'insertAdjacentHTML') {
        if (prev && prev.value === '.' && next && next.value === '(') {
          findings.push({ kind: 'HARD_FAIL:DOM_STRING', file: filePath, symbol: 'insertAdjacentHTML', fingerprint: getContextFingerprint(tokens, i) });
        }
      }

      if (t.type === 'identifier' && (t.value === 'window' || t.value === 'globalThis')) {
        if (next && next.value === '.' && next2 && next2.type === 'identifier' && next3 && assignmentOps.includes(next3.value)) {
          findings.push({ kind: 'HARD_FAIL:GLOBAL_EXPOSURE', file: filePath, symbol: `${t.value}.${next2.value}`, fingerprint: getContextFingerprint(tokens, i) });
        }
        if (next && next.value === '[' && next2 && next2.type === 'string' && next3 && next3.value === ']') {
          const next4 = tokens[i + 4];
          if (next4 && assignmentOps.includes(next4.value)) {
            findings.push({ kind: 'HARD_FAIL:GLOBAL_EXPOSURE', file: filePath, symbol: `${t.value}[${next2.value}]`, fingerprint: getContextFingerprint(tokens, i) });
          }
        }
        if (prev && (prev.value === '++' || prev.value === '--')) {
          if (next && next.value === '.' && next2 && next2.type === 'identifier') {
            findings.push({ kind: 'HARD_FAIL:GLOBAL_EXPOSURE', file: filePath, symbol: `${t.value}.${next2.value}`, fingerprint: getContextFingerprint(tokens, i) });
          }
          if (next && next.value === '[' && next2 && next2.type === 'string' && next3 && next3.value === ']') {
            findings.push({ kind: 'HARD_FAIL:GLOBAL_EXPOSURE', file: filePath, symbol: `${t.value}[${next2.value}]`, fingerprint: getContextFingerprint(tokens, i) });
          }
        }
      }

      if (t.depth === 0) {
        if (t.type === 'keyword' && ['let', 'const', 'var'].includes(t.value)) {
          findings.push({ kind: 'REVIEW_REQUIRED:TOP_LEVEL_STATE', file: filePath, symbol: t.value, fingerprint: getContextFingerprint(tokens, i) });
        }
        if (t.type === 'keyword' && ['function', 'class'].includes(t.value)) {
          findings.push({ kind: 'REVIEW_REQUIRED:TOP_LEVEL_CONSTRUCT', file: filePath, symbol: t.value, fingerprint: getContextFingerprint(tokens, i) });
        }
        if (t.type === 'punctuator' && t.value === '=>') {
          findings.push({ kind: 'REVIEW_REQUIRED:TOP_LEVEL_CONSTRUCT', file: filePath, symbol: 'arrow_function', fingerprint: getContextFingerprint(tokens, i) });
        }
      }

      if (t.type === 'identifier' && t.value === 'callApiPost') {
        findings.push({ kind: 'REVIEW_REQUIRED:CALL_API_POST', file: filePath, symbol: 'callApiPost', fingerprint: getContextFingerprint(tokens, i) });
      }
    }

    if (isModule) {
      if (t.type === 'identifier' && (t.value === 'window' || t.value === 'globalThis')) {
        if (next && next.value === '.' && next2 && next2.type === 'identifier') {
          findings.push({ kind: 'REVIEW_REQUIRED:REVERSE_DEPENDENCY', file: filePath, symbol: `${t.value}.${next2.value}`, fingerprint: getContextFingerprint(tokens, i) });
        }
        if (next && next.value === '[' && next2 && next2.type === 'string' && next3 && next3.value === ']') {
          findings.push({ kind: 'REVIEW_REQUIRED:REVERSE_DEPENDENCY', file: filePath, symbol: `${t.value}[${next2.value}]`, fingerprint: getContextFingerprint(tokens, i) });
        }
      }
    }
  }
  return findings;
}

function walkDir(dir, files = []) {
  if (!existsSync(dir)) return files;
  const list = readdirSync(dir);
  for (const item of list) {
    const fullPath = join(dir, item);
    if (statSync(fullPath).isDirectory()) {
      walkDir(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

// --- 3. Core Gate Logic ---
export function runArchitectureGate(mockFiles = null) {
  let filesToScan = [];
  
  if (mockFiles) {
    filesToScan = mockFiles;
  } else {
    const filesSet = new Set();
    try {
      const allFiles = walkDir(resolve(rootDir, 'active/h-app'));
      for (const f of allFiles) {
        if (f.endsWith('.js')) {
          const relPath = f.replace(resolve(rootDir) + '/', '');
          filesSet.add(relPath.replace(/\\/g, '/'));
        }
      }
      try {
        execSync('git ls-tree -r --name-only HEAD active/h-app/', {cwd: rootDir, stdio: ['pipe', 'pipe', 'ignore']})
          .toString('utf8').split('\n').filter(f => f.endsWith('.js')).forEach(f => filesSet.add(f));
      } catch (e) {
        // HEAD might not have active/h-app if completely new, which is fine, we just fall back to WT files.
      }
    } catch (e) {
      console.error(`🛑 Failed to enumerate files: ${e.message}`);
      return { hasError: true };
    }
    
    for (const f of filesSet) {
      let headContent = '';
      let wtContent = '';

      try {
        const treeCheck = execSync(`git ls-tree HEAD "${f}"`, {cwd: rootDir, stdio: ['pipe', 'pipe', 'ignore']}).toString('utf8').trim();
        if (treeCheck) {
          try {
            headContent = execSync(`git show HEAD:"${f}"`, {cwd: rootDir, stdio: ['pipe', 'pipe', 'ignore']}).toString('utf8');
          } catch (e) {
            console.error(`🛑 Failed to read HEAD content for ${f}: ${e.message}`);
            return { hasError: true };
          }
        }
      } catch (e) {
        // If git ls-tree fails (e.g., path not in HEAD), headContent remains ''
      }

      if (existsSync(resolve(rootDir, f))) {
        try {
          wtContent = readFileSync(resolve(rootDir, f), 'utf8');
        } catch (e) {
          console.error(`🛑 Failed to read WT content for ${f}: ${e.message}`);
          return { hasError: true };
        }
      } else if (f === 'active/h-app/app.js') {
        console.error('🛑 WT active/h-app/app.js is missing!');
        return { hasError: true };
      }

      filesToScan.push({ filePath: f, headContent, wtContent });
    }
  }

  let hasError = false;
  let allWtMultiset = [];

  for (const file of filesToScan) {
    const { filePath, headContent, wtContent, wtMissing, headReadError } = file;

    if (headReadError) {
      console.error(`🛑 Failed to read HEAD content for ${filePath} (mock)`);
      return { hasError: true };
    }
    if (wtMissing) {
      console.error(`🛑 WT ${filePath} is missing!`);
      return { hasError: true };
    }

    const headTokens = tokenize(headContent);
    const wtTokens = tokenize(wtContent);

    const headFindings = analyzeTokens(headTokens, filePath);
    const wtFindings = analyzeTokens(wtTokens, filePath);

    const headMultiset = headFindings.map(f => `${f.kind}::${f.symbol}::${f.fingerprint}`);
    const wtMultiset = wtFindings.map(f => `${f.kind}::${f.symbol}::${f.fingerprint}`);

    for (const h of headMultiset) {
      const index = wtMultiset.indexOf(h);
      if (index !== -1) {
        wtMultiset.splice(index, 1);
      }
    }
    
    if (filePath === 'active/h-app/app.js') {
      const headLines = headContent ? headContent.split('\n').length : 0;
      const wtLines = wtContent ? wtContent.split('\n').length : 0;
      if (wtLines > headLines) {
        console.warn(`⚠️ [WARN] ${filePath} line count increased!`);
        console.warn(`   HEAD lines: ${headLines}`);
        console.warn(`   WT lines:   ${wtLines}`);
        console.warn(`   Delta:      +${wtLines - headLines}`);
      }
      file.wtLines = wtLines;
      file.headLines = headLines;
    }

    if (wtMultiset.length > 0) {
      console.error(`\n🛑 [Architecture Guard Failed] Net-New Violations Detected in ${filePath}:`);
      for (const v of wtMultiset) {
        const [kind, symbol, fingerprint] = v.split('::');
        console.error(`   - [${kind}] ${symbol}`);
        console.error(`     Fingerprint: ${fingerprint}`);
        hasError = true;
      }
      allWtMultiset.push(...wtMultiset);
    }
  }

  return { hasError, newViolations: allWtMultiset, scannedFiles: filesToScan };
}

import { fileURLToPath } from 'url';
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runArchitectureGate();
  if (result.hasError) {
    process.exit(1);
  }
  console.log('✅ [Architecture Guard] PASSED: No Net-New Architecture Violations.');
  process.exit(0);
}
