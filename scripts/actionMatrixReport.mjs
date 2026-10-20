// node scripts/actionMatrixReport.mjs <report.json> [cost.json]: prints the outcome histogram, per-command counts, the error findings and
// the build failures of an action matrix report (ACTION_MATRIX_REPORT) and the slowest designs of a cost file (ACTION_MATRIX_COST_OUT).
import { readFileSync } from 'node:fs';

const say = (...parts) =>
  process.stdout.write(`${parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}
`);
const [reportFile, costFile] = process.argv.slice(2);
if (reportFile === undefined) {
  console.error('usage: node scripts/actionMatrixReport.mjs <report.json> [cost.json]');
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportFile, 'utf8'));
say(`kernel ${report.kernel}: ${report.rows.length} actions`, report.histogram);
const byCommand = {};
for (const row of report.rows) {
  const key = `${row.command}/${row.outcome}${row.errorKind ? `:${row.errorKind}` : ''}`;
  byCommand[key] = (byCommand[key] ?? 0) + 1;
}
say(byCommand);
const errors = report.rows.filter((row) => row.outcome === 'error');
for (const row of errors.slice(0, 40)) say('ERROR', row.key, row.errorKind, row.detail);
const unbuilt = report.rows.filter((row) => row.command === 'build_project' && row.outcome !== 'ok');
say(`designs that did not build: ${unbuilt.length}`);
for (const row of unbuilt.slice(0, 15)) say('  ', row.design, row.detail.slice(0, 140));
if (costFile !== undefined) {
  const costs = JSON.parse(readFileSync(costFile, 'utf8')).designs.sort((a, b) => b.ms - a.ms);
  say(`${costs.length} designs, ${costs.reduce((sum, d) => sum + d.ms, 0)} ms total; slowest:`, costs.slice(0, 8));
}
