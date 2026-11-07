/**
 * check_motion_truth and the machine kinds: run warnings reach the verdict (DRV-M4 review): lost steps fail it, the stepper timestep, the induction steady-state
 * form and a PMSM over its voltage limit cap it at plausible, a stepper ledger is no evidence; every coded warning the sources emit is mapped or exempted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { AUX } from '@dynamics/sim/actuators/controller';
import { machineWarnings } from '@dynamics/sim/actuators/machineWarnings';
import { buildSimulationModel } from '@dynamics/sim/simulationModel';
import { RUN_WARNING_EXEMPT, RUN_WARNING_POLICY } from '@dynamics/sim/truth/warningItems';
import { INDUCTION_SHEET, PMSM_SHEET, STEPPER_SHEET, constantProfile, machineBench } from './machineFixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Item {
  code: string;
  status: string;
  ids: string[];
}
interface Truth {
  verdict: 'trusted' | 'plausible' | 'not_trusted';
  items: Item[];
}
const truthOf = (doc: CadDocument, params: Record<string, unknown>): Truth =>
  execute(doc, 'check_motion_truth', { level: 'quick', ...params }).data as Truth;
const item = (truth: Truth, code: string): Item | undefined => truth.items.find((entry) => entry.code === code);

const holdStepper = (sheet: Record<string, unknown>, extra: ReturnType<typeof constantProfile>[] = []): CadDocument =>
  machineBench(1e-5, { kind: 'stepper', stepperDatasheet: { dampingNmsPerRad: 0.02, ...STEPPER_SHEET, ...sheet } }, [
    ...extra,
    { command: 'add_motion_profile', params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] } },
    { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p' } },
  ]);

describe('stepper verdicts', () => {
  it('a load above the holding torque loses steps: DRV_STEPS_LOST fails and the verdict is not_trusted', () => {
    const doc = machineBench(1e-5, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, dampingNmsPerRad: 0.01 } }, [
      {
        command: 'add_motor',
        params: { joint: 'j', id: 'load_torque', kind: 'torque_curve', torque: -0.8, source: { name: 'test load', grade: 'A' } },
      },
      { command: 'add_motion_profile', params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] } },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p' } },
    ]);
    const truth = truthOf(doc, { duration: 0.1, timestep: 1e-4 });
    expect(item(truth, 'DRV_STEPS_LOST')).toMatchObject({ status: 'fail', ids: ['m'] });
    expect(truth.verdict).toBe('not_trusted');
  });

  it('at the 1 ms step the stepper ringing (omega_n dt = 1.58 > 0.2) is not resolved: DRV_STEPPER_TIMESTEP warns and the verdict is plausible, not trusted', () => {
    const truth = truthOf(holdStepper({}), { duration: 0.05, timestep: 1e-3 });
    expect(item(truth, 'DRV_STEPPER_TIMESTEP')).toMatchObject({ status: 'warn', ids: ['m'] });
    expect(truth.verdict).toBe('plausible');
  });

  it('its ledger closes by construction: the closure item is info (not evidence), never a pass', () => {
    const truth = truthOf(holdStepper({}), { duration: 0.02, timestep: 1e-5 });
    expect(item(truth, 'DRV_LEDGER_CLOSURE')?.status).toBe('info');
    expect(item(truth, 'DRV_STEPPER_TIMESTEP')).toBeUndefined();
    expect(item(truth, 'DRV_STEPS_LOST')).toBeUndefined();
  });
});

describe('induction and PMSM verdicts', () => {
  it('an induction run is plausible at best: DRV_INDUCTION_QUASI_STEADY warns (steady-state torque, no flux transients)', () => {
    const doc = machineBench(1, { kind: 'induction', inductionDatasheet: INDUCTION_SHEET }, [
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 230, frequencyHz: 50 } },
    ]);
    const truth = truthOf(doc, { duration: 0.5, timestep: 1e-3 });
    expect(item(truth, 'DRV_INDUCTION_QUASI_STEADY')).toMatchObject({ status: 'warn', ids: ['m'] });
    expect(truth.verdict).toBe('plausible');
  });

  it('a PMSM that needs more than V_bus / sqrt(3) once R i is counted warns DRV_PMSM_VOLTAGE_OVER and is plausible; within the limit it raises nothing', () => {
    const over = machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, phaseResistanceOhm: 0.2 } }, [
      constantProfile('t', 'torque', 'N*m', 1.2, 1),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    const truth = truthOf(over, { duration: 0.2, timestep: 1e-4 });
    expect(item(truth, 'DRV_PMSM_VOLTAGE_OVER')).toMatchObject({ status: 'warn', ids: ['m'] });
    expect(truth.verdict).toBe('plausible');
    const fine = machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET }, [
      constantProfile('t', 'torque', 'N*m', 0.3, 1),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    expect(item(truthOf(fine, { duration: 0.2, timestep: 1e-4 }), 'DRV_PMSM_VOLTAGE_OVER')).toBeUndefined();
  });
});

describe('a recovered overshoot is not a lost step (DRV_STEPPER_OVERSHOOT)', () => {
  const doc = holdStepper({});
  const built = buildSimulationModel(doc, 1e-5, null);
  const run = 'error' in built ? undefined : built.drives[0];
  const trace = (lost: number[]): SimulationTrace =>
    ({
      times: lost.map((_, k) => k * 1e-3),
      aux: {
        [run ? run.base + AUX.lostSteps : 0]: lost,
        [run ? run.base + AUX.lag : 0]: lost.map((n) => (n * Math.PI) / 2),
        [run ? run.base + AUX.lostTime : 0]: lost.map((n) => (n === 0 ? -1 : 0.001)),
      },
    }) as unknown as SimulationTrace;

  it('steps lost at the peak but none at the end: an overshoot warning, no DRV_STEPS_LOST; steps still lost at the end: DRV_STEPS_LOST', () => {
    expect(run).toBeDefined();
    if (run === undefined) return;
    const recovered = machineWarnings(run, trace([0, 4, 0]), 0, 1e-5);
    expect(recovered.some((w) => w.startsWith('DRV_STEPPER_OVERSHOOT'))).toBe(true);
    expect(recovered.some((w) => w.startsWith('DRV_STEPS_LOST'))).toBe(false);
    const lost = machineWarnings(run, trace([0, 4, 4]), 0, 1e-5);
    expect(lost.some((w) => w.startsWith('DRV_STEPS_LOST'))).toBe(true);
    expect(lost.some((w) => w.startsWith('DRV_STEPPER_OVERSHOOT'))).toBe(false);
    expect(machineWarnings(run, trace([0, 0, 0]), 0, 1e-5)).toEqual([]);
  });

  it('the timestep warning states that its estimate is conservative (rotor inertia only)', () => {
    if (run === undefined) return;
    // the estimate takes the rotor inertia and the holding torque (a loaded rotor rings lower), so it can only over-warn; the ringing it protects is the one VC-DRV-27 measures within 2 %
    const warnings = machineWarnings(run, trace([0, 0]), 0, 1e-3);
    expect(warnings[0]).toContain('conservative estimate');
  });
});

describe('every coded warning the sources emit has a truth rule', () => {
  const SKIP = ['truth', 'sizingReport.ts'];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (SKIP.includes(name)) return [];
      return statSync(path).isDirectory() ? files(path) : name.endsWith('.ts') ? [path] : [];
    });

  it('each DRV_ / FPR_ code that starts a warning text in sim/ or simulate.ts is in RUN_WARNING_POLICY or RUN_WARNING_EXEMPT (with its reason)', () => {
    const root = 'packages/domain-dynamics/src';
    const found = new Set<string>();
    for (const file of [...files(join(root, 'sim')), join(root, 'commands/simulate.ts')])
      for (const match of readFileSync(file, 'utf8').matchAll(/[`'"]((?:DRV|FPR)_[A-Z0-9_]+): /g)) found.add(match[1] ?? '');
    // codes of a refusal or a finding of another command (they never appear in the warnings of a run) are named here with why
    const notWarnings: Record<string, string> = { DRV_MARGIN_LOW: 'size_drive finding', DRV_SPEED_OVER: 'size_drive finding' };
    const unmapped = [...found].filter(
      (code) => RUN_WARNING_POLICY[code] === undefined && RUN_WARNING_EXEMPT[code] === undefined && notWarnings[code] === undefined,
    );
    expect(unmapped).toEqual([]);
    expect(found.size).toBeGreaterThan(8);
    for (const reason of Object.values(RUN_WARNING_EXEMPT)) expect(reason.length).toBeGreaterThan(10);
    for (const policy of Object.values(RUN_WARNING_POLICY)) expect(policy.reason.length).toBeGreaterThan(10);
  });

  it('the verdict-relevant statuses: the stepper loss fails, the model-form warnings warn, the stated defaults are info', () => {
    expect(RUN_WARNING_POLICY['DRV_STEPS_LOST']?.status).toBe('fail');
    for (const code of [
      'DRV_STEPPER_TIMESTEP',
      'DRV_STEPPER_OVERSHOOT',
      'DRV_INDUCTION_QUASI_STEADY',
      'DRV_PMSM_VOLTAGE_OVER',
      'DRV_TRACKING_ERROR',
    ])
      expect(RUN_WARNING_POLICY[code]?.status, code).toBe('warn');
  });
});
