/**
 * Creep through the real pipeline (PHY-11 VC-CRP-40..43): the pack plans -> fea_mesh (Netgen) -> check_creep -> fea_solve (CalculiX *VISCO) ->
 * creep_report, compared with the closed forms of validation/expected_results.json. Skipped without llull-mesh / ccx.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relaxedStress } from '@cae/creep/closedForm';
import { setGeometryKernel } from '@core/geometry/kernel';
import { closeCase, dataOf, listOf, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { feaToolsMissing } from './feaTestSupport';
import { createNativeTestKernel } from './kernelTestSupport';

const PLANS = path.resolve(__dirname, '../../docs/physics/11-creep-viscoelasticity/validation/plans');
const plan = (name: string): PlanStep[] => JSON.parse(readFileSync(path.join(PLANS, `${name}.plan.json`), 'utf8')) as PlanStep[];

interface Solved {
  readonly checkBefore: Record<string, unknown>;
  readonly checkAfter: Record<string, unknown>;
  readonly report: Record<string, unknown>;
  readonly solveSummary: string;
}

async function solvePlan(c: ThermalCase, steps: PlanStep[], timeoutS = 600): Promise<Solved> {
  const planned = await c.runPlan(steps);
  expect(planned.code, String(planned.json['summary'])).toBe(0);
  const meshed = await c.cli('fea_mesh', `analysisId=${c.analysisId}`, 'timeoutS=300');
  expect(meshed.code, String(meshed.json['summary'])).toBe(0);
  const checkBefore = dataOf((await c.cli('check_creep', `analysisId=${c.analysisId}`)).json);
  const solved = await c.cli('fea_solve', `analysisId=${c.analysisId}`, `timeoutS=${timeoutS}`);
  expect(solved.code, String(solved.json['summary'])).toBe(0);
  const reported = await c.cli('creep_report', `analysisId=${c.analysisId}`);
  expect(reported.code, String(reported.json['summary'])).toBe(0);
  const checkAfter = dataOf((await c.cli('check_creep', `analysisId=${c.analysisId}`)).json);
  return { checkBefore, checkAfter, report: dataOf(reported.json), solveSummary: String(solved.json['summary']) };
}

/** Last { tS, value } of the named probe of a creep_report. */
function lastOf(report: Record<string, unknown>, name: string): { tS: number; value: number } {
  const probes = report['probes'] as Record<string, { name: string; history: { tS: number; value: number }[] }>;
  const entry = Object.values(probes).find((probe) => probe.name === name);
  const last = entry?.history.at(-1);
  if (last === undefined) throw new Error(`no history for probe '${name}'`);
  return last;
}

/** Codes of the error items of a check_creep `data`. */
const errorCodes = (data: Record<string, unknown>): string[] =>
  listOf(data['items'])
    .filter((entry) => entry['severity'] === 'error')
    .map((entry) => String(entry['code']));

function measure(caseId: string, measured: Record<string, unknown>): void {
  const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
  if (target !== undefined && target !== '')
    appendFileSync(target, `${JSON.stringify({ pack: '11-creep-viscoelasticity', caseId, measured })}\n`);
}

describe.skipIf(feaToolsMissing())('creep (netgen + ccx)', () => {
  let c: ThermalCase | undefined;

  beforeAll(async () => {
    c = await openCase('creep');
  });
  afterAll(() => closeCase(c));

  it('VC-CRP-40: Norton unit cube, 20 MPa for 1000 s, centre creep strain 0.32 within 1 %', async () => {
    if (c === undefined) throw new Error('no case');
    const { checkBefore, checkAfter, report } = await solvePlan(c, plan('crp_norton_unit_cube'));
    expect(errorCodes(checkBefore)).toEqual(['FEA_RESULTS_MISSING']);
    expect(errorCodes(checkAfter)).toEqual([]);
    const last = lastOf(report, 'centre');
    measure('VC-CRP-40', { value: last.value, unit: '-', tS: last.tS });
    expect(Math.abs(last.value / 0.32 - 1)).toBeLessThan(0.01);
    expect(listOf([report['quickCheck']])[0]?.['ratioFeToClosedForm']).toBeCloseTo(1, 2);
  }, 900_000);
  it('VC-CRP-41: bar relaxation at fixed strain, s_zz(3600 s) = 93.8687 MPa and the whole history within 1 % of the closed form', async () => {
    if (c === undefined) throw new Error('no case');
    const { checkAfter, report } = await solvePlan(c, plan('crp_bar_relaxation'));
    expect(errorCodes(checkAfter)).toEqual([]);
    const probes = report['probes'] as Record<string, { name: string; history: { tS: number; value: number }[] }>;
    const history = Object.values(probes)[0]?.history ?? [];
    const last = history.at(-1);
    measure('VC-CRP-41', { value: last?.value, unit: 'MPa', tS: last?.tS });
    expect(last?.tS).toBeCloseTo(3600, 3);
    expect(Math.abs((last?.value ?? 0) / 93.8687499151 - 1)).toBeLessThan(0.01);
    for (const point of history) expect(Math.abs(point.value / relaxedStress(100, 200000, 1e-18, 5, point.tS) - 1)).toBeLessThan(0.01);
  }, 900_000);

  it.skipIf(feaToolsMissing(true))(
    'VC-CRP-42: thick tube in stationary creep, hoop stress at the bore 14.4666 and at the outer face 20.4666 MPa within 3 %',
    async () => {
      if (c === undefined) throw new Error('no case');
      setGeometryKernel(createNativeTestKernel()); // the exact B-rep: a faceted bore would not resolve the load face
      const { checkAfter, report } = await solvePlan(c, plan('crp_thick_cylinder_stationary'), 1800);
      // the 05 through-thickness measure counts the layers across the 10 mm axial slice, which carries no bending (plane strain): the only finding
      expect(errorCodes(checkAfter)).toEqual(['FEA_MESH_INADEQUATE']);
      const bore = lastOf(report, 'bore');
      const outer = lastOf(report, 'outer');
      measure('VC-CRP-42', { bore: bore.value, outer: outer.value, unit: 'MPa', tS: bore.tS });
      expect(Math.abs(bore.value / 14.466573955 - 1)).toBeLessThan(0.03);
      expect(Math.abs(outer.value / 20.466573955 - 1)).toBeLessThan(0.03);
    },
    2_400_000,
  );

  // VC-CRP-43 (beam in stationary creep bending, plan crp_beam_stationary_bending): the plan builds and checks, but CalculiX 2.21 does not converge the first
  // *VISCO increment of the end-moment model (increment cut below the minimum, measured 2026-11-08, spec section 13): open, not asserted here
  it.todo(
    'VC-CRP-43: beam in stationary creep bending, |s_xx| at the mid-span outer fibre 110 MPa (blocked: first *VISCO increment does not converge)',
  );
});
