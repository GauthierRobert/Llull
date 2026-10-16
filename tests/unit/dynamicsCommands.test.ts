/**
 * Dynamics commands end to end: CAD geometry (mm) → mass properties → MuJoCo → report, checked against closed-form physics. Plus the
 * failure path of every command.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

/** Run a command that must succeed; returns the next document and the first affected id. */
function run(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.document === doc && result.affected.length === 0 && /no-op|rejected/.test(result.summary)) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

function simulate(doc: CadDocument, params: Record<string, unknown>): SimulationData {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as SimulationData;
}

/** A steel disc (r = 100 mm, h = 20 mm, axis Y) on a revolute joint about Y through its centre: I = m r² / 2. */
function discOnShaft(): { doc: CadDocument; joint: string; body: string; mass: number; inertia: number } {
  let doc = createEmptyDocument();
  const disc = run(doc, 'add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0], position: [0, 0, 500] });
  const body = run(disc.doc, 'add_rigid_body', { entityIds: [disc.id], name: 'flywheel' });
  const joint = run(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [0, 0, 500], axis: [0, 1, 0] });
  doc = joint.doc;
  const mass = 7850 * Math.PI * 0.1 * 0.1 * 0.02;
  return { doc, joint: joint.id, body: body.id, mass, inertia: (mass * 0.01) / 2 };
}

