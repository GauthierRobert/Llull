/**
 * VC-INT-12 (FR-INT-06, TR-INT-07): a steel cantilever L 1000, b 20, h 50 mm, E 210 GPa, nu 0.3, tip load P 1000 N through the `llull` CLI
 * (fea_mesh with Netgen, fea_solve with CalculiX). The quadratic mesh with several layers through the width reproduces the Timoshenko tip
 * deflection 7.634 mm within 2 % and records an `adequate` mesh; one linear element through the width records `inadequate` and the
 * fea_solve summary says so. Skipped without llull-mesh or `ccx`.
 *
 * Expected element layers (hit distance / local element size, size = (6 x mean volume of the crossed tets)^(1/3), a Kuhn cell of side s reads s; a regular tet of edge a reads 0.89 a): the load acts
 * along z, so the bending depth is DEPTH = 50 mm (y, the width b = 20 mm, is the thin direction of the section and governs the 5th percentile).
 *   C3D10, globalSize 6: edges about 5-6 mm, size about 4-5 mm: about 4-5 layers through b, about 10-12 through DEPTH; budget 2 (adequate, >= 2x margin).
 *   C3D4, globalSize 40: no edge is below the section scale (the 20 mm width), so size >= about 16 mm: at most about 1.3 layers through b and about 3
 *   through DEPTH; budget 4 (inadequate through the bending depth as well as the width). Estimates, not measured here (no ccx / llull-mesh on the author machine).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { FEA_TOOL_ENV, HAS_CCX, HAS_MESHER } from './feaTestSupport';

const LENGTH = 1000;
const WIDTH = 20;
const DEPTH = 50;
const LOAD = 1000;
/** Timoshenko tip deflection of the cantilever: P L^3 / (3 E I) + P L / (k G A), k = 5/6 (Euler-Bernoulli alone: 7.619 mm). */
const TIMOSHENKO_MM = 7.634;
const source = { citation: 'test input of this validation case (not a material claim)' };

const plan = (order: 1 | 2, globalSize: number): unknown[] => [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [LENGTH, WIDTH, DEPTH], position: [0, 0, 0], anchor: 'min' }, as: 'beam' },
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
  {
    command: 'create_analysis',
    params: { name: 'cantilever', analysisType: 'static', unitSystem: 'N-mm-t-s', solver: 'calculix' },
    as: 'an',
  },
  { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$beam', idealization: 'solid' } },
  {
    command: 'add_fea_constraint',
    params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$beam', facesNear: [[0, WIDTH / 2, DEPTH / 2]] } },
  },
  {
    command: 'add_fea_load',
    params: {
      analysisId: '$an',
      name: 'tip',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId: '$beam', facesNear: [[LENGTH, WIDTH / 2, DEPTH / 2]] },
      vector: [0, 0, -LOAD],
      distribution: 'total',
    },
  },
  { command: 'set_mesh_controls', params: { analysisId: '$an', order, globalSize } },
];

let work = '';

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

/** Builds the cantilever document for `order` / `globalSize`, meshes and solves it; returns the artifacts and the fea_solve summary. */
async function solveCantilever(
  name: string,
  order: 1 | 2,
  globalSize: number,
): Promise<{ mesh: FeMeshArtifact; results: FeResultsArtifact; summary: string }> {
  const docPath = path.join(work, `${name}.llull.json`);
  const planPath = path.join(work, `${name}.plan.json`);
  writeFileSync(planPath, JSON.stringify(plan(order, globalSize)));
  const built = await cli(docPath, 'run', planPath);
  expect(built.code, String(built.json['summary'])).toBe(EXIT_OK);
  const analysisId = Object.keys(deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases ?? {})[0] ?? '';
  const meshed = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
  expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
  const solved = await cli(docPath, 'fea_solve', `analysisId=${analysisId}`, 'timeoutS=550');
  expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
  const store = defaultFeArtifactStore();
  return {
    mesh: store.get(String(dataOf(meshed.json)['meshHash'])) as FeMeshArtifact,
    results: store.get(String(dataOf(solved.json)['resultsHash'])) as FeResultsArtifact,
    summary: String(solved.json['summary']),
  };
}

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-cantilever-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  setGeometryKernel(await createManifoldKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!HAS_MESHER || !HAS_CCX)('cantilever tip deflection and mesh adequacy (netgen + ccx)', () => {
  it('C3D10 with several layers through the width: tip deflection within 2 % of Timoshenko, adequacy recorded as adequate', async () => {
    const { mesh, results, summary } = await solveCantilever('quadratic', 2, 6);
    expect(mesh.blocks[0]?.type).toBe('C3D10');
    expect(results.adequacy?.verdict, JSON.stringify(results.adequacy)).toBe('adequate');
    expect(summary).toContain('Mesh adequacy: adequate');
    const tip = mesh.nodes.filter((node) => Math.abs(node[1] - LENGTH) < 1e-6);
    expect(tip.length).toBeGreaterThan(4);
    const displacement = results.steps.at(-1)?.fields['DISP'];
    const uz = displacement?.components.indexOf('D3') ?? -1;
    expect(uz).toBeGreaterThanOrEqual(0);
    const mean = tip.reduce((sum, node) => sum + (displacement?.values[String(node[0])]?.[uz] ?? 0), 0) / tip.length;
    expect(Math.abs(Math.abs(mean) / TIMOSHENKO_MM - 1)).toBeLessThan(0.02);
  }, 600_000);

  it('C3D4 with about one element through the width and under 4 through the depth: the recorded verdict is inadequate and fea_solve says so', async () => {
    const { mesh, results, summary } = await solveCantilever('linear', 1, 40);
    expect(mesh.blocks[0]?.type).toBe('C3D4');
    expect(results.adequacy?.verdict, JSON.stringify(results.adequacy)).toBe('inadequate');
    expect(summary).toContain('Mesh adequacy: INADEQUATE');
  }, 600_000);
});
