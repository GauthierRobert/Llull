/**
 * 14 FLL-M1 end to end through the `llull` CLI on the real llull-compute (and CalculiX): implicit bodies meshed straight from their field
 * (set_mesh_controls source implicit_field -> fea_mesh -> fea_solve). Oracles: the exact volume of a field sphere and box, and the
 * Euler-Bernoulli cantilever of VC-FLL-01 (b 10, h 8, L 150 mm, E 2 GPa, F 5.4 N: tip deflection FL^3 / (3EI) = 7.1191 mm, 2 %) on a field box,
 * and VC-FLL-09 on a drone-body stand-in (plans in docs/aerospace/14-flight-loads-aeroelasticity/validation/plans).
 * Determinism: meshing the same document twice gives the same mesh artifact hash (bit-identical nodes and elements).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { setFieldEngine } from '@core/geometry/field/engine';
import { isRecord } from '@lib/isRecord';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks } from '../src/fea/caeHooks';
import { runFieldMesh } from '../src/fea/fieldMesh';
import { createComputeRunner, type ComputeRunner, type JobRun } from '../src/native/computeJob';
import { installFieldEngine } from '../src/native/fieldEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { requireTools } from '../../tests/requireTool';
import { FEA_TOOL_ENV, HAS_CCX } from './feaTestSupport';
import { REPO_ROOT } from './packCli';

const HAS_COMPUTE = nativeBinaryPath('llull-compute') !== null;
const source = { citation: 'test input of this validation case (not a material claim)' };

let work = '';

function io(out: string[]): CliIo {
  return {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: { ...FEA_TOOL_ENV },
    prepareKernel: () => Promise.resolve(),
  };
}

async function cli(docPath: string, ...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const code = await runCli([...argv, '--doc', docPath, '--json'], io(out));
  const parsed: unknown = JSON.parse(out.join('') || '{}');
  return { code, json: isRecord(parsed) ? parsed : {} };
}

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

/** A document built by `plan`; returns its path and its single analysis id. */
async function documentOf(name: string, plan: readonly Record<string, unknown>[]): Promise<{ docPath: string; analysisId: string }> {
  const docPath = path.join(work, `${name}.llull.json`);
  const planPath = path.join(work, `${name}.plan.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  const { code, json } = await cli(docPath, 'run', planPath);
  expect(code, String(json['summary'])).toBe(EXIT_OK);
  const analysisId = Object.keys(deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases ?? {})[0] ?? '';
  expect(analysisId).not.toBe('');
  return { docPath, analysisId };
}

const PLANS = path.join(REPO_ROOT, 'docs/aerospace/14-flight-loads-aeroelasticity/validation/plans');
const validationPlan = (name: string): Record<string, unknown>[] =>
  JSON.parse(readFileSync(path.join(PLANS, `${name}.plan.json`), 'utf8')) as Record<string, unknown>[];

/** mm units and the test material 'petg' (E 2 GPa, nu 0.3), to give create_implicit_body. */
const MATERIAL: Record<string, unknown>[] = [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'create_material', params: { name: 'petg', density: 0.00127, color: '#88aacc', metalness: 0, roughness: 0.6 } },
  {
    command: 'add_material_model',
    params: {
      material: 'petg',
      id: 'elastic',
      model: { kind: 'elastic_isotropic', E: { value: 2, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
      basis: 'company',
      source,
    },
  },
  { command: 'define_constitutive_set', params: { material: 'petg', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
];

function analysisPlan(fixAt: number[], loadAt: number[], force: number[], globalSize: number): Record<string, unknown>[] {
  return [
    { command: 'create_analysis', params: { name: 'field', analysisType: 'static', unitSystem: 'N-mm-t-s', solver: 'calculix' }, as: 'an' },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$body', idealization: 'solid' } },
    {
      command: 'add_fea_constraint',
      params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$body', facesNear: [fixAt] } },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'tip',
        kind: 'force',
        loadCase: 'LC1',
        category: 'limit',
        target: { entityId: '$body', facesNear: [loadAt] },
        vector: force,
        distribution: 'total',
      },
    },
    { command: 'set_mesh_controls', params: { analysisId: '$an', source: 'implicit_field', order: 2, globalSize } },
  ];
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-field-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  installFieldEngine();
});

afterAll(() => {
  setFieldEngine(null);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(requireTools([['native:llull-compute', HAS_COMPUTE]]))('fea_mesh source implicit_field (llull-compute)', () => {
  it('meshes a field sphere to its exact volume, deterministically, and refuses a body that is not one', async () => {
    const { docPath, analysisId } = await documentOf('sphere', [
      ...MATERIAL,
      { command: 'add_field_primitive', params: { shape: 'sphere', radius: 10 }, as: 'f' },
      { command: 'create_implicit_body', params: { field: '$f', voxel: 1, material: 'petg' }, as: 'body' },
      ...analysisPlan([0, 0, -10], [0, 0, 10], [0, 0, 100], 2),
    ]);
    const first = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
    expect(first.code, String(first.json['summary'])).toBe(EXIT_OK);
    const data = dataOf(first.json);
    const [figures] = data['fieldParts'] as { volume: number; minDihedralDeg: number; maxDihedralDeg: number; elements: number }[];
    const exact = (4 / 3) * Math.PI * 1000;
    expect(Math.abs((figures?.volume ?? 0) / exact - 1)).toBeLessThan(1e-4);
    expect(figures?.minDihedralDeg).toBeGreaterThan(10.7832);
    expect(figures?.maxDihedralDeg).toBeLessThan(164.817);
    const mesh = defaultFeArtifactStore().get(String(data['meshHash'])) as FeMeshArtifact;
    expect(mesh.mesher).toBe('llull-field');
    expect(mesh.blocks.map((b) => b.type)).toEqual(['C3D10']);
    expect(mesh.faceSets[Object.keys(mesh.faceSets)[0] ?? '']?.length).toBeGreaterThan(0);
    const second = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
    expect(dataOf(second.json)['meshHash']).toBe(data['meshHash']);
    const geometry = await cli(docPath, 'set_mesh_controls', `analysisId=${analysisId}`, 'source=geometry');
    expect(geometry.code).toBe(EXIT_OK);
    const box = await cli(docPath, 'add_box', 'size=[1,1,1]');
    const boxId = String((box.json['affected'] as string[])[0]);
    await cli(docPath, 'set_part_idealization', `analysisId=${analysisId}`, `entityId=${boxId}`, 'idealization=solid');
    await cli(docPath, 'set_mesh_controls', `analysisId=${analysisId}`, 'source=implicit_field');
    const refused = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
    expect(refused.code).toBe(EXIT_COMMAND_ERROR);
    expect(String(refused.json['summary'])).toContain('FLL_IMPLICIT_FIELD_MISSING');
  }, 240_000);

  it.skipIf(requireTools([['calculix', HAS_CCX]]))(
    'solves the VC-FLL-01 cantilever on a field box within 2 % of Euler-Bernoulli',
    async () => {
      const [b, h, length, force, e] = [10, 8, 150, 5.4, 2000];
      const { docPath, analysisId } = await documentOf('cantilever', validationPlan('fll_m1_field_cantilever'));
      const meshed = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
      expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
      const [figures] = dataOf(meshed.json)['fieldParts'] as { volume: number }[];
      expect(Math.abs((figures?.volume ?? 0) / (length * b * h) - 1)).toBeLessThan(1e-9);
      const solved = await cli(docPath, 'fea_solve', `analysisId=${analysisId}`, 'timeoutS=600');
      expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
      const mesh = defaultFeArtifactStore().get(String(dataOf(meshed.json)['meshHash'])) as FeMeshArtifact;
      const results = defaultFeArtifactStore().get(String(dataOf(solved.json)['resultsHash'])) as FeResultsArtifact;
      const displacement = results.steps.at(-1)?.fields['DISP'];
      const uz = displacement?.components.indexOf('D3') ?? -1;
      const tip = mesh.nodes.filter((node) => Math.abs(node[1] - length) < 1e-6);
      expect(tip.length).toBeGreaterThan(4);
      const deflection = -tip.reduce((sum, node) => sum + (displacement?.values[String(node[0])]?.[uz] ?? 0), 0) / tip.length;
      const oracle = (force * length ** 3) / (3 * e * ((b * h ** 3) / 12));
      expect(oracle).toBeCloseTo(7.1191, 4);
      console.warn(
        `VC-FLL-01 on a field box: tip deflection ${deflection} mm vs ${oracle} mm (${(100 * (deflection / oracle - 1)).toFixed(3)} %)`,
      );
      expect(Math.abs(deflection / oracle - 1)).toBeLessThan(0.02);
    },
    600_000,
  );
});

/**
 * VC-FLL-09 on a stand-in of the reference drone body (lite8.lld is not in the repository): a 250 x 250 x 44 mm blended hub, two arms and four
 * motor pads with a battery pocket, realised at voxel 0.8 like the reference and meshed from its field at 2 mm: under 1.5 M tetrahedra
 * (TECHNICAL_SPEC §8) and within 0.5 % of the implicit body volume. The 60 s budget is reported, not asserted (no wall-clock assertions).
 * The support and the load sit on the flat bottom / top faces (z = -10 / +10) of two motor pads (radius 16): their node sets must stay on those
 * disks and their face sets must cover about pi 16^2.
 */
describe.skipIf(requireTools([['native:llull-compute', HAS_COMPUTE]]))('VC-FLL-09 drone-body stand-in (llull-compute)', () => {
  it('meshes the body from its field at 2 mm within the budgets and 0.5 % of its volume', async () => {
    const { docPath, analysisId } = await documentOf('drone', validationPlan('fll_m1_drone_standin'));
    const doc = deserializeDocument(readFileSync(docPath, 'utf8'));
    const bodyId = Object.keys(doc.implicit?.bodies ?? {})[0] ?? '';
    const body = await cli(docPath, 'implicit_properties', `id=${bodyId}`);
    const bodyVolume = Number(dataOf(body.json)['volume']);
    const started = Date.now();
    const meshed = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
    const seconds = (Date.now() - started) / 1000;
    expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
    const [figures] = dataOf(meshed.json)['fieldParts'] as {
      volume: number;
      elements: number;
      minDihedralDeg: number;
      maxDihedralDeg: number;
    }[];
    console.warn(
      `VC-FLL-09 stand-in: ${figures?.elements} C3D10 in ${seconds.toFixed(1)} s, volume ${figures?.volume} vs body ${bodyVolume} ` +
        `(${(100 * ((figures?.volume ?? 0) / bodyVolume - 1)).toFixed(3)} %), dihedral ${figures?.minDihedralDeg}-${figures?.maxDihedralDeg}`,
    );
    expect(Math.abs((figures?.volume ?? 0) / bodyVolume - 1)).toBeLessThan(0.005);
    expect(figures?.elements).toBeLessThan(1.5e6);
    const mesh = defaultFeArtifactStore().get(String(dataOf(meshed.json)['meshHash'])) as FeMeshArtifact;
    const h = 2;
    const coordinates = new Map(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]] as const]));
    const corners = new Map(mesh.blocks.flatMap((block) => block.elements.map((row) => [row[0], row.slice(1, 5)] as const)));
    const faceCorners: Readonly<Record<number, readonly number[]>> = { 1: [0, 1, 2], 2: [0, 3, 1], 3: [1, 3, 2], 4: [2, 3, 0] };
    for (const [prefix, centre, z] of [
      ['C_', [116, 0], -10],
      ['L_', [-116, 0], 10],
    ] as const) {
      const key = Object.keys(mesh.nodeSets).find((name) => name.startsWith(prefix)) ?? '';
      const nodes = mesh.nodeSets[key] ?? [];
      expect(nodes.length).toBeGreaterThan(20);
      for (const id of nodes) {
        const [x, y, nz] = coordinates.get(id) ?? [NaN, NaN, NaN];
        expect(Math.abs(nz - z), `${key} node ${id} z`).toBeLessThanOrEqual(h);
        expect(Math.hypot(x - centre[0], y - centre[1]), `${key} node ${id} r`).toBeLessThanOrEqual(16 + h);
      }
      const area = (mesh.faceSets[key] ?? []).reduce((sum, [element, label]) => {
        const p = (faceCorners[label] ?? []).map((k) => coordinates.get(corners.get(element)?.[k] ?? -1) ?? [0, 0, 0]);
        const [a, b, c] = [p[0] ?? [0, 0, 0], p[1] ?? [0, 0, 0], p[2] ?? [0, 0, 0]];
        const u: readonly [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v: readonly [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        return sum + 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      }, 0);
      console.warn(`VC-FLL-09 stand-in: ${key} face set area ${area.toFixed(1)} mm^2 vs pi 16^2 = ${(Math.PI * 256).toFixed(1)}`);
      expect(Math.abs(area / (Math.PI * 256) - 1)).toBeLessThan(0.05);
    }
  }, 600_000);
});

describe.skipIf(requireTools([['native:llull-compute', HAS_COMPUTE]]))(
  'fea_mesh source implicit_field cancellation (llull-compute)',
  () => {
    it('kills the job (process tree) when its caller leaves and records nothing', async () => {
      const { docPath, analysisId } = await documentOf('drone-cancel', validationPlan('fll_m1_drone_standin'));
      const doc = deserializeDocument(readFileSync(docPath, 'utf8'));
      const request = caeHooks.meshRequest(doc, analysisId);
      if ('code' in request) throw new Error(request.message);
      const cancel = new AbortController();
      let aborted = false;
      const commands: string[] = [];
      const host = {
        getDoc: () => doc,
        applyCommand: (name: string): { summary: string; affected: string[]; isError: boolean } => {
          commands.push(name);
          return { summary: '', affected: [], isError: false };
        },
        signal: cancel.signal,
        onProgress: (): void => {
          if (!aborted) {
            aborted = true;
            cancel.abort();
          }
        },
      };
      const env = { ...process.env, ...FEA_TOOL_ENV };
      const real = createComputeRunner(env);
      let job: Promise<JobRun> | null = null;
      const runner: ComputeRunner = { ...real, run: (...args) => (job = real.run(...args)) };
      const result = await runFieldMesh(request, host, { runner, store: defaultFeArtifactStore(), hooks: caeHooks, env });
      expect(result.summary).toContain('FEA_MESH_CANCELLED');
      expect(aborted).toBe(true);
      // the job process ended because it was killed (its whole tree), not because it finished
      expect((await (job as Promise<JobRun> | null))?.code).toBe('NATIVE_CANCELLED');
      expect(commands).toEqual([]);
    }, 300_000);
  },
);