describe('simulate_motion — closed-form checks through the CAD model', () => {
  it('flywheel from CAD geometry under constant torque: ω(t) = τt/I, gravity has no effect on a centred wheel', () => {
    const { doc, joint, inertia } = discOnShaft();
    const motor = run(doc, 'add_motor', { joint, kind: 'torque_curve', torque: 3 });
    const data = simulate(motor.doc, { duration: 2, detail: 'series' });
    const result = data.joints[joint];
    expect(data.engine).toMatch(/^MuJoCo/);
    expect(Math.abs((result?.finalVelocity ?? 0) - (3 * 2) / inertia) / ((3 * 2) / inertia)).toBeLessThan(1e-6);
    expect(data.series?.times.length).toBe(101);
    expect(data.warnings.some((w) => w.includes('still accelerating'))).toBe(true);
  });

  it('propeller spin-up matches the exact solution ω(t) = ω∞·tanh(kω∞t/I), ω∞ = sqrt(τ/k), k = Cp·ρ·D⁵/(2π)³', () => {
    const { doc, joint, inertia } = discOnShaft();
    const [torque, cp, ct, rho, d] = [20, 0.05, 0.1, 1.225, 1.0];
    const motor = run(doc, 'add_motor', { joint, kind: 'torque_curve', torque });
    const prop = run(motor.doc, 'add_propeller', { joint, diameter: d, thrustCoefficient: ct, powerCoefficient: cp });
    const data = simulate(prop.doc, { duration: 3, detail: 'series', sampleRate: 10 });
    const k = (cp * rho * d ** 5) / (2 * Math.PI) ** 3;
    const terminal = Math.sqrt(torque / k);
    const times = data.series?.times ?? [];
    const speeds = data.series?.jointVelocity[joint] ?? [];
    times.forEach((t, i) =>
      expect(Math.abs((speeds[i] ?? 0) - terminal * Math.tanh((k * terminal * t) / inertia))).toBeLessThan(terminal * 1e-5),
    );
    const propeller = data.propellers[prop.id];
    // at the operating point the propeller absorbs the motor torque, and the thrust follows Ct·ρ·n²·D⁴
    const n = terminal / (2 * Math.PI);
    expect(propeller?.torque).toBeCloseTo(torque, 2);
    expect(propeller?.thrust).toBeCloseTo(ct * rho * n * n * d ** 4, 1);
    expect(data.joints[joint]?.steady).toBe(true);
  });

  it('converges at second order: halving the timestep quarters the error against the exact spin-up', () => {
    const { doc, joint, inertia } = discOnShaft();
    const motor = run(doc, 'add_motor', { joint, kind: 'torque_curve', torque: 20 });
    const prop = run(motor.doc, 'add_propeller', { joint, diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 });
    const k = (0.05 * 1.225) / (2 * Math.PI) ** 3;
    const terminal = Math.sqrt(20 / k);
    const worstError = (timestep: number): number => {
      const data = simulate(prop.doc, { duration: 1, timestep, detail: 'series', sampleRate: 10 });
      const speeds = data.series?.jointVelocity[joint] ?? [];
      return (data.series?.times ?? []).reduce(
        (worst, t, i) => Math.max(worst, Math.abs((speeds[i] ?? 0) - terminal * Math.tanh((k * terminal * t) / inertia))),
        0,
      );
    };
    const order = Math.log2(worstError(0.002) / worstError(0.001));
    expect(order).toBeGreaterThan(1.8);
    expect(order).toBeLessThan(2.2);
  });

  it('reduction gear: the prop runs at ratio × crank speed and absorbs crank torque / ratio at steady state', () => {
    let doc = createEmptyDocument();
    const crankDisc = run(doc, 'add_cylinder', { radius: 60, height: 40, axis: [0, 1, 0], position: [0, 0, 800] });
    const propDisc = run(crankDisc.doc, 'add_cylinder', { radius: 150, height: 15, axis: [0, 1, 0], position: [0, 200, 800] });
    const crank = run(propDisc.doc, 'add_rigid_body', { entityIds: [crankDisc.id], name: 'crank' });
    const propBody = run(crank.doc, 'add_rigid_body', { entityIds: [propDisc.id], name: 'prop', density: 600 });
    const crankJoint = run(propBody.doc, 'add_body_joint', { kind: 'revolute', child: crank.id, anchor: [0, 0, 800], axis: [0, 1, 0] });
    const propJoint = run(crankJoint.doc, 'add_body_joint', {
      kind: 'revolute',
      child: propBody.id,
      anchor: [0, 200, 800],
      axis: [0, 1, 0],
    });
    const ratio = 21 / 72;
    const gear = run(propJoint.doc, 'add_gear_coupling', { driver: crankJoint.id, driven: propJoint.id, ratio });
    const motor = run(gear.doc, 'add_motor', { joint: crankJoint.id, kind: 'torque_curve', torque: 40 });
    const prop = run(motor.doc, 'add_propeller', { joint: propJoint.id, diameter: 1.2, thrustCoefficient: 0.1, powerCoefficient: 0.05 });
    doc = prop.doc;
    const data = simulate(doc, { duration: 20 });
    const crankRpm = data.joints[crankJoint.id]?.finalRpm ?? 0;
    const propRpm = data.joints[propJoint.id]?.finalRpm ?? 0;
    expect(propRpm / crankRpm).toBeCloseTo(ratio, 4);
    expect(data.gears[gear.id]?.maxRatioError).toBeLessThan(1e-3);
    // power balance: τ_crank·ω_crank = Q_prop·ω_prop  →  Q_prop = τ / ratio
    expect(data.propellers[prop.id]?.torque ?? 0).toBeCloseTo(40 / ratio, 0);
    expect(data.motors[motor.id]?.power ?? 0).toBeCloseTo(data.propellers[prop.id]?.power ?? -1, -1);
    expect(data.warnings).toEqual([]);
  });

  it('flags propeller tips past Mach 0.85 and coefficients no real propeller reaches', () => {
    const { doc, joint } = discOnShaft();
    const motor = run(doc, 'add_motor', { joint, kind: 'speed', rpm: 6000, maxTorque: 5000 });
    const prop = run(motor.doc, 'add_propeller', { joint, diameter: 2, thrustCoefficient: 0.2, powerCoefficient: 0.02 });
    const data = simulate(prop.doc, { duration: 1 });
    const result = data.propellers[prop.id];
    expect(result?.tipMach).toBeCloseTo((6000 * (2 * Math.PI)) / 60 / 340.3, 1);
    expect(result?.figureOfMerit).toBeCloseTo(0.2 ** 1.5 / (0.02 * Math.sqrt(Math.PI / 2)), 9);
    expect(data.warnings.some((w) => w.includes('Mach'))).toBe(true);
    expect(data.warnings.some((w) => w.includes('figure of merit'))).toBe(true);
  });

  it('a speed motor holds its rpm (zero steady error) and supplies exactly the propeller torque', () => {
    const { doc, joint } = discOnShaft();
    const motor = run(doc, 'add_motor', { joint, kind: 'speed', rpm: 1500, maxTorque: 200 });
    const prop = run(motor.doc, 'add_propeller', { joint, diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 });
    const data = simulate(prop.doc, { duration: 2 });
    expect(Math.abs((data.joints[joint]?.finalRpm ?? 0) - 1500) / 1500).toBeLessThan(0.001);
    // the governor delivers exactly the propeller's drag torque at the held speed
    expect(data.motors[motor.id]?.torque ?? 0).toBeCloseTo(data.propellers[prop.id]?.torque ?? -1, 3);
  });

  it('a free body falls under gravity: z = -g t² / 2 (poses in document units)', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [100, 100, 100], position: [0, 0, 1000] });
    const body = run(box.doc, 'add_rigid_body', { entityIds: [box.id] });
    const data = simulate(body.doc, { duration: 1, detail: 'poses', sampleRate: 10 });
    const path = data.poses?.bodies[body.id]?.position ?? [];
    expect(path[path.length - 1]?.[2]).toBeCloseTo(1000 - (9.81 * 1000) / 2, 1);
    expect(data.poses?.bodies[body.id]?.orientation[0]).toEqual([1, 0, 0, 0]);
  });

  it('a fixed body never moves and set_gravity changes the fall', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [100, 100, 100], position: [0, 0, 1000] });
    const body = run(box.doc, 'add_rigid_body', { entityIds: [box.id], fixed: true });
    const moon = execute(body.doc, 'set_gravity', { gravity: [0, 0, -1.62] }).document;
    expect(moon.dynamics?.gravity).toEqual([0, 0, -1.62]);
    const data = simulate(moon, { duration: 1, detail: 'poses' });
    const path = data.poses?.bodies[body.id]?.position ?? [];
    expect(path[path.length - 1]?.[2]).toBeCloseTo(1000, 6);
  });
});

