/**
 * Physics pack 10 (rigid-body dynamics) replayed through the real `llull` CLI entry: every plan of
 * `docs/physics/10-rigid-body-dynamics/validation/plans` runs on a fresh --doc (`llull run PLAN --json`), its `simulate_motion` series
 * is measured (period from velocity zero crossings, values by 4-point Lagrange interpolation) and compared with the numbers of
 * `expected_results.json`. Tolerances are the pack's own, except the ENGINE entries below, where the MuJoCo model cannot reach the
 * pack tolerance (reasons next to each entry and in the pack README).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installPhysicsEngine } from '../src/physicsEngine';
import { REPO_ROOT, cliPlan, newSession, runPlan, type Session } from './packCli';

beforeAll(async () => {
  expect(await installPhysicsEngine()).toBe(true);
}, 60_000);

const PACK = 'docs/physics/10-rigid-body-dynamics/validation';
const SLOW = 120_000;

interface PackCase {
  readonly id: string;
  readonly value: number | number[];
  readonly tolerance: { readonly rel?: number; readonly abs?: number };
}
const cases = new Map(
  (JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'expected_results.json'), 'utf8')) as { cases: PackCase[] }).cases.map((c) => [
    c.id,
    c,
  ]),
);
const expectedOf = (id: string): number[] => {
  const value = cases.get(id)?.value;
  return Array.isArray(value) ? value : [value as number];
};
const packRel = (id: string): number => cases.get(id)?.tolerance.rel ?? 0;

/** Pack tolerance replaced by what the engine reaches (relative), with the reason. */
const ENGINE = {
  /** the slider-crank links cannot be massless in MuJoCo (links 5 g, crank 100 kg flywheel for a stiff speed servo): about 0.5 % off */
  crankTorque: 0.01,
  /** a(theta) is the difference of the sampled velocity (1e-3 covers the start-up transient of the speed servo) */
  pistonAcceleration: 1e-3,
  /** piston stroke and speed follow the crank angle; the speed servo lags it by about 1e-5 rad */
  pistonKinematics: 1e-5,
  /** MuJoCo friction is a near-rigid soft constraint (impedance 0.9999): the sticking instant is late by about 2e-4 relative */
  coulombStopTime: 1e-3,
  /** rest position of the Coulomb oscillator, soft friction row (measured 2e-7 relative at 1e-5 s) */
  coulombRest: 1e-5,
} as const;

type Series = Record<string, number[]>;
interface SimulationData {
  readonly bodies: Record<string, { massKg: number }>;
  readonly series: { times: number[]; jointVelocity: Series; jointPosition: Series; motorTorque: Series };
  readonly reactions?: { joints: Record<string, { forceN: { value: number } }> };
  readonly energy?: { maxDeviationFraction: number; dissipatedJ: number };
  readonly loops?: { tier: string };
  readonly warnings: string[];
}
interface PlanStep {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
}
type PlanAction = { command: string; params: Record<string, unknown>; as?: string };

const planActions = (name: string): PlanAction[] =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'plans', `${name}.plan.json`), 'utf8')) as PlanAction[];

/** Runs `actions` (or the plan file) on a fresh document; returns the data of the last `simulate_motion` step. */
async function simulate(planFile: string | PlanAction[]): Promise<{ data: SimulationData; steps: PlanStep[]; session: Session }> {
  const session = newSession();
  if (typeof planFile === 'string') await runPlan(session, { plan_file: path.join(PACK, 'plans', `${planFile}.plan.json`) });
  else await cliPlan(session, planFile);
  const report = session.last?.json as { ok: boolean; data: { steps: PlanStep[] } };
  expect(session.last?.code, session.last?.stdout.slice(0, 600)).toBe(0);
  const steps = report.data.steps;
  expect(steps.every((step) => step.ok)).toBe(true);
  const data = [...steps].reverse().find((step) => step.command === 'simulate_motion')?.data as SimulationData;
  expect(data.warnings.filter((w) => w.includes('FPR_LOOP') || w.includes('unreliable'))).toEqual([]);
  return { data, steps, session };
}

/** 4-point Lagrange interpolation of `values` (sampled at `times`) at `at`. */
function interpolate(times: number[], values: number[], at: number): number {
  let nearest = 0;
  for (let i = 0; i < times.length; i += 1) if (Math.abs((times[i] ?? 0) - at) < Math.abs((times[nearest] ?? 0) - at)) nearest = i;
  const first = Math.min(Math.max(nearest - 1, 0), times.length - 4);
  const nodes = [first, first + 1, first + 2, first + 3];
  return nodes.reduce((sum, a) => {
    const weight = nodes.reduce((w, b) => (a === b ? w : (w * (at - (times[b] ?? 0))) / ((times[a] ?? 0) - (times[b] ?? 0))), 1);
    return sum + weight * (values[a] ?? 0);
  }, 0);
}

