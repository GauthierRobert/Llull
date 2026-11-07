/**
 * run_convergence_study (PHY-00 VNV-M3, host transport): the loop, the level documents and the final record, with FAKE mesh and solve transports (no
 * llull-mesh / ccx here) that write genuine content-addressed artifacts into an on-disk store and record them through the real registry commands, so the
 * record command verifies them exactly as it does a real run. ORACLE (hand-derived): value f(h) = F0 + C h^2 on tetrahedra grids of 12, 96, 768
 * elements (h doubles per level): order 2, extrapolated F0.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { representativeSpacing } from '@lib/convergence';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { meshMeasure } from '@cae/vnv/studyQuantity';
import { createFeArtifactStore } from '../../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../../server/src/fea/caeHooks';
import { runConvergenceStudy, type FeaConvergenceDeps } from '../../../../server/src/fea/feaConvergence';
import { barDocument, mustRun } from '../deckFixtures';
import { gridMesh } from '../gridMesh';
import { must, plateDocument } from '../shellFixtures';
import { C, F0 } from './studyFixtures';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-study-transport-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const store = createFeArtifactStore(directory);

const bar = barDocument();
const withProbe = mustRun(bar.doc, 'add_result_probe', {
  analysisId: bar.analysisId,
  name: 'mid',
  point: [1, 0.5, 0.5],
  quantity: 'von_mises',
});
const START = mustRun(withProbe, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 0.25, order: 1 });
const PROBE = Object.keys(START.analysis?.cases[bar.analysisId]?.probes ?? {})[0] ?? 'missing';
const ctx = { ...defaultContext(), feaArtifacts: store };

const outcome = (result: ReturnType<typeof execute>): FeaToolResult => ({
  summary: result.summary,
  affected: result.affected,
  isError: result.rejected === true,
});

/** A host over `initial` that records through the real commands. */
function hostOf(initial: CadDocument): FeaHost & { readonly current: () => CadDocument } {
  let current = initial;
  return {
    current: () => current,
    getDoc: () => current,
    applyCommand: (name, params) => {
      const result = execute(current, name, params, ctx);
      if (result.rejected !== true) current = result.document;
      return outcome(result);
    },
  };
}

interface Fakes {
  readonly meshCalls: number[];
  readonly deps: FeaConvergenceDeps;
}

/** Fake transports: the mesh has 1/globalSize cells per unit, the solution is the power law of the representative spacing. */
function fakes(overrides: Partial<FeaConvergenceDeps> = {}, failAt?: { stage: 'mesh' | 'solve'; call: number }): Fakes {
  const meshCalls: number[] = [];
  let solveCalls = 0;
  const volume = { current: 0 };
  const deps: FeaConvergenceDeps = {
    store,
    hooks: caeHooks,
    mesh: (analysisId, host) => {
      const doc = host.getDoc();
      const size = doc.analysis?.cases[analysisId]?.mesh.globalSize ?? 1;
      meshCalls.push(size);
      if (failAt?.stage === 'mesh' && failAt.call === meshCalls.length)
        return Promise.resolve({
          summary: 'fea_mesh FEA_MESH_FAILED: boom',
          affected: [],
          isError: true,
          data: { code: 'FEA_MESH_FAILED' },
        });
      const cells = Math.round(1 / size);
      const grid = gridMesh({ cells: [2 * cells, cells, cells], size: [2, 1, 1] });
      const mesh: FeMeshArtifact = {
        kind: 'fe_mesh',
        unitSystem: 'N-mm-t-s',
        mesher: 'fake',
        mesherVersion: '1',
        inputHash: analysisInputHash(doc, analysisId, 'mesh'),
        nodes: grid.nodes,
        blocks: [{ type: 'C3D4', entityId: bar.boxId, elements: grid.elements.map((nodes, index) => [index + 1, ...nodes]) }],
        nodeSets: {},
        faceSets: {},
        targets: {},
      };
      return Promise.resolve(host.applyCommand('record_fe_mesh', { analysisId, summary: meshSummary(mesh, store.put(mesh)) }));
    },
    solve: (analysisId, _options, host) => {
      solveCalls += 1;
      if (failAt?.stage === 'solve' && failAt.call === solveCalls)
        return Promise.resolve({
          summary: 'fea_solve FEA_SOLVER_FAILED: no',
          affected: [],
          isError: true,
          data: { code: 'FEA_SOLVER_FAILED' },
        });
      const doc = host.getDoc();
      const meshHash = doc.analysis?.cases[analysisId]?.meshSummary?.meshHash ?? '';
      const mesh = store.get(meshHash);
      if (mesh?.kind !== 'fe_mesh') return Promise.resolve({ summary: 'no mesh', affected: [], isError: true });
      const measure = meshMeasure(mesh);
      if ('code' in measure) return Promise.resolve({ summary: measure.message, affected: [], isError: true });
      if (volume.current === 0) volume.current = measure.value;
      const h = representativeSpacing(volume.current, measure.elements, 3);
      const results: FeResultsArtifact = {
        kind: 'fe_results',
        meshHash,
        inputHash: analysisInputHash(doc, analysisId, 'full'),
        solver: 'fake-ccx',
        solverVersion: '1',
        steps: [
          {
            step: 1,
            time: 1,
            fields: {
              DISP: { components: ['D1', 'D2', 'D3'], values: Object.fromEntries(mesh.nodes.map((node) => [String(node[0]), [0, 0, 0]])) },
              STRESS: {
                components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
                values: Object.fromEntries(mesh.nodes.map((node) => [String(node[0]), [F0 + C * h * h, 0, 0, 0, 0, 0]])),
              },
            },
          },
        ],
      };
      const resultsHash = store.put(results);
      return Promise.resolve(
        host.applyCommand('record_fea_results', { analysisId, summary: resultsSummary(doc, analysisId, mesh, results, resultsHash) }),
      );
    },
    ...overrides,
  };
  return { meshCalls, deps };
}

