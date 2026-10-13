/**
 * scratch/parallel_test/verify_worker_a.mjs
 * Fixed unit test for Worker A
 */
import fs from 'fs';
import path from 'path';
import assert from 'assert';

const targetFile = path.resolve('scratch/parallel_test/worker_a_metric.mjs');
if (!fs.existsSync(targetFile)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const mod = await import(targetFile);
assert.strictEqual(typeof mod.calculatePostingMetrics, 'function', 'calculatePostingMetrics must be exported');

const res = mod.calculatePostingMetrics(1000, 250);
assert.strictEqual(res.requiredHours, 4, '1000 households at 250/hr must take 4 hours');
assert.strictEqual(res.totalHouseholds, 1000);

console.log('🟢 Worker A unit test PASSED');
process.exit(0);
