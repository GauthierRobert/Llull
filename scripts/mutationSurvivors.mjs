// node scripts/mutationSurvivors.mjs reports/mutation-<folder>.json [--lines N] [--examples N]
// Summarises a Stryker JSON report for docs/MUTATION.md: per-file score, then per file the lines with the most surviving or uncovered
// mutants (the clusters worth a new oracle part, golden plan or fuzz identity) with a few example mutations.
import { readFileSync } from 'node:fs';

const [reportPath, ...rest] = process.argv.slice(2);
if (reportPath === undefined) {
  console.error('usage: node scripts/mutationSurvivors.mjs <report.json> [--lines N] [--examples N]');
  process.exit(2);
}
const option = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? Number(rest[at + 1]) : fallback;
};
const hotLines = option('lines', 5);
const examples = option('examples', 2);

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const prefix = 'packages/core/src/commands/';
const totals = { killed: 0, survived: 0, noCoverage: 0 };
const rows = [];

for (const [file, entry] of Object.entries(report.files)) {
  const counts = { killed: 0, survived: 0, noCoverage: 0 };
  const open = [];
  for (const mutant of entry.mutants) {
    if (mutant.status === 'Killed' || mutant.status === 'Timeout') counts.killed++;
    else if (mutant.status === 'Survived') counts.survived++;
    else if (mutant.status === 'NoCoverage') counts.noCoverage++;
    else continue;
    if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') open.push(mutant);
  }
  for (const key of Object.keys(totals)) totals[key] += counts[key];
  const byLine = new Map();
  for (const mutant of open) {
    const line = mutant.location.start.line;
    byLine.set(line, [...(byLine.get(line) ?? []), mutant]);
  }
  const clusters = [...byLine.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, hotLines);
  rows.push({ file: file.replace(prefix, ''), counts, clusters, source: entry.source.split('\n') });
}

const print = (line) =>
  process.stdout.write(`${line}
`);
const score = ({ killed, survived, noCoverage }) => ((100 * killed) / Math.max(1, killed + survived + noCoverage)).toFixed(1);
print(`score ${score(totals)}%  killed ${totals.killed}  survived ${totals.survived}  no coverage ${totals.noCoverage}`);
for (const row of rows.sort((a, b) => b.counts.survived + b.counts.noCoverage - (a.counts.survived + a.counts.noCoverage))) {
  print(
    `\n${row.file}  ${score(row.counts)}%  (killed ${row.counts.killed}, survived ${row.counts.survived}, no coverage ${row.counts.noCoverage})`,
  );
  for (const [line, mutants] of row.clusters) {
    const status = mutants.every((m) => m.status === 'NoCoverage') ? 'uncovered' : 'survived';
    print(`  L${line} x${mutants.length} ${status}: ${(row.source[line - 1] ?? '').trim().slice(0, 110)}`);
    for (const m of mutants.slice(0, examples)) print(`      ${m.mutatorName} -> ${m.replacement.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
