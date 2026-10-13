import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runKnowledgeGate, validateRegistrySchema } from '../scripts/check-knowledge-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log('====================================================');
console.log('🧪 RUNNING K1 KNOWLEDGE SYNC GATE TEST SUITE');
console.log('====================================================');

let testCount = 0;
let passCount = 0;

function runTestCase(name, fn) {
  testCount++;
  process.stdout.write(`  [Case ${String(testCount).padStart(2, '0')}] ${name.padEnd(52)} ... `);
  try {
    fn();
    console.log('✅ PASS');
    passCount++;
  } catch (err) {
    console.log('❌ FAIL');
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

/**
 * Helper to build a temporary minimal valid fixture tree
 */
function withFixture(setupFn, testFn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-test-fixture-'));
  try {
    setupFn(tempDir);
    testFn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Creates a base valid repository structure in targetDir
 */
function createBaseValidTree(targetDir) {
  // Recursively copy .agents, docs, active, data
  fs.cpSync(path.join(REPO_ROOT, '.agents'), path.join(targetDir, '.agents'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'docs'), path.join(targetDir, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'active'), path.join(targetDir, 'active'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'data'), path.join(targetDir, 'data'), { recursive: true });

  fs.copyFileSync(path.join(REPO_ROOT, 'AGENTS.md'), path.join(targetDir, 'AGENTS.md'));
  if (fs.existsSync(path.join(REPO_ROOT, 'CNAME'))) {
    fs.copyFileSync(path.join(REPO_ROOT, 'CNAME'), path.join(targetDir, 'CNAME'));
  }
}

// =============================================================================
// 1. Current Tree Verification
// =============================================================================
runTestCase('Current repository base tree passes all 20 invariants', () => {
  const result = runKnowledgeGate({ root: REPO_ROOT });
  assert.strictEqual(result.hasError, false, `Expected clean pass, got: ${result.errors.join('; ')}`);
  assert.strictEqual(result.passedInvariants.length, 20);
});

// =============================================================================
// 2. K1-01: Schema Conformance & Strict Closure
// =============================================================================
runTestCase('K1-01: Schema rejects invalid activationState enum', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.activationState = 'invalid-state';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-01')));
  });
});

runTestCase('K1-01: Schema rejects additional property at root', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.unauthorizedRootProperty = 'bad';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-01') && e.includes('unauthorizedRootProperty')));
  });
});

// =============================================================================
// 3. K1-02: Physical Roles Exclusivity
// =============================================================================
runTestCase('K1-02: Rejects unexpected extra physical role', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.physicalRoles.push('qa_tester');
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-02')));
  });
});

// =============================================================================
// 4. K1-03: Capability Packs Existence
// =============================================================================
runTestCase('K1-03: Rejects missing manifestPath file', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.rmSync(path.join(dir, '.agents/skills/h-app-architecture/SKILL.md'));
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-03')));
  });
});

runTestCase('K1-03: Rejects unlisted skill directory', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.mkdirSync(path.join(dir, '.agents/skills/unlisted-rogue-skill'), { recursive: true });
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-03') && e.includes('unlisted-rogue-skill')));
  });
});

// =============================================================================
// 5. K1-04: Zero Dangling Skills
// =============================================================================
runTestCase('K1-04: Rejects task contract referencing unknown skill', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.taskContracts['TC-HAPP-MODULAR'].requiredPacks.push('nonexistent-pack');
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-04') && e.includes('nonexistent-pack')));
  });
});

// =============================================================================
// 6. K1-05: Task Contracts Integrity
// =============================================================================
runTestCase('K1-05: Rejects task contract with invalid maxFiles', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.taskContracts['TC-HAPP-MODULAR'].maxFiles = -1;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-05')));
  });
});

