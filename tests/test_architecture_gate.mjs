import assert from 'assert';
import { execSync } from 'child_process';
import { runArchitectureGate } from '../scripts/check-architecture-gate.mjs';
import fs from 'fs';
import path from 'path';

const PASS_TESTS = [
  {
    name: 'comment内 innerHTML',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: '// el.innerHTML = "hi";\n/* el["innerHTML"] = "test" */' }]
  },
  {
    name: 'template literalのplain textに "window.foo =" があるだけ',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: '{ const a = `plain window.foo = text`; }' }]
  },
  {
    name: 'existing reverse dependency無変更',
    files: [{ filePath: 'active/h-app/modules/api.js', headContent: 'window.waitForLiffAuthReady();', wtContent: 'window.waitForLiffAuthReady();' }]
  }
];

const FAIL_TESTS = [
  {
    name: 'template interpolation内 window.foo =',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'const a = `${(window.foo = 1)}`;' }]
  },
  {
    name: 'window.foo ??=',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'window.foo ??= 1;' }]
  },
  {
    name: 'window.foo ||=',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'window.foo ||= 1;' }]
  },
  {
    name: 'reverse dependencyをmodules/*.jsへ追加',
    files: [{ filePath: 'active/h-app/modules/api.js', headContent: '', wtContent: 'window.appState;' }]
  },
  {
    name: 'reverse dependencyをrender.jsへ追加',
    files: [{ filePath: 'active/h-app/render.js', headContent: '', wtContent: 'window.renderState;' }]
  },
  {
    name: 'HEAD baseline取得不能',
    files: [{ filePath: 'active/h-app/app.js', headContent: null, wtContent: 'var a = 1;', headReadError: true }]
  },
  {
    name: 'WT app.js消失',
    files: [{ filePath: 'active/h-app/app.js', headContent: 'var a = 1;', wtContent: null, wtMissing: true }]
  },
  {
    name: 'window.counter++',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'window.counter++;' }]
  },
  {
    name: 'window.counter--',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'window.counter--;' }]
  },
  {
    name: '++window.counter',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: '++window.counter;' }]
  },
  {
    name: '--window.counter',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: '--window.counter;' }]
  },
  {
    name: 'globalThis.counter++',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'globalThis.counter++;' }]
  },
  {
    name: '++globalThis.counter',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: '++globalThis.counter;' }]
  },
  {
    name: 'window[\'counter\']++',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'window[\'counter\']++;' }]
  },
  {
    name: '++window[\'counter\']',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: '++window[\'counter\'];' }]
  }
];

const REVIEW_TESTS = [
  {
    name: 'top-level class NewFeature {}',
    files: [{ filePath: 'active/h-app/app.js', headContent: '', wtContent: 'class NewFeature {}' }]
  }
];

let failed = false;

