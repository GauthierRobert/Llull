// node scripts/actionMatrixMergeCosts.mjs <out.json> <cost.json>...: merges the per-shard cost files of an action matrix run into one
// { designs: [{ design, ms, actions }] } file that the next run feeds to --costs to balance its shards.
import { readFileSync, writeFileSync } from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (out === undefined || inputs.length === 0) {
  console.error('usage: node scripts/actionMatrixMergeCosts.mjs <out.json> <cost.json>...');
  process.exit(2);
}
const byDesign = new Map();
for (const file of inputs) for (const entry of JSON.parse(readFileSync(file, 'utf8')).designs ?? []) byDesign.set(entry.design, entry);
const designs = [...byDesign.values()].sort((a, b) => (a.design < b.design ? -1 : 1));
writeFileSync(out, `${JSON.stringify({ designs }, null, 2)}\n`);
process.stdout.write(`${designs.length} designs, ${designs.reduce((sum, d) => sum + d.ms, 0)} ms -> ${out}\n`);
