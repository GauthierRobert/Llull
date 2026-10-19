// Writes tests/oracle/<nn-name>/{plan.json, expected.json} from the closed-form formulas in this folder.
// Run: node tools/oracle-analytic/generate.mjs   (or the Python port, `python -I tools/oracle-analytic/generate.py`, when available)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blendCases } from './casesBlends.mjs';
import { booleanCases } from './casesBooleans.mjs';
import { featureCases } from './casesFeatures.mjs';
import { featureDepthCases } from './casesFeatureDepth.mjs';
import { filletDepthCases } from './casesFilletDepth.mjs';
import { threadCases } from './casesThreads.mjs';
import { primitiveCases } from './casesPrimitives.mjs';
import { sheetMetalCases } from './casesSheetMetal.mjs';
import { profileCases } from './casesProfiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/oracle');
const cases = [];
for (const build of [
  primitiveCases,
  profileCases,
  booleanCases,
  featureCases,
  blendCases,
  sheetMetalCases,
  featureDepthCases,
  filletDepthCases,
  threadCases,
])
  build(cases);

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && /^\d{2,3}-/.test(entry.name)) rmSync(path.join(root, entry.name), { recursive: true });
}
const write = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
for (const { id, plan, expected } of cases) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'plan.json'), plan);
  write(path.join(dir, 'expected.json'), expected);
}
process.stdout.write(`wrote ${cases.length} oracle cases to ${root}\n`);
