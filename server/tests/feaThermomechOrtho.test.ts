/**
 * PHY-04 M4b orthotropic CTE (TR-TMC-25) through the real Gmsh + CalculiX 2.21: `*EXPANSION, TYPE=ORTHO` with the isotropic `*ELASTIC` of 05 and,
 * with `set_material_orientation`, `*ORIENTATION` named on the solid section. A free 10 mm cube (one face held per axis) heated 20 -> 120 degC
 * with alpha 1 / 2 / 3 = 10 / 20 / 30 ppm per K grows 10 x alpha_i x 100 along each material direction: 0.01 / 0.02 / 0.03 mm, stress free.
 * Rotating material direction 1 onto the document y axis swaps the x and y growth. Manifold geometry (a box); skipped without Gmsh or CalculiX.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { isRecord } from '@lib/isRecord';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { dataOf, planPath, Workspace } from './feaThermomechSupport';

type Step = { command: string; params: Record<string, unknown>; as?: string };

let workspace: Workspace;
beforeAll(async () => {
  workspace = new Workspace();
  setGeometryKernel(await createManifoldKernel());
}, 120_000);
afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const ALPHA = [1e-5, 2e-5, 3e-5] as const;

/** The restrained block of PHY-04 made free (only the x = 0, y = 0, z = 0 faces held normal) with one secant CTE per material direction. */
function orthoPlan(orientation: Step[]): Step[] {
  const block = JSON.parse(readFileSync(planPath('tmc_restrained_block'), 'utf8')) as Step[];
  const steps: Step[] = [];
  for (const step of block) {
    if (step.command === 'add_fea_constraint' && ['x1', 'y1', 'z1'].includes(String(step.params['name']))) continue;
    if (step.command === 'add_result_probe') continue;
    if (step.command === 'define_property_model' && isRecord(step.params['model'])) {
      const model = step.params['model'];
      ALPHA.forEach((alpha, index) =>
        steps.push({
          ...step,
          params: {
            ...step.params,
            model: { ...model, id: `cte${index + 1}`, direction: String(index + 1), form: { kind: 'constant', value: alpha } },
          },
        }),
      );
      continue;
    }
    steps.push(step);
  }
  return [...steps, ...orientation];
}

async function growth(name: string, orientation: Step[]): Promise<{ deck: string; u: number[]; vonMises: number }> {
  const session = workspace.open(name);
  const file = path.join(workspace.dir, `${name}.plan.json`);
  writeFileSync(file, JSON.stringify(orthoPlan(orientation)));
  const analysisId = await session.idOf(file, 'an');
  await session.mesh(analysisId);
  const exported = await session.cli('fea_export', `analysisId=${analysisId}`);
  await session.solve(analysisId);
  const u = [];
  for (const field of ['u_x', 'u_y', 'u_z']) {
    const read = await session.cli('fea_result_field', `analysisId=${analysisId}`, `field=${field}`, 'points=[[10,10,10]]');
    const rows = dataOf(read.json)['rows'];
    u.push(Array.isArray(rows) && isRecord(rows[0]) ? Number(rows[0]['value']) : Number.NaN);
  }
  const vm = await session.cli('fea_result_field', `analysisId=${analysisId}`, 'field=von_mises', 'limit=1');
  const max = dataOf(vm.json)['max'];
  return { deck: String(dataOf(exported.json)['text']), u, vonMises: isRecord(max) ? Number(max['value']) : Number.NaN };
}

describe.skipIf(!HAS_GMSH || !HAS_CCX)('orthotropic thermal expansion in CalculiX 2.21', () => {
  it('grows 10 x alpha_i x dT along each axis with *EXPANSION, TYPE=ORTHO and an isotropic *ELASTIC, stress free', async () => {
    const { deck, u, vonMises } = await growth('ortho', []);
    expect(deck).toContain('*EXPANSION, TYPE=ORTHO, ZERO=20');
    ALPHA.forEach((alpha, axis) => expect((u[axis] ?? 0) / (10 * alpha * 100) - 1).toBeCloseTo(0, 4));
    expect(vonMises).toBeLessThan(0.01);
  }, 300_000);

  it('follows set_material_orientation: material direction 1 along y swaps the x and y growth (*ORIENTATION on the section)', async () => {
    const orientation: Step = {
      command: 'set_material_orientation',
      params: { analysisId: '$an', entityId: '$bar', axis1: [0, 1, 0], axis2: [-1, 0, 0] },
    };
    const { deck, u, vonMises } = await growth('ortho-rotated', [orientation]);
    expect(deck).toMatch(/\*SOLID SECTION, ELSET=\w+, MATERIAL=M_1, ORIENTATION=OR_\w+/);
    expect((u[0] ?? 0) / (10 * ALPHA[1] * 100) - 1).toBeCloseTo(0, 4);
    expect((u[1] ?? 0) / (10 * ALPHA[0] * 100) - 1).toBeCloseTo(0, 4);
    expect((u[2] ?? 0) / (10 * ALPHA[2] * 100) - 1).toBeCloseTo(0, 4);
    expect(vonMises).toBeLessThan(0.01);
  }, 300_000);
});