describe('dynamics commands — validation and bookkeeping', () => {
  it('add_rigid_body reports mass and rejects bad entities', () => {
    const disc = run(createEmptyDocument(), 'add_cylinder', { radius: 100, height: 20 });
    const ok = execute(disc.doc, 'add_rigid_body', { entityIds: [disc.id], massKg: 2 });
    expect(ok.summary).toMatch(/2\.000 kg/);
    expect(execute(disc.doc, 'add_rigid_body', { entityIds: ['nope'] }).summary).toMatch(/not found/);
    expect(execute(ok.document, 'add_rigid_body', { entityIds: [disc.id] }).summary).toMatch(/already belongs/);
    expect(execute(disc.doc, 'add_rigid_body', { entityIds: [disc.id, disc.id] }).summary).toMatch(/twice/);
    const arc = run(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 1 });
    expect(execute(arc.doc, 'add_rigid_body', { entityIds: [arc.id] }).summary).toMatch(/2D/);
    expect(execute(ok.document, 'add_rigid_body', { entityIds: [disc.id], id: ok.affected[0] }).affected).toEqual([]);
  });

  it('add_body_joint rejects unknown / fixed / doubly-jointed children, loops and zero axes', () => {
    const { doc, body, joint } = discOnShaft();
    const anchor = [0, 0, 0];
    expect(execute(doc, 'add_body_joint', { kind: 'revolute', child: 'x', anchor, axis: [0, 1, 0] }).summary).toMatch(/not found/);
    expect(execute(doc, 'add_body_joint', { kind: 'revolute', child: body, anchor, axis: [0, 1, 0] }).summary).toMatch(/already hangs/);
    const other = run(doc, 'add_box', { size: [10, 10, 10] });
    const fixed = run(other.doc, 'add_rigid_body', { entityIds: [other.id], fixed: true });
    expect(execute(fixed.doc, 'add_body_joint', { kind: 'revolute', child: fixed.id, anchor, axis: [0, 1, 0] }).summary).toMatch(/fixed/);
    const free = run(other.doc, 'add_rigid_body', { entityIds: [other.id] });
    expect(execute(free.doc, 'add_body_joint', { kind: 'revolute', child: free.id, anchor, axis: [0, 0, 0] }).summary).toMatch(/non-zero/);
    expect(
      execute(free.doc, 'add_body_joint', { kind: 'revolute', child: free.id, parent: 'zz', anchor, axis: [0, 0, 1] }).summary,
    ).toMatch(/not found/);
    const chained = run(free.doc, 'add_body_joint', {
      kind: 'prismatic',
      child: free.id,
      parent: body,
      anchor,
      axis: [0, 0, 1],
      initialVelocity: 1,
    });
    expect(chained.doc.dynamics?.joints[chained.id]?.initialVelocity).toBe(1);
    expect(execute(doc, 'add_body_joint', { kind: 'revolute', child: body, parent: body, anchor, axis: [0, 0, 1] }).summary).toMatch(
      /already hangs/,
    );
    expect(joint).toMatch(/^bjoint/);
  });

  it('add_gear_coupling rejects bad joints, ratios, double drives and circles', () => {
    const { doc, joint } = discOnShaft();
    const other = run(doc, 'add_box', { size: [10, 10, 10] });
    const body = run(other.doc, 'add_rigid_body', { entityIds: [other.id] });
    const second = run(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [0, 0, 0], axis: [0, 0, 1] });
    const d = second.doc;
    expect(execute(d, 'add_gear_coupling', { driver: 'x', driven: second.id, ratio: 1 }).summary).toMatch(/not found/);
    expect(execute(d, 'add_gear_coupling', { driver: joint, driven: 'x', ratio: 1 }).summary).toMatch(/not found/);
    expect(execute(d, 'add_gear_coupling', { driver: joint, driven: joint, ratio: 1 }).summary).toMatch(/itself/);
    expect(execute(d, 'add_gear_coupling', { driver: joint, driven: second.id, ratio: 0 }).summary).toMatch(/non-zero/);
    const geared = run(d, 'add_gear_coupling', { driver: joint, driven: second.id, ratio: 2 });
    expect(execute(geared.doc, 'add_gear_coupling', { driver: joint, driven: second.id, ratio: 3 }).summary).toMatch(/already driven/);
    expect(execute(geared.doc, 'add_gear_coupling', { driver: second.id, driven: joint, ratio: 3 }).summary).toMatch(/circular/);
  });

  it('add_motor and add_propeller validate their inputs', () => {
    const { doc, joint } = discOnShaft();
    expect(execute(doc, 'add_motor', { joint: 'x', kind: 'torque_curve', torque: 1 }).summary).toMatch(/not found/);
    expect(execute(doc, 'add_motor', { joint, kind: 'torque_curve' }).summary).toMatch(/needs `curve`/);
    expect(
      execute(doc, 'add_motor', {
        joint,
        kind: 'torque_curve',
        curve: [
          [100, 1],
          [50, 2],
        ],
      }).summary,
    ).toMatch(/increase/);
    expect(execute(doc, 'add_motor', { joint, kind: 'speed', rpm: 100 }).summary).toMatch(/maxTorque/);
    expect(
      execute(doc, 'add_motor', {
        joint,
        kind: 'torque_curve',
        curve: [
          [0, 10],
          [1000, 20],
        ],
        throttle: 0.5,
      }).summary,
    ).toMatch(/peak 20/);
    expect(execute(doc, 'add_propeller', { joint: 'x', diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 }).summary).toMatch(
      /not found/,
    );
    expect(
      execute(doc, 'add_propeller', { joint, diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05, thrustDirection: [0, 0, 0] })
        .summary,
    ).toMatch(/non-zero/);
    const slider = run(doc, 'add_box', { size: [10, 10, 10] });
    const body = run(slider.doc, 'add_rigid_body', { entityIds: [slider.id] });
    const prismatic = run(body.doc, 'add_body_joint', { kind: 'prismatic', child: body.id, anchor: [0, 0, 0], axis: [1, 0, 0] });
    expect(
      execute(prismatic.doc, 'add_propeller', { joint: prismatic.id, diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 }).summary,
    ).toMatch(/prismatic/);
    // motors speak rpm / N·m: a slide cannot take one
    expect(execute(prismatic.doc, 'add_motor', { joint: prismatic.id, kind: 'speed', rpm: 100, maxTorque: 5 }).summary).toMatch(
      /prismatic; motors .* drive revolute joints/,
    );
  });

  it('delete_dynamics_item cascades from a body to its joint and loads; commands are pure', () => {
    const { doc, body, joint } = discOnShaft();
    const motor = run(doc, 'add_motor', { joint, kind: 'torque_curve', torque: 1 });
    const before = JSON.stringify(motor.doc);
    const removed = execute(motor.doc, 'delete_dynamics_item', { id: body });
    expect(JSON.stringify(motor.doc)).toBe(before);
    expect(removed.summary).toMatch(/2 dependent/);
    expect(removed.document.dynamics?.joints).toEqual({});
    expect(removed.document.dynamics?.motors).toEqual({});
    expect(execute(motor.doc, 'delete_dynamics_item', { id: 'nothing' }).summary).toMatch(/no dynamics record/);
  });

  it('inspect_dynamics reports mass and inertia about the joint axis without an engine', () => {
    const { doc, inertia, mass } = discOnShaft();
    const data = execute(doc, 'inspect_dynamics', {}).data as { bodies: Record<string, { massKg: number; inertiaAboutJointAxis: number }> };
    const body = Object.values(data.bodies)[0];
    expect(body?.massKg).toBeCloseTo(mass, 9);
    expect(body?.inertiaAboutJointAxis).toBeCloseTo(inertia, 9);
    expect(execute(createEmptyDocument(), 'inspect_dynamics', {}).summary).toMatch(/not simulatable — no rigid bodies/);
  });

  it('inspect_dynamics lists fixed and free bodies (no joint axis) and the counts', () => {
    const { doc } = discOnShaft();
    const frame = run(doc, 'add_box', { size: [10, 10, 10], position: [0, 0, -100] });
    const fixed = run(frame.doc, 'add_rigid_body', { entityIds: [frame.id], fixed: true });
    const loose = run(fixed.doc, 'add_box', { size: [10, 10, 10], position: [500, 0, 0] });
    const free = run(loose.doc, 'add_rigid_body', { entityIds: [loose.id], name: 'loose' });
    const result = execute(free.doc, 'inspect_dynamics', {});
    const bodies = (
      result.data as {
        bodies: Record<string, { fixed: boolean; joint: string | null; inertiaAboutJointAxis: number | null; name: string | null }>;
      }
    ).bodies;
    expect(bodies[fixed.id]).toMatchObject({ fixed: true, joint: null, inertiaAboutJointAxis: null, name: null });
    expect(bodies[free.id]).toMatchObject({ fixed: false, joint: null, name: 'loose' });
    expect(result.summary).toMatch(/fixed.*1 joint\(s\), 0 gear\(s\), 0 motor\(s\), 0 propeller\(s\)/);
  });

  it('deleting a joint takes its gears and loads; deleting a lone motor removes only it', () => {
    const { doc, joint } = discOnShaft();
    const other = run(doc, 'add_box', { size: [10, 10, 10] });
    const body = run(other.doc, 'add_rigid_body', { entityIds: [other.id] });
    const second = run(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [0, 0, 0], axis: [0, 0, 1] });
    const gear = run(second.doc, 'add_gear_coupling', { driver: joint, driven: second.id, ratio: 2 });
    const motor = run(gear.doc, 'add_motor', { joint, kind: 'torque_curve', torque: 1 });
    const noJoint = execute(motor.doc, 'delete_dynamics_item', { id: second.id });
    expect(noJoint.document.dynamics?.gears).toEqual({});
    expect(noJoint.document.dynamics?.motors[motor.id]).toBeDefined();
    const noMotor = execute(motor.doc, 'delete_dynamics_item', { id: motor.id });
    expect(noMotor.summary).toBe(`delete_dynamics_item: removed '${motor.id}'.`);
  });

  it('initialRpm applies to revolute joints only; prismatic joints take initialVelocity (m/s)', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const body = run(box.doc, 'add_rigid_body', { entityIds: [box.id] });
    const slide = run(body.doc, 'add_body_joint', {
      kind: 'prismatic',
      child: body.id,
      anchor: [0, 0, 0],
      axis: [1, 0, 0],
      initialRpm: 600,
    });
    expect(slide.doc.dynamics?.joints[slide.id]?.initialVelocity).toBe(0);
    const { doc, body: wheel } = discOnShaft();
    const spun = execute(
      execute(doc, 'delete_dynamics_item', { id: Object.keys(doc.dynamics?.joints ?? {})[0] }).document,
      'add_body_joint',
      { kind: 'revolute', child: wheel, anchor: [0, 0, 500], axis: [0, 1, 0], initialRpm: 600 },
    );
    expect(Object.values(spun.document.dynamics?.joints ?? {})[0]?.initialVelocity).toBeCloseTo(20 * Math.PI, 12);
  });

  it('simulate_motion explains why it cannot run', () => {
    expect(execute(createEmptyDocument(), 'simulate_motion', {}).summary).toMatch(/no rigid bodies/);
    const { doc } = discOnShaft();
    expect(execute(doc, 'simulate_motion', { duration: 600, timestep: 0.00001 }).summary).toMatch(/steps/);
    setPhysicsEngine(null);
    try {
      expect(execute(doc, 'simulate_motion', {}).summary).toMatch(/no physics engine/);
    } finally {
      void createMujocoPhysics().then(setPhysicsEngine);
    }
  });
});
