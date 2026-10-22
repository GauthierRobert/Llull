/**
 * thermo_static with a temperature-dependent Young's modulus through the real Netgen (llull-mesh) + CalculiX: a bar restrained along x (lateral faces free),
 * uniform 400 degC from a 20 degC reference, E(T) as a table (200 GPa at 20 degC, 185 at 300, 170 at 500), nu 0.3, constant alpha 1.2e-5 1/K.
 * Uniaxial restrained expansion: sigma = -E(T_hot) alpha dT = -177.5 GPa x 1.2e-5 x 380 K = -809.4 MPa (E at 20 degC would give -912.0 MPa,
 * +12.7 %). Skipped without llull-mesh or CalculiX.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { HAS_CCX, HAS_MESHER } from './feaTestSupport';
import { Workspace } from './feaThermomechSupport';

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

const source = { citation: 'test input of this validation case (not a material claim)' };
const property = (id: string, name: string, unit: string, form: Record<string, unknown>, range: number[]): Record<string, unknown> => ({
  command: 'define_property_model',
  params: {
    material: 'et',
    model: {
      id,
      property: name,
      unit,
      variables: [{ variable: 'T', unit: 'degC' }],
      form,
      validity: [{ variable: 'T', unit: 'degC', data: range }],
      basis: 'company',
      source,
      preferred: true,
    },
  },
});
const constrain = (name: string, dofs: Record<string, number>, near: Record<string, number[][]>): Record<string, unknown> => ({
  command: 'add_fea_constraint',
  params: { analysisId: '$an', name, kind: 'displacement', dofs, target: { entityId: '$bar', ...near } },
});

const plan = [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [100, 20, 20], position: [50, 0, 10] }, as: 'bar' },
  { command: 'create_material', params: { name: 'et', density: 0.0078 } },
  { command: 'assign_material', params: { entityIds: ['$bar'], materialName: 'et' } },
  property(
    'E.tab',
    'E',
    'GPa',
    {
      kind: 'table1d',
      variable: 'T',
      points: [
        [20, 200],
        [300, 185],
        [500, 170],
      ],
      interpolation: 'linear',
    },
    [20, 500],
  ),
  property('nu.const', 'nu', '1', { kind: 'constant', value: 0.3 }, [20, 500]),
  property('cte.const', 'cte', '1/K', { kind: 'constant', value: 1.2e-5 }, [20, 500]),
  {
    command: 'create_analysis',
    params: { name: 'restrained', analysisType: 'thermo_static', referenceTemperature: { value: 20, unit: 'degC' } },
    as: 'an',
  },
  { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar' } },
  constrain('x0', { ux: 0 }, { facesNear: [[0, 0, 10]] }),
  constrain('x1', { ux: 0 }, { facesNear: [[100, 0, 10]] }),
  constrain('pin', { uy: 0, uz: 0 }, { pointsNear: [[0, 0, 10]] }),
  constrain('rot', { uz: 0 }, { pointsNear: [[0, 10, 10]] }),
  {
    command: 'set_temperature_field',
    params: {
      analysisId: '$an',
      source: { kind: 'uniform', value: { value: 400, unit: 'degC' } },
      cteBasis: { et: { kind: 'secant', referenceTemperature: { value: 20, unit: 'degC' } } },
    },
  },
  { command: 'set_mesh_controls', params: { analysisId: '$an', globalSize: 10, order: 2 } },
  { command: 'add_result_probe', params: { analysisId: '$an', name: 'sx', point: [50, 0, 10], quantity: 's_xx' } },
];

describe.skipIf(!READY)('thermo_static follows E(T)', () => {
  it('restrained bar at 400 degC: sigma_xx = -E(400 degC) alpha dT within 0.5 %, not the 20 degC value', async () => {
    const file = path.join(workspace.dir, 'et.plan.json');
    writeFileSync(file, JSON.stringify(plan));
    const session = workspace.open('et');
    const analysisId = await session.idOf(file, 'an');
    const probes = await session.solved(analysisId, 3);
    const expected = -177500 * 1.2e-5 * 380;
    expect(probes['sx']).toBeCloseTo(expected, -1);
    expect(Math.abs((probes['sx'] ?? 0) / expected - 1)).toBeLessThan(0.005);
  }, 120_000);
});
