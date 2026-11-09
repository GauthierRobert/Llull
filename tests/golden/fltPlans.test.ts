/**
 * Golden pins of the 13 FLT validation plans (docs/aerospace/13-flight-dynamics/validation/plans): the normalized document and the numbers of
 * every run_flight / flight_report step at 6 significant digits, tied to the MuJoCo version that produced them; replaying a plan on a fresh
 * document gives the identical document and the identical run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createEmptyDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { normalize } from './normalize';

let engineName = '';
beforeAll(async () => {
  const engine = await createMujocoPhysics();
  engineName = engine.name;
  setPhysicsEngine(engine);
});
afterAll(() => setPhysicsEngine(null));

interface Step {
  command: string;
  ok: boolean;
  summary: string;
  data?: unknown;
}

const PLANS = 'docs/aerospace/13-flight-dynamics/validation/plans';

function run(name: string): { steps: Step[]; document: ReturnType<typeof createEmptyDocument> } {
  const actions = JSON.parse(readFileSync(`${PLANS}/${name}.plan.json`, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const data = result.data as { steps: Step[] };
  expect(data.steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps: data.steps, document: result.document };
}

/** Every number of `value` at 6 significant digits (the engine's last bits are not the pin). */
function six(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(6)) : value;
  if (Array.isArray(value)) return value.map(six);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, six(entry)]));
  return value;
}

const dataOf = (steps: Step[], command: string): unknown => steps.find((step) => step.command === command)?.data;

describe('13 FLT validation plans, golden', () => {
  it('the plans were produced by MuJoCo 4.0 (the pins are per engine version)', () => {
    expect(engineName).toMatch(/MuJoCo 4\.0\./);
  });

  it('sc-flt-01-hover: the reference quad knocked at t = 0 returns to the VC-FLT-09 hover; replay is identical', () => {
    const plan = run('sc-flt-01-hover');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    expect(six(dataOf(plan.steps, 'run_flight'))).toMatchSnapshot('run_flight');
    expect(six(dataOf(plan.steps, 'flight_report'))).toMatchSnapshot('flight_report');
    const again = run('sc-flt-01-hover');
    expect(again.document).toEqual(plan.document);
    expect(JSON.stringify(dataOf(again.steps, 'run_flight'))).toBe(JSON.stringify(dataOf(plan.steps, 'run_flight')));
  }, 120_000);

  it('sc-flt-02-gust: the VC-FLT-07 gust report with the VC-FLT-14 timestep check', () => {
    const plan = run('sc-flt-02-gust');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const report = dataOf(plan.steps, 'flight_report') as { timestepCheck: { gci: { gci21Fine: number } } };
    expect(report.timestepCheck.gci.gci21Fine).toBeLessThan(0.01);
    expect(six(report)).toMatchSnapshot('flight_report');
  }, 120_000);

  it('sc-flt-03-endurance: the 4S2P pack hover chain (VC-FLT-11): analytic endurance, the flown current and a replay-identical run', () => {
    const plan = run('sc-flt-03-endurance');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const estimate = dataOf(plan.steps, 'estimate_endurance') as {
      bus: { currentA: number };
      hover: { figureOfMerit: number };
      endurance: { timeS: number; limitedBy: string };
      capacityOverCurrentS: number;
    };
    // momentum theory on the static coefficients: FM = Ct^1.5 / (Cp sqrt(pi / 2))
    expect(estimate.hover.figureOfMerit).toBeCloseTo(0.1158 ** 1.5 / (0.0466 * Math.sqrt(Math.PI / 2)), 9);
    expect(estimate.endurance.limitedBy).toBe('cutoff_voltage');
    expect(estimate.endurance.timeS).toBeLessThan(estimate.capacityOverCurrentS);
    expect(estimate.endurance.timeS).toBeGreaterThan(0.6 * estimate.capacityOverCurrentS);
    const flown = dataOf(plan.steps, 'run_flight') as { battery: { pt: { meanCurrentA: number; cutoffAtS: number | null } } };
    expect(Math.abs(flown.battery.pt.meanCurrentA - estimate.bus.currentA) / estimate.bus.currentA).toBeLessThan(0.03);
    expect(flown.battery.pt.cutoffAtS).toBeNull();
    expect(six(estimate)).toMatchSnapshot('estimate_endurance');
    expect(six(flown)).toMatchSnapshot('run_flight');
    expect(six(dataOf(plan.steps, 'flight_report'))).toMatchSnapshot('flight_report');
    const again = run('sc-flt-03-endurance');
    expect(again.document).toEqual(plan.document);
    expect(JSON.stringify(dataOf(again.steps, 'run_flight'))).toBe(JSON.stringify(dataOf(plan.steps, 'run_flight')));
  }, 120_000);

  it('sc-flt-04-wind-aero: the wing quad with a pivoting wing in a 6 m/s head wind with a gust and seeded Dryden turbulence; replay is identical', () => {
    const plan = run('sc-flt-04-wind-aero');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const flown = dataOf(plan.steps, 'run_flight') as {
      aero: { wing: { pivotDeg: { final: number }; peakLiftN: number; outsideFraction: number } };
    };
    // the servo reached the 8° command (6 s + 0.27 s at 30 deg/s) before the end
    expect(flown.aero.wing.pivotDeg.final).toBeCloseTo(8, 6);
    expect(flown.aero.wing.peakLiftN).toBeGreaterThan(0);
    expect(six(flown)).toMatchSnapshot('run_flight');
    expect(six(dataOf(plan.steps, 'flight_report'))).toMatchSnapshot('flight_report');
    const again = run('sc-flt-04-wind-aero');
    expect(again.document).toEqual(plan.document);
    expect(JSON.stringify(dataOf(again.steps, 'run_flight'))).toBe(JSON.stringify(dataOf(plan.steps, 'run_flight')));
  }, 120_000);
});
