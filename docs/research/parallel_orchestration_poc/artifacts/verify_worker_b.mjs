/**
 * scratch/parallel_test/verify_worker_b.mjs
 * Fixed unit test for Worker B
 */
import fs from 'fs';
import path from 'path';
import assert from 'assert';

const targetFile = path.resolve('scratch/parallel_test/worker_b_report.mjs');
if (!fs.existsSync(targetFile)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const mod = await import(targetFile);
assert.strictEqual(typeof mod.formatPostingReport, 'function', 'formatPostingReport must be exported');

const sampleMetrics = { totalHouseholds: 1000, requiredHours: 4 };
const output = mod.formatPostingReport(sampleMetrics);
assert.ok(output.includes('1000'), 'Report must contain total households');
assert.ok(output.includes('4h') || output.includes('4時間'), 'Report must contain required hours');

console.log('🟢 Worker B unit test PASSED');
process.exit(0);
