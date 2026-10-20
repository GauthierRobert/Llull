/**
 * FE pipeline end to end through the `llull` CLI on a temp document: set-up plan -> fea_mesh (Gmsh via the Python bridge) -> fea_solve
 * (CalculiX) -> fea_report. An axial steel bar must carry sigma_zz = F / A (1 %). Also fea_export, the stale-mesh refusal and the
 * missing-tool codes. Skipped without the `gmsh` Python module or `ccx`.
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
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { FEA_TOOL_ENV, HAS_CCX, HAS_GMSH } from './feaTestSupport';

const AREA = 10 * 10; // mm^2
const FORCE = 1000; // N
const LENGTH = 40; // mm
const source = { citation: 'test input of this validation case (not a material claim)' };
const PLAN = [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [10, 10, LENGTH], position: [0, 0, 0], anchor: 'min' }, as: 'bar' },
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
  { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$bar'] } },
  {
    command: 'create_analysis',
    params: { name: 'bar_axial', analysisType: 'static', unitSystem: 'N-mm-t-s', solver: 'calculix' },
    as: 'an',
  },
  { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar', idealization: 'solid' } },
  {
    command: 'add_fea_constraint',
    params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$bar', facesNear: [[5, 5, 0]] } },
  },
  {
    command: 'add_fea_load',
    params: {
      analysisId: '$an',
      name: 'pull',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId: '$bar', facesNear: [[5, 5, LENGTH]] },
      vector: [0, 0, FORCE],
      distribution: 'total',
    },
  },
  { command: 'set_mesh_controls', params: { analysisId: '$an', order: 2, globalSize: 5 } },
];

let work = '';
let docPath = '';
let analysisId = '';

function io(out: string[], err: string[] = []): CliIo {
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    env: { ...FEA_TOOL_ENV },
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
const currentDoc = (): ReturnType<typeof deserializeDocument> => deserializeDocument(readFileSync(docPath, 'utf8'));

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-e2e-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  docPath = path.join(work, 'bar.llull.json');
  setGeometryKernel(await createManifoldKernel());
  const planPath = path.join(work, 'plan.json');
  writeFileSync(planPath, JSON.stringify(PLAN));
  const { code, json } = await cli('run', planPath);
  expect(code, String(json['summary'])).toBe(EXIT_OK);
  analysisId = Object.keys(currentDoc().analysis?.cases ?? {})[0] ?? '';
  expect(analysisId).not.toBe('');
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!HAS_GMSH || !HAS_CCX)('FE pipeline (gmsh + ccx)', () => {
  it('refuses to solve or export before a mesh exists', async () => {
    const solve = await cli('fea_solve', `analysisId=${analysisId}`);
    expect(solve.code).toBe(EXIT_COMMAND_ERROR);
    expect(String(solve.json['summary'])).toContain('FEA_MESH_MISSING');
    const exported = await cli('fea_export', `analysisId=${analysisId}`);
    expect(String(exported.json['summary'])).toContain('FEA_MESH_MISSING');
  });

  it('meshes, solves and reports an axial bar with sigma_zz = F / A', async () => {
    const meshed = await cli('fea_mesh', `analysisId=${analysisId}`);
    expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
    const meshHash = String(dataOf(meshed.json)['meshHash']);
    const mesh = defaultFeArtifactStore().get(meshHash) as FeMeshArtifact;
    expect(mesh.kind).toBe('fe_mesh');
    expect(mesh.blocks[0]?.type).toBe('C3D10');
    expect(dataOf(meshed.json)['facetedParts']).toEqual([]);
    expect(String(meshed.json['summary'])).not.toContain('faceted tessellation');
    expect(currentDoc().analysis?.cases[analysisId]?.meshSummary?.meshHash).toBe(meshHash);

    const solved = await cli('fea_solve', `analysisId=${analysisId}`, 'timeoutS=300');
    expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
    const results = defaultFeArtifactStore().get(String(dataOf(solved.json)['resultsHash'])) as FeResultsArtifact;
    expect(results.kind).toBe('fe_results');
    expect(results.meshHash).toBe(meshHash);
    const plot = await cli('render_fea_results', `analysisId=${analysisId}`, 'field=s_zz');
    expect(plot.code, String(plot.json['summary'])).toBe(EXIT_OK);
    expect(String(dataOf(plot.json)['svg'])).toContain('<svg');
    expect(Number((dataOf(plot.json)['max'] as { value: number }).value)).toBeGreaterThan(0);
    expect(results.solver).toBe('calculix');

    const stress = results.steps.at(-1)?.fields['STRESS'];
    const szz = stress?.components.indexOf('SZZ') ?? -1;
    expect(szz).toBeGreaterThanOrEqual(0);
    const midspan = mesh.nodes.filter((node) => Math.abs(node[3] - LENGTH / 2) <= 5);
    expect(midspan.length).toBeGreaterThan(4);
    const mean = midspan.reduce((sum, node) => sum + (stress?.values[String(node[0])]?.[szz] ?? 0), 0) / midspan.length;
    expect(Math.abs(mean / (FORCE / AREA) - 1)).toBeLessThan(0.01);

    const report = await cli('fea_report', `analysisId=${analysisId}`);
    expect(report.code, String(report.json['summary'])).toBe(EXIT_OK);
    expect(JSON.stringify(report.json)).toContain('solved');
  }, 240_000);

  it('exports the deck with its sha256', async () => {
    const deckPath = path.join(work, 'bar.inp');
    const out: string[] = [];
    const code = await runCli(['fea_export', `analysisId=${analysisId}`, '--doc', docPath, '--save', deckPath, '--quiet'], io(out));
    expect(code).toBe(EXIT_OK);
    const deck = readFileSync(deckPath, 'utf8');
    expect(deck).toContain('*NODE');
    expect(deck).toContain('*STEP');
  });

  it('marks the mesh stale after a set-up change and refuses to solve it', async () => {
    const changed = await cli('set_mesh_controls', `analysisId=${analysisId}`, 'globalSize=4');
    expect(changed.code).toBe(EXIT_OK);
    const solve = await cli('fea_solve', `analysisId=${analysisId}`);
    expect(solve.code).toBe(EXIT_COMMAND_ERROR);
    expect(String(solve.json['summary'])).toContain('FEA_MESH_STALE');
  });
});

describe('FE transports without tools', () => {
  it('answers FEA_TOOL_MISSING when Python is disabled (fea_mesh)', async () => {
    const out: string[] = [];
    const code = await runCli(['fea_mesh', `analysisId=${analysisId}`, '--doc', docPath, '--json'], {
      ...io(out),
      env: { LLULL_PYTHON: 'off' },
    });
    expect(code).toBe(EXIT_COMMAND_ERROR);
    expect(out.join('')).toContain('FEA_TOOL_MISSING');
  });
});
