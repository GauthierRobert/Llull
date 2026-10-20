/**
 * PHY-09 random_response through fea_solve (TR-DYN-44, RS1 RS-7) with a scripted CalculiX: the deck refusal without damping (VC-DYN-40),
 * the TypeScript nodal rms field without llull-compute, DYN_POST_TOO_LARGE above the budget, and - when `llull-compute` is built - the
 * native `post random` field bit-identical to the TypeScript reference on the VC-DYN-21 strip and on a larger synthetic mesh with the
 * wall times of both engines (VC-DYN-48). The modal results are the exact Euler-Bernoulli data of tests/unit/cae/dynamics/solvedFixtures.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary } from '@cae/results/summary';
import { randomFieldInput, randomFieldReference, randomJobJson } from '@cae/dynamics/nodalField';
import { isPostProblem } from '@cae/dynamics/randomSetup';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { caeHooks } from '../src/fea/caeHooks';
import type { CcxRunner } from '../src/fea/ccxProcess';
import { runFeaSolve } from '../src/fea/feaSolve';
import { createComputeRunner, f64Bytes, f64Values, readOutput, withJobFolder } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { randomPostStep } from '../src/native/randomField';
import { mustRun, readyRandomStrip, strip } from '../../tests/unit/cae/dynamics/fixtures';
import { modalResults, stripMesh } from '../../tests/unit/cae/dynamics/solvedFixtures';
import { syntheticInput } from '../../tests/unit/cae/dynamics/syntheticBasis';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('dynamicsRandomField: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-dyn-store-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hostOf(start: CadDocument): FeaHost & { doc: () => CadDocument } {
  let doc = start;
  return {
    doc: () => doc,
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

/** Scripted CalculiX: writes placeholder result files; the hooks return the EB modal results of the mesh. */
const fakeCcx: CcxRunner = {
  run: async (jobDirectory, job) => {
    await writeFile(path.join(jobDirectory, `${job}.frd`), 'placeholder');
    await writeFile(path.join(jobDirectory, `${job}.dat`), 'placeholder');
    return { exitCode: 0, log: '', timedOut: false };
  },
  version: () => Promise.resolve('2.21'),
};

function meshed(
  doc: CadDocument,
  analysisId: string,
  boxId: string,
  cells?: readonly [number, number, number],
): { doc: CadDocument; mesh: FeMeshArtifact } {
  const mesh = stripMesh(doc, analysisId, boxId, cells);
  const constraintId = doc.analysis?.cases[analysisId]?.constraintOrder[0] ?? '';
  const withSets: FeMeshArtifact = {
    ...mesh,
    nodeSets: { [`C_${constraintId}`]: mesh.nodes.filter(([, x]) => x === 0).map(([id]) => id) },
  };
  const hash = store.put(withSets);
  const recorded = execute(
    doc,
    'record_fe_mesh',
    { analysisId, summary: meshSummary(withSets, hash) },
    { ...defaultContext(), feaArtifacts: store },
  );
  if (recorded.rejected === true) throw new Error(recorded.summary);
  return { doc: recorded.document, mesh: withSets };
}

function solveDeps(mesh: FeMeshArtifact, runner = createComputeRunner({}, null)): Parameters<typeof runFeaSolve>[3] {
  const modal = modalResults(mesh, 6);
  return {
    store,
    ccx: fakeCcx,
    hooks: { ...caeHooks, parseFrd: () => modal.steps, parseDat: () => modal.dat },
    randomPost: randomPostStep(runner, {}),
  };
}

function probed(): ReturnType<typeof readyRandomStrip> {
  const ready = readyRandomStrip();
  const doc = mustRun(ready.doc, 'add_result_probe', { analysisId: ready.analysisId, name: 'tip', point: [100, 10, 1.5], quantity: 'a_z' });
  return { ...ready, doc };
}

