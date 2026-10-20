/**
 * VC-DYN-48 (crate level): random-response jobs and their TypeScript nodal rms fields, written as the fixture `cargo test` reads
 * (solver/crates/llull-post/tests/fixtures/random_jobs.json; regenerate with LLULL_WRITE_NATIVE_FIXTURES=1). Cases: the Euler-Bernoulli strip
 * of VC-DYN-21 through the full TS pipeline (randomFieldInput of a recorded artifact) and seeded synthetic modal bases with viscous and
 * structural damping. `llull-post` must reproduce every value bit for bit (tests/random_reference.rs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeResultsArtifact } from '@core/model/analysis';
import { analysisInputHash } from '@cae/hash/inputHash';
import { randomFieldInput, randomFieldReference, randomJobJson, type RandomFieldInput } from '@cae/dynamics/nodalField';
import { isPostProblem } from '@cae/dynamics/randomSetup';
import { mustRun, readyRandomStrip } from '../cae/dynamics/fixtures';
import { modalResults, stripMesh } from '../cae/dynamics/solvedFixtures';
import { syntheticInput } from '../cae/dynamics/syntheticBasis';

const FIXTURE = path.resolve(__dirname, '../../../solver/crates/llull-post/tests/fixtures/random_jobs.json');
const WRITE = process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1';
// The nodal rms fields sample V8 Math, so the fixture is pinned to the Node major CI generates it with (another V8 can differ in the last ulp).
const FIXTURE_NODE_MAJOR = 22;
const v8Pinned = it.skipIf(!WRITE && Number(process.versions.node.split('.')[0]) !== FIXTURE_NODE_MAJOR);

function stripInput(): RandomFieldInput {
  const ready = readyRandomStrip();
  const doc = mustRun(ready.doc, 'set_dynamic_basis', { analysisId: ready.analysisId, modes: 6 });
  const mesh = stripMesh(doc, ready.analysisId, ready.boxId);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: '',
    inputHash: analysisInputHash(doc, ready.analysisId, 'full'),
    solver: 'calculix',
    solverVersion: 'test',
    ...modalResults(mesh, 6),
  };
  const input = randomFieldInput(doc, ready.analysisId, mesh, results);
  if (isPostProblem(input)) throw new Error(input.message);
  return input;
}

describe('llull-post random fixtures (VC-DYN-48 crate level)', () => {
  v8Pinned('writes the jobs and TypeScript nodal rms fields the Rust job must reproduce bit for bit', () => {
    const cases = [
      { name: 'eb_strip_vc_dyn_21', input: stripInput() },
      { name: 'synthetic_viscous', input: syntheticInput(48, 16, 20, false) },
      { name: 'synthetic_structural', input: syntheticInput(4848, 10, 8, true) },
    ].map(({ name, input }) => ({
      name,
      job: randomJobJson(input),
      modal: Array.from(input.modal),
      field: Array.from(randomFieldReference(input)),
    }));
    for (const entry of cases) expect(entry.field.every(Number.isFinite)).toBe(true);
    const text = `${JSON.stringify(cases)}\n`;
    if (WRITE) writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, 'utf8') === text, 'random_jobs.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
