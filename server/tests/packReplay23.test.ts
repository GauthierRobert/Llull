/**
 * Physics pack 23 (drives and physical truth) replayed through the real `llull` CLI entry: every plan of
 * `docs/physics/23-drives-physical-truth/validation/plans` runs on a fresh --doc (`llull run PLAN --json`), and the numbers of its analysis steps are compared
 * with `expected_results.json` at the pack's own tolerances (VC-DRV-01, 04, 05, 13, 18, 34, 37, 38). The unit and golden suites run the same plans in-process;
 * this one proves the CLI path (parameter parsing, plan aliases, JSON report) gives the same answers.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installPhysicsEngine } from '../src/physicsEngine';
import { REPO_ROOT, newSession, runPlan, type Session } from './packCli';

beforeAll(async () => {
  expect(await installPhysicsEngine()).toBe(true);
}, 60_000);

const PACK = 'docs/physics/23-drives-physical-truth/validation';
const SLOW = 300_000;
const RPM_TO_RAD_S = Math.PI / 30;

interface PackCase {
  readonly id: string;
  readonly value: number;
  readonly tolerance: { readonly rel?: number; readonly abs?: number; readonly max?: number };
}
const cases = (JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'expected_results.json'), 'utf8')) as { cases: PackCase[] }).cases;
const caseOf = (id: string, index = 0): PackCase => {
  const found = cases.filter((entry) => entry.id === id)[index];
  if (found === undefined) throw new Error(`no case ${id}[${index}]`);
  return found;
};
const reference = JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'drv_reference.json'), 'utf8')) as {
  dcStep: { samples: { tS: number; speedRadS: number; currentA: number }[] };
};

interface PlanStep {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
}
interface Plan {
  readonly steps: PlanStep[];
  readonly session: Session;
}

/** Runs the plan file on a fresh document through the CLI and returns its steps; every step must have succeeded. */
async function replay(name: string): Promise<Plan> {
  const session = newSession();
  await runPlan(session, { plan_file: path.join(PACK, 'plans', `${name}.plan.json`) });
  expect(session.last?.code, session.last?.stdout.slice(0, 800)).toBe(0);
  const steps = (session.last?.json as { data: { steps: PlanStep[] } }).data.steps;
  expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps, session };
}
const dataOf = <T>(plan: Plan, command: string): T => plan.steps.filter((step) => step.command === command).at(-1)?.data as T;

/** Every comparison made (label, actual, expected): the relative error must stay within the pack tolerance. */
const near = (label: string, actual: number, expected: number, tolerance: PackCase['tolerance']): void => {
  const allowed = Math.max((tolerance.rel ?? 0) * Math.abs(expected), tolerance.abs ?? 0);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(allowed);
};

/** Linear interpolation of a series at `at`. */
function interpolate(times: readonly number[], values: readonly number[], at: number): number {
  const high = times.findIndex((time) => time >= at - 1e-12);
  const low = Math.max(0, high - 1);
  const [t0, t1, v0, v1] = [times[low] as number, times[high] as number, values[low] as number, values[high] as number];
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (at - t0)) / (t1 - t0);
}

describe('pack 23 plans use only registered commands', () => {
  it.each(['drv_maxon_step', 'drv_lead_screw', 'drv_stick_slip', 'drv_servo_sizing'])(
    '%s validates (llull run --validate)',
    async (name) => {
      const session = newSession();
      await runPlan(session, { plan_file: path.join(PACK, 'plans', `${name}.plan.json`) }, ['--validate']);
      expect(session.last?.code, session.last?.stdout.slice(0, 500)).toBe(0);
    },
    SLOW,
  );
});

describe('VC-DRV-01, 04, 05 — maxon RE 40 148877 step through the CLI', () => {
  let plan: Plan;
  beforeAll(async () => {
    plan = await replay('drv_maxon_step');
  }, SLOW);

  it('VC-DRV-01: the six datasheet checks pass and the largest gap is 0.523 % (limit 1 %)', () => {
    const checked = dataOf<{ consistent: boolean; maxGap: number; checks: unknown[] }>(plan, 'check_motor_data');
    expect(checked.consistent).toBe(true);
    expect(checked.checks).toHaveLength(6);
    expect(checked.maxGap).toBeLessThanOrEqual(caseOf('VC-DRV-01').tolerance.max ?? 0);
    near('largest gap', checked.maxGap, caseOf('VC-DRV-01').value, { abs: 1e-6 });
  });

  it('VC-DRV-04: speed and current at 0.5 .. 30 ms within the pack tolerance, current peak 36.83 A', () => {
    const run = dataOf<{
      drives: { m_re40: { peak: { currentA: number }; series: { times: number[]; shaftSpeedRpm: number[]; currentA: number[] } } };
    }>(plan, 'simulate_motion');
    const { times, shaftSpeedRpm, currentA } = run.drives.m_re40.series;
    const speed = shaftSpeedRpm.map((rpm) => rpm * RPM_TO_RAD_S);
    reference.dcStep.samples.forEach((sample, k) => {
      near(
        `speed at ${sample.tS}`,
        interpolate(times, speed, sample.tS),
        caseOf('VC-DRV-04', 2 * k).value,
        caseOf('VC-DRV-04', 2 * k).tolerance,
      );
      near(
        `current at ${sample.tS}`,
        interpolate(times, currentA, sample.tS),
        caseOf('VC-DRV-04', 2 * k + 1).value,
        caseOf('VC-DRV-04', 2 * k + 1).tolerance,
      );
    });
    near('current peak', run.drives.m_re40.peak.currentA, caseOf('VC-DRV-04', 14).value, caseOf('VC-DRV-04', 14).tolerance);
  });

  it('VC-DRV-05: input 8.6763 J = copper 4.3405 J + kinetic 4.3358 J, closure within 1e-3', () => {
    const { ledger } = dataOf<{ ledger: { closureRelative: number; entries: { kind: string; joules: number }[] } }>(
      plan,
      'simulate_motion',
    );
    const term = (kind: string): number =>
      ledger.entries.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.joules, 0);
    near('electrical input', term('electrical_input'), caseOf('VC-DRV-05', 0).value, caseOf('VC-DRV-05', 0).tolerance);
    near('copper', term('copper'), caseOf('VC-DRV-05', 1).value, caseOf('VC-DRV-05', 1).tolerance);
    near('kinetic', term('kinetic'), caseOf('VC-DRV-05', 2).value, caseOf('VC-DRV-05', 2).tolerance);
    expect(ledger.closureRelative).toBeLessThanOrEqual(1e-3);
  });
});