function runTest(test, expectedError) {
  const res = runArchitectureGate(test.files);
  try {
    assert.strictEqual(res.hasError, expectedError, `${test.name}: expected hasError=${expectedError} but got ${res.hasError}`);
    console.log(`✅ ${test.name}`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    failed = true;
  }
}

console.log("--- RUNNING ARCHITECTURE GATE TESTS ---");
console.log("\n[PASS TESTS]");
for (const t of PASS_TESTS) runTest(t, false);

console.log("\n[FAIL TESTS]");
for (const t of FAIL_TESTS) runTest(t, true);

console.log("\n[REVIEW_REQUIRED TESTS]");
for (const t of REVIEW_TESTS) runTest(t, true);

// Integration Test simulation
console.log("\n[INTEGRATION TESTS]");
const os = await import('os');
const rootDir = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-gate-test-'));

try {
  execSync('git init', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: tempDir });
  execSync('git config user.email "test@example.com"', { cwd: tempDir });

  fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'active/h-app/modules'), { recursive: true });

  fs.copyFileSync(path.join(rootDir, 'scripts/check-scope.mjs'), path.join(tempDir, 'scripts/check-scope.mjs'));
  fs.copyFileSync(path.join(rootDir, 'scripts/check-architecture-gate.mjs'), path.join(tempDir, 'scripts/check-architecture-gate.mjs'));
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Governance');

  const scope = ["scripts/check-scope.mjs", "active/h-app/app.js"];
  fs.writeFileSync(path.join(tempDir, '.agents/current-scope.json'), JSON.stringify(scope));
  fs.writeFileSync(path.join(tempDir, 'active/h-app/app.js'), 'window.existing = 1;');
  execSync('git add . && git commit -m "baseline"', { cwd: tempDir, stdio: 'ignore' });

  // Test 1: scope-only early exit
  fs.writeFileSync(path.join(tempDir, '.agents/current-scope.json'), JSON.stringify([...scope, "new.js"]));
  let res = execSync('node scripts/check-scope.mjs --scope-only', { cwd: tempDir, encoding: 'utf8' });
  assert.ok(res.includes('PASSED: Scope definition update isolated'), 'Test 1 failed');
  execSync('git checkout -- .agents/current-scope.json', { cwd: tempDir, stdio: 'ignore' });

  // Test 2: default Scope PASS -> Architecture Guard execution
  fs.writeFileSync(path.join(tempDir, 'active/h-app/app.js'), 'window.existing = 1;\n// comment');
  res = execSync('node scripts/check-scope.mjs', { cwd: tempDir, encoding: 'utf8' });
  assert.ok(res.includes('[Architecture Guard] Executing Mechanical Architecture Guard'), 'Test 2 failed');

  // Test 3: Architecture Guard FAIL -> audit gate non-zero
  fs.writeFileSync(path.join(tempDir, 'active/h-app/app.js'), 'window.existing = 1;\nwindow.foo = 2;');
  try {
    execSync('node scripts/check-scope.mjs', { cwd: tempDir, encoding: 'utf8', stdio: 'pipe' });
    throw new Error('Test 3: Should have failed');
  } catch (e) {
    assert.ok(e.status !== 0 && e.stderr.toString().includes('HARD_FAIL:GLOBAL_EXPOSURE'), 'Test 3 failed');
  }
  execSync('git checkout -- active/h-app/app.js', { cwd: tempDir, stdio: 'ignore' });

  // Test 4: Governance + app simultaneous modification -> separation FAIL
  fs.writeFileSync(path.join(tempDir, 'active/h-app/app.js'), 'window.existing = 1;\n// mod');
  fs.writeFileSync(path.join(tempDir, 'scripts/check-scope.mjs'), fs.readFileSync(path.join(tempDir, 'scripts/check-scope.mjs'), 'utf8') + '\n// mod');
  try {
    execSync('node scripts/check-scope.mjs', { cwd: tempDir, encoding: 'utf8', stdio: 'pipe' });
    throw new Error('Test 4: Should have failed');
  } catch (e) {
    assert.ok(e.status !== 0 && e.stderr.toString().includes('Governance Separation Violation'), 'Test 4 failed');
  }
  execSync('git checkout -- scripts/check-scope.mjs active/h-app/app.js', { cwd: tempDir, stdio: 'ignore' });

  // Test 5: Untracked new JS file is scanned
  // Track the modules directory so git status outputs the file path, not the directory path
  fs.writeFileSync(path.join(tempDir, 'active/h-app/modules/.keep'), '');
  execSync('git add active/h-app/modules/.keep', { cwd: tempDir, stdio: 'ignore' });
  
  fs.writeFileSync(path.join(tempDir, '.agents/current-scope.json'), JSON.stringify([...scope, "active/h-app/modules/storage.js"]));
  execSync('git add .agents/current-scope.json && git commit -m "update scope for test 5"', { cwd: tempDir, stdio: 'ignore' });
  
  fs.writeFileSync(path.join(tempDir, 'active/h-app/modules/storage.js'), 'window.appState;');
  // NOT running git add for storage.js
  try {
    execSync('node scripts/check-scope.mjs', { cwd: tempDir, encoding: 'utf8', stdio: 'pipe' });
    throw new Error('Test 5: Should have failed');
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    if (stderr.includes('Scope Violations Detected')) {
      throw new Error(`Test 5 failed with Scope Violation instead of Arch Guard: ${stderr}`);
    }
    assert.ok(e.status !== 0 && stderr.includes('REVIEW_REQUIRED:REVERSE_DEPENDENCY'), `Test 5 failed: Untracked file was not scanned. Stderr: ${stderr}, Stdout: ${stdout}`);
  }

} catch (e) {
  console.error(`❌ Integration test failed: ${e.message}`);
  failed = true;
}

if (failed) {
  process.exit(1);
} else {
  console.log("\n🎉 ALL ARCHITECTURE GATE TESTS PASSED!");
  process.exit(0);
}