/** Times where the velocity changes sign (turning points), linearly interpolated; samples at rest (|v| below `floor`) are ignored. */
function turningTimes(times: number[], velocity: number[], floor = 0): number[] {
  const found: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const [a, b] = [velocity[i - 1] ?? 0, velocity[i] ?? 0];
    if (a !== 0 && a * b <= 0 && Math.abs(a) > floor)
      found.push((times[i - 1] ?? 0) + ((times[i] ?? 0) - (times[i - 1] ?? 0)) * (a / (a - b)));
  }
  return found;
}

/** Period = twice the time between two consecutive turning points. */
function period(data: SimulationData, joint: string): number {
  const crossings = turningTimes(data.series.times, data.series.jointVelocity[joint] ?? []);
  expect(crossings.length).toBeGreaterThanOrEqual(2);
  return 2 * ((crossings[1] ?? 0) - (crossings[0] ?? 0));
}

/** Every comparison made (label, actual, expected, relative error, allowed): `LLULL_PACK10_TABLE=<file>` writes it after the run. */
const table: string[] = [];
afterAll(() => {
  const out = process.env['LLULL_PACK10_TABLE'];
  if (out !== undefined && out !== '') writeFileSync(out, table.join('\n'));
});
const near = (label: string, actual: number, expected: number, rel: number): void => {
  table.push(`${label} | ${actual} | ${expected} | ${Math.abs(actual / expected - 1).toExponential(2)} | ${rel}`);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected} (rel ${Math.abs(actual / expected - 1)})`).toBeLessThanOrEqual(
    rel * Math.abs(expected),
  );
};

/** The pendulum plan with the bob raised to `amplitudeDeg` from the downward vertical and a run long enough for two turning points. */
function pendulumAt(amplitudeDeg: number, periodS: number): PlanAction[] {
  const theta = (amplitudeDeg * Math.PI) / 180;
  return planActions('rbd_pendulum_release').map((action) => {
    if (action.command === 'add_box')
      return { ...action, params: { ...action.params, position: [1000 * Math.sin(theta), 0, -1000 * Math.cos(theta)] } };
    if (action.command === 'simulate_motion') {
      const duration = Math.round(1.05 * periodS * 100) / 100;
      return { ...action, params: { ...action.params, duration, sampleRate: Math.floor(5900 / duration) } };
    }
    return action;
  });
}

describe('pack 10 plans use only registered commands', () => {
  it.each([
    'rbd_pendulum_release',
    'rbd_compound_pendulum',
    'rbd_compound_pendulum_small',
    'rbd_slider_crank',
    'rbd_spring_mass_damper',
    'rbd_coulomb_oscillator',
  ])(
    '%s validates (llull run --validate)',
    async (name) => {
      const session = newSession();
      await runPlan(session, { plan_file: path.join(PACK, 'plans', `${name}.plan.json`) }, ['--validate']);
      expect(session.last?.code, session.last?.stdout.slice(0, 500)).toBe(0);
    },
    SLOW,
  );
});

describe('VC-RBD-10, 11 — simple pendulum (1 kg point mass on 1 m)', () => {
  const amplitudes = [10, 45, 90, 135, 170];
  const periods = expectedOf('VC-RBD-10');
  const tensions = new Map([
    [10, 0],
    [90, 1],
    [170, 2],
  ]);
  it.each(amplitudes.map((deg, i) => [deg, periods[i] as number] as const))(
    'VC-RBD-10 period at %i deg = %f s',
    async (deg, expected) => {
      const { data } = await simulate(deg === 90 ? 'rbd_pendulum_release' : pendulumAt(deg, expected));
      near(`T(${deg} deg)`, period(data, 'pivot'), expected, packRel('VC-RBD-10'));
      const row = tensions.get(deg);
      if (row !== undefined) {
        const tension = data.reactions?.joints['pivot']?.forceN.value as number;
        near(`VC-RBD-11 pivot tension at ${deg} deg`, tension, expectedOf('VC-RBD-11')[row] as number, packRel('VC-RBD-11'));
      }
    },
    SLOW,
  );
});

describe('VC-RBD-12 — compound pendulum, inertia from the box geometry', () => {
  const [small, large] = expectedOf('VC-RBD-12') as [number, number];
  it(
    '90 deg release',
    async () => {
      const { data } = await simulate('rbd_compound_pendulum');
      expect(data.bodies['bar']?.massKg).toBeCloseTo(7800 * 0.5 * 0.01 * 0.01, 9);
      near('T(90 deg)', period(data, 'pivot'), large, packRel('VC-RBD-12'));
    },
    SLOW,
  );
  it(
    'small amplitude (initial speed 0.005 rad/s)',
    async () => {
      const { data } = await simulate('rbd_compound_pendulum_small');
      const measured = period(data, 'pivot');
      near('T(small)', measured, small, packRel('VC-RBD-12'));
      expect(Math.abs(measured / 1.15840094518 - 1), 'the slender-rod formula must not be matched').toBeGreaterThan(2e-5);
    },
    SLOW,
  );
});

describe('VC-RBD-20, 21 — slider-crank r 0.05 m, l 0.2 m, 100 rad/s', () => {
  it(
    'kinematics and crank torque',
    async () => {
      const { data, steps } = await simulate('rbd_slider_crank');
      const inspect = steps.find((step) => step.command === 'inspect_dynamics')?.data as { mobility: { dof: number } };
      expect(inspect.mobility.dof).toBe(1);
      expect(data.loops?.tier).toBe('pass');
      const { times, jointPosition, jointVelocity, motorTorque } = data.series;
      const at = (series: number[], deg: number, shift = 0): number => interpolate(times, series, ((deg * Math.PI) / 180 + shift) / 100);
      const x = (deg: number): number => 0.25 + at(jointPosition['j_slide'] as number[], deg);
      const [x0, a0, x90, v90, a90] = expectedOf('VC-RBD-20') as [number, number, number, number, number];
      const acceleration = (deg: number): number => {
        const h = 1e-3;
        return (at(jointVelocity['j_slide'] as number[], deg, h) - at(jointVelocity['j_slide'] as number[], deg, -h)) / ((2 * h) / 100);
      };
      const velocity = (deg: number): number => at(jointVelocity['j_slide'] as number[], deg);
      near('x(0)', x(0), x0, packRel('VC-RBD-20'));
      near('x(90)', x(90), x90, ENGINE.pistonKinematics);
      near('v(90)', velocity(90), v90, ENGINE.pistonKinematics);
      near('a(90)', acceleration(90), a90, ENGINE.pistonAcceleration);
      near('a(0)', velocity(0.0002 * 100 * (180 / Math.PI)) / 2e-4, a0, ENGINE.pistonAcceleration);
      const [t60, t90] = expectedOf('VC-RBD-21') as [number, number];
      near('crank torque 60 deg', at(motorTorque['drive'] as number[], 60), t60, ENGINE.crankTorque);
      near('crank torque 90 deg', at(motorTorque['drive'] as number[], 90), t90, ENGINE.crankTorque);
      near('crank speed held', at(jointVelocity['j_crank'] as number[], 90), 100, 1e-3);
    },
    SLOW,
  );
});

describe('VC-RBD-30, 31 — spring-mass-damper, 1 kg, 1000 N/m, 2 N s/m, x0 10 mm', () => {
  it(
    'closed form x(t) and logarithmic decrement',
    async () => {
      const { data } = await simulate('rbd_spring_mass_damper');
      const { times, jointPosition, jointVelocity } = data.series;
      const q = jointPosition['slide'] as number[];
      const displacementMm = (t: number): number => (interpolate(times, q, t) + 0.01) * 1000;
      const [x05, x10, decrement] = expectedOf('VC-RBD-30') as [number, number, number];
      near('x(0.5)', displacementMm(0.5), x05, packRel('VC-RBD-30'));
      near('x(1.0)', displacementMm(1.0), x10, packRel('VC-RBD-30'));
      const turning = turningTimes(times, jointVelocity['slide'] as number[]);
      const peakAfterOnePeriod = (turning[1] ?? 0) as number;
      near('log decrement', Math.log(10 / displacementMm(peakAfterOnePeriod)), decrement, packRel('VC-RBD-30'));
      expect(data.energy?.dissipatedJ).toBeGreaterThan(0.04);
    },
    SLOW,
  );

  it(
    'VC-RBD-31 undamped, 100 periods: energy does not drift',
    async () => {
      const actions = planActions('rbd_spring_mass_damper').map((action) => {
        if (action.command === 'add_body_joint') return { ...action, params: { ...action.params, damping: 0 } };
        if (action.command === 'simulate_motion')
          return { ...action, params: { ...action.params, duration: 19.87, sampleRate: 300, detail: 'summary' } };
        return action;
      });
      const { data } = await simulate(actions);
      const drift = data.energy?.maxDeviationFraction as number;
      table.push(`VC-RBD-31 energy drift | ${drift} | 0 | abs | ${cases.get('VC-RBD-31')?.tolerance.abs}`);
      expect(drift).toBeLessThanOrEqual(cases.get('VC-RBD-31')?.tolerance.abs as number);
    },
    SLOW,
  );
});

describe('VC-RBD-40 — Coulomb oscillator (m 1 kg, k 100 N/m, mu 0.1, x0 0.1 m)', () => {
  it(
    '5 half cycles, stop time, rest position, no creep afterwards',
    async () => {
      const { data } = await simulate('rbd_coulomb_oscillator');
      const { times, jointPosition, jointVelocity } = data.series;
      const turning = turningTimes(times, jointVelocity['slide'] as number[], 1e-6);
      const [halfCycles, stopTime, rest] = expectedOf('VC-RBD-40') as [number, number, number];
      expect(turning.length).toBe(halfCycles);
      near('stop time', turning[turning.length - 1] as number, stopTime, ENGINE.coulombStopTime);
      const position = (index: number): number => (jointPosition['slide']?.[index] ?? 0) + 0.1;
      const last = times.length - 1;
      near('rest position', position(last), rest, ENGINE.coulombRest);
      expect(Math.abs(position(last) - position(Math.floor(last * 0.8))), 'a smoothed law would creep after the stop').toBeLessThan(1e-8);
    },
    SLOW,
  );
});
