/**
 * Bolt pretension through the real pipeline (PHY-06 VC-CNT-51, FR-CNT-03/04): a 6 mm x 20 mm steel bar fixed at both ends with a pretension
 * section of 10 kN at mid-length. plan -> fea_mesh (Netgen) -> check_contact -> fea_solve (CalculiX) -> contact_report + the end reactions.
 * Oracle: statics (each end reaction = the preload, section force = the preload) and, for the lock, the bar stiffness E A / L. Skipped without llull-mesh / ccx.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boltCuts } from '@cae/contact/pretensionResults';
import type { FeMeshArtifact } from '@core/model/analysis';
import { closeCase, dataOf, listOf, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { feaToolsMissing } from './feaTestSupport';

const PLAN = path.resolve(__dirname, 'fixtures/contact/cnt_pretension_bar.plan.json');
const PRELOAD_N = 10_000;
const YOUNG_MPA = 200_000;
const LENGTH_MM = 20;
const STRETCH_MM = 0.01;

const plan = (): PlanStep[] => JSON.parse(readFileSync(PLAN, 'utf8')) as PlanStep[];

/** The bar with the top end driven in z (0 in the preload step, `STRETCH_MM` in a second step) instead of fixed: a service step that adds elongation. */
function driven(lockAfter: boolean): PlanStep[] {
  const step = (name: string, value: number, as: string): PlanStep => ({
    command: 'add_analysis_step',
    params: {
      analysisId: '$an',
      name,
      multipliers: {},
      control: {
        kind: 'displacement',
        target: { entityId: '$bolt', facesNear: [[0, 0, 20]] },
        dof: 'uz',
        value,
        initialIncrement: 0.5,
        minIncrement: 0.0001,
        maxIncrement: 1,
        maxIncrements: 20,
      },
    },
    as,
  });
  const out: PlanStep[] = [];
  for (const entry of plan()) {
    if (entry.command === 'add_fea_constraint' && entry.params['name'] === 'top') continue;
    if (entry.command === 'add_curve_probe' && entry.params['name'] === 'top_reaction') continue;
    if (entry.command === 'add_analysis_step') out.push(step('preload', 0, 'st1'), step('stretch', STRETCH_MM, 'st2'));
    else if (entry.command === 'add_bolt_pretension') out.push({ ...entry, params: { ...entry.params, lockAfter } });
    else out.push(entry);
  }
  return out;
}

interface Run {
  readonly bolts: Record<string, number | null>[];
  readonly peaks: Record<string, number>;
  readonly check: Record<string, unknown>;
  readonly checkBefore: Record<string, unknown>;
  readonly area: number;
}

/** The artifact store reads LLULL_FEA_CACHE once (the first case opened): every run of this file writes its artifacts there. */
let cacheDirectory = '';

async function runPlan(name: string, steps: PlanStep[]): Promise<{ run: Run; c: ThermalCase }> {
  const c = await openCase(name);
  if (cacheDirectory === '') cacheDirectory = path.join(c.dir, 'cache');
  const planned = await c.runPlan(steps);
  expect(planned.code, String(planned.json['summary'])).toBe(0);
  const meshed = await c.cli('fea_mesh', `analysisId=${c.analysisId}`, 'timeoutS=300');
  expect(meshed.code, String(meshed.json['summary'])).toBe(0);
  const checkBefore = dataOf((await c.cli('check_contact', `analysisId=${c.analysisId}`)).json);
  const solved = await c.cli('fea_solve', `analysisId=${c.analysisId}`, 'timeoutS=600');
  expect(solved.code, String(solved.json['summary'])).toBe(0);
  const reported = await c.cli('contact_report', `analysisId=${c.analysisId}`);
  expect(reported.code, String(reported.json['summary'])).toBe(0);
  const check = dataOf((await c.cli('check_contact', `analysisId=${c.analysisId}`)).json);
  const analysis = c.document().analysis?.cases[c.analysisId];
  const peaks = Object.fromEntries((analysis?.results?.nonlinear?.curves ?? []).map((curve) => [curve.name, curve.peakLoad]));
  const meshHash = analysis?.meshSummary?.meshHash ?? '';
  const mesh = JSON.parse(gunzipSync(readFileSync(path.join(cacheDirectory, `${meshHash}.json.gz`))).toString('utf8')) as FeMeshArtifact;
  const cuts = analysis === undefined ? [] : boltCuts(analysis, mesh, 1);
  const area = Array.isArray(cuts) ? (cuts[0]?.cut.area ?? Number.NaN) : Number.NaN;
  return { c, run: { bolts: listOf(dataOf(reported.json)['bolts']) as Record<string, number | null>[], peaks, check, checkBefore, area } };
}

