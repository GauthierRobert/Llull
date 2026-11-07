/**
 * set_joint_physics (PHY-23 DRV-M2): VC-DRV-17 (stiction breakaway, no creep), VC-DRV-18 (stick-slip plan), VC-DRV-19 (load-dependent friction),
 * VC-DRV-20 (end stop restitution, penetration, contact time), armature, Stribeck, and the coded refusals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine, type FrictionObservation } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { buildJointPhysics, effectiveFriction, latchBlockers } from '@dynamics/sim/jointPhysics';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { loadPlan, noGravity, runSteps, section, seriesOf, slider, spinner, SOURCE_A } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Ledger {
  closureRelative: number;
}
interface RunData {
  ledger?: Ledger;
  stops?: Record<string, { peakPenetration: number; peakForce: number }>;
  warnings: string[];
}
const dataOf = (result: ReturnType<typeof execute>): RunData => result.data as RunData;

const force = (id: string, points: [number, number][]): { command: string; params: Record<string, unknown> } => ({
  command: 'add_motion_profile',
  params: { id, quantity: 'force', unit: 'N', segments: [{ kind: 'table', points, interpolation: 'linear' }] },
});

describe('stiction (VC-DRV-17)', () => {
  const stuck = (): CadDocument =>
    runSteps([
      ...slider('s', 1),
      noGravity,
      {
        command: 'set_joint_physics',
        params: { joint: 'j_s', friction: { model: 'stiction', staticN: 2, kineticN: 1, source: SOURCE_A } },
      },
      force('ramp', [
        [0, 0],
        [10, 10],
      ]),
      { command: 'add_load_schedule', params: { joint: 'j_s', kind: 'force', profile: 'ramp', id: 'push' } },
    ]).doc;

  it('a 1 kg slide under a 1 N/s force ramp breaks away at 2.000 s (+-2 ms), then accelerates at (F - 1 N)/m; no creep before', () => {
    const run = execute(stuck(), 'simulate_motion', { duration: 2.1, timestep: 5e-5, sampleRate: 1000, detail: 'series', energy: true });
    const [x, v] = [seriesOf(run, 'jointPosition', 'j_s'), seriesOf(run, 'jointVelocity', 'j_s')];
    expect(Math.max(...x.slice(0, 1990).map(Math.abs))).toBeLessThanOrEqual(1e-9);
    const first = v.findIndex((speed) => Math.abs(speed) > 1e-6);
    expect(first).toBeGreaterThanOrEqual(1998);
    expect(first).toBeLessThanOrEqual(2002);
    const after = ((v[2015] ?? 0) - (v[2005] ?? 0)) / 0.01;
    expect(Math.abs(after / (2.01 - 1) - 1)).toBeLessThan(0.02);
    expect(dataOf(run).ledger?.closureRelative).toBeLessThan(1e-3);
  });

  it('below the static level the joint holds for the whole run (the friction constraint, not a threshold)', () => {
    const doc = runSteps([
      ...slider('s', 1),
      noGravity,
      {
        command: 'set_joint_physics',
        params: { joint: 'j_s', friction: { model: 'stiction', staticN: 2, kineticN: 1, source: SOURCE_A } },
      },
      { command: 'add_load_schedule', params: { joint: 'j_s', kind: 'force', constant: 1.9 } },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 1, timestep: 1e-4, sampleRate: 100, detail: 'series' });
    expect(Math.max(...seriesOf(run, 'jointPosition', 'j_s').map(Math.abs))).toBeLessThanOrEqual(1e-9);
  });
});

describe('stick-slip on a belt (VC-DRV-18)', () => {
  it('the plan limit cycle has the period 0.671239 s: release at x = 0.02 m, slip ends at x = 0', () => {
    const reference = section<{ periodS: number; stickReleaseXM: number; stickTimeS: number }>('stickSlip');
    const run = runSteps(loadPlan('drv_stick_slip')).last;
    const [relative, belt, v] = [
      seriesOf(run, 'jointPosition', 'j_block'),
      seriesOf(run, 'jointPosition', 'j_belt'),
      seriesOf(run, 'jointVelocity', 'j_block'),
    ];
    const extension = relative.map((position, i) => position + (belt[i] ?? 0));
    const releases: number[] = [];
    const sticks: number[] = [];
    for (let i = 1; i < v.length; i++) {
      const [before, now] = [Math.abs(v[i - 1] ?? 0) > 1e-9, Math.abs(v[i] ?? 0) > 1e-9];
      if (!before && now) releases.push(i);
      if (before && !now) sticks.push(i);
    }
    // the first release is the start-up slip; later ones are the limit cycle
    expect(releases.length).toBeGreaterThanOrEqual(5);
    const periods = releases.slice(1).map((index, k) => (index - (releases[k] ?? 0)) / 2000);
    for (const period of periods.slice(1)) expect(Math.abs(period / reference.periodS - 1)).toBeLessThan(0.02);
    for (const index of releases.slice(2)) expect(Math.abs((extension[index] ?? 0) / reference.stickReleaseXM - 1)).toBeLessThan(0.02);
    for (const index of sticks.slice(1)) expect(Math.abs(extension[index] ?? 1)).toBeLessThan(0.02 * reference.stickReleaseXM);
    const stickTime = ((releases[3] ?? 0) - (sticks[2] ?? 0)) / 2000;
    expect(Math.abs(stickTime / reference.stickTimeS - 1)).toBeLessThan(0.02);
    // the ledger lists the friction heat of the block; the belt servo jump-starts from rest, an impulse of 1/2 m v^2 = 0.025 J whose work the
    // first-order servo estimate cannot resolve (known limit, spec 13.14): the closure error is that impulse and does not grow with time
    const ledger = dataOf(run).ledger as Ledger & { closureErrorJ: number; entries: { element: string; joules: number }[] };
    expect(ledger.entries.find((entry) => entry.element === 'friction:j_block')?.joules).toBeGreaterThan(0.1);
    expect(Math.abs(ledger.closureErrorJ)).toBeLessThan(0.03);
  });

  it('with the belt already at speed there is no start-up impulse and the books close to 1e-3 (friction heat = servo work - spring energy)', () => {
    const plan = loadPlan('drv_stick_slip');
    const belt = plan.find((step) => step.command === 'add_body_joint' && step.params['id'] === 'j_belt');
    if (belt === undefined) throw new Error('no belt joint');
    belt.params['initialVelocity'] = 0.1;
    const last = plan[plan.length - 1];
    if (last !== undefined) last.params['duration'] = 1.5;
    expect(dataOf(runSteps(plan).last).ledger?.closureRelative).toBeLessThan(1e-3);
  });
});

describe('load-dependent friction (VC-DRV-19)', () => {
  const wheel = (): CadDocument =>
    runSteps([
      { command: 'add_cylinder', params: { radius: 50, height: 10, position: [0, 0, 0], axis: [0, 1, 0] }, as: 'w' },
      { command: 'add_rigid_body', params: { entityIds: ['$w'], id: 'wheel', massKg: 5, inertiaKgM2: [0.005, 0.01, 0.005, 0, 0, 0] } },
      {
        command: 'add_body_joint',
        params: { kind: 'revolute', child: 'wheel', parent: 'ground', anchor: [0, 0, 0], axis: [0, 1, 0], id: 'j' },
      },
      {
        command: 'set_joint_physics',
        params: { joint: 'j', friction: { model: 'load_dependent', mu: 0.2, pinRadiusMm: 10, source: SOURCE_A } },
      },
      { command: 'add_motor', params: { joint: 'j', kind: 'torque_curve', torque: 0.2 } },
    ]).doc;

  it('J 0.01, 5 kg radial load, pin 10 mm, mu 0.2, 0.2 N*m: alpha = (0.2 - 0.0981) / 0.01 = 10.19 rad/s^2, at dt and dt/2 to 0.5 %', () => {
    const alpha = (dt: number): number => {
      const run = execute(wheel(), 'simulate_motion', { duration: 0.2, timestep: dt, sampleRate: 1 / dt, detail: 'series', energy: true });
      expect(dataOf(run).ledger?.closureRelative).toBeLessThan(1e-3);
      return (seriesOf(run, 'jointVelocity', 'j')[Math.round(0.1 / dt)] ?? 0) / 0.1;
    };
    const [coarse, fine] = [alpha(1e-3), alpha(5e-4)];
    expect(Math.abs(coarse / 10.19 - 1)).toBeLessThan(0.01);
    expect(Math.abs(fine / coarse - 1)).toBeLessThan(0.005);
  });

  it('adds the preload to the radial load and, on a prismatic joint, uses mu x load without a radius', () => {
    const doc = execute(wheel(), 'set_joint_physics', {
      joint: 'j',
      friction: { model: 'load_dependent', mu: 0.2, pinRadiusMm: 10, preloadN: 50.95, source: SOURCE_A },
    }).document;
    const run = execute(doc, 'simulate_motion', { duration: 0.2, timestep: 1e-3, sampleRate: 1000, detail: 'series' });
    expect((seriesOf(run, 'jointVelocity', 'j')[100] ?? 0) / 0.1).toBeCloseTo((0.2 - 0.2 * 0.01 * (49.05 + 50.95)) / 0.01, 1);
    const slide = runSteps([
      ...slider('s', 2),
      {
        command: 'set_joint_physics',
        params: { joint: 'j_s', friction: { model: 'load_dependent', mu: 0.5, pinRadiusMm: 1, source: SOURCE_A } },
      },
      { command: 'add_load_schedule', params: { joint: 'j_s', kind: 'force', constant: 20 } },
    ]).doc;
    // gravity presses the slide on its guide: F_r = m g perpendicular to the axis, friction = mu m g = 9.81 N, a = (20 - 9.81) / 2
    const slid = execute(slide, 'simulate_motion', { duration: 0.2, timestep: 1e-3, sampleRate: 1000, detail: 'series' });
    expect((seriesOf(slid, 'jointVelocity', 'j_s')[100] ?? 0) / 0.1).toBeCloseTo((20 - 0.5 * 2 * 9.81) / 2, 1);
  });
});

describe('end stops (VC-DRV-20)', () => {
  const stop = (extra: Record<string, unknown> = {}): CadDocument => {
    const doc = runSteps([
      ...spinner('s', 0.01),
      noGravity,
      {
        command: 'set_joint_physics',
        params: { joint: 'j_s', limits: { min: -5, max: 0.01, stiffness: 1000, dampingRatio: 0.2, ...extra } },
      },
    ]).doc;
    const dynamics = doc.dynamics;
    const joint = dynamics?.joints['j_s'];
    if (dynamics === undefined || joint === undefined) throw new Error('no joint');
    return { ...doc, dynamics: { ...dynamics, joints: { ...dynamics.joints, j_s: { ...joint, initialVelocity: 1 } } } };
  };

  it('k 1000 N*m/rad, zeta 0.2, J 0.01, 1 rad/s: restitution 0.57174 (3 %), peak penetration 2.391e-3 rad (5 %), contact 10.10 ms (5 %); the books close', () => {
    const reference = section<{ restitution: number; peakPenetrationRad: number; contactTimeS: number }>('endStop');
    const run = execute(stop(), 'simulate_motion', { duration: 0.2, timestep: 1e-5, sampleRate: 20000, detail: 'series', energy: true });
    const [q, v] = [seriesOf(run, 'jointPosition', 'j_s'), seriesOf(run, 'jointVelocity', 'j_s')];
    expect(Math.abs(-(v[v.length - 1] ?? 0) / reference.restitution - 1)).toBeLessThan(0.03);
    const stats = dataOf(run).stops?.['j_s'];
    expect(Math.abs((stats?.peakPenetration ?? 0) / reference.peakPenetrationRad - 1)).toBeLessThan(0.05);
    expect(stats?.peakForce).toBeGreaterThan(0);
    expect((stats as { effectiveInertia?: number }).effectiveInertia).toBeCloseTo(0.01, 12);
    const contact = q.filter((angle) => angle > 0.01).length / 20000;
    expect(Math.abs(contact / reference.contactTimeS - 1)).toBeLessThan(0.05);
    expect(dataOf(run).ledger?.closureRelative).toBeLessThan(1e-3);
  });

  it('restitution replaces the damping ratio (e 0.5717 is zeta 0.2) and an impact on the lower stop mirrors it', () => {
    const byRestitution = execute(stop({ dampingRatio: undefined, restitution: 0.5717 }), 'simulate_motion', {
      duration: 0.2,
      timestep: 1e-5,
      sampleRate: 1000,
      detail: 'series',
    });
    expect(-(seriesOf(byRestitution, 'jointVelocity', 'j_s').at(-1) ?? 0)).toBeCloseTo(0.5717, 1);
    const doc = stop({ min: -0.01, max: 5 });
    const dynamics = doc.dynamics;
    const joint = dynamics?.joints['j_s'];
    if (dynamics === undefined || joint === undefined) throw new Error('no joint');
    const down = { ...doc, dynamics: { ...dynamics, joints: { ...dynamics.joints, j_s: { ...joint, initialVelocity: -1 } } } };
    const run = execute(down, 'simulate_motion', { duration: 0.2, timestep: 1e-5, sampleRate: 1000, detail: 'series' });
    expect(seriesOf(run, 'jointVelocity', 'j_s').at(-1) ?? 0).toBeCloseTo(0.5719, 2);
  });

  it('refuses a stop the timestep cannot integrate (omega_n dt > 0.1) before running', () => {
    const run = execute(stop({ stiffness: 1e6 }), 'simulate_motion', { duration: 0.05, timestep: 1e-3 });
    expect(run.summary).toMatch(/DRV_STEP_TOO_COARSE/);
    expect(run.data).toBeUndefined();
  });
});

describe('rest latch and its exclusions (DRV_STICTION_NOT_LATCHED)', () => {
  const stiction = { model: 'stiction', staticN: 2, kineticN: 1, source: SOURCE_A };
  const notes = (doc: CadDocument): string[] =>
    (execute(doc, 'simulate_motion', { duration: 0.01, timestep: 1e-4, sampleRate: 100 }).data as RunData).warnings.filter((w) =>
      w.startsWith('DRV_STICTION_NOT_LATCHED'),
    );

  it('a free stiction joint is latched and silent', () => {
    const doc = runSteps([
      ...slider('s', 1),
      noGravity,
      { command: 'set_joint_physics', params: { joint: 'j_s', friction: stiction } },
    ]).doc;
    expect(notes(doc)).toEqual([]);
  });

  it('a stiction joint a transmission couples is not latched and the run says why', () => {
    const doc = runSteps([
      ...slider('s', 1),
      ...spinner('r', 1e-3),
      noGravity,
      { command: 'add_transmission', params: { kind: 'rack_pinion', pinion: 'j_r', rack: 'j_s', pitchRadiusMm: 10, id: 'rk' } },
      { command: 'set_joint_physics', params: { joint: 'j_s', friction: stiction } },
    ]).doc;
    const [note] = notes(doc);
    expect(note).toMatch(/joint 'j_s' is coupled by transmission 'rk'.*rest latch is off/);
    expect(notes(doc)).toHaveLength(1);
  });

  it('a joint with a speed governor is not latched: the set-point cannot wind up, and the governed run holds its speed', () => {
    const doc = runSteps([
      ...slider('s', 1),
      noGravity,
      { command: 'set_joint_physics', params: { joint: 'j_s', friction: stiction } },
      { command: 'add_motor', params: { joint: 'j_s', kind: 'speed', speedMps: 0.1, maxForceN: 50, id: 'gov' } },
    ]).doc;
    expect(notes(doc)[0]).toMatch(/acted on by linear_speed motor 'gov'/);
    const run = execute(doc, 'simulate_motion', { duration: 1, timestep: 1e-4, sampleRate: 100, detail: 'series' });
    const v = seriesOf(run, 'jointVelocity', 'j_s');
    expect(v[100]).toBeCloseTo(0.1, 3);
  });

  it('a model with kinematic loops latches nothing', () => {
    const doc = runSteps([
      ...spinner('r', 1e-3),
      ...slider('s', 1),
      noGravity,
      { command: 'set_joint_physics', params: { joint: 'j_s', friction: stiction } },
    ]).doc;
    const dynamics = doc.dynamics;
    if (dynamics === undefined) throw new Error('no dynamics');
    const built = buildJointPhysics(dynamics, {
      timestep: 1e-4,
      sign: () => 1,
      inertiaOf: () => 1,
      unlatched: latchBlockers(dynamics, true),
    });
    if (built === null || 'error' in built) throw new Error('no block');
    expect(built.block.restLatch).toEqual([false]);
    expect(built.notes[0]).toMatch(/kinematic loops/);
  });
});

describe('armature and Stribeck friction', () => {
  it('an armature adds inertia to the joint coordinate: alpha = T / (J + armature)', () => {
    const doc = runSteps([
      ...spinner('s', 0.01),
      noGravity,
      { command: 'set_joint_physics', params: { joint: 'j_s', armatureKgM2: 0.04 } },
      { command: 'add_load_schedule', params: { joint: 'j_s', kind: 'torque', constant: 1 } },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 1e-4, sampleRate: 100, detail: 'series' });
    expect((seriesOf(run, 'jointVelocity', 'j_s')[10] ?? 0) / 0.1).toBeCloseTo(1 / 0.05, 3);
  });

  it('the Stribeck level is finite at rest (static), falls to Coulomb above the Stribeck speed and never gives NaN', () => {
    const doc = runSteps([
      ...slider('s', 1),
      {
        command: 'set_joint_physics',
        params: {
          joint: 'j_s',
          friction: { model: 'stribeck', staticN: 3, coulombN: 1, stribeckVelocity: 0.01, viscousNsPerM: 0.5, source: SOURCE_A },
        },
      },
    ]).doc;
    const dynamics = doc.dynamics;
    if (dynamics === undefined) throw new Error('no dynamics');
    const built = buildJointPhysics(dynamics, { timestep: 1e-4, sign: () => 1, inertiaOf: () => 1, unlatched: new Map() });
    if (built === null || 'error' in built) throw new Error('no block');
    const { block } = built;
    const observed: FrictionObservation = {
      radialLoad: new Float64Array(1),
      bendingMoment: new Float64Array(1),
      saturated: new Uint8Array(1),
    };
    const level = (velocity: number): number =>
      block.frictionLevel({ time: 0, jointPosition: { j_s: 0 }, jointVelocity: { j_s: velocity } }, observed)[0] ?? Number.NaN;
    expect(level(0)).toBe(3);
    expect(level(0.01)).toBeCloseTo(1 + 2 / Math.E, 12);
    expect(level(-0.01)).toBe(level(0.01));
    expect(level(10)).toBeCloseTo(1, 12);
    expect(effectiveFriction(dynamics, dynamics.joints['j_s'] as never)).toMatchObject({ dry: 0, damping: 0.5 });
    // simulation: 2.5 N holds under a static level of 3 N, 3.5 N slides
    const push = (newtons: number): ReturnType<typeof execute> =>
      execute(execute(doc, 'add_load_schedule', { joint: 'j_s', kind: 'force', constant: newtons }).document, 'simulate_motion', {
        duration: 0.5,
        timestep: 1e-4,
        sampleRate: 100,
        detail: 'series',
        energy: true,
      });
    const [held, slid] = [push(2.5), push(3.5)];
    expect(Math.max(...seriesOf(held, 'jointPosition', 'j_s').map(Math.abs))).toBeLessThanOrEqual(1e-9);
    expect(seriesOf(slid, 'jointPosition', 'j_s').at(-1) ?? 0).toBeGreaterThan(1e-3);
    expect(dataOf(slid).ledger?.closureRelative).toBeLessThan(1e-3);
  });

  it('a coulomb model replaces the joint friction and damping of add_body_joint (viscous given); a motor friction still adds', () => {
    const doc = runSteps([
      ...spinner('s', 0.01),
      noGravity,
      { command: 'set_joint_physics', params: { joint: 'j_s', friction: { model: 'coulomb', kineticNm: 0.5, source: SOURCE_A } } },
    ]).doc;
    const joint = doc.dynamics?.joints['j_s'];
    if (doc.dynamics === undefined || joint === undefined) throw new Error('no joint');
    const shortcut = { ...doc.dynamics, joints: { ...doc.dynamics.joints, j_s: { ...joint, friction: 9, damping: 3 } } };
    expect(effectiveFriction(shortcut, shortcut.joints['j_s'] ?? joint)).toEqual({ dry: 0.5, damping: 3, dynamic: null });
    const none = { ...shortcut, jointPhysics: {} };
    expect(effectiveFriction(none, none.joints['j_s'] ?? joint)).toEqual({ dry: 9, damping: 3, dynamic: null });
  });
});

describe('set_joint_physics refusals, replacement semantics, purity', () => {
  const base = (): CadDocument => runSteps([...spinner('r', 0.01), ...slider('p', 1)]).doc;
  const set = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, 'set_joint_physics', params);
  const refused = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> => {
    const result = set(doc, params);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    return result;
  };

  it('refuses unknown / spherical joints, nothing to set and bad numbers with their codes', () => {
    const doc = base();
    expect(refused(doc, { joint: 'nope', armatureKgM2: 1 }).summary).toMatch(/not found/);
    expect(refused(doc, { joint: 'j_r' }).summary).toMatch(/nothing to set/);
    const friction = (extra: Record<string, unknown>, joint = 'j_r'): ReturnType<typeof execute> =>
      refused(doc, { joint, friction: { source: SOURCE_A, ...extra } });
    expect(friction({ model: 'stiction', staticNm: 1, kineticNm: 2 }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'stiction', staticNm: 1 }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'coulomb' }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'coulomb', kineticN: 1 }).summary).toMatch(/does not fit revolute/);
    expect(friction({ model: 'coulomb', kineticNm: 1, viscousNsPerM: 1 }).summary).toMatch(/viscousNsPerM does not fit revolute/);
    expect(friction({ model: 'coulomb', kineticNm: 1, viscousNmsPerRad: -1 }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'coulomb', kineticNm: 1 }, 'j_p').summary).toMatch(/does not fit prismatic/);
    expect(friction({ model: 'coulomb', kineticN: 1, viscousNmsPerRad: 1 }, 'j_p').summary).toMatch(
      /viscousNmsPerRad does not fit prismatic/,
    );
    expect(friction({ model: 'stribeck', staticNm: 2, coulombNm: 1 }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'stribeck', staticNm: 0.5, coulombNm: 1, stribeckVelocity: 1 }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'load_dependent', mu: 0.1 }).error?.code).toBe('DRV_FRICTION_INVALID');
    expect(friction({ model: 'load_dependent', mu: 0.1, pinRadiusMm: 5, frictionArmMm: -1 }).error?.code).toBe('DRV_FRICTION_INVALID');
    const limits = (extra: Record<string, unknown>): ReturnType<typeof execute> =>
      refused(doc, { joint: 'j_r', limits: { min: -1, max: 1, stiffness: 100, ...extra } });
    expect(limits({ min: 2 }).error?.code).toBe('DRV_LIMITS_INVALID');
    expect(limits({ stiffness: 0 }).error?.code).toBe('DRV_LIMITS_INVALID');
    expect(limits({ dampingRatio: -1 }).error?.code).toBe('DRV_LIMITS_INVALID');
    expect(limits({ restitution: 1e-9 }).summary).toMatch(/not reachable/);
    const spherical = execute(doc, 'add_body_joint', { kind: 'spherical', child: 'b_p', parent: 'b_r', anchor: [0, 0, 10], id: 'j_ball' });
    expect(refused(spherical.document, { joint: 'j_ball', armatureKgM2: 1 }).summary).toMatch(/spherical/);
  });

  it('stores friction, limits and armature; later calls replace the parts they give, keep the others and null clears; an empty record disappears', () => {
    const doc = base();
    const before = JSON.stringify(doc);
    const first = set(doc, {
      joint: 'j_r',
      friction: { model: 'stiction', staticNm: 2, kineticNm: 1, source: SOURCE_A },
      limits: { min: -1, max: 1, stiffness: 100, restitution: 0.4 },
      armatureKgM2: 0.5,
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.affected).toEqual(['j_r']);
    expect(first.document.dynamics?.jointPhysics?.['j_r']).toEqual({
      id: 'j_r',
      friction: { model: 'stiction', static: 2, kinetic: 1, source: SOURCE_A },
      limits: { min: -1, max: 1, stiffness: 100, restitution: 0.4 },
      armatureKgM2: 0.5,
    });
    expect(first.summary).toMatch(/friction stiction, end stops \[-1, 1\] k 100, armature 0.5/);
    const swapped = set(first.document, {
      joint: 'j_r',
      friction: { model: 'coulomb', kineticNm: 0.1, viscousNmsPerRad: 0.01, source: SOURCE_A },
    });
    expect(swapped.document.dynamics?.jointPhysics?.['j_r']).toMatchObject({
      friction: { model: 'coulomb', kinetic: 0.1, viscous: 0.01 },
      limits: { max: 1 },
      armatureKgM2: 0.5,
    });
    const cleared = set(swapped.document, { joint: 'j_r', friction: null, limits: null, armatureKgM2: null });
    expect(cleared.document.dynamics?.jointPhysics).toEqual({});
    expect(cleared.summary).toMatch(/cleared/);
    expect(set(first.document, { joint: 'j_r', armatureKgM2: 0 }).document.dynamics?.jointPhysics?.['j_r']).not.toHaveProperty(
      'armatureKgM2',
    );
    const loaded = set(base(), {
      joint: 'j_p',
      friction: { model: 'load_dependent', mu: 0.1, pinRadiusMm: 5, preloadN: 1, frictionArmMm: 20, baseN: 0.2, source: SOURCE_A },
    });
    expect(loaded.document.dynamics?.jointPhysics?.['j_p']?.friction).toMatchObject({
      model: 'load_dependent',
      base: 0.2,
      frictionArmMm: 20,
      preloadN: 1,
    });
    const stribeck = set(base(), {
      joint: 'j_r',
      friction: { model: 'stribeck', staticNm: 2, coulombNm: 1, stribeckVelocity: 0.1, source: SOURCE_A },
    });
    expect(stribeck.document.dynamics?.jointPhysics?.['j_r']?.friction).toMatchObject({ model: 'stribeck', stribeckVelocity: 0.1 });
  });

  it('deleting a joint removes its joint physics and a joint load schedule', () => {
    const doc = set(base(), { joint: 'j_r', armatureKgM2: 1 }).document;
    const loaded = execute(doc, 'add_load_schedule', { joint: 'j_r', kind: 'torque', constant: 1, id: 'l' }).document;
    const gone = execute(loaded, 'delete_dynamics_item', { id: 'j_r' }).document;
    expect(gone.dynamics?.jointPhysics).toEqual({});
    expect(gone.dynamics?.loadSchedules).toEqual({});
  });
});
