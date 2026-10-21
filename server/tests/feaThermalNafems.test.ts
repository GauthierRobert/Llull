/**
 * NAFEMS thermal benchmarks through the real pipeline (plan -> fea_mesh (Gmsh) -> fea_solve (CalculiX) -> analysis_report), judged with the
 * PHY-00 judge against the pack's expected_results.json: VC-THM-03 (T3, transient, sine amplitude) and VC-THM-04 (T4, steady, films).
 * Plans: server/tests/fixtures/thermal (the pack's plans adapted to create_material + define_property_model). Skipped without gmsh / ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCase, expectCase, loadPlan, openCase, type ThermalCase } from './feaThermalSupport';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';

describe.skipIf(!HAS_GMSH || !HAS_CCX)('NAFEMS thermal benchmarks (gmsh + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('nafems');
  });
  afterEach(() => closeCase(opened));

  const solveCase = async (plan: string): Promise<{ c: ThermalCase; report: Record<string, unknown> }> => {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(loadPlan(plan));
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const checked = await c.cli('check_thermal', `analysisId=${c.analysisId}`);
    expect(JSON.stringify(checked.json['data'])).not.toContain('"severity":"error"');
    return { c, report: await c.solve() };
  };

  it('VC-THM-03 NAFEMS T3: 36.6 degC at x = 0.08 m, t = 32 s (1 %), heat balance under 5 %', async () => {
    const { c, report } = await solveCase('thm_nafems_t3');
    const [time, temperature] = c.probe(report, 'x080');
    expect(time).toBe(32);
    expectCase('VC-THM-03', temperature);
    expect(Math.abs(temperature / 36.603116 - 1)).toBeLessThan(0.01);
    expect(report['state']).toBe('solved');
    // A boundary driven by an amplitude leaves a few percent the solver's prescribed-node treatment does not close (see heatBalance.ts).
    expect((report['heatBalance'] as { residualRel: number }).residualRel).toBeLessThan(0.05);
  }, 300_000);

  it('VC-THM-04 NAFEMS T4: 18.2538 degC at (0.6, 0.2) m (1 %) on a thin slab with adiabatic faces', async () => {
    const { c, report } = await solveCase('thm_nafems_t4');
    const [, temperature] = c.probe(report, 'E');
    expectCase('VC-THM-04', temperature);
    expect(Math.abs(temperature / 18.2537565 - 1)).toBeLessThan(0.01);
    expect(report['heatBalance']).toMatchObject({ withinTolerance: true });
  }, 300_000);
});
