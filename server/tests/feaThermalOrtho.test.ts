/**
 * Orthotropic conductivity (k models of direction 1 / 2 / 3 -> `*CONDUCTIVITY, TYPE=ORTHO`) through the real pipeline: a 0.1 m cube with
 * k = (10, 20, 30) W/(m K) held at 100 / 0 degC on opposing faces along each axis carries q = k_i dT / L = 100 000 / 200 000 / 300 000 W/m^2 (the
 * field is linear, so tet10 is exact). Skipped without gmsh / ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCase, editStep, loadPlan, openCase, type ThermalCase } from './feaThermalSupport';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';

const SIDE_M = 0.1;
const CONDUCTIVITY = [10, 20, 30];
const DELTA_T = 100;
/** Centre of the low / high face along axis i. */
const face = (axis: number, high: boolean): number[] => [0, 1, 2].map((i) => (i === axis ? (high ? SIDE_M : 0) : SIDE_M / 2));

describe.skipIf(!HAS_GMSH || !HAS_CCX)('orthotropic conductivity (gmsh + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('ortho');
  });
  afterEach(() => closeCase(opened));

  it.each([0, 1, 2])(
    'axis %i: heat flow k_i dT A / L through the cube and a linear mid temperature (0.1 %)',
    async (axis) => {
      const c = opened as ThermalCase;
      let plan = loadPlan('thm_ortho_conductivity');
      plan = editStep(plan, 'add_thermal_bc', { target: { entityId: '$block', facesNear: [face(axis, false)] } }, 'hot_T');
      plan = editStep(plan, 'add_thermal_bc', { target: { entityId: '$block', facesNear: [face(axis, true)] } }, 'cold_T');
      const planned = await c.runPlan(plan);
      expect(planned.code, String(planned.json['summary'])).toBe(0);
      const checked = await c.cli('check_thermal', `analysisId=${c.analysisId}`);
      expect(JSON.stringify(checked.json['data'])).not.toContain('"severity":"error"');
      const report = await c.solve();
      const expected = ((CONDUCTIVITY[axis] ?? 0) * DELTA_T * SIDE_M * SIDE_M) / SIDE_M;
      expect(Math.abs(c.flow(report, 'hot_T') / expected - 1)).toBeLessThan(1e-3);
      expect(c.flow(report, 'cold_T')).toBeCloseTo(-c.flow(report, 'hot_T'), 3);
      const [, middle] = c.probe(report, 'middle');
      expect(middle).toBeCloseTo(DELTA_T / 2, 2);
    },
    300_000,
  );
});
