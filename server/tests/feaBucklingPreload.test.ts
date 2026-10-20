/**
 * What CalculiX 2.21 does with the eigen decks of FEA-REST (05 §13), on slender steel bars (E 210 GPa, nu 0.3, 7800 kg/m^3, square 10 mm section),
 * through the real Gmsh + ccx (Manifold geometry, no native kernel needed):
 * - free-free modal (`*FREQUENCY n, -1`): six rigid-body modes, then the first free-free bending pair at (4.730^2 / 2 pi) sqrt(E I / (rho A L^4))
 *   = 1333 Hz for L = 200 mm (measured 1321.7, -0.8 %: shear and rotary inertia); TOTAL EFFECTIVE MASS = rho V;
 * - fixed-free column 300 mm, P_cr = pi^2 E I / (4 L^2) = 4797.8 N: under a 2000 N preload (set_buckling_preload) and a 1000 N reference the factor
 *   is 1.6008 = P_cr / 3000 N, i.e. it multiplies preload + reference (it would be 2.80 if the preload were held constant).
 * Skipped without Gmsh or CalculiX.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { FEA_TOOL_ENV, HAS_CCX, HAS_GMSH } from './feaTestSupport';

type Step = Record<string, unknown>;

const E = 210000;
const SIDE = 10;
const INERTIA = SIDE ** 4 / 12;
let work = '';

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-eigen-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  setGeometryKernel(await createManifoldKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

async function report(name: string, plan: Step[]): Promise<{ eigen: Record<string, unknown>; summary: string }> {
  const docPath = path.join(work, `${name}.llull.json`);
  const cli = async (...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> => {
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      readStdin: () => Promise.resolve(''),
      env: { ...FEA_TOOL_ENV },
      prepareKernel: () => Promise.resolve(),
    };
    const code = await runCli([...argv, '--doc', docPath, '--json'], io);
    const parsed: unknown = JSON.parse(out.join('') || '{}');
    return { code, json: isRecord(parsed) ? parsed : {} };
  };
  const planPath = path.join(work, `${name}.plan.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  const ran = await cli('run', planPath);
  expect(ran.code, String(ran.json['summary'])).toBe(EXIT_OK);
  const analysisId = Object.keys(deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases ?? {})[0] ?? '';
  for (const tool of ['fea_mesh', 'fea_solve']) {
    const done = await cli(tool, `analysisId=${analysisId}`);
    expect(done.code, String(done.json['summary'])).toBe(EXIT_OK);
  }
  const { json } = await cli('fea_report', `analysisId=${analysisId}`);
  const eigen = dataOf(json)['eigen'];
  return { eigen: isRecord(eigen) ? eigen : {}, summary: String(json['summary']) };
}

function bar(length: number, analysis: Record<string, unknown>, extra: Step[], clamped = true): Step[] {
  return [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [length, SIDE, SIDE], position: [0, 0, 0], anchor: 'min' }, as: 'bar' },
    { command: 'create_material', params: { name: 'st', density: 0.0078 } },
    {
      command: 'add_material_model',
      params: {
        material: 'st',
        id: 'elastic',
        model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
        basis: 'company',
        source: { citation: 'test input' },
      },
    },
    { command: 'define_constitutive_set', params: { material: 'st', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
    { command: 'assign_material', params: { materialName: 'st', entityIds: ['$bar'] } },
    { command: 'create_analysis', params: { name: 'eigen', ...analysis }, as: 'an' },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar' } },
    ...(clamped
      ? [
          {
            command: 'add_fea_constraint',
            params: { analysisId: '$an', name: 'fix', kind: 'fixed', target: { entityId: '$bar', facesNear: [[0, 5, 5]] } },
          },
        ]
      : []),
    ...extra,
    { command: 'set_mesh_controls', params: { analysisId: '$an', globalSize: 4, order: 2 } },
  ];
}

const endForce = (name: string, fx: number, loadCase: string): Step => ({
  command: 'add_fea_load',
  params: { analysisId: '$an', name, kind: 'force', vector: [fx, 0, 0], loadCase, target: { entityId: '$bar', facesNear: [[300, 5, 5]] } },
});

describe.skipIf(!HAS_GMSH || !HAS_CCX)('eigen decks against CalculiX 2.21', () => {
  it('free-free modal (*FREQUENCY n, -1): six rigid-body modes, then the free-free bending pair; total effective mass = rho V', async () => {
    const { eigen, summary } = await report('free', bar(200, { analysisType: 'modal', modes: 10 }, [], false));
    expect(eigen['rigidBodyModes']).toBe(6);
    const modes = Array.isArray(eigen['modes']) ? eigen['modes'].filter(isRecord) : [];
    const freeFree = (4.73 ** 2 / (2 * Math.PI)) * Math.sqrt((E * 1e6 * INERTIA * 1e-12) / (7800 * SIDE * SIDE * 1e-6 * 0.2 ** 4));
    expect(Number(modes[6]?.['frequencyHz']) / freeFree - 1).toBeGreaterThan(-0.03);
    expect(Number(modes[6]?.['frequencyHz']) / freeFree - 1).toBeLessThan(0.01);
    const total = eigen['totalEffectiveMass'] as number[];
    for (const component of total) expect(Math.abs(component / (200 * SIDE * SIDE * 7.8e-9) - 1)).toBeLessThan(0.01);
    expect(summary).toContain('of the model mass');
  }, 300_000);

  it('a buckling preload is scaled with the reference: factor x (preload + reference) = P_cr', async () => {
    const critical = (Math.PI ** 2 * E * INERTIA) / (4 * 300 ** 2);
    const plain = await report('buckle', bar(300, { analysisType: 'buckling', modes: 2 }, [endForce('P', -1000, 'REF')]));
    expect(plain.eigen).toMatchObject({ factorsMultiply: 'reference' });
    expect((Number(plain.eigen['criticalFactor']) * 1000) / critical - 1).toBeLessThan(0.03);
    const preloaded = await report(
      'preload',
      bar(300, { analysisType: 'buckling', modes: 2 }, [
        endForce('pre', -2000, 'PRE'),
        endForce('P', -1000, 'REF'),
        { command: 'set_buckling_preload', params: { analysisId: '$an', preloadLoadCase: 'PRE' } },
      ]),
    );
    expect(preloaded.eigen).toMatchObject({ factorsMultiply: 'preload_and_reference' });
    expect(Number(preloaded.eigen['criticalFactor']) / Number(plain.eigen['criticalFactor'])).toBeCloseTo(1 / 3, 4);
    expect(preloaded.summary).toContain('(preload + reference)');
  }, 300_000);
});