describe.skipIf(feaToolsMissing())('bolt pretension (netgen + ccx)', () => {
  let fixed: Run | undefined;
  let fixedCase: ThermalCase | undefined;
  let locked: Run | undefined;
  let lockedCase: ThermalCase | undefined;
  let free: Run | undefined;
  let freeCase: ThermalCase | undefined;

  beforeAll(async () => {
    ({ run: fixed, c: fixedCase } = await runPlan('pretension', plan()));
    ({ run: locked, c: lockedCase } = await runPlan('pretension-locked', driven(true)));
    ({ run: free, c: freeCase } = await runPlan('pretension-free', driven(false)));
    const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
    if (target !== undefined && target !== '')
      appendFileSync(
        target,
        `${JSON.stringify({ pack: '06-contact-joints', caseId: 'VC-CNT-51', measured: { value: fixed?.bolts[0]?.['axialForce'], unit: 'N' } })}\n`,
      );
  }, 1_800_000);

  afterAll(() => {
    closeCase(fixedCase);
    closeCase(lockedCase);
    closeCase(freeCase);
  });

  it('accepts the deck: no set-up error before the solve, one bolt row for the one step', () => {
    expect(JSON.stringify(fixed?.checkBefore['items'])).not.toContain('"severity":"error"');
    expect(fixed?.bolts).toHaveLength(1);
    expect(fixed?.bolts[0]).toMatchObject({ solverStep: 1, facesUsed: expect.any(Number) });
  });

  it('VC-CNT-51: the section force after the preload step is 10 kN (0.5 %) and each end reaction is 10 kN (0.5 %)', () => {
    const force = fixed?.bolts[0]?.['axialForce'] ?? Number.NaN;
    expect(Math.abs(force / PRELOAD_N - 1)).toBeLessThan(0.005);
    expect(Math.abs(Math.abs(fixed?.peaks['bottom_reaction'] ?? 0) / PRELOAD_N - 1)).toBeLessThan(0.005);
    expect(Math.abs(Math.abs(fixed?.peaks['top_reaction'] ?? 0) / PRELOAD_N - 1)).toBeLessThan(0.005);
    expect(Math.abs(fixed?.bolts[0]?.['shearForce'] ?? 1)).toBeLessThan(0.01 * PRELOAD_N);
    expect(fixed?.bolts[0]?.['shortening']).toBeGreaterThan(0);
    const codes = listOf(fixed?.check['items']).map((entry) => entry['code']);
    expect(codes).not.toContain('CNT_PRELOAD_MISMATCH');
    expect(codes).not.toContain('CNT_CONTACT_NOT_CONVERGED');
  });

  it('a locked bolt holds its length: the second step adds E A delta / L to the force (5 %); an unlocked one keeps the preload (0.5 %)', () => {
    const area = locked?.area ?? Number.NaN;
    const stiffness = (YOUNG_MPA * area) / LENGTH_MM;
    const [first, second] = locked?.bolts ?? [];
    expect(Math.abs((first?.['axialForce'] ?? 0) / PRELOAD_N - 1)).toBeLessThan(0.005);
    const added = (second?.['axialForce'] ?? 0) - (first?.['axialForce'] ?? 0);
    expect(Math.abs(added / (stiffness * STRETCH_MM) - 1)).toBeLessThan(0.05);
    expect(Math.abs(locked?.peaks['bottom_reaction'] ?? 0)).toBeGreaterThan(PRELOAD_N * 1.1);
    const [, loose] = free?.bolts ?? [];
    expect(Math.abs((loose?.['axialForce'] ?? 0) / PRELOAD_N - 1)).toBeLessThan(0.005);
    expect(Math.abs(Math.abs(free?.peaks['bottom_reaction'] ?? 0) / PRELOAD_N - 1)).toBeLessThan(0.005);
  });
});
