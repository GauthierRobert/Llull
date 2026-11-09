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
});