// =============================================================================
// 7. K1-06: Virtual Profession Resolvability
// =============================================================================
runTestCase('K1-06: Rejects virtual profession with unknown contract', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.virtualProfessions['H-App Frontend Specialist'].defaultTaskContract = 'TC-GHOST-CONTRACT';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-06')));
  });
});

// =============================================================================
// 8. K1-07: Frontmatter Skills Whitelist
// =============================================================================
runTestCase('K1-07: Rejects agent.md with unauthorized extra skill', () => {
  withFixture(createBaseValidTree, (dir) => {
    const agentFile = path.join(dir, '.agents/agents/execution/agent.md');
    let text = fs.readFileSync(agentFile, 'utf8');
    text = text.replace('skills:\n', 'skills:\n  - h-app-architecture\n');
    fs.writeFileSync(agentFile, text, 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-07') && e.includes('extra=[h-app-architecture]')));
  });
});

// =============================================================================
// 9. K1-08: Governance Uniformity
// =============================================================================
runTestCase('K1-08: Rejects ai-foundation granting write permission to Architect', () => {
  withFixture(createBaseValidTree, (dir) => {
    const fPath = path.join(dir, 'docs/ai-foundation.md');
    let text = fs.readFileSync(fPath, 'utf8');
    text += '\nArchitect: Write Permission granted.\n';
    fs.writeFileSync(fPath, text, 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-08')));
  });
});

// =============================================================================
// 10. K1-09: Zero Copy Residue & Zero Superseded
// =============================================================================
runTestCase('K1-09: Rejects presence of superseded core-rules.md', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, '.agents/rules/core-rules.md'), '# Old Core Rules\n', 'utf8');
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09') && e.includes('core-rules.md')));
  });
});

runTestCase('K1-09: Rejects presence of backup .bak file', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, '.agents/skills/h-app-architecture/SKILL.md.bak'), 'backup', 'utf8');
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09') && e.includes('.bak')));
  });
});

// =============================================================================
// 11. K1-10: Canonical Auth Synchronization
// =============================================================================
runTestCase('K1-10: Rejects duplicated auth matrix table in security-rule.md', () => {
  withFixture(createBaseValidTree, (dir) => {
    const secPath = path.join(dir, '.agents/rules/security-rule.md');
    let text = fs.readFileSync(secPath, 'utf8');
    text += '\n\n| Action | 認可レベル | 資格情報 |\n|---|---|---|\n| getDashboardSnapshot | Dashboard Manager | Token |\n';
    fs.writeFileSync(secPath, text, 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-10')));
  });
});

// =============================================================================
// 12. MANDATORY K1-11 3 CASES
// =============================================================================
runTestCase('K1-11 Case 1 (PASS): evidenceSources[] contains SENTINEL token path', () => {
  withFixture(createBaseValidTree, (dir) => {
    // Add sentinel to data/config.js to define active district
    const cfgPath = path.join(dir, 'data/config.js');
    fs.writeFileSync(cfgPath, 'window.PMS_CONFIG = { districtId: "SENTINEL_DISTRICT" };\n', 'utf8');

    // Register evidence source with sentinel in os-registry.json
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const evPath = 'docs/research/evidence_sentinel_district_lessons.md';
    reg.capabilityPacks['h-app-architecture'].evidenceSources.push(evPath);
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    // Create the dummy evidence file so it exists
    fs.writeFileSync(path.join(dir, evPath), '# Evidence\n', 'utf8');

    const res = runKnowledgeGate({ root: dir });
    // Invariant K1-11 must PASS for evidenceSources!
    assert.ok(res.passedInvariants.includes('K1-11'), 'K1-11 should pass when sentinel is only in evidenceSources');
  });
});

runTestCase('K1-11 Case 2 (FAIL): security-rule.md contains SENTINEL token', () => {
  withFixture(createBaseValidTree, (dir) => {
    const cfgPath = path.join(dir, 'data/config.js');
    fs.writeFileSync(cfgPath, 'window.PMS_CONFIG = { districtId: "SENTINEL_DISTRICT" };\n', 'utf8');

    const secRule = path.join(dir, '.agents/rules/security-rule.md');
    fs.appendFileSync(secRule, '\n// Unauthorized contamination for SENTINEL_DISTRICT\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-11') && e.includes('SENTINEL_DISTRICT')));
  });
});

