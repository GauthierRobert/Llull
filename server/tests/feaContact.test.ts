/**
 * Structural contact through the real pipeline (PHY-06 VC-CNT-30, VC-CNT-50 deck acceptance): a 10 mm steel cube pressed with 10 MPa
 * (1000 N) on an equal cube (surface_to_surface linear penalty, mu 0.2, adjust 0.01), then slid 0.05 mm along x. plan -> fea_mesh (Netgen, two
 * volumes) -> check_contact -> fea_solve (CalculiX) -> contact_report + the ground reaction curve. Skipped without llull-mesh / ccx.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeCase, dataOf, listOf, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { feaToolsMissing } from './feaTestSupport';

const PLAN = path.resolve(__dirname, 'fixtures/contact/cnt_friction_block.plan.json');
const NORMAL_FORCE_N = 1000;
const MU = 0.2;

describe.skipIf(feaToolsMissing())('structural contact (netgen + ccx)', () => {
  let c: ThermalCase | undefined;
  let rows: Record<string, number>[] = [];
  let checkBefore: Record<string, unknown> = {};
  let checkAfter: Record<string, unknown> = {};
  let peakFriction = Number.NaN;

  beforeAll(async () => {
    c = await openCase('contact');
    const planned = await c.runPlan(JSON.parse(readFileSync(PLAN, 'utf8')) as PlanStep[]);
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const meshed = await c.cli('fea_mesh', `analysisId=${c.analysisId}`, 'timeoutS=300');
    expect(meshed.code, String(meshed.json['summary'])).toBe(0);
    checkBefore = dataOf((await c.cli('check_contact', `analysisId=${c.analysisId}`)).json);
    const solved = await c.cli('fea_solve', `analysisId=${c.analysisId}`, 'timeoutS=600');
    expect(solved.code, String(solved.json['summary'])).toBe(0);
    const reported = await c.cli('contact_report', `analysisId=${c.analysisId}`);
    expect(reported.code, String(reported.json['summary'])).toBe(0);
    rows = listOf(dataOf(reported.json)['rows']) as Record<string, number>[];
    checkAfter = dataOf(
      (await c.cli('check_contact', `analysisId=${c.analysisId}`, 'penetrationTolerance={"value":0.01,"source":"test"}')).json,
    );
    peakFriction = c.document().analysis?.cases[c.analysisId]?.results?.nonlinear?.curves[0]?.peakLoad ?? Number.NaN;
    const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
    if (target !== undefined && target !== '')
      appendFileSync(
        target,
        `${JSON.stringify({ pack: '06-contact-joints', caseId: 'VC-CNT-30.a', measured: { value: Math.abs(peakFriction), unit: 'N' }, rows })}\n`,
      );
  }, 900_000);

  afterAll(() => closeCase(c));

  it('accepts the deck: no set-up error before the solve, no overclosure, one row per step from the frd CONTACT block', () => {
    expect(JSON.stringify(checkBefore['items'])).not.toContain('"severity":"error"');
    expect(JSON.stringify(checkBefore['items'])).not.toContain('CNT_INITIAL_OVERCLOSURE');
    expect(rows.map((row) => row['solverStep'])).toEqual([1, 2]);
  });

  it('pressing: the whole slave face is closed, sticks, and carries the 1000 N normal load (0.5 %); COPEN < 0 is the penalty overclosure', () => {
    const pressed = rows[0] ?? {};
    expect(pressed['closedAreaFraction']).toBe(1);
    expect(pressed['slidingAreaFraction']).toBe(0);
    expect(Math.abs((pressed['normalForce'] ?? 0) / NORMAL_FORCE_N - 1)).toBeLessThan(0.005);
    expect(
      Math.abs((pressed['maxPenetration'] ?? 0) - ((pressed['maxPressure'] as unknown as { value: number }).value ?? 0) / 1e6),
    ).toBeLessThan(1e-9);
  });

  it('VC-CNT-30.a: sliding, the ground reaction plateaus at mu N = 200 N (2 %), the face slides with shear = mu x pressure', () => {
    expect(Math.abs(Math.abs(peakFriction) / (MU * NORMAL_FORCE_N) - 1)).toBeLessThan(0.02);
    const slid = rows[1] ?? {};
    expect(slid['slidingAreaFraction']).toBe(1);
    expect(Math.abs((slid['shearForce'] ?? 0) / (slid['normalForce'] ?? 1) - MU)).toBeLessThan(1e-3);
    expect(slid['maxSlip']).toBeGreaterThan(0.04);
    const codes = listOf(checkAfter['items']).map((entry) => entry['code']);
    expect(codes).not.toContain('CNT_CONTACT_NOT_CONVERGED');
    expect(codes).not.toContain('CNT_PENETRATION_EXCESSIVE');
  });
});
