/**
 * A plane imprinted mid-span must not split the model: a steel cantilever (L 100, b 10, h 10 mm, tip load 100 N, C3D10) meshed with and without a
 * refinement target on the section x = 50 (intersectPlane, so llull-mesh imprints the plane) gives the same tip deflection within mesh tolerance and
 * the closed-form value within 3 %. Skipped without llull-mesh, the native llull-kernel (the plane needs exact STEP geometry) or `ccx`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { FEA_TOOL_ENV, HAS_CCX, HAS_MESHER } from './feaTestSupport';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';

const LENGTH = 100;
const SIDE = 10;
const LOAD = 100;
const MID = LENGTH / 2;
/** Euler-Bernoulli tip deflection P L^3 / (3 E I), I = b h^3 / 12, E 210 GPa (the Timoshenko shear term adds about 1 % at L / h = 10). */
const BEAM_MM = (LOAD * LENGTH ** 3) / (3 * 210_000 * ((SIDE * SIDE ** 3) / 12));
const source = { citation: 'test input of this validation case (not a material claim)' };

const plan = (split: boolean): unknown[] => [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [LENGTH, SIDE, SIDE], position: [0, 0, 0], anchor: 'min' }, as: 'beam' },
  { command: 'create_material', params: { name: 'steel', density: 0.0078, color: '#9aa0a6', metalness: 1, roughness: 0.4 } },
  {
    command: 'add_material_model',
    params: {
      material: 'steel',
      id: 'elastic',
      model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
      basis: 'company',
      source,
    },
  },
  { command: 'define_constitutive_set', params: { material: 'steel', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
  { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$beam'] } },
  { command: 'create_analysis', params: { name: 'cantilever', analysisType: 'static', unitSystem: 'N-mm-t-s', solver: 'calculix' }, as: 'an' },
  { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$beam', idealization: 'solid' } },
  {
    command: 'add_fea_constraint',
    params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$beam', facesNear: [[0, SIDE / 2, SIDE / 2]] } },
  },
  {
    command: 'add_fea_load',
    params: {
      analysisId: '$an',
      name: 'tip',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId: '$beam', facesNear: [[LENGTH, SIDE / 2, SIDE / 2]] },
      vector: [0, 0, -LOAD],
      distribution: 'total',
    },
  },
  {
    command: 'set_mesh_controls',
    params: {
      analysisId: '$an',
      order: 2,
      globalSize: 3,
      refinements: split
        ? [{ target: { entityId: '$beam', facesNear: [[MID, SIDE / 2, SIDE]], intersectPlane: { point: [MID, 0, 0], normal: [1, 0, 0] } }, size: 2 }]
        : [],
    },
  },
];

let work = '';
let kernel: ReturnType<typeof createNativeTestKernel> | null = null;

const io = (out: string[]): CliIo => ({
  stdout: (text) => out.push(text),
  stderr: () => undefined,
  readStdin: () => Promise.resolve(''),
  env: { ...FEA_TOOL_ENV },
  prepareKernel: () => Promise.resolve(),
});

async function cli(docPath: string, ...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const code = await runCli([...argv, '--doc', docPath, '--json'], io(out));
  const parsed: unknown = JSON.parse(out.join('') || '{}');
  return { code, json: isRecord(parsed) ? parsed : {} };
}

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

async function solve(name: string, split: boolean): Promise<{ mesh: FeMeshArtifact; tip: number }> {
  const docPath = path.join(work, `${name}.llull.json`);
  const planPath = path.join(work, `${name}.plan.json`);
  writeFileSync(planPath, JSON.stringify(plan(split)));
  const built = await cli(docPath, 'run', planPath);
  expect(built.code, String(built.json['summary'])).toBe(EXIT_OK);
  const analysisId = Object.keys(deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases ?? {})[0] ?? '';
  const meshed = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
  expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
  const solved = await cli(docPath, 'fea_solve', `analysisId=${analysisId}`, 'timeoutS=550');
  expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
  const store = defaultFeArtifactStore();
  const mesh = store.get(String(dataOf(meshed.json)['meshHash'])) as FeMeshArtifact;
  const results = store.get(String(dataOf(solved.json)['resultsHash'])) as FeResultsArtifact;
  const displacement = results.steps.at(-1)?.fields['DISP'];
  const uz = displacement?.components.indexOf('D3') ?? -1;
  expect(uz).toBeGreaterThanOrEqual(0);
  const tip = mesh.nodes.filter((node) => Math.abs(node[1] - LENGTH) < 1e-6);
  expect(tip.length).toBeGreaterThan(4);
  const mean = tip.reduce((sum, node) => sum + (displacement?.values[String(node[0])]?.[uz] ?? 0), 0) / tip.length;
  return { mesh, tip: Math.abs(mean) };
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-planesplit-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  if (nativeKernelBinary !== null) {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  kernel?.dispose();
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!HAS_MESHER || !HAS_CCX || nativeKernelBinary === null)('plane imprint keeps one model (netgen + ccx + OCC kernel)', () => {
  it('a mid-span plane target leaves the tip deflection of the cantilever unchanged', async () => {
    const whole = await solve('whole', false);
    const split = await solve('split', true);
    const section = split.mesh.nodes.filter((node) => Math.abs(node[1] - MID) < 1e-9 && Math.abs(node[3] - SIDE) < 1e-9);
    expect(section.length, 'the mesh holds a line of nodes on the imprinted section').toBeGreaterThanOrEqual(3);
    expect(Math.abs(split.tip / whole.tip - 1), `${split.tip} vs ${whole.tip}`).toBeLessThan(0.01);
    expect(Math.abs(split.tip / BEAM_MM - 1)).toBeLessThan(0.03);
  }, 900_000);
});