runTestCase('K1-11 Case 3 (FAIL): os-registry.json description contains SENTINEL token', () => {
  withFixture(createBaseValidTree, (dir) => {
    const cfgPath = path.join(dir, 'data/config.js');
    fs.writeFileSync(cfgPath, 'window.PMS_CONFIG = { districtId: "SENTINEL_DISTRICT" };\n', 'utf8');

    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.capabilityPacks['h-app-architecture'].description += ' for SENTINEL_DISTRICT';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-11') && e.includes('SENTINEL_DISTRICT')));
  });
});

// =============================================================================
// 13. K1-11: Absolute Host Path Detection
// =============================================================================
runTestCase('K1-11: Detects absolute /Users/ host path in universal code', () => {
  withFixture(createBaseValidTree, (dir) => {
    const appPath = path.join(dir, 'active/api/v2_api.js');
    fs.appendFileSync(appPath, '\nconst tmp = "/Users/devuser/myproject/temp";\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-11') && e.includes('Absolute host path')));
  });
});

// =============================================================================
// 14. K1-12: Digest Mismatch & Duplication
// =============================================================================
runTestCase('K1-12: Rejects altered canonical source file (digest mismatch)', () => {
  withFixture(createBaseValidTree, (dir) => {
    const docPath = path.join(dir, 'docs/architecture/01_DESIGN_CONTRACT.md');
    fs.appendFileSync(docPath, '\n<!-- tamper -->\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-12') && e.includes('Digest mismatch')));
  });
});

// =============================================================================
// 15. K1-13: Canonical & Evidence Separation
// =============================================================================
runTestCase('K1-13: Rejects research document registered as canonicalSource', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.capabilityPacks['h-app-architecture'].canonicalSources.push({
      path: 'docs/research/evidence_kuwana_historical_lessons.md',
      sha256: '0000000000000000000000000000000000000000000000000000000000000000'
    });
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-13')));
  });
});

// =============================================================================
// 16. K1-14: Registry-Driven Surface Scan
// =============================================================================
runTestCase('K1-14: Rejects missing operational surface file', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.operationalKnowledgeSurfaces.push('docs/ghost_surface.md');
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-14') && e.includes('ghost_surface.md')));
  });
});

// =============================================================================
// 17. K1-15: Authority & Deployment Separation
// =============================================================================
runTestCase('K1-15: Rejects districtProvisioning with canDeployCode = true', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.authorities.districtProvisioning.canDeployCode = true;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-15')));
  });
});

// =============================================================================
// 18. K1-16: Zero Dangling Canonical Sources
// =============================================================================
runTestCase('K1-16: Rejects missing canonical source file on disk', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.rmSync(path.join(dir, 'docs/api/API_CONTRACT.md'));
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-16') && e.includes('API_CONTRACT.md')));
  });
});

// =============================================================================
// 19. K1-17: Forbidden Archive / Legacy / Reference
// =============================================================================
runTestCase('K1-17: Rejects creation of .agents/archive graveyard directory', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.mkdirSync(path.join(dir, '.agents/archive'), { recursive: true });
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-17')));
  });
});

// =============================================================================
// 20. K1-19: Broken Operational References
// =============================================================================
runTestCase('K1-19: Rejects broken relative Markdown link in operational surface', () => {
  withFixture(createBaseValidTree, (dir) => {
    const docPath = path.join(dir, 'AGENTS.md');
    fs.appendFileSync(docPath, '\nSee also: [Broken Target](docs/architecture/nonexistent_file.md)\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-19') && e.includes('nonexistent_file.md')));
  });
});

