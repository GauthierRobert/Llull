/** check_dynamics: static input / loop items, simulation self-checks (loop drift, energy, timestep), failure paths, purity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CheckItem, CheckResult } from '@core/model/checkResult';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { type SimulationRun, energyItem, loopDriftItem, timestepItem } from '@dynamics/commands/dynamicsSimChecks';
import { sliderCrank } from './sliderCrankFixture';

function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  expect(result.rejected, `${command}: ${result.summary}`).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** A box spinning about Z at 60 rpm; `massKg` and `damping` optional. */
function spinner(options: { massKg?: number; damping?: number } = {}): CadDocument {
  const box = step(createEmptyDocument(), 'add_box', { size: [100, 10, 10], position: [50, 0, 0] });
  const body = step(box.doc, 'add_rigid_body', {
    id: 'arm',
    entityIds: [box.id],
    ...(options.massKg !== undefined ? { massKg: options.massKg } : {}),
  });
  return step(body.doc, 'add_body_joint', {
    id: 'arm_j',
    kind: 'revolute',
    child: 'arm',
    anchor: [0, 0, 0],
    axis: [0, 0, 1],
    initialRpm: 60,
    ...(options.damping !== undefined ? { damping: options.damping } : {}),
  }).doc;
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'check_dynamics', { duration: 0.5, ...params });
const dataOf = (doc: CadDocument, params: Record<string, unknown> = {}): CheckResult => check(doc, params).data as CheckResult;
const itemOf = (data: CheckResult, code: string): CheckItem => {
  const found = data.items.find((entry) => entry.code === code);
  if (found === undefined) throw new Error(`no ${code} in ${data.items.map((entry) => entry.code).join(', ')}`);
  return found;
};

describe('check_dynamics without a physics engine', () => {
  it('no rigid bodies: not_run with FPR_NO_MOTION, document untouched', () => {
    const doc = createEmptyDocument();
    const result = check(doc);
    const data = result.data as CheckResult;
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(data.check).toBe('dynamics');
    expect(data.status).toBe('not_run');
    expect(data.items.map((entry) => entry.code)).toEqual(['FPR_NO_MOTION']);
    expect(data.reviewRequired).toBe(true);
    expect(data.unverified).toBe(true);
  });

  it('defaulted mass and a lossless model warn; the simulation items are not_run, never pass', () => {
    const data = dataOf(spinner());
    const mass = itemOf(data, 'FPR_MASS_DEFAULTED');
    expect(mass.status).toBe('warn');
    expect(mass.ids).toEqual(['arm']);
    expect(mass.findingKey).toBe('dynamics:FPR_MASS_DEFAULTED:arm');
    expect(mass.values.defaultedMassKg).toBeGreaterThan(0);
    expect(itemOf(data, 'FPR_NO_LOSSES').status).toBe('warn');
    expect(itemOf(data, 'FPR_ENERGY_CLOSURE').status).toBe('not_run');
    expect(itemOf(data, 'FPR_ENERGY_CLOSURE').remediation).toMatch(/simulate_motion/);
    expect(itemOf(data, 'FPR_TIMESTEP_SENSITIVE').status).toBe('not_run');
    expect(data.items.some((entry) => entry.code === 'FPR_LOOP_DRIFT')).toBe(false);
    expect(data.status).toBe('not_run');
    expect(data.unverified).toBe(true);
  });

  it('a stated mass and damping pass the input items', () => {
    const data = dataOf(spinner({ massKg: 2, damping: 0.1 }));
    expect(itemOf(data, 'FPR_MASS_DEFAULTED').status).toBe('pass');
    expect(itemOf(data, 'FPR_NO_LOSSES').status).toBe('pass');
  });

  it('a body whose mass cannot be computed is not_run', () => {
    const doc = spinner();
    const broken: CadDocument = { ...doc, entities: {} };
    const item = itemOf(dataOf(broken), 'FPR_MASS_DEFAULTED');
    expect(item.status).toBe('not_run');
    expect(item.ids).toEqual(['arm']);
  });

  it('a propeller with an impossible figure of merit gives FPR_UNREALISTIC', () => {
    const prop = (cp: number): CheckItem =>
      itemOf(
        dataOf(
          step(spinner({ massKg: 2 }), 'add_propeller', { joint: 'arm_j', diameter: 1, thrustCoefficient: 0.2, powerCoefficient: cp }).doc,
        ),
        'FPR_UNREALISTIC',
      );
    const bad = prop(0.01);
    expect(bad.status).toBe('warn');
    expect(bad.values.figureOfMerit).toBeGreaterThan(0.8);
    expect(bad.threshold?.value).toBe(0.8);
    expect(prop(0.1).status).toBe('pass');
  });

  it('loop open at the start pose is a fail naming the joint; the simulation is not attempted', () => {
    const { doc } = sliderCrank({ wrist: 'revolute', wristGapMm: 1 });
    const data = dataOf(doc);
    const open = itemOf(data, 'FPR_LOOP_OPEN');
    expect(open.status).toBe('fail');
    expect(open.ids).toEqual(['wrist_j']);
    expect(open.values.maxGapMm).toBeCloseTo(1, 6);
    expect(data.status).toBe('fail');
    expect(itemOf(data, 'FPR_ENERGY_CLOSURE').status).toBe('not_run');
  });

  it('a planar loop warns FPR_REDUNDANT_CONSTRAINT with fewer redundant rows once the wrist is spherical', () => {
    const revolute = itemOf(dataOf(sliderCrank({ wrist: 'revolute' }).doc), 'FPR_REDUNDANT_CONSTRAINT');
    const spherical = dataOf(sliderCrank({ wrist: 'spherical' }).doc);
    expect(revolute.status).toBe('warn');
    expect(revolute.values.redundantRows).toBe(3);
    expect(itemOf(spherical, 'FPR_REDUNDANT_CONSTRAINT').values.redundantRows).toBe(1);
    expect(itemOf(spherical, 'FPR_LOOP_OPEN').status).toBe('pass');
  });

  it('a loop-free model has no loop items', () => {
    expect(dataOf(spinner()).items.some((entry) => entry.code === 'FPR_LOOP_OPEN')).toBe(false);
  });

  it('a loop that would close through a prismatic joint fails FPR_LOOP_PRISMATIC', () => {
    const { doc } = sliderCrank();
    const dynamics = doc.dynamics!;
    const slide = dynamics.joints.slide_j!;
    const broken: CadDocument = {
      ...doc,
      dynamics: { ...dynamics, joints: { ...dynamics.joints, slide_2: { ...slide, id: 'slide_2', axis: [0, 1, 0] } } },
    };
    const item = itemOf(dataOf(broken), 'FPR_LOOP_PRISMATIC');
    expect(item.status).toBe('fail');
    expect(item.ids.length).toBeGreaterThan(0);
  });

  it('rejects invalid params and is pure', () => {
    const doc = spinner();
    const before = structuredClone(doc);
    const bad = execute(doc, 'check_dynamics', { duration: -1 });
    expect(bad.rejected).toBe(true);
    expect(bad.document).toBe(doc);
    expect(bad.affected).toEqual([]);
    expect(execute(doc, 'check_dynamics', { timestep: 1 }).rejected).toBe(true);
    const ok = check(doc);
    expect(ok.document).toBe(doc);
    expect(ok.affected).toEqual([]);
    expect(doc).toEqual(before);
  });
});

