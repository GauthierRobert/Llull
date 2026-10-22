/**
 * VC-THM-30: the view factor CalculiX uses in a cavity (`*RADIATE, CAVITY=` through the real pipeline) against `compute_view_factors` and
 * the closed form 0.199824895698 (VC-THM-09.a: two parallel directly opposed unit squares 1 m apart); the converged CalculiX factor is judged
 * against the pack value (pinned 2026-10-17, abs 5e-4).
 * Plans: server/tests/fixtures/thermal/thm_parallel_plates_cavity. Skipped without llull-mesh / ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { STEFAN_BOLTZMANN as SIGMA, viewFactorParallel } from '@cae/thermal/thermalClosedForms';
import { closeCase, editStep, expectCase, loadPlan, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { HAS_CCX, HAS_MESHER } from './feaTestSupport';

/** Plate 1 is held at 1 K (as is the environment) and plate 2 at 500 K, so the plate-1 balance is -sigma F12 (T2^4 - 1) A. */
const [T_PLATE_1, T_PLATE_2] = [1, 500];
const AREA_M2 = 1;
const CLOSED_FORM = viewFactorParallel(1, 1, 1);

const SQUARE = (height: number, flip: boolean): { name: string; vertices: number[][]; flip?: boolean } => ({
  name: flip ? 'upper' : 'lower',
  vertices: [
    [0, 0, height],
    [1, 0, height],
    [1, 1, height],
    [0, 1, height],
  ],
  ...(flip ? { flip: true } : {}),
});

/** F12 of `compute_view_factors` (pure TS contour integral) for the two squares facing each other. */
function llullFactor(): number {
  const result = execute(createEmptyDocument(), 'compute_view_factors', { lengthUnit: 'm', surfaces: [SQUARE(0, false), SQUARE(1, true)] });
  const matrix = (result.data as { matrix: number[][] }).matrix;
  return matrix[0]?.[1] ?? Number.NaN;
}

/** The pack's plate plan with very conductive plates (the radiating faces sit at the BC temperatures), plates at 1 K and 500 K, and face probes. */
function plan(size: number, order: number): PlanStep[] {
  const conductive = loadPlan('thm_parallel_plates_cavity').map((step) =>
    step.command === 'define_property_model' && (step.params['model'] as { id: string }).id === 'k_const'
      ? { ...step, params: { ...step.params, model: { ...(step.params['model'] as object), form: { kind: 'constant', value: 1e5 } } } }
      : step,
  );
  const edited = editStep(
    editStep(editStep(conductive, 'add_thermal_bc', { value: T_PLATE_1 }, 'hot_T'), 'add_thermal_bc', { value: T_PLATE_2 }, 'cold_T'),
    'set_mesh_controls',
    { globalSize: size, order },
  );
  return [
    ...edited,
    { command: 'add_result_probe', params: { analysisId: '$an', name: 'face1', point: [0.5, 0.5, 0], quantity: 'temperature' } },
    { command: 'add_result_probe', params: { analysisId: '$an', name: 'face2', point: [0.5, 0.5, 1], quantity: 'temperature' } },
  ];
}

describe.skipIf(!HAS_MESHER || !HAS_CCX)('VC-THM-30: CalculiX cavity view factor vs compute_view_factors (netgen + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('viewfactor');
  });
  afterEach(() => closeCase(opened));

  /** F12 inferred from the plate-1 heat flow: q1 = sigma A (T1^4 - F12 T2^4 - (1 - F12) Te^4), Te = 1 K (open environment). */
  async function ccxFactor(size: number, order: number): Promise<number> {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(plan(size, order));
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const report = await c.solve();
    const [, face1] = c.probe(report, 'face1');
    const [, face2] = c.probe(report, 'face2');
    const lost = c.flow(report, 'hot_T');
    return (lost / (SIGMA * AREA_M2) - (face1 ** 4 - 1)) / -(face2 ** 4 - 1);
  }

  it('llull TS factor equals the closed form 0.199824895698 (1e-5); CalculiX agrees with both within 2e-4 on a coarse tet4 mesh and 2e-5 on tet10 h = 0.05', async () => {
    const llull = llullFactor();
    expect(Math.abs(llull - CLOSED_FORM)).toBeLessThan(1e-5);
    expect(CLOSED_FORM).toBeCloseTo(0.199824895698, 11);
    const coarse = await ccxFactor(0.1, 1);
    const fine = await ccxFactor(0.05, 2);
    expect(Math.abs(coarse - llull)).toBeLessThan(2e-4);
    expect(Math.abs(fine - llull)).toBeLessThan(2e-5);
    expect(Math.abs(fine - CLOSED_FORM)).toBeLessThan(2e-5);
    expectCase('VC-THM-30', fine);
  }, 600_000);
});
