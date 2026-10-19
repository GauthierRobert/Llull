/**
 * Coupled temperature-displacement with a temperature-dependent Young's modulus through the real Gmsh + CalculiX: the restrained bar of
 * tmc_coupled_bar (both ends 120 degC, 20 degC reference, alpha 1.2e-5 1/K, restrained along x) with E(T) as a table
 * (200 GPa at 20 degC, 185 at 300, 170 at 500). The solved field is uniform 120 degC, so sigma_xx = -E(120 degC) alpha dT
 * = -(200 - 15 x 100 / 280) GPa x 1.2e-5 x 100 K = -233.57 MPa (the constant 200 GPa at the reference would give -240.0 MPa, +2.8 %).
 * Skipped without Gmsh or CalculiX.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { isRecord } from '@lib/isRecord';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { dataOf, planPath, Workspace } from './feaThermomechSupport';

const READY = HAS_GMSH && HAS_CCX && nativeKernelBinary !== null;
let workspace: Workspace;
beforeAll(async () => {
  workspace = new Workspace();
  if (READY) setGeometryKernel(createNativeTestKernel());
}, 120_000);
afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const source = { citation: 'test input of this validation case (not a material claim)' };
const property = (id: string, name: string, unit: string, form: Record<string, unknown>): Record<string, unknown> => ({
  command: 'define_property_model',
  params: {
    material: 'steel_test',
    model: {
      id,
      property: name,
      unit,
      variables: [{ variable: 'T', unit: 'degC' }],
      form,
      validity: [{ variable: 'T', unit: 'degC', data: [20, 500] }],
      basis: 'company',
      source,
      preferred: true,
    },
  },
});

/** The tmc_coupled_bar plan with its constant elastic constitutive set replaced by E(T) / nu property models. */
function barPlan(): unknown[] {
  const base: unknown = JSON.parse(readFileSync(planPath('tmc_coupled_bar'), 'utf8'));
  const steps = (Array.isArray(base) ? base : []).filter(
    (step) => !(isRecord(step) && (step['command'] === 'add_material_model' || step['command'] === 'define_constitutive_set')),
  );
  const at = steps.findIndex((step) => isRecord(step) && step['command'] === 'assign_material');
  steps.splice(
    at,
    0,
    property('E.tab', 'E', 'GPa', {
      kind: 'table1d',
      variable: 'T',
      points: [
        [20, 200],
        [300, 185],
        [500, 170],
      ],
      interpolation: 'linear',
    }),
    property('nu.const', 'nu', '1', { kind: 'constant', value: 0.3 }),
  );
  return steps;
}

describe.skipIf(!READY)('coupled procedure follows E(T)', () => {
  it('writes an E, nu, T table and the restrained bar at 120 degC gives sigma_xx = -E(120 degC) alpha dT within 1 %', async () => {
    const file = path.join(workspace.dir, 'coupled-et.plan.json');
    writeFileSync(file, JSON.stringify(barPlan()));
    const session = workspace.open('coupled-et');
    const analysisId = await session.idOf(file, 'an');
    await session.mesh(analysisId);
    const exported = await session.cli('fea_export', `analysisId=${analysisId}`);
    const deck = String(dataOf(exported.json)['text']);
    expect(deck).toMatch(/\*ELASTIC\n200000, 0\.3, 20\n/);
    await session.solve(analysisId);
    const probes = await session.probes(analysisId, 3);
    const expected = -(200000 - (15000 * 100) / 280) * 1.2e-5 * 100;
    expect(probes['T_mid']).toBeCloseTo(120, 3);
    expect(Math.abs((probes['mid'] ?? 0) / expected - 1)).toBeLessThan(0.01);
    expect(Math.abs((probes['mid'] ?? 0) / (-200000 * 1.2e-5 * 100) - 1)).toBeGreaterThan(0.02);
  }, 240_000);
});