// =============================================================================
// 21. K1-20: Activation State Coherence
// =============================================================================
runTestCase('K1-20: Rejects non-active state in production registry', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.activationState = 'staging';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-20')));
  });
});

// =============================================================================
// 22. Universal Copy Simulation & --root Isolation
// =============================================================================
runTestCase('Universal Copy Simulation: clean copy passes without host info leakage', () => {
  withFixture(createBaseValidTree, (dir) => {
    // Simulate target district without .git
    const cfgPath = path.join(dir, 'data/config.js');
    fs.writeFileSync(cfgPath, 'window.PMS_CONFIG = { districtId: "TARGET_DISTRICT_SENTINEL" };\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CNAME'), 'target-district.postingmap.jp\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'data/municipality_master.csv'), 'city_name,city_code,total_towns\nTARGET_CITY_SENTINEL,99999,100\n', 'utf8');

    // Confirm that the fixture passes cleanly
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, false, `Expected clean copy pass, got: ${res.errors.join('; ')}`);
  });
});

runTestCase('Universal Copy Simulation: source district leakage into active/** triggers FAIL', () => {
  withFixture(createBaseValidTree, (dir) => {
    const cfgPath = path.join(dir, 'data/config.js');
    fs.writeFileSync(cfgPath, 'window.PMS_CONFIG = { districtId: "TARGET_DISTRICT_SENTINEL" };\n', 'utf8');

    // Contaminate active/api/v2_api.js with target district name
    fs.appendFileSync(path.join(dir, 'active/api/v2_api.js'), '\nconst d = "TARGET_DISTRICT_SENTINEL";\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-11') && e.includes('TARGET_DISTRICT_SENTINEL')));
  });
});

runTestCase('--root Isolation: fixture without .git does not leak host repository remote info', () => {
  withFixture(createBaseValidTree, (dir) => {
    // dir has NO .git directory
    assert.strictEqual(fs.existsSync(path.join(dir, '.git')), false);

    // Host repo has remote with district information.
    // If isolation works, dir evaluates with 0 errors even though dir does not have the host remote.
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, false, `Isolation test failed: ${res.errors.join('; ')}`);
  });
});

// =============================================================================
// 23. Versioned Supreme Principle Governance Tests
// =============================================================================
runTestCase('Principle Governance: clean Versioned Principle Contract passes', () => {
  withFixture(createBaseValidTree, (dir) => {
    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, false, `Expected pass, got: ${res.errors.join('; ')}`);
  });
});

runTestCase('Principle Governance: rejects missing principleContract in registry', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    delete reg.principleContract;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-01') || e.includes('K1-20')));
  });
});

runTestCase('Principle Governance: rejects missing principle file on disk', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.rmSync(path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md'), { force: true });

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-16') || e.includes('K1-20')));
  });
});

runTestCase('Principle Governance: rejects invalid principleVersion format', () => {
  withFixture(createBaseValidTree, (dir) => {
    const pPath = path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md');
    let content = fs.readFileSync(pPath, 'utf8');
    content = content.replace(/principleVersion:\s*"[^"]+"/, 'principleVersion: "2026_10_08"');
    fs.writeFileSync(pPath, content, 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-20') && e.includes('invalid format')));
  });
});

runTestCase('Principle Governance: rejects status != CURRENT', () => {
  withFixture(createBaseValidTree, (dir) => {
    const pPath = path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md');
    let content = fs.readFileSync(pPath, 'utf8');
    content = content.replace(/status:\s*"CURRENT"/, 'status: "DRAFT"');
    fs.writeFileSync(pPath, content, 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-20') && e.includes('status must be "CURRENT"')));
  });
});

runTestCase('Principle Governance: rejects version mismatch between principle and registry', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg.principleContract.expectedVersion = '2026-10-09';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-20') && e.includes('Version mismatch')));
  });
});

