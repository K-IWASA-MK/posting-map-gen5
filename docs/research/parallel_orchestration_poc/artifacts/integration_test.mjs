/**
 * scratch/parallel_test/integration_test.mjs
 * Integration test combining Worker A and Worker B modules
 */
import assert from 'assert';
import path from 'path';

const fileA = path.resolve('scratch/parallel_test/worker_a_metric.mjs');
const fileB = path.resolve('scratch/parallel_test/worker_b_report.mjs');

const modA = await import(fileA);
const modB = await import(fileB);

const metrics = modA.calculatePostingMetrics(3000, 300);
assert.strictEqual(metrics.requiredHours, 10);

const report = modB.formatPostingReport(metrics);
assert.ok(report.includes('3000'));
console.log('--- Integrated Report Output ---');
console.log(report);
console.log('--------------------------------');

console.log('🟢 Parallel Worker Integration Test PASSED cleanly!');
process.exit(0);