describe('check_dynamics with the MuJoCo engine', () => {
  beforeAll(async () => {
    setPhysicsEngine(await createMujocoPhysics());
  });
  afterAll(() => setPhysicsEngine(null));

  it('a damped spinner: energy balance and timestep sensitivity are evaluated', () => {
    const data = dataOf(spinner({ massKg: 2, damping: 0.05 }));
    expect(data.provenance.engine).toBeDefined();
    const energy = itemOf(data, 'FPR_ENERGY_CLOSURE');
    expect(['pass', 'warn']).toContain(energy.status);
    expect(energy.values.balanceErrorFraction).toBeDefined();
    const timestep = itemOf(data, 'FPR_TIMESTEP_SENSITIVE');
    expect(timestep.status).toBe('pass');
    expect(timestep.values.halfTimestepS).toBeCloseTo((timestep.values.timestepS ?? 0) / 2, 9);
    expect(timestep.threshold?.value).toBe(0.01);
    expect(data.items.some((entry) => entry.code === 'FPR_LOOP_DRIFT')).toBe(false);
    expect(data.inputsHash).toMatch(/\S/);
  });

  it('a body that never moves: the timestep comparison is not_run', () => {
    const box = step(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const body = step(box.doc, 'add_rigid_body', { id: 'b', entityIds: [box.id], massKg: 1 });
    const doc = step(body.doc, 'add_body_joint', { id: 'j', kind: 'revolute', child: 'b', anchor: [0, 0, 0], axis: [0, 0, 1] }).doc;
    expect(itemOf(dataOf(doc), 'FPR_TIMESTEP_SENSITIVE').status).toBe('not_run');
  });

  it('a timestep already at the finest allowed step is info with the reason, not a not_run and not a pass', () => {
    const data = dataOf(spinner({ massKg: 2, damping: 0.05 }), { timestep: 1e-5, duration: 0.02 });
    const timestep = itemOf(data, 'FPR_TIMESTEP_SENSITIVE');
    expect(timestep.status).toBe('info');
    expect(timestep.note).toMatch(/finest allowed timestep \(0\.00001 s\)/);
    expect(timestep.values.minimumTimestepS).toBe(1e-5);
    expect(data.items.some((entry) => entry.status === 'not_run')).toBe(false);
    // nothing was compared: the result stays unverified even though no item is not_run
    expect(data.unverified).toBe(true);
  });

  it('a timestep just above the floor is compared against the finest allowed step, not skipped', () => {
    const data = dataOf(spinner({ massKg: 2, damping: 0.05 }), { timestep: 1.5e-5, duration: 0.02 });
    const timestep = itemOf(data, 'FPR_TIMESTEP_SENSITIVE');
    expect(['pass', 'warn']).toContain(timestep.status);
    expect(timestep.values.halfTimestepS).toBeCloseTo(1e-5, 12);
  });

  it('a periodic mechanism is compared phase-aligned over the last turn: converged passes, a too-coarse step that changes the cycle warns', () => {
    const { doc } = sliderCrank({ crankRpm: 300 });
    const converged = itemOf(dataOf(doc, { duration: 0.6, timestep: 2e-4 }), 'FPR_TIMESTEP_SENSITIVE');
    expect(converged.note).toMatch(/last turn of joint/);
    expect(converged.values.comparedTurnDeg).toBeGreaterThan(179);
    expect(converged.values.maxChangeFraction).toBeLessThan(0.01);
    expect(converged.status).toBe('pass');
    const fast = sliderCrank({ crankRpm: 1500 }).doc;
    const coarse = itemOf(dataOf(fast, { duration: 0.3, timestep: 0.01 }), 'FPR_TIMESTEP_SENSITIVE');
    expect(coarse.note).toMatch(/last turn of joint/);
    expect(coarse.values.maxChangeFraction).toBeGreaterThan(0.01);
    expect(coarse.status).toBe('warn');
  });

  it('a closed slider-crank reports the loop residual', () => {
    const { doc } = sliderCrank({ crankRpm: 300 });
    const data = dataOf(doc, { duration: 0.2 });
    const drift = itemOf(data, 'FPR_LOOP_DRIFT');
    expect(['pass', 'warn', 'fail']).toContain(drift.status);
    expect(drift.values.residualUm).toBeGreaterThanOrEqual(0);
    expect(itemOf(data, 'FPR_LOOP_OPEN').status).toBe('pass');
  });

  it('a propeller whose tips are supersonic warns FPR_UNREALISTIC with the tip Mach', () => {
    const base = step(spinner({ massKg: 2, damping: 0.05 }), 'add_propeller', {
      joint: 'arm_j',
      diameter: 1,
      thrustCoefficient: 0.1,
      powerCoefficient: 0.1,
    }).doc;
    const fast = step(base, 'add_motor', { joint: 'arm_j', kind: 'speed', rpm: 20000, maxTorque: 1000 }).doc;
    const tips = dataOf(fast, { duration: 0.2 }).items.filter((entry) => entry.code === 'FPR_UNREALISTIC');
    const mach = tips.find((entry) => entry.values.tipMach !== undefined);
    expect(mach?.status).toBe('warn');
    expect(new Set(tips.map((entry) => entry.findingKey)).size).toBe(tips.length);
  });
});

describe('check_dynamics simulation item builders', () => {
  const run = (extra: Record<string, unknown>): SimulationRun =>
    ({ engine: 'test', timestep: 0.001, joints: {}, propellers: {}, ...extra }) as unknown as SimulationRun;
  const joint = (finalVelocity: number, finalPosition: number): Record<string, unknown> => ({
    j: { kind: 'revolute', finalVelocity, finalPosition, peakVelocity: 10 },
  });

  it('cycle-energy closure of a cylinder engine passes inside the gate and fails outside', () => {
    const closure = (ratio: number, crankSide: { ratio: number } | null): SimulationRun =>
      run({ engineReport: { energyClosure: { ratio, gate: 0.005, crankSide } } });
    expect(energyItem(closure(0.001, null)).status).toBe('pass');
    expect(energyItem(closure(0.001, { ratio: 0.02 })).status).toBe('fail');
    expect(energyItem(closure(0.01, null)).values.closureFraction).toBe(0.01);
  });

  it('the energy balance warns above the gate and is not_run when the engine reports none', () => {
    expect(energyItem(run({ energy: { balanceErrorFraction: 0.001, balanceErrorJ: 0 } })).status).toBe('pass');
    expect(energyItem(run({ energy: { balanceErrorFraction: 0.05, balanceErrorJ: 1 } })).status).toBe('warn');
    expect(energyItem(run({})).status).toBe('not_run');
  });

  it('loop drift follows the residual tier', () => {
    const drift = (tier: string): CheckItem | undefined =>
      loopDriftItem(run({ loops: { count: 1, ids: ['w'], residualM: 5e-6, tier, passM: 1e-6, failM: 1e-5 } }))[0];
    expect(drift('pass')?.status).toBe('pass');
    expect(drift('warn')?.status).toBe('warn');
    expect(drift('fail')?.status).toBe('fail');
    expect(drift('fail')?.values.residualUm).toBeCloseTo(5, 9);
    expect(loopDriftItem(run({}))).toEqual([]);
  });

  it('timestep sensitivity warns when halving the step changes a joint state by more than 1 %', () => {
    const [coarse, fine] = [run({ joints: joint(10, 100) }), run({ joints: joint(10, 100.5) })];
    expect(timestepItem(coarse, run({ joints: joint(10, 100.001) }), null).status).toBe('pass');
    const warned = timestepItem(coarse, run({ joints: joint(9, 100) }), null);
    expect(warned.status).toBe('warn');
    expect(warned.ids).toEqual(['j']);
    expect(timestepItem(coarse, fine, null).values.maxChangeFraction).toBeCloseTo(0.005, 3);
    expect(timestepItem(coarse, null, 'why').note).toBe('why');
  });
});