const QUANTITY = { kind: 'field_max', field: 'von_mises', loadCase: 'LC1' };

describe('run_convergence_study', () => {
  it('meshes and solves three levels (coarsest first) in copies, then records a study the command verifies', async () => {
    const host = hostOf(START);
    const { deps, meshCalls } = fakes();
    const ownMesh = START.analysis?.cases[bar.analysisId]?.mesh;
    const result = await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY }, host, deps);
    expect(result.isError).toBe(false);
    expect(meshCalls).toEqual([1, 0.5, 0.25]);
    expect(result.summary).toMatch(
      /3 levels, globalSize 0\.2500 \/ 0\.5000 \/ 1\.000\. record_convergence_study: 'cs-\d+\.\d+'.*observed order 2\.000/,
    );
    expect(result.data).toMatchObject({ ratio: 2, next: 'check_verification' });
    const analysisCase = host.current().analysis?.cases[bar.analysisId];
    expect(analysisCase?.mesh).toEqual(ownMesh);
    expect(analysisCase).not.toHaveProperty('meshSummary');
    expect(analysisCase).not.toHaveProperty('results');
    const study = Object.values(analysisCase?.studies ?? {})[0];
    expect(study?.levels.map((level) => level.controls.globalSize)).toEqual([0.25, 0.5, 1]);
    expect(study?.levels.map((level) => level.elements)).toEqual([768, 96, 12]);
    expect(study?.unit).toBe('MPa');
    const checked = execute(host.current(), 'check_verification', { analysisId: bar.analysisId }, ctx).data as {
      studies: { state: string; report: { p: number; extrapolated: number } }[];
    };
    expect(checked.studies[0]?.state).toBe('current');
    expect(checked.studies[0]?.report.p).toBeCloseTo(2, 6);
    expect(checked.studies[0]?.report.extrapolated).toBeCloseTo(F0, 6);
  });

  it('is deterministic: the same document, plan and tools give the same study (VC-VNV-17 at the level of fakes)', async () => {
    const first = hostOf(START);
    const second = hostOf(START);
    await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY, levels: 4, ratio: 1.5 }, first, fakes().deps);
    await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY, levels: 4, ratio: 1.5 }, second, fakes().deps);
    const studies = (host: ReturnType<typeof hostOf>): string => JSON.stringify(host.current().analysis?.cases[bar.analysisId]?.studies);
    expect(studies(first)).toBe(studies(second));
    expect(Object.values(first.current().analysis?.cases[bar.analysisId]?.studies ?? {})[0]?.levels).toHaveLength(4);
  });

  it('scales minSize and the refinement sizes with each level, and follows a probe', async () => {
    const refined = mustRun(START, 'set_mesh_controls', {
      analysisId: bar.analysisId,
      minSize: 0.05,
      refinements: [{ target: { entityId: bar.boxId, pointsNear: [[0, 0, 0]] }, size: 0.1 }],
    });
    const host = hostOf(refined);
    const result = await runConvergenceStudy(
      bar.analysisId,
      { quantity: { kind: 'probe', probeId: PROBE, loadCase: 'LC1' } },
      host,
      fakes().deps,
    );
    expect(result.isError).toBe(false);
    const study = Object.values(host.current().analysis?.cases[bar.analysisId]?.studies ?? {})[0];
    expect(study?.quantity).toEqual({ kind: 'probe', probeId: PROBE, loadCase: 'LC1' });
    expect(study?.levels.map((level) => level.controls.globalSize)).toEqual([0.25, 0.5, 1]);
    expect(study?.levels.map((level) => level.controls.minSize)).toEqual([0.05, 0.1, 0.2]);
    expect(study?.levels.map((level) => level.controls.refinements[0]?.size)).toEqual([0.1, 0.2, 0.4]);
  });

  it('starts the finest level at the given size', async () => {
    const host = hostOf(START);
    const result = await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY, finest: 0.5, levels: 3, ratio: 2 }, host, fakes().deps);
    // sizes 0.5 / 1 / 2: the fake mesher has round(1 / size) cells, so levels 1 and 2 coincide (12 elements): the record refuses non-increasing spacing
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/VNV_LEVELS_INVALID/);
    const fine = hostOf(START);
    const ok = await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY, finest: 0.125 }, fine, fakes().deps);
    expect(ok.isError).toBe(false);
    const study = Object.values(fine.current().analysis?.cases[bar.analysisId]?.studies ?? {})[0];
    expect(study?.levels.map((level) => level.controls.globalSize)).toEqual([0.125, 0.25, 0.5]);
  });

  it('refuses bad options with their code and leaves the document unchanged', async () => {
    const run = async (analysisId: string, options: Record<string, unknown>): Promise<{ result: FeaToolResult; changed: boolean }> => {
      const host = hostOf(START);
      const result = await runConvergenceStudy(analysisId, { quantity: QUANTITY, ...options }, host, fakes().deps);
      return { result, changed: host.current() !== START };
    };
    const codeOf = (found: { result: FeaToolResult }): unknown => (found.result.data as { code?: string } | undefined)?.code;
    const unknown = await run('an-9.9', {});
    expect(codeOf(unknown)).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(codeOf(await run(bar.analysisId, { levels: 2 }))).toBe('VNV_PARAM_INVALID');
    expect(codeOf(await run(bar.analysisId, { levels: 7 }))).toBe('VNV_PARAM_INVALID');
    expect(codeOf(await run(bar.analysisId, { levels: 3.5 }))).toBe('VNV_PARAM_INVALID');
    expect(codeOf(await run(bar.analysisId, { ratio: 1.05 }))).toBe('VNV_RATIO_TOO_SMALL');
    expect(codeOf(await run(bar.analysisId, { finest: -1 }))).toBe('VNV_PARAM_INVALID');
    expect(codeOf(await run(bar.analysisId, { quantity: { kind: 'probe' } }))).toBe('VNV_PARAM_INVALID');
    expect(codeOf(await run(bar.analysisId, { quantity: 'u' }))).toBe('VNV_PARAM_INVALID');
    const plate = plateDocument();
    const shell = must(plate.doc, 'set_part_idealization', {
      analysisId: plate.analysisId,
      entityId: plate.plateId,
      idealization: 'shell',
    });
    const shellHost = hostOf(shell);
    const refused = await runConvergenceStudy(plate.analysisId, { quantity: QUANTITY }, shellHost, fakes().deps);
    expect((refused.data as { code?: string }).code).toBe('VNV_CASE_UNSUPPORTED');
    expect(unknown.changed).toBe(false);
    expect(shellHost.current()).toBe(shell);
  });

  it('stops at a level that fails to mesh or solve with VNV_LEVEL_FAILED and the 05 code; nothing is recorded', async () => {
    for (const [failAt, stage, cause] of [
      [{ stage: 'mesh' as const, call: 2 }, 'meshing', 'FEA_MESH_FAILED'],
      [{ stage: 'solve' as const, call: 1 }, 'solving', 'FEA_SOLVER_FAILED'],
    ] as const) {
      const host = hostOf(START);
      const result = await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY }, host, fakes({}, failAt).deps);
      expect(result.isError).toBe(true);
      expect(result.summary).toMatch(/^run_convergence_study VNV_LEVEL_FAILED: level \d (meshing|solving) failed with/);
      expect(result.data).toMatchObject({ code: 'VNV_LEVEL_FAILED', stage, cause });
      expect(host.current()).toBe(START);
    }
  });

  it('refuses a level above the element cap before its solve, and a level whose artifacts cannot be read back', async () => {
    const capped = fakes({ hooks: { ...caeHooks, maxStudyElements: 100 } });
    const host = hostOf(START);
    const result = await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY }, host, capped.deps);
    expect(result.data).toMatchObject({ code: 'VNV_LEVEL_TOO_LARGE' });
    expect(result.summary).toMatch(/level 0 has 768 elements \(cap 100\)/);
    expect(host.current()).toBe(START);
    const silent = fakes({ solve: () => Promise.resolve({ summary: 'ok', affected: [], isError: false }) });
    const unreadable = await runConvergenceStudy(bar.analysisId, { quantity: QUANTITY }, hostOf(START), silent.deps);
    expect(unreadable.summary).toMatch(/cannot be read back from the store/);
  });

  it('refuses a quantity the results do not hold, after the runs, without recording', async () => {
    const host = hostOf(START);
    const result = await runConvergenceStudy(bar.analysisId, { quantity: { kind: 'probe', probeId: 'p-none' } }, host, fakes().deps);
    expect((result.data as { code?: string }).code).toBe('VNV_QUANTITY_UNAVAILABLE');
    expect(result.summary).toMatch(/level 0: no probe 'p-none'/);
    expect(host.current()).toBe(START);
  });
});
