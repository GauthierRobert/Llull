/**
 * Nonlinear static pipeline end to end with the real tools (gmsh + ccx 2.21; skipped without them): a 10 x 10 x 40 mm bar of J2 perfectly
 * plastic steel (E 210 GPa, yield 250 MPa) is pulled by displacement control past yield and driven back to zero displacement (2 steps), and
 * loaded by pressure inside the elastic range. The reaction-displacement curve read per increment from the .dat must give the elastic stiffness
 * E A / L, the plastic plateau sigma_y A0 / (1 + strain) (uniaxial, constant volume, NLGEOM), the permanent set at zero reaction and the
 * per-increment convergence table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { FeResultsArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { extractCurves } from '@cae/nonlinear/curves';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';

const AREA = 100; // mm^2
const LENGTH = 40; // mm
const E = 210000; // MPa
const YIELD = 250; // MPa
const T293 = [{ variable: 'T', unit: 'K', data: [293, 293] }];
const PLASTIC_RANGE = [...T293, { variable: 'equivalentPlasticStrain', unit: '1', data: [0, 0.05] }];
const SOURCE = { citation: 'test input of this validation case (not a material claim)' };

const setUp = (analysis: string): Record<string, unknown>[] => [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [10, 10, LENGTH], position: [0, 0, 0], anchor: 'min' }, as: 'bar' },
  { command: 'create_material', params: { name: 'steel', density: 0.0078, color: '#9aa0a6', metalness: 1, roughness: 0.4 } },
  {
    command: 'add_material_model',
    params: {
      material: 'steel',
      id: 'el',
      model: { kind: 'elastic_isotropic', E: { value: E, unit: 'MPa' }, nu: { value: 0.3, unit: '1' } },
      basis: 'company',
      source: SOURCE,
      validity: T293,
    },
  },
  {
    command: 'add_material_model',
    params: {
      material: 'steel',
      id: 'j2',
      model: {
        kind: 'j2_plasticity',
        isotropic: { kind: 'perfect', yieldStress: { value: YIELD, unit: 'MPa' } },
        kinematic: { kind: 'none' },
      },
      basis: 'company',
      source: SOURCE,
      validity: PLASTIC_RANGE,
    },
  },
  { command: 'define_constitutive_set', params: { material: 'steel', set: { id: 'ep', elastic: 'el', plastic: 'j2' }, makeDefault: true } },
  { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$bar'] } },
  { command: 'create_analysis', params: { name: analysis, analysisType: 'nonlinear_static', unitSystem: 'N-mm-t-s' }, as: 'an' },
  { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar', idealization: 'solid' } },
  { command: 'set_part_constitutive_set', params: { analysisId: '$an', entityId: '$bar', constitutiveSetId: 'ep' } },
  // uniaxial: the root face is held in z only; three point constraints remove the rigid-body modes without restraining the Poisson contraction
  {
    command: 'add_fea_constraint',
    params: {
      analysisId: '$an',
      name: 'root',
      kind: 'displacement',
      dofs: { uz: 0 },
      target: { entityId: '$bar', facesNear: [[5, 5, 0]] },
    },
  },
  {
    command: 'add_fea_constraint',
    params: {
      analysisId: '$an',
      name: 'pin_a',
      kind: 'displacement',
      dofs: { ux: 0, uy: 0 },
      target: { entityId: '$bar', pointsNear: [[0, 0, 0]] },
    },
  },
  {
    command: 'add_fea_constraint',
    params: {
      analysisId: '$an',
      name: 'pin_b',
      kind: 'displacement',
      dofs: { uy: 0 },
      target: { entityId: '$bar', pointsNear: [[10, 0, 0]] },
    },
  },
  { command: 'set_mesh_controls', params: { analysisId: '$an', order: 2, globalSize: 10 } },
];

const INCREMENTS = { initialIncrement: 0.05, minIncrement: 0.0001, maxIncrement: 0.1, maxIncrements: 100 };
const TOP = { entityId: '$bar', facesNear: [[5, 5, LENGTH]] };

const PULL_PLAN = [
  ...setUp('pull_unload'),
  {
    command: 'set_nonlinear_controls',
    params: { analysisId: '$an', nlgeom: true, convergence: { name: 'ccx_default' }, outputIncrements: 'all' },
  },
  {
    command: 'add_analysis_step',
    params: {
      analysisId: '$an',
      name: 'pull',
      multipliers: {},
      control: { kind: 'displacement', target: TOP, dof: 'uz', value: 0.4, ...INCREMENTS },
    },
  },
  {
    command: 'add_analysis_step',
    params: {
      analysisId: '$an',
      name: 'unload',
      multipliers: {},
      control: { kind: 'displacement', target: TOP, dof: 'uz', value: 0, ...INCREMENTS },
    },
  },
  {
    command: 'add_curve_probe',
    params: {
      analysisId: '$an',
      name: 'pull_curve',
      load: { kind: 'reaction', constraintId: 'root', component: 'z' },
      displacement: { point: [5, 5, LENGTH], dof: 'uz' },
    },
  },
];

const PRESSURE_PLAN = [
  ...setUp('pressure'),
  {
    command: 'add_fea_load',
    params: { analysisId: '$an', name: 'p_top', kind: 'pressure', loadCase: 'LC1', category: 'limit', target: TOP, magnitude: 1 },
  },
  { command: 'set_nonlinear_controls', params: { analysisId: '$an', nlgeom: false, outputIncrements: 'all' } },
  {
    command: 'add_analysis_step',
    params: { analysisId: '$an', name: 'press', multipliers: { LC1: -200 }, control: { kind: 'load', ...INCREMENTS } },
  },
  {
    command: 'add_curve_probe',
    params: {
      analysisId: '$an',
      name: 'press_curve',
      load: { kind: 'load', loadId: 'p_top' },
      displacement: { point: [5, 5, LENGTH], dof: 'uz' },
    },
  },
];

const RELEASE_PLAN = [
  ...setUp('release'),
  {
    command: 'add_fea_load',
    params: { analysisId: '$an', name: 'p_top', kind: 'pressure', loadCase: 'LC1', category: 'limit', target: TOP, magnitude: 1 },
  },
  { command: 'set_nonlinear_controls', params: { analysisId: '$an', nlgeom: false, outputIncrements: 'all' } },
  {
    command: 'add_analysis_step',
    params: {
      analysisId: '$an',
      name: 'drive',
      multipliers: {},
      control: { kind: 'displacement', target: TOP, dof: 'uz', value: 0.02, ...INCREMENTS },
    },
  },
  {
    command: 'add_analysis_step',
    params: { analysisId: '$an', name: 'release', multipliers: { LC1: 0 }, control: { kind: 'load', ...INCREMENTS } },
  },
  {
    command: 'add_curve_probe',
    params: {
      analysisId: '$an',
      name: 'release_curve',
      load: { kind: 'reaction', constraintId: 'root', component: 'z' },
      displacement: { point: [5, 5, LENGTH], dof: 'uz' },
    },
  },
];

let work = '';
let docPath = '';

function io(out: string[]): CliIo {
  return {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
}

async function cli(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const code = await runCli([...argv, '--doc', docPath, '--json'], io(out));
  const parsed: unknown = JSON.parse(out.join('') || '{}');
  return { code, json: isRecord(parsed) ? parsed : {} };
}

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

/** Runs `plan` on a fresh document, meshes and solves; returns the stored results and the analysis of the document. */
async function solvePlan(
  plan: unknown[],
  name: string,
): Promise<{ results: FeResultsArtifact; solve: Record<string, unknown>; summary: string }> {
  docPath = path.join(work, `${name}.llull.json`);
  const planPath = path.join(work, `${name}.plan.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  const ran = await cli('run', planPath);
  expect(ran.code, String(ran.json['summary'])).toBe(EXIT_OK);
  const analysisId = Object.keys(deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases ?? {})[0] ?? '';
  const meshed = await cli('fea_mesh', `analysisId=${analysisId}`);
  expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
  const solved = await cli('fea_solve', `analysisId=${analysisId}`, 'timeoutS=300');
  expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
  const results = defaultFeArtifactStore().get(String(dataOf(solved.json)['resultsHash'])) as FeResultsArtifact;
  return { results, solve: dataOf(solved.json), summary: String(solved.json['summary']) };
}

const analysisOf = (): NonNullable<ReturnType<typeof deserializeDocument>['analysis']>['cases'][string] => {
  const analysis = deserializeDocument(readFileSync(docPath, 'utf8')).analysis;
  return analysis?.cases[analysis.caseOrder[0] ?? ''] as NonNullable<typeof analysis>['cases'][string];
};

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-nl-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  setGeometryKernel(await createManifoldKernel());
}, 60_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!HAS_GMSH || !HAS_CCX)('nonlinear static pipeline (gmsh + ccx)', () => {
  it('pulls a perfectly plastic bar through yield and back: elastic stiffness, plastic plateau, permanent set, convergence', async () => {
    const { results, solve, summary } = await solvePlan(PULL_PLAN, 'pull');
    expect(results.convergence?.length).toBeGreaterThan(2);
    expect(results.convergence?.some((row) => row.step === 2)).toBe(true);
    expect(summary).toContain('increment(s)');
    expect(solve['convergence']).toMatchObject({ increments: results.convergence?.length });

    const [curve] = extractCurves(analysisOf(), results);
    expect(curve?.time.length).toBeGreaterThan(5);
    const load = curve?.load ?? [];
    const displacement = curve?.displacement ?? [];
    // first stored increment is elastic: F = E A / L * u
    const elastic = (E * AREA) / LENGTH;
    expect(Math.abs((load[1] ?? 0) / (-(displacement[1] ?? 1) * elastic) - 1)).toBeLessThan(0.01);
    // end of step 1 (u = 0.4 mm, engineering strain 1 %): NLGEOM carries Cauchy stress on the current area, constant volume (plastic flow) gives
    // A = A0 / (1 + strain), so the plateau is sigma_y A0 / 1.01
    const topIndex = displacement.findIndex((value) => Math.abs(value - 0.4) < 1e-9);
    expect(topIndex).toBeGreaterThan(0);
    expect(Math.abs(Math.abs(load[topIndex] ?? 0) / ((YIELD * AREA) / (1 + 0.4 / LENGTH)) - 1)).toBeLessThan(0.003);
    // step 2 drives the top displacement back to 0: elastic unloading (slope E A / L), zero reaction at the permanent set u_p = u - F / k,
    // then compressive yield at the same plateau because the total displacement ends at 0
    const crossing = load.findIndex((value, index) => index > topIndex && value > 0);
    expect(crossing).toBeGreaterThan(topIndex);
    const [d0, d1, f0, f1] = [displacement[crossing - 1] ?? 0, displacement[crossing] ?? 0, load[crossing - 1] ?? 0, load[crossing] ?? 0];
    const permanentSet = d0 + ((0 - f0) / (f1 - f0)) * (d1 - d0);
    const expectedSet = 0.4 - (YIELD * AREA) / (1 + 0.4 / LENGTH) / elastic;
    expect(Math.abs(permanentSet / expectedSet - 1)).toBeLessThan(0.01);
    expect(Math.abs(displacement.at(-1) ?? 1)).toBeLessThan(1e-9);
    expect(load.at(-1) ?? 0).toBeGreaterThan(0.98 * YIELD * AREA);

    const state = analysisOf();
    expect(state.results?.nonlinear).toMatchObject({ nlgeom: true, completed: true });
    expect(state.results?.nonlinear?.steps).toHaveLength(2);
    expect(state.results?.nonlinear?.curves[0]).toMatchObject({ name: 'pull_curve', peakLoad: expect.any(Number) });
    expect(state.results?.nonlinear?.maxPeeq?.value).toBeGreaterThan(0.005);
  }, 300_000);

  it('a displacement drive does not leak into a later load step: the released bar returns to zero displacement and reaction', async () => {
    const { results } = await solvePlan(RELEASE_PLAN, 'release');
    const [curve] = extractCurves(analysisOf(), results);
    const drive = curve?.time.findIndex((time) => Math.abs(time - 1) < 1e-9) ?? -1;
    expect(drive).toBeGreaterThan(0);
    expect(Math.abs(curve?.displacement[drive] ?? 0)).toBeCloseTo(0.02, 9);
    expect(Math.abs(curve?.load[drive] ?? 0)).toBeGreaterThan(1000);
    expect(curve?.time.at(-1)).toBeCloseTo(2, 9);
    expect(Math.abs(curve?.displacement.at(-1) ?? 1)).toBeLessThan(1e-6);
    expect(Math.abs(curve?.load.at(-1) ?? 1)).toBeLessThan(1);
  }, 300_000);

  it('loads the bar by pressure inside the elastic range: displacement = p L / E and the load axis is the ramped multiplier', async () => {
    const { results } = await solvePlan(PRESSURE_PLAN, 'pressure');
    const [curve] = extractCurves(analysisOf(), results);
    const last = (curve?.time.length ?? 1) - 1;
    expect(curve?.time[last]).toBeCloseTo(1, 9);
    expect(Math.abs((curve?.load[last] ?? 0) / -200 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(curve?.displacement[last] ?? 0) / ((200 * LENGTH) / E) - 1)).toBeLessThan(0.01);
  }, 300_000);
});
