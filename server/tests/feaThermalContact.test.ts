/**
 * Contact conductance through the real pipeline (plan -> fea_mesh (two separate volumes) -> fea_solve (tied *CONTACT PAIR with *GAP CONDUCTANCE)
 * -> analysis_report), judged with the PHY-00 judge: VC-THM-11.a/b (two slabs, interface conductance 2000 W/(m^2*K)). Skipped without llull-mesh / ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCase, editStep, expectCase, loadPlan, openCase, type ThermalCase } from './feaThermalSupport';
import { HAS_CCX, HAS_MESHER } from './feaTestSupport';

const AREA_M2 = 0.1 * 0.1;
/** The probes at 0.0099 / 0.0101 m sit in a linear field per slab: extrapolate the two interface temperatures to z = 0.01 m. */
const EXTRAPOLATION = 0.01 / 0.0099;

describe.skipIf(!HAS_MESHER || !HAS_CCX)('thermal contact conductance (netgen + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('contact');
  });
  afterEach(() => closeCase(opened));

  async function solveSlabs(contact?: Record<string, unknown>): Promise<{ c: ThermalCase; report: Record<string, unknown> }> {
    const c = opened as ThermalCase;
    const base = loadPlan('thm_contact_slabs');
    const planned = await c.runPlan(contact === undefined ? base : editStep(base, 'add_thermal_contact', contact));
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const checked = await c.cli('check_thermal', `analysisId=${c.analysisId}`);
    expect(JSON.stringify(checked.json['data'])).not.toContain('"severity":"error"');
    return { c, report: await c.solve() };
  }

  function interfaceTemperatures(c: ThermalCase, report: Record<string, unknown>): { lower: number; upper: number } {
    const [, hot] = c.probe(report, 't_hot');
    const [, cold] = c.probe(report, 't_cold');
    const [, below] = c.probe(report, 't_lower');
    const [, above] = c.probe(report, 't_upper');
    return { lower: hot + (below - hot) * EXTRAPOLATION, upper: cold + (above - cold) * EXTRAPOLATION };
  }

  it('VC-THM-11.a/b: two slabs (150 and 15 W/(m K), 10 mm each) with h = 2000 W/(m^2 K): flux 64864.9 W/m^2 (0.5 %) and a 32.43 K jump (1 %)', async () => {
    const { c, report } = await solveSlabs();
    const flux = c.flow(report, 'hot_T') / AREA_M2;
    const { lower, upper } = interfaceTemperatures(c, report);
    expectCase('VC-THM-11.a', flux, 'W/m^2');
    expectCase('VC-THM-11.b', lower - upper, 'K');
    expect(Math.abs(flux / 64864.8648649 - 1)).toBeLessThan(1e-3);
    expect(c.flow(report, 'cold_T')).toBeCloseTo(-c.flow(report, 'hot_T'), 1);
    expect(report['heatBalance']).toMatchObject({ withinTolerance: true });
  }, 300_000);

  it('a conductance table is read at the mean interface temperature: h(T) = 1000 + 30 T satisfies q = h (T1 - T2) on the solved field', async () => {
    const { c, report } = await solveSlabs({
      conductance: {
        points: [
          [1000, 0, 0],
          [4000, 0, 100],
        ],
      },
    });
    const flux = c.flow(report, 'hot_T') / AREA_M2;
    const { lower, upper } = interfaceTemperatures(c, report);
    const h = 1000 + 30 * ((lower + upper) / 2);
    expect(Math.abs(flux / (h * (lower - upper)) - 1)).toBeLessThan(5e-3);
    expect(flux).toBeGreaterThan(64864.8648649);
  }, 300_000);
});