describe('fea_solve on random_response cases', () => {
  it('refuses a case without damping with the deck code (VC-DYN-40)', async () => {
    const bare = strip();
    const { doc, mesh } = meshed(bare.doc, bare.analysisId, bare.boxId);
    const result = await runFeaSolve(bare.analysisId, 60, hostOf(doc), solveDeps(mesh));
    expect(result).toMatchObject({ isError: true, data: { code: 'DYN_DAMPING_UNSET' } });
  });

  it('attaches the TypeScript nodal rms field without llull-compute and records the VC-DYN-21 probe', async () => {
    const ready = probed();
    const { doc, mesh } = meshed(ready.doc, ready.analysisId, ready.boxId);
    const host = hostOf(doc);
    const result = await runFeaSolve(ready.analysisId, 60, host, solveDeps(mesh));
    expect(result.isError, result.summary).toBe(false);
    expect(result.summary).toContain('in TypeScript (llull-compute not installed');
    expect(result.data).toMatchObject({ nodalField: { engine: 'ts', deterministic: true } });
    const summary = host.doc().analysis?.cases[ready.analysisId]?.results?.dynamics;
    expect(summary?.nodalField).toMatchObject({ engine: 'ts', nodes: mesh.nodes.length });
    const tip = summary?.probes[0];
    expect(tip?.kind === 'random' && Math.abs(tip.rms / 76.4330589827 - 1)).toBeLessThan(1e-6);
  });

  it('refuses before CalculiX when the field exceeds the TypeScript budget and llull-compute is absent (DYN_POST_TOO_LARGE)', () => {
    const ready = probed();
    const huge = mustRun(ready.doc, 'set_dynamic_basis', { analysisId: ready.analysisId, modes: 100 });
    const step = randomPostStep(createComputeRunner({}, null), {});
    const big: FeMeshArtifact = {
      ...stripMesh(huge, ready.analysisId, ready.boxId),
      nodes: Array.from({ length: 40_000 }, (_, i) => [i + 1, 0, 0, 0]),
    };
    expect(step.precheck(huge, ready.analysisId, big)).toMatchObject({ code: 'DYN_POST_TOO_LARGE' });
    expect(step.precheck(huge, ready.analysisId, stripMesh(huge, ready.analysisId, ready.boxId))).toBeNull();
    expect(randomPostStep(createComputeRunner({}, 'llull-compute'), {}).precheck(huge, ready.analysisId, big)).toBeNull();
  });

  native(
    'runs llull-compute post random: field bit-identical to the TypeScript reference (VC-DYN-48), recorded through fea_solve',
    async () => {
      const ready = probed();
      const { doc, mesh } = meshed(ready.doc, ready.analysisId, ready.boxId);
      const host = hostOf(doc);
      const runner = createComputeRunner({}, BINARY);
      const result = await runFeaSolve(ready.analysisId, 60, host, solveDeps(mesh, runner));
      expect(result.isError, result.summary).toBe(false);
      expect(result.data).toMatchObject({ nodalField: { engine: 'native-cpu' } });
      const stored = store.get((result.data as { resultsHash: string }).resultsHash) as FeResultsArtifact;
      expect(stored.nodalRms?.engine).toBe('native-cpu');
      const input = randomFieldInput(host.doc(), ready.analysisId, mesh, {
        ...stored,
        nodalRms: undefined,
      } as unknown as FeResultsArtifact);
      if (isPostProblem(input)) throw new Error(input.message);
      const reference = randomFieldReference(input);
      input.nodeIds.forEach((node, index) =>
        expect(stored.nodalRms?.values[String(node)]).toEqual(Array.from(reference.subarray(index * 12, index * 12 + 12))),
      );
    },
  );

  native(
    'larger mesh: native and TypeScript fields identical; wall times recorded (VC-DYN-48)',
    async () => {
      const ready = probed();
      const { doc, mesh } = meshed(ready.doc, ready.analysisId, ready.boxId, [200, 20, 6]);
      const modal = modalResults(mesh, 6);
      const partial: FeResultsArtifact = {
        kind: 'fe_results',
        meshHash: '',
        inputHash: analysisInputHash(doc, ready.analysisId, 'full'),
        solver: 'calculix',
        solverVersion: 't',
        ...modal,
      };
      const tsStarted = Date.now();
      const input = randomFieldInput(doc, ready.analysisId, mesh, partial);
      if (isPostProblem(input)) throw new Error(input.message);
      const reference = randomFieldReference(input);
      const tsMs = Date.now() - tsStarted;
      const step = randomPostStep(createComputeRunner({}, BINARY), {});
      const nativeRun = await step.run(doc, ready.analysisId, mesh, partial);
      if (!('results' in nativeRun)) throw new Error(nativeRun.message);
      expect(nativeRun.engine).toBe('native-cpu');
      const values = nativeRun.results.nodalRms?.values ?? {};
      let identical = true;
      input.nodeIds.forEach((node, index) => {
        const row = values[String(node)] ?? [];
        for (let c = 0; c < 12; c += 1) if (!Object.is(row[c], reference[index * 12 + c])) identical = false;
      });
      expect(identical).toBe(true);
      console.warn(
        `VC-DYN-48: ${input.nodeIds.length} nodes x 12 components x 6 modes: TS ${tsMs} ms (incl. job build), native ${nativeRun.elapsedMs} ms (incl. job build, spawn, I/O)`,
      );
    },
    120_000,
  );

  native(
    'heavy synthetic job (20 000 nodes x 60 modes x 12 components): identical fields, wall times recorded (VC-DYN-48)',
    async () => {
      const input = syntheticInput(2026, 20_000, 60, false);
      const tsStarted = Date.now();
      const reference = randomFieldReference(input);
      const tsMs = Date.now() - tsStarted;
      const runner = createComputeRunner({}, BINARY);
      const files = { 'job.json': JSON.stringify(randomJobJson(input)), 'modal.f64': f64Bytes(input.modal) };
      const outcome = await withJobFolder(files, async (folder) => {
        const run = await runner.run(['post', 'random'], folder, 600_000);
        expect(run.ok, run.message).toBe(true);
        return { field: f64Values(await readOutput(folder, run, 'field.f64')), ms: run.elapsedMs };
      });
      expect(outcome.field.length).toBe(reference.length);
      expect(outcome.field.every((value, index) => Object.is(value, reference[index]))).toBe(true);
      console.warn(
        `VC-DYN-48: 20000 nodes x 12 components x 60 modes: TS reference ${tsMs} ms, llull-compute post random ${outcome.ms} ms (process incl. I/O)`,
      );
    },
    600_000,
  );
});
