/**
 * check_motion_truth (PHY-23 DRV-M3): VC-DRV-30 (observed order and GCI on the compound pendulum), VC-DRV-33 (unbounded effort), VC-DRV-34 (provenance verdict
 * on the servo sizing plan), and the DRV-M2 leftovers: the named cause of a servo jump-start ledger error, the honest order of the stop / backlash ledger
 * closure, and the flagged configuration-dependent stop inertia. Plus the study mechanics (levels, outputs, floor), reference series and the refusals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { servoSizingDoc } from './sizingFixtures';
import { loadPlan, noGravity, runSteps, seriesOf, spinner, type DriveSeriesData } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Item {
  code: string;
  status: string;
  ids: string[];
  values: Record<string, number>;
  note?: string;
  remediation: string;
  unverified?: boolean;
}
interface Truth {
  status: string;
  verdict: 'trusted' | 'plausible' | 'not_trusted';
  items: Item[];
  study: {
    level: string;
    steps: number[];
    rows: { key: string; order: number | null; orderAssumed: boolean; gci: number | null; status: string; note: string }[];
  } | null;
  provenance: { id: string; grade: string }[];
  timestepS: number | null;
  durationS: number;
}
const truthOf = (result: ReturnType<typeof execute>): Truth => result.data as Truth;
const itemsOf = (truth: Truth, code: string): Item[] => truth.items.filter((item) => item.code === code);
const only = (truth: Truth, code: string, id?: string): Item => {
  const found = itemsOf(truth, code).filter((item) => id === undefined || item.ids.includes(id));
  expect(found, `${code} ${id ?? ''}`).toHaveLength(1);
  return found[0] as Item;
};
const errorOf = (result: ReturnType<typeof execute>): { code: string } | undefined =>
  (result as unknown as { error?: { code: string } }).error;

describe('check_motion_truth on the servo sizing plan (VC-DRV-34, UC-2)', () => {
  let doc: CadDocument;
  let truth: Truth;
  beforeAll(() => {
    doc = servoSizingDoc();
    truth = truthOf(execute(doc, 'check_motion_truth', { duration: 1, level: 'full' }));
  }, 300_000);

  it('verdict plausible: friction (grade C) is the lowest-grade input and DRV_PARAM_UNSOURCED lists it; the other items pass', () => {
    expect(truth.verdict).toBe('plausible');
    expect(truth.provenance[0]).toMatchObject({ id: 'j_load.friction', grade: 'C' });
    expect(only(truth, 'DRV_PARAM_UNSOURCED')).toMatchObject({ status: 'warn', ids: ['j_load.friction'] });
    expect(truth.items.filter((item) => item.status === 'warn' || item.status === 'fail').map((item) => item.code)).toEqual([
      'DRV_PARAM_UNSOURCED',
    ]);
    expect(only(truth, 'DRV_LEDGER_CLOSURE').status).toBe('pass');
  });

  it('regrading the friction to B makes the verdict trusted (VC-DRV-34 second half)', () => {
    const regraded = truthOf(execute(servoSizingDoc({ grade: 'B' }), 'check_motion_truth', { duration: 1, level: 'full' }));
    expect(regraded.verdict).toBe('trusted');
    expect(only(regraded, 'DRV_PARAM_UNSOURCED').status).toBe('pass');
    expect(regraded.items.every((item) => item.status === 'pass' || item.status === 'info')).toBe(true);
  }, 300_000);

  it('the level full study ran at dt, dt/2, dt/4 from the controller period and observed an order near 1 (the first-order servo and winding steps)', () => {
    expect(truth.study?.level).toBe('full');
    expect(truth.timestepS).toBe(1e-4);
    expect(truth.study?.steps).toEqual([1e-4, 5e-5, 2.5e-5]);
    const rows = truth.study?.rows ?? [];
    for (const key of ['j_load.finalVelocity', 'm_re40.rmsCurrent', 'm_re40.peakCurrent']) {
      const row = rows.find((entry) => entry.key === key);
      expect(row?.orderAssumed, key).toBe(false);
      expect(row?.order ?? Number.NaN, key).toBeGreaterThan(0.5);
      expect(row?.order ?? Number.NaN, key).toBeLessThan(2);
      expect(row?.gci ?? Number.NaN, key).toBeLessThan(0.01);
    }
  });

  it('the envelope is a dynamics review with a hash, provenance of the engine, a summary with the verdict, and the document untouched (pure)', () => {
    const before = structuredClone(doc);
    const result = execute(doc, 'check_motion_truth', { duration: 0.5, outputs: ['j_load.finalVelocity'] });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(doc).toEqual(before);
    expect(result.summary).toMatch(/^check_motion_truth: verdict plausible — 0 fail, 1 warn, 0 not_run/);
    expect(result.summary).toMatch(/hash [0-9a-f]{16}/);
    expect(result.summary).toMatch(/Computed by llull, not approved/);
    const data = truthOf(result);
    expect(data.status).toBe('warn');
    expect(itemsOf(data, 'DRV_TIMESTEP_STUDY').map((item) => item.ids[0])).toEqual(['j_load.finalVelocity']);
    expect(data.study?.rows[0]?.orderAssumed).toBe(true);
    expect(itemsOf(data, 'DRV_TIMESTEP_STUDY')[0]?.note).toMatch(/order assumed 1/);
  });
});

describe('observed order of the energy error (VC-DRV-30)', () => {
  const pendulum = (name: string): CadDocument =>
    runSteps(
      (
        JSON.parse(readFileSync(`docs/physics/10-rigid-body-dynamics/validation/plans/${name}.plan.json`, 'utf8')) as {
          command: string;
          params: Record<string, unknown>;
        }[]
      ).filter((step) => step.command !== 'simulate_motion'),
    ).doc;

  it('compound pendulum, RK4 at dt 1, 0.5, 0.25 ms: the energy error falls with order 4.15 (3.5 .. 4.5), the period GCI is 0 and every item passes', () => {
    const truth = truthOf(execute(pendulum('rbd_compound_pendulum'), 'check_motion_truth', { duration: 5, level: 'full', timestep: 1e-3 }));
    const energy = truth.study?.rows.find((row) => row.key === 'energy.balanceErrorJ');
    expect(energy?.order ?? Number.NaN).toBeGreaterThanOrEqual(3.5);
    expect(energy?.order ?? Number.NaN).toBeLessThanOrEqual(4.5);
    expect(only(truth, 'DRV_TIMESTEP_STUDY', 'energy.balanceErrorJ').status).toBe('pass');
    const period = truth.study?.rows.find((row) => row.key === 'pivot.periodS');
    expect(period?.gci ?? Number.NaN).toBeLessThan(0.01);
    expect(only(truth, 'DRV_TIMESTEP_STUDY', 'pivot.periodS').status).toBe('pass');
    expect(truth.verdict).toBe('trusted');
  });

  it('the small-amplitude plan has an energy error at round-off (1e-16 J) at every step: reported as such, not as an order', () => {
    const truth = truthOf(
      execute(pendulum('rbd_compound_pendulum_small'), 'check_motion_truth', { duration: 3, level: 'full', timestep: 1e-3 }),
    );
    const energy = truth.study?.rows.find((row) => row.key === 'energy.balanceErrorJ');
    expect(energy?.order).toBeNull();
    expect(energy?.status).toBe('pass');
  });
});

describe('effort, provenance and reference engine (VC-DRV-33)', () => {
  it('PHY-22 slider-crank with a 1e6 N*m speed motor and no source: DRV_EFFORT_UNBOUNDED names the motor, the fix names a motor model or a sourced limit, the verdict is at best plausible', () => {
    const plan = JSON.parse(readFileSync('docs/physics/22-motion-video/validation/plans/mov_slider_crank_base.plan.json', 'utf8')) as {
      command: string;
      params: Record<string, unknown>;
    }[];
    const doc = runSteps(plan).doc;
    const truth = truthOf(execute(doc, 'check_motion_truth', { duration: 0.2, level: 'quick' }));
    const effort = only(truth, 'DRV_EFFORT_UNBOUNDED', 'drive');
    expect(effort.status).toBe('warn');
    expect(effort.remediation).toMatch(/motor model/);
    expect(effort.remediation).toMatch(/sourced torque limit/);
    expect(effort.note).toMatch(/limits its torque to 1000000 N·m with no motor model and no source/);
    expect(truth.verdict).not.toBe('trusted');
    expect(only(truth, 'DRV_PARAM_UNSOURCED').ids).toContain('drive.effort');
    expect(itemsOf(truth, 'FPR_LOOP_DRIFT')).toHaveLength(1);
  }, 300_000);

  it('engines ["reference"] is reported not_run with NATIVE_TOOL_MISSING (the reference engine is not installed)', () => {
    const truth = truthOf(
      execute(servoSizingDoc({ grade: 'B' }), 'check_motion_truth', {
        duration: 0.2,
        engines: ['reference'],
        outputs: ['j_load.finalPosition'],
      }),
    );
    expect(only(truth, 'NATIVE_TOOL_MISSING').status).toBe('not_run');
    expect(truth.verdict).toBe('plausible');
  });
});

describe('DRV-M2 leftovers: ledger cause, stop order, stop inertia', () => {
  it('a servo that jump-starts a mass: the closure fails (16 %) and the cause is named with its kinetic energy (no silent pass); verdict not_trusted', () => {
    const plan = loadPlan('drv_stick_slip').filter((step) => step.command !== 'simulate_motion');
    const truth = truthOf(execute(runSteps(plan).doc, 'check_motion_truth', { duration: 1, timestep: 5e-5 }));
    const closure = only(truth, 'DRV_LEDGER_CLOSURE');
    expect(closure.status).toBe('fail');
    expect(closure.values['closureRelative']).toBeGreaterThan(0.1);
    const cause = only(truth, 'DRV_LEDGER_SERVO_JUMP');
    expect(cause.ids).toEqual(['m_belt']);
    expect(cause.note).toMatch(/jump start/);
    // hand: 1/2 (5 kg belt + 1 kg block riding on it) (0.1 m/s)^2 = 0.03 J against the 0.025 J of the error
    expect(cause.values['jumpKineticJ']).toBeCloseTo(0.03, 6);
    expect(cause.values['closureErrorJ']).toBeCloseTo(0.025, 3);
    expect(truth.verdict).toBe('not_trusted');
  }, 300_000);

  it('the same plan with the belt already at speed closes and carries no cause item', () => {
    const plan = loadPlan('drv_stick_slip').filter((step) => step.command !== 'simulate_motion');
    const belt = plan.find((step) => step.command === 'add_body_joint' && step.params['id'] === 'j_belt');
    if (belt === undefined) throw new Error('no belt joint');
    belt.params['initialVelocity'] = 0.1;
    const truth = truthOf(execute(runSteps(plan).doc, 'check_motion_truth', { duration: 1, timestep: 5e-5 }));
    expect(only(truth, 'DRV_LEDGER_CLOSURE').status).toBe('pass');
    expect(itemsOf(truth, 'DRV_LEDGER_SERVO_JUMP')).toHaveLength(0);
  }, 300_000);

  const stopBench = (): CadDocument => {
    const doc = runSteps([
      ...spinner('s', 0.01),
      noGravity,
      { command: 'set_joint_physics', params: { joint: 'j_s', limits: { min: -5, max: 0.01, stiffness: 1000, dampingRatio: 0.2 } } },
    ]).doc;
    const dynamics = doc.dynamics;
    const joint = dynamics?.joints['j_s'];
    if (dynamics === undefined || joint === undefined) throw new Error('no joint');
    return { ...doc, dynamics: { ...dynamics, joints: { ...dynamics.joints, j_s: { ...joint, initialVelocity: 1 } } } };
  };

  it('an end stop impact: penetration is 0.05 % of the 5.01 rad travel (pass); the ledger closure error falls with the step and its order is reported (first order, honestly)', () => {
    const truth = truthOf(execute(stopBench(), 'check_motion_truth', { duration: 0.1, level: 'full', timestep: 4e-5 }));
    const penetration = only(truth, 'DRV_STOP_PENETRATION', 'j_s');
    expect(penetration.status).toBe('pass');
    expect(penetration.values['peakPenetration']).toBeGreaterThan(1e-3);
    expect(penetration.values['penetrationRatio']).toBeLessThan(0.01);
    const order = only(truth, 'DRV_LEDGER_ORDER');
    expect(order.status).toBe('info');
    expect(order.note).toMatch(/first order in dt|first order/);
    const row = truth.study?.rows.find((entry) => entry.key === 'ledger.closureErrorJ');
    // measured: the closure error is 1.6e-3 at dt 1e-5, 2.5e-3 at 4e-5 (spec 13.15): it falls with the step at order about 1
    expect(row?.order ?? Number.NaN).toBeGreaterThan(0.5);
    expect(row?.order ?? Number.NaN).toBeLessThan(2);
    expect(order.values['observedOrder']).toBeCloseTo(row?.order ?? Number.NaN, 8);
  }, 300_000);

  it('backlash: the gear gap is the travel of its penetration item (1 % gate), the cluster it couples carries no inertia warning', () => {
    const doc = runSteps([
      ...spinner('in', 1e-4),
      ...spinner('out', 1e-3, [100, 0, 0]),
      noGravity,
      {
        command: 'add_transmission',
        params: {
          kind: 'gear',
          driver: 'j_in',
          driven: 'j_out',
          ratio: 1,
          backlashDeg: 0.5,
          meshStiffnessNmPerRad: 2000,
          id: 'g',
          source: { name: 'bench', grade: 'A' },
        },
      },
      {
        command: 'set_joint_physics',
        params: {
          joint: 'j_out',
          friction: { model: 'coulomb', kineticNm: 0, viscousNmsPerRad: 0.01, source: { name: 'bench', grade: 'A' } },
        },
      },
      {
        command: 'add_motion_profile',
        params: { id: 'p', quantity: 'torque', unit: 'N*m', segments: [{ kind: 'sine', amplitude: 0.01, frequencyHz: 1, cycles: 1 }] },
      },
      { command: 'add_load_schedule', params: { joint: 'j_in', kind: 'torque', profile: 'p' } },
    ]).doc;
    const truth = truthOf(execute(doc, 'check_motion_truth', { duration: 1.2, timestep: 2e-5 }));
    const penetration = only(truth, 'DRV_STOP_PENETRATION', 'g');
    // the gap is 0.5 deg = 0.0087266 rad
    expect(penetration.values['travel']).toBeCloseTo((0.5 * Math.PI) / 180, 9);
    expect(penetration.values['penetrationRatio']).toBeLessThan(0.01);
    expect(itemsOf(truth, 'DRV_STOP_INERTIA_VARIES')).toHaveLength(0);
  }, 300_000);

  it('a stop that carries another moving joint: DRV_STOP_INERTIA_VARIES warns (the inertia changed during the run); with the joint below it still, it passes', () => {
    const chain = (below: number, speed = 1): CadDocument => {
      const doc = runSteps([
        ...spinner('a', 0.01),
        { command: 'add_cylinder', params: { radius: 20, height: 10, position: [100, 0, 0], axis: [0, 0, 1] }, as: 'geo_b' },
        {
          command: 'add_rigid_body',
          params: { entityIds: ['$geo_b'], id: 'b_b', massKg: 0.5, inertiaKgM2: [0.001, 0.001, 0.002, 0, 0, 0] },
        },
        {
          command: 'add_body_joint',
          params: { kind: 'revolute', child: 'b_b', parent: 'b_a', anchor: [100, 0, 0], axis: [0, 0, 1], id: 'j_b' },
        },
        noGravity,
        { command: 'set_joint_physics', params: { joint: 'j_a', limits: { min: -5, max: 0.01, stiffness: 1000, dampingRatio: 0.2 } } },
      ]).doc;
      const dynamics = doc.dynamics;
      const [a, b] = [dynamics?.joints['j_a'], dynamics?.joints['j_b']];
      if (dynamics === undefined || a === undefined || b === undefined) throw new Error('no joints');
      return {
        ...doc,
        dynamics: {
          ...dynamics,
          joints: { ...dynamics.joints, j_a: { ...a, initialVelocity: speed }, j_b: { ...b, initialVelocity: below } },
        },
      };
    };
    const moving = truthOf(execute(chain(2), 'check_motion_truth', { duration: 0.1, timestep: 2e-5 }));
    const warned = only(moving, 'DRV_STOP_INERTIA_VARIES', 'j_a');
    expect(warned.status).toBe('warn');
    expect(warned.ids).toContain('j_b');
    expect(warned.note).toMatch(/change its effective inertia with the configuration/);
    expect(warned.remediation).toMatch(/per-step rewrite not built/);
    // nothing moves at all: the stop is never touched and the joint below stays where it is
    const still = truthOf(execute(chain(0, 0), 'check_motion_truth', { duration: 0.1, timestep: 2e-5 }));
    expect(only(still, 'DRV_STOP_INERTIA_VARIES', 'j_a').status).toBe('pass');
  }, 300_000);
});

describe('study mechanics and reference series', () => {
  const bench = (): CadDocument => servoSizingDoc({ grade: 'B' });

  it('a first step whose half is below 5e-6 s cannot be refined: the study is not_run with the reason and the verdict is plausible', () => {
    const truth = truthOf(execute(bench(), 'check_motion_truth', { duration: 0.01, timestep: 8e-6 }));
    expect(truth.timestepS).toBe(8e-6);
    const study = only(truth, 'DRV_TIMESTEP_STUDY');
    expect(study.note).toMatch(/below the smallest step 0.000005 s/);
    expect(study.status).toBe('not_run');
    expect(truth.verdict).toBe('plausible');
  });

  it('a base simulation that refuses (controller period not a whole number of steps) gives not_run items with the quoted reason', () => {
    const truth = truthOf(execute(bench(), 'check_motion_truth', { duration: 0.1, timestep: 3e-4 }));
    expect(only(truth, 'DRV_LEDGER_CLOSURE').status).toBe('not_run');
    expect(only(truth, 'DRV_LEDGER_CLOSURE').note).toMatch(/DRV_CONTROL_RATE/);
    expect(truth.timestepS).toBeNull();
    expect(truth.verdict).toBe('plausible');
  });

  it('stored reference series: the model against its own run matches (the verdict can be trusted); a 30 % miss on a grade A reference is a fail and not_trusted', () => {
    const doc = bench();
    const run = execute(doc, 'simulate_motion', { duration: 0.3, timestep: 1e-4, sampleRate: 1000, detail: 'drives', energy: true });
    const series = (run.data as { drives: { m_re40: { series: DriveSeriesData } } }).drives.m_re40.series;
    const speed = seriesOf(run, 'jointVelocity', 'j_load');
    const add = (scale: number): CadDocument =>
      execute(doc, 'add_reference_data', {
        id: 'w',
        series: { quantity: 'joint_velocity', target: 'j_load', times: series.times, values: speed.map((value) => value * scale) },
        source: 'the model itself',
        grade: 'A',
      }).document;
    const match = truthOf(execute(add(1), 'check_motion_truth', { duration: 0.3, outputs: ['j_load.finalVelocity'] }));
    expect(only(match, 'DRV_REFERENCE_MATCH', 'w').status).toBe('pass');
    expect(match.verdict).toBe('trusted');
    const miss = truthOf(execute(add(1.3), 'check_motion_truth', { duration: 0.3, outputs: ['j_load.finalVelocity'] }));
    expect(only(miss, 'DRV_REFERENCE_MISMATCH', 'w').status).toBe('fail');
    expect(miss.verdict).toBe('not_trusted');
    // a reference that outlasts the run is simulated by itself
    const long = execute(doc, 'add_reference_data', {
      id: 'w',
      series: { quantity: 'joint_velocity', target: 'j_load', times: [0, 0.5], values: [0, 0] },
      source: 'x',
      grade: 'C',
    }).document;
    const outlasting = truthOf(execute(long, 'check_motion_truth', { duration: 0.1, outputs: ['j_load.finalVelocity'] }));
    expect(outlasting.items.filter((item) => item.code.startsWith('DRV_REFERENCE_') && item.ids.includes('w'))).toHaveLength(1);
  }, 300_000);

  it('refuses with the reason: unknown output key, no bodies, no physics engine', () => {
    const doc = bench();
    const unknown = execute(doc, 'check_motion_truth', { duration: 0.05, outputs: ['ghost.speed'] });
    expect(unknown.summary).toMatch(/unknown output\(s\) ghost\.speed; this model offers: .*j_load\.finalVelocity/);
    expect(unknown.document).toBe(doc);
    expect(errorOf(unknown)).toBeUndefined();
    expect(execute(runSteps([]).doc, 'check_motion_truth', {}).summary).toMatch(/no rigid bodies/);
    setPhysicsEngine(null);
    expect(execute(doc, 'check_motion_truth', {}).summary).toMatch(/no physics engine is loaded/);
  });

  it('rejects schema violations (level, engines, duration, timestep below the smallest step)', () => {
    const doc = bench();
    for (const params of [{ level: 'deep' }, { engines: ['mujoco'] }, { duration: 0 }, { timestep: 1e-7 }, { outputs: [] }])
      expect(execute(doc, 'check_motion_truth', params).summary, JSON.stringify(params)).toMatch(/rejected: invalid params/);
  });
});
