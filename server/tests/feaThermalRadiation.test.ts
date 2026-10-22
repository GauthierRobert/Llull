/**
 * Wall convection and radiation benchmarks through the real pipeline (plan -> fea_mesh -> fea_solve -> analysis_report), judged with the PHY-00
 * judge against the pack's expected_results.json: VC-THM-01.a-d, VC-THM-05 (NAFEMS T2), VC-THM-14.a/b (CalculiX oneel8ra) and the open-cavity
 * plates of VC-THM-09/10. Plans: server/tests/fixtures/thermal. Skipped without llull-mesh / ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STEFAN_BOLTZMANN as SIGMA, viewFactorParallel } from '@cae/thermal/thermalClosedForms';
import { closeCase, expectCase, loadPlan, openCase, type ThermalCase } from './feaThermalSupport';
import { HAS_CCX, HAS_MESHER } from './feaTestSupport';

describe.skipIf(!HAS_MESHER || !HAS_CCX)('wall and radiation benchmarks (netgen + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('radiation');
  });
  afterEach(() => closeCase(opened));

  async function solveCase(plan: string): Promise<{ c: ThermalCase; report: Record<string, unknown> }> {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(loadPlan(plan));
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    return { c, report: await c.solve() };
  }

  it('VC-THM-01.a-d: wall with films on both faces (flux, face temperatures, heat balance)', async () => {
    const { c, report } = await solveCase('thm_wall_convection');
    const [, hot] = c.probe(report, 'hot_face');
    const [, cold] = c.probe(report, 'cold_face');
    expectCase('VC-THM-01.a', c.flow(report, 'hot_film'), 'W/m^2');
    expectCase('VC-THM-01.b', hot);
    expectCase('VC-THM-01.c', cold);
    expectCase('VC-THM-01.d', (report['heatBalance'] as { residualRel: number }).residualRel);
    expect(c.flow(report, 'cold_film')).toBeCloseTo(-c.flow(report, 'hot_film'), 1);
    expect(report['physicalConstants']).toBeNull();
  }, 120_000);

  it('VC-THM-05 NAFEMS T2: radiating face of the 1D slab at 927.008 K with the exact SI sigma (0.1 %)', async () => {
    const { c, report } = await solveCase('thm_nafems_t2_radiation');
    const [, temperature] = c.probe(report, 'face');
    expectCase('VC-THM-05', temperature);
    expect(Math.abs(temperature - 927.00395045)).toBeLessThan(0.01);
    expect(report['physicalConstants']).toMatchObject({
      stefanBoltzmann: { value: SIGMA, defaulted: true },
      absoluteZero: { value: 0, unit: 'K', defaulted: true },
    });
  }, 120_000);

  it('VC-THM-14.a/b CalculiX oneel8ra: -0.950739 degC and 47.5369 W with the recorded sigma 5.669e-8 override (1e-4)', async () => {
    const { c, report } = await solveCase('thm_oneel8ra_radiation');
    const [, temperature] = c.probe(report, 'face');
    expectCase('VC-THM-14.a', temperature);
    expectCase('VC-THM-14.b', c.flow(report, 'fixed'));
    expect(report['physicalConstants']).toMatchObject({
      stefanBoltzmann: { value: 5.669e-8, defaulted: false, source: expect.stringContaining('oneel8ra') as unknown },
      absoluteZero: { value: -273.15, unit: 'degC', defaulted: true },
    });
    expect((report['heatBalance'] as { residualRel: number }).residualRel).toBeLessThan(1e-4);
  }, 120_000);

  it('oneel8ra with the default exact sigma misses 1e-4 (why the override is recorded): the plan without it is 2e-4 off', async () => {
    const c = opened as ThermalCase;
    const plan = loadPlan('thm_oneel8ra_radiation').filter((step) => step.command !== 'set_thermal_physical_constants');
    expect((await c.runPlan(plan)).code).toBe(0);
    const report = await c.solve();
    const [, temperature] = c.probe(report, 'face');
    const relative = Math.abs(temperature / -0.950738649222 - 1);
    expect(relative).toBeGreaterThan(1e-4);
    expect(relative).toBeLessThan(5e-4);
    expect(report['physicalConstants']).toMatchObject({ stefanBoltzmann: { value: SIGMA, defaulted: true } });
  }, 120_000);

  it('VC-THM-09/10 open cavity: two black 1 m plates 1 m apart match the closed-form view-factor exchange (0.5 %); warns that the balance is not integrated', async () => {
    const { c, report } = await solveCase('thm_parallel_plates_cavity');
    const f12 = viewFactorParallel(1, 1, 1);
    const [t1, t2, environment] = [400, 300, 1];
    const hot = SIGMA * (t1 ** 4 - f12 * t2 ** 4 - (1 - f12) * environment ** 4);
    const cold = SIGMA * (f12 * t1 ** 4 + (1 - f12) * environment ** 4 - t2 ** 4);
    expect(Math.abs(c.flow(report, 'hot_T') / hot - 1)).toBeLessThan(0.005);
    expect(Math.abs(c.flow(report, 'cold_T') / -cold - 1)).toBeLessThan(0.005);
    const checked = await c.cli('check_thermal', `analysisId=${c.analysisId}`);
    expect(JSON.stringify(checked.json['data'])).toContain('heat balance not evaluated');
  }, 180_000);
});
