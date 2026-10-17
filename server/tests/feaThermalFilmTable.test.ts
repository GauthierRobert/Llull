/**
 * Temperature-dependent film coefficient h(T) (`filmTable`) through the real pipeline. CalculiX has no table on `*FILM`, so the
 * deck writes a tied gap conductance to a prescribed-temperature sink layer (thermal/deckFilmSink.ts). Closed form: a 0.1 m slab of k = 50 W/(m K)
 * held at 100 degC on one face and cooled on the other by h(T) = 100 + 2 T into 20 degC has the face temperature Ts solving
 * k (100 - Ts) / L = (100 + 2 Ts)(Ts - 20), i.e. Ts^2 + 280 Ts - 26000 = 0. Skipped without gmsh / ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCase, editStep, loadPlan, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';

const FACE_TEMPERATURE = (-280 + Math.sqrt(280 ** 2 + 4 * 26000)) / 2;
const FLUX_W_M2 = (50 * (100 - FACE_TEMPERATURE)) / 0.1;
const AREA_M2 = 0.01;

/** The same slab as a transient case (initial 20 degC, 100 s in 2 s increments) with the top film given as `film`. */
function transientPlan(film: Record<string, unknown>): PlanStep[] {
  const plan = editStep(loadPlan('thm_film_table'), 'add_thermal_bc', film, 'top_film').map((step) =>
    step.command === 'create_analysis' ? { ...step, params: { ...step.params, analysisType: 'heat_transient' } } : step,
  );
  return [
    ...plan,
    { command: 'set_initial_temperature', params: { analysisId: '$an', value: 20.0, unit: 'degC' } },
    { command: 'set_thermal_step', params: { analysisId: '$an', endTimeS: 100, initialIncrementS: 2, fixedIncrements: true } },
  ];
}

describe.skipIf(!HAS_GMSH || !HAS_CCX)('film coefficient table h(T) (gmsh + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('filmtable');
  });
  afterEach(() => closeCase(opened));

  it.each([
    [1, 0.05],
    [2, 0.05],
    [2, 0.1],
  ])(
    'steady, tet%i h=%f: face temperature 73.5416 degC and flux %f W/m^2 match the closed form (1e-4), balance under 1e-5',
    async (order, size) => {
      const c = opened as ThermalCase;
      const plan = editStep(loadPlan('thm_film_table'), 'set_mesh_controls', { order, globalSize: size });
      const planned = await c.runPlan(plan);
      expect(planned.code, String(planned.json['summary'])).toBe(0);
      const report = await c.solve();
      const [, top] = c.probe(report, 'top_face');
      expect(Math.abs(top / FACE_TEMPERATURE - 1)).toBeLessThan(1e-4);
      expect(Math.abs(c.flow(report, 'bottom_T') / AREA_M2 / FLUX_W_M2 - 1)).toBeLessThan(1e-4);
      expect(c.flow(report, 'top_film')).toBeCloseTo(-c.flow(report, 'bottom_T'), 2);
      expect((report['heatBalance'] as { residualRel: number }).residualRel).toBeLessThan(1e-5);
      expect(report['minT']).toMatchObject({ value: expect.closeTo(FACE_TEMPERATURE, 3) as unknown });
    },
    300_000,
  );

  it('refuses a table in a transient case (ccx 2.21: the surface temperature rise came out 2-8 % off a constant film), steady is the supported scope', async () => {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(
      transientPlan({
        filmTable: {
          points: [
            [0, 500],
            [100, 500],
          ],
        },
      }),
    );
    expect(planned.code).not.toBe(0);
    expect(JSON.stringify(planned.json)).toContain('THM_FILM_INVALID');
  }, 120_000);
});