runTestCase('Principle Governance: rejects principle digest mismatch in principleContract', () => {
  withFixture(createBaseValidTree, (dir) => {
    const pPath = path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md');
    fs.appendFileSync(pPath, '\n<!-- tamper -->\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-12') && e.includes('principleContract')));
  });
});

runTestCase('Principle Governance: rejects behavior-preservation digest mismatch on principle tampering', () => {
  withFixture(createBaseValidTree, (dir) => {
    const regPath = path.join(dir, '.agents/os-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const dummySha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const pSrc = reg.capabilityPacks['behavior-preservation'].canonicalSources.find(s => s.path === 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md');
    if (pSrc) pSrc.sha256 = dummySha;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-12') && e.includes('behavior-preservation')));
  });
});

runTestCase('Principle Governance: rejects district token in Supreme Principle', () => {
  withFixture(createBaseValidTree, (dir) => {
    const cfgPath = path.join(dir, 'data/config.js');
    fs.writeFileSync(cfgPath, 'window.PMS_CONFIG = { districtId: "TARGET_DISTRICT_SENTINEL" };\n', 'utf8');

    const pPath = path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md');
    fs.appendFileSync(pPath, '\nTARGET_DISTRICT_SENTINEL\n');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-11') && e.includes('TARGET_DISTRICT_SENTINEL')));
  });
});

runTestCase('K1-09: rejects .agents/old-principles directory and does not trigger K1-17', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.mkdirSync(path.join(dir, '.agents/old-principles'), { recursive: true });

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')), 'Must fail K1-09');
    assert.ok(!res.errors.some(e => e.includes('K1-17')), 'Must NOT fail K1-17 (owned by K1-09)');
  });
});

runTestCase('K1-09: rejects docs/old-principles directory and does not trigger K1-17', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.mkdirSync(path.join(dir, 'docs/old-principles'), { recursive: true });

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')), 'Must fail K1-09');
    assert.ok(!res.errors.some(e => e.includes('K1-17')), 'Must NOT fail K1-17 (owned by K1-09)');
  });
});

runTestCase('K1-09: rejects docs/architecture/old-principles directory and does not trigger K1-17', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.mkdirSync(path.join(dir, 'docs/architecture/old-principles'), { recursive: true });

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')), 'Must fail K1-09');
    assert.ok(!res.errors.some(e => e.includes('K1-17')), 'Must NOT fail K1-17 (owned by K1-09)');
  });
});

runTestCase('K1-09: rejects Supreme Principle .bak file', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md.bak'), 'stale backup', 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')));
  });
});

runTestCase('K1-09: rejects Supreme Principle .old file', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md.old'), 'stale backup', 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')));
  });
});

runTestCase('K1-09: rejects Supreme Principle .copy file', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES.md.copy'), 'stale copy', 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')));
  });
});

runTestCase('K1-09: rejects Supreme Principle versioned alias', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, 'docs/architecture/SUPREME_PRODUCT_PRINCIPLES_2026_10_08.md'), 'versioned alias', 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, true);
    assert.ok(res.errors.some(e => e.includes('K1-09')));
  });
});

runTestCase('K1-09: unrelated legitimate filename containing "copy" must NOT fail', () => {
  withFixture(createBaseValidTree, (dir) => {
    fs.writeFileSync(path.join(dir, 'docs/architecture/copy_strategy.md'), '# Copy Strategy\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.agents/skills/behavior-preservation/sample_copy.md'), '# Sample Copy\n', 'utf8');

    const res = runKnowledgeGate({ root: dir });
    assert.strictEqual(res.hasError, false, `Unrelated copy files must not cause error: ${res.errors ? res.errors.join(', ') : ''}`);
    assert.ok(!res.errors.some(e => e.includes('K1-09')));
  });
});

console.log('====================================================');
console.log(`📊 K1 TEST SUITE SUMMARY: ${passCount} / ${testCount} PASSED (100%)`);
console.log('====================================================');