describe('VC-DRV-13 — lead screw lift through the CLI', () => {
  it(
    'the 10 kg nut lifts at 10.3303 m/s^2 within 1 % (mu 0.1)',
    async () => {
      const plan = await replay('drv_lead_screw');
      const run = dataOf<{ series: { times: number[]; jointVelocity: Record<string, number[]> } }>(plan, 'simulate_motion');
      const [times, v] = [run.series.times, run.series.jointVelocity['j_nut'] as number[]];
      const [a, b] = [interpolate(times, v, 0.05), interpolate(times, v, 0.15)];
      near('lift acceleration', (b - a) / 0.1, caseOf('VC-DRV-13', 2).value, caseOf('VC-DRV-13', 2).tolerance);
    },
    SLOW,
  );
});

describe('VC-DRV-18 — stick-slip through the CLI', () => {
  it(
    'the limit cycle repeats every 0.671239 s (2 %): releases of the block velocity from rest',
    async () => {
      const plan = await replay('drv_stick_slip');
      const run = dataOf<{ series: { times: number[]; jointVelocity: Record<string, number[]> } }>(plan, 'simulate_motion');
      const [times, v] = [run.series.times, run.series.jointVelocity['j_block'] as number[]];
      const releases: number[] = [];
      for (let i = 1; i < v.length; i++)
        if (Math.abs(v[i - 1] as number) <= 1e-9 && Math.abs(v[i] as number) > 1e-9) releases.push(times[i] as number);
      expect(releases.length).toBeGreaterThanOrEqual(5);
      // the first release is the start-up slip; the cycle is periodic from the second period on
      const periods = releases.slice(1).map((time, k) => time - (releases[k] as number));
      for (const period of periods.slice(1)) near('period', period, caseOf('VC-DRV-18', 0).value, caseOf('VC-DRV-18', 0).tolerance);
    },
    SLOW,
  );
});

describe('VC-DRV-34, 37, 38 — servo sizing through the CLI', () => {
  let plan: Plan;
  beforeAll(async () => {
    plan = await replay('drv_servo_sizing');
  }, SLOW);

  it('VC-DRV-34: friction (grade C) is the lowest-grade input, the verdict is plausible, and size_drive lists it unsourced', () => {
    const truth = dataOf<{
      verdict: string;
      items: { code: string; status: string; ids: string[] }[];
      provenance: { id: string; grade: string }[];
    }>(plan, 'check_motion_truth');
    expect(truth.verdict).toBe('plausible');
    expect(truth.provenance[0]).toMatchObject({ id: 'j_load.friction', grade: 'C' });
    expect(
      truth.items.filter((item) => item.status === 'warn' || item.status === 'fail').map((item) => `${item.code}:${item.ids.join('+')}`),
    ).toEqual(['DRV_PARAM_UNSOURCED:j_load.friction']);
    const sizing = dataOf<{ findings: { code: string; ids: string[] }[]; provenance: { lowest: { id: string } } }>(plan, 'size_drive');
    expect(sizing.provenance.lowest.id).toBe('j_load.friction');
    expect(sizing.findings.find((finding) => finding.code === 'DRV_PARAM_UNSOURCED')?.ids).toEqual(['j_load.friction']);
  });

  it('VC-DRV-37: verdict ok, a limiting factor is reported, the best ratio is within one sweep step of sqrt(J_L / J_m) = 10', () => {
    const sizing = dataOf<{
      verdict: string;
      limiting: { factor: string };
      sweep: { best: { reduction: number }; inertiaMatchedRatio: number; rows: { reduction: number }[] };
    }>(plan, 'size_drive');
    expect(sizing.verdict).toBe('ok');
    expect(sizing.limiting.factor).toBe('rms_current');
    const steps = sizing.sweep.rows.map((row) => row.reduction);
    expect(steps).toEqual([5, 8, 10, 12, 15, 20]);
    near('inertia matched ratio', sizing.sweep.inertiaMatchedRatio, 10, { rel: 1e-3 });
    expect(Math.abs(steps.indexOf(sizing.sweep.best.reduction) - steps.indexOf(10))).toBeLessThanOrEqual(1);
  });

  it('VC-DRV-38: the ledger closes within 1e-3, energy is regenerated on deceleration, the gear loses power', () => {
    const run = dataOf<{ ledger: { closureRelative: number; entries: { kind: string; joules: number }[] } }>(plan, 'simulate_motion');
    expect(run.ledger.closureRelative).toBeLessThanOrEqual(1e-3);
    const sum = (kind: string): number =>
      run.ledger.entries.filter((entry) => entry.kind === kind).reduce((total, entry) => total + entry.joules, 0);
    expect(sum('regeneration')).toBeLessThan(0);
    expect(sum('transmission_loss')).toBeGreaterThan(0);
  });
});
