/**
 * Modal (*FREQUENCY) and linear buckling (*BUCKLE) through the real Netgen (llull-mesh) + CalculiX, against closed forms of slender steel bars (E 210 GPa,
 * nu 0.3, 7800 kg/m^3, square 10 mm section):
 * - cantilever 200 mm: f1 = (1.8751^2 / 2 pi) sqrt(E I / (rho A L^4)) = 209.5 Hz (measured 209.73, +0.1 %); the two bending planes are degenerate;
 * - fixed-free column 300 mm: P_cr = pi^2 E I / (4 L^2) = 4797.8 N, so under 1000 N the buckling factor is 4.798 (measured 4.8025, +0.1 %).
 * Skipped without llull-mesh or CalculiX.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { isRecord } from '@lib/isRecord';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { HAS_CCX, HAS_MESHER } from './feaTestSupport';
import { dataOf, Workspace, type Session } from './feaThermomechSupport';

const READY = HAS_MESHER && HAS_CCX && nativeKernelBinary !== null;
let workspace: Workspace;
beforeAll(async () => {
  workspace = new Workspace();
  if (READY) setGeometryKernel(createNativeTestKernel());
}, 120_000);
afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const E = 210000;
const SIDE = 10;
const INERTIA = SIDE ** 4 / 12;

function barPlan(length: number, analysis: Record<string, unknown>, extra: Record<string, unknown>[]): Record<string, unknown>[] {
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
    {
      command: 'add_fea_constraint',
      params: { analysisId: '$an', name: 'fix', kind: 'fixed', target: { entityId: '$bar', facesNear: [[0, SIDE / 2, SIDE / 2]] } },
    },
    ...extra,
    { command: 'set_mesh_controls', params: { analysisId: '$an', globalSize: 4, order: 2 } },
  ];
}

async function solved(name: string, plan: Record<string, unknown>[]): Promise<{ session: Session; analysisId: string; summary: string }> {
  const file = path.join(workspace.dir, `${name}.plan.json`);
  writeFileSync(file, JSON.stringify(plan));
  const session = workspace.open(name);
  const analysisId = await session.idOf(file, 'an');
  await session.mesh(analysisId);
  await session.solve(analysisId);
  const { json } = await session.cli('analysis_report', `analysisId=${analysisId}`);
  return { session, analysisId, summary: String(json['summary']) };
}

function resultsOf(json: Record<string, unknown>): Record<string, unknown> {
  const results = dataOf(json)['results'];
  return isRecord(results) ? results : {};
}

describe.skipIf(!READY)('modal and buckling analyses', () => {
  it('cantilever first natural frequency matches the Euler-Bernoulli value within 2 %', async () => {
    const length = 200;
    const { session, analysisId, summary } = await solved('modal', barPlan(length, { analysisType: 'modal', modes: 4 }, []));
    const { json } = await session.cli('analysis_report', `analysisId=${analysisId}`);
    const frequencies = resultsOf(json)['frequenciesHz'] as number[];
    const beam =
      (1.8751 ** 2 / (2 * Math.PI)) * Math.sqrt((E * 1e6 * (INERTIA * 1e-12)) / (7800 * (SIDE * SIDE * 1e-6) * (length * 1e-3) ** 4));
    expect(frequencies).toHaveLength(4);
    expect(frequencies[0]).toBeGreaterThan(beam * 0.98);
    expect(frequencies[0]).toBeLessThan(beam * 1.02);
    expect(Math.abs((frequencies[1] ?? 0) / (frequencies[0] ?? 1) - 1)).toBeLessThan(0.01);
    expect(summary).toContain('natural frequencies');
    const eigen = dataOf(json)['eigen'];
    expect(isRecord(eigen) && eigen['kind']).toBe('modal');
    expect(isRecord(eigen) && eigen['rigidBodyModes']).toBe(0);
    // ccx prints six components per participation row: a layout this reader cannot parse would drop the table, so assert it is present.
    const modes = isRecord(eigen) && Array.isArray(eigen['modes']) ? eigen['modes'] : [];
    expect(isRecord(modes[0]) && Array.isArray(modes[0]['participation'])).toBe(true);
    expect(isRecord(eigen) && eigen['warnings']).toEqual([]);
    const closedForm = await session.cli(
      'hand_check',
      'check=cantilever_frequency',
      `inputs={"E_MPa":${E},"rho_t_per_mm3":7.8e-9,"b_mm":${SIDE},"h_mm":${SIDE},"L_mm":${length}}`,
      `compare={"quantity":"frequency_weak_axis_Hz","value":${String(frequencies[0])},"toleranceRel":0.02}`,
    );
    expect(dataOf(closedForm.json)['comparison']).toMatchObject({ withinTolerance: true });
    const plot = await session.cli('render_fea_results', `analysisId=${analysisId}`, 'mode=3');
    expect(plot.code).toBe(0);
    expect(String(plot.json['summary'])).toContain('mode 3');
    expect(String(plot.json['summary'])).toContain('Hz');
  }, 180_000);

  it('fixed-free column buckles at pi^2 E I / (4 L^2) within 3 %', async () => {
    const length = 300;
    const load = {
      analysisId: '$an',
      name: 'P',
      kind: 'force',
      vector: [-1000, 0, 0],
      target: { entityId: '$bar', facesNear: [[length, SIDE / 2, SIDE / 2]] },
    };
    const { session, analysisId } = await solved(
      'buckling',
      barPlan(length, { analysisType: 'buckling', modes: 2 }, [{ command: 'add_fea_load', params: load }]),
    );
    const { json } = await session.cli('analysis_report', `analysisId=${analysisId}`);
    const factors = resultsOf(json)['bucklingFactors'] as number[];
    const critical = (Math.PI ** 2 * E * INERTIA) / (4 * length ** 2);
    expect(factors).toHaveLength(2);
    expect((factors[0] ?? 0) * 1000).toBeGreaterThan(critical * 0.97);
    expect((factors[0] ?? 0) * 1000).toBeLessThan(critical * 1.03);
    expect(dataOf(json)['eigen']).toMatchObject({ kind: 'buckling', criticalMode: 1 });
    const column = await session.cli(
      'hand_check',
      'check=euler_column',
      `inputs={"L_mm":${length},"E_MPa":${E},"b_mm":${SIDE},"h_mm":${SIDE},"K":2}`,
      `compare={"quantity":"critical_load_N","value":${(factors[0] ?? 0) * 1000},"toleranceRel":0.03}`,
    );
    expect(dataOf(column.json)['comparison']).toMatchObject({ withinTolerance: true });
    const plot = await session.cli('render_fea_results', `analysisId=${analysisId}`, 'mode=1');
    expect(String(plot.json['summary'])).toContain('buckling factor');
  }, 180_000);
});
