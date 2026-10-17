/** Multibody-dynamics audit fixes: redundant-constraint reactions, governor start, peaks, timestep, friction, summaries, plot. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine, type PhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { lightFourBarActions, nonGrashofFourBarActions } from './lightFourBarFixture';
import { sliderCrank } from './sliderCrankFixture';

let engineForTests: PhysicsEngine | null = null;
beforeAll(async () => {
  engineForTests = await createMujocoPhysics();
  setPhysicsEngine(engineForTests);
});
afterAll(() => setPhysicsEngine(null));

type Data = SimulationData & {
  samples: number;
  reactions?: { joints: Record<string, { forceN: { value: number } }>; loops: Record<string, { forceN: { value: number } }> };
};

function simulate(doc: CadDocument, params: Record<string, unknown>): Data {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Data;
}

function build(actions: readonly Record<string, unknown>[]): CadDocument {
  return execute(createEmptyDocument(), 'build_project', { actions }).document;
}

const withMotor = (doc: CadDocument, rpm: number): CadDocument =>
  execute(doc, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm, maxTorque: 1e5 }).document;

describe('redundant loop constraints carry no reaction (audit 1)', () => {
  it('a crank off the rod plane gives the same peak reactions as the planar one, not a 1 MN spike', () => {
    const run = (crankZMm: number): Data => {
      const { doc } = sliderCrank({ crankRpm: 3000, crankZMm, crankInertia: 0.05 });
      return simulate(withMotor(doc, 3000), { duration: 0.1 });
    };
    const [flat, lifted] = [run(0), run(-20)];
    const peak = (d: Data): number => d.reactions?.loops['wrist_j']?.forceN.value ?? 0;
    expect(peak(flat)).toBeGreaterThan(100);
    expect(peak(lifted)).toBeLessThan(2 * peak(flat));
    expect(lifted.reactions?.joints['crank_j']?.forceN.value ?? 0).toBeLessThan(
      10 * (flat.reactions?.joints['crank_j']?.forceN.value ?? 1),
    );
  });
});

describe('speed governor starts without a transient (audit 2)', () => {
  it('initialRpm = motor rpm keeps the crank at speed from the first sample', () => {
    const { doc } = sliderCrank({ crankRpm: 3000 });
    const data = simulate(withMotor(doc, 3000), { duration: 0.02, detail: 'series', sampleRate: 5000 });
    const speeds = data.series?.jointVelocity['crank_j'] ?? [];
    const target = (3000 * 2 * Math.PI) / 60;
    expect(speeds.length).toBeGreaterThan(50);
    for (const speed of speeds.slice(1)) expect(Math.abs(speed - target) / target).toBeLessThan(0.05);
  });
});

describe('reaction peaks cover every integration step (audit 3)', () => {
  it('the peak does not depend on the sample rate', () => {
    const { doc } = sliderCrank({ crankRpm: 3000, startDeg: 45 });
    const motor = withMotor(doc, 3000);
    const peak = (sampleRate: number): number =>
      simulate(motor, { duration: 0.1, sampleRate, crankAxis: 'crank_j' }).reactions?.loops['wrist_j']?.forceN.value ?? 0;
    const [coarse, fine] = [peak(37), peak(20000)];
    expect(fine).toBeGreaterThan(100);
    expect(coarse).toBeGreaterThanOrEqual(fine * 0.98);
    expect(coarse).toBeLessThanOrEqual(fine * 1.02);
  });
});

describe('auto timestep recovers a light slow loop (audit 4)', () => {
  it('halves the step until the four-bar loop residual passes, and says so', () => {
    const data = simulate(build(lightFourBarActions), { duration: 1 }) as Data & {
      loops: { tier: string; residualM: number; solver: { timestepS: number; timestepBasis: string } };
    };
    expect(data.loops.tier).not.toBe('fail');
    expect(data.loops.solver.timestepS).toBeLessThan(0.001);
    expect(data.loops.solver.timestepBasis).toMatch(/halved/);
    expect(data.warnings.some((w) => /halved/.test(w))).toBe(true);
  });

  it('an explicit timestep is never changed', () => {
    const data = simulate(build(lightFourBarActions), { duration: 0.05, timestep: 0.001 }) as Data & {
      loops: { solver: { timestepS: number } };
    };
    expect(data.loops.solver.timestepS).toBe(0.001);
  });
});

const incline = (friction: number): CadDocument =>
  build([
    { command: 'add_box', params: { size: [100, 100, 100], position: [0, 0, 0] }, as: 'blk' },
    { command: 'add_rigid_body', params: { id: 'blk', entityIds: ['$blk'], density: 1000 } },
    {
      command: 'add_body_joint',
      params: { id: 'slide', kind: 'prismatic', child: 'blk', anchor: [0, 0, 0], axis: [0.8660254, 0, -0.5], friction },
    },
  ]);

describe('dry friction sticks (audit 5)', () => {
  it('10 N of friction holds a 4.9 N pull: creep below 1e-5 m/s', () => {
    const data = simulate(incline(10), { duration: 2 });
    expect(Math.abs(data.joints['slide']?.finalVelocity ?? 1)).toBeLessThan(1e-5);
    expect(Math.abs(data.joints['slide']?.finalPosition ?? 1)).toBeLessThan(1e-4);
  });

  it('2 N of friction against the same pull slides with a = (4.905 - 2) / 1 kg', () => {
    const data = simulate(incline(2), { duration: 1 });
    expect(data.joints['slide']?.finalVelocity ?? 0).toBeCloseTo(4.905 - 2, 1);
  });
});

const swingArm: Record<string, unknown>[] = [
  { command: 'add_box', params: { size: [60, 60, 20], position: [0, 0, 10] }, as: 'baseB' },
  { command: 'create_component', params: { name: 'Base', entityIds: ['$baseB'], componentId: 'base' }, as: 'base1' },
  { command: 'add_box', params: { size: [200, 20, 10], position: [100, 0, 25] }, as: 'armB' },
  { command: 'create_component', params: { name: 'Arm', entityIds: ['$armB'], componentId: 'arm' }, as: 'arm1' },
  { command: 'add_box', params: { size: [20, 20, 40], position: [0, 150, 25] }, as: 'stopB' },
  { command: 'create_component', params: { name: 'Stop', entityIds: ['$stopB'], componentId: 'stop' }, as: 'stop1' },
  { command: 'add_joint', params: { id: 'hinge', kind: 'revolute', a: { instanceId: '$base1' }, b: { instanceId: '$arm1' }, axis: 'z' } },
];

describe('motion_study interference uses rotation and tolerates contact (audit 6)', () => {
  const study = (): {
    interferences: { stepIndex: number; instanceIdA: string; instanceIdB: string }[];
    summary: { framesWithInterference: number };
  } => {
    const doc = build(swingArm);
    const result = execute(doc, 'motion_study', {
      mode: 'joint',
      target: 'hinge',
      start: 0,
      end: Math.PI / 2,
      steps: 10,
      interferenceCheck: true,
    });
    return result.data as ReturnType<typeof study>;
  };

  it('flags the arm sweeping into the stop only in the late frames, never the resting base/arm contact', () => {
    const data = study();
    const frames = [...new Set(data.interferences.map((pair) => pair.stepIndex))];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).not.toContain(0);
    expect(Math.min(...frames)).toBeGreaterThanOrEqual(4);
    expect(frames).toContain(9);
    expect(data.summary.framesWithInterference).toBe(frames.length);
  });
});

describe('inspect_dynamics on a prismatic joint (audit 8)', () => {
  it('reports the translating mass, not a moment of inertia', () => {
    const result = execute(incline(0), 'inspect_dynamics', {});
    const body = (result.data as { bodies: Record<string, { inertiaAboutJointAxis: number | null; translatingMassKg: number | null }> })
      .bodies['blk'];
    expect(body?.inertiaAboutJointAxis).toBeNull();
    expect(body?.translatingMassKg).toBeCloseTo(1, 6);
    expect(result.summary).toMatch(/translating mass 1\.000 kg along joint slide/);
    expect(result.summary).not.toMatch(/kg·m²/);
  });

  it('keeps the moment of inertia for a revolute joint', () => {
    const { doc } = sliderCrank();
    const body = (execute(doc, 'inspect_dynamics', {}).data as { bodies: Record<string, { inertiaAboutJointAxis: number | null }> }).bodies[
      'crank'
    ];
    expect(body?.inertiaAboutJointAxis ?? 0).toBeGreaterThan(0);
  });
});

describe('summaries tell periodic motion from a transient (audit 7, 9)', () => {
  const pendulum = (): CadDocument =>
    build([
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'add_sphere', params: { radius: 10, position: [1000, 0, 0] }, as: 'bob' },
      { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'], name: 'bob' } },
      { command: 'add_body_joint', params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0] } },
    ]);

  it('a swinging pendulum is periodic with its period, not "still accelerating"', () => {
    const result = execute(pendulum(), 'simulate_motion', { duration: 12 });
    const joint = (result.data as Data).joints['pivot'];
    expect(joint?.periodic).toBe(true);
    expect(joint?.periodS ?? 0).toBeGreaterThan(1.5);
    expect(joint?.periodS ?? 0).toBeLessThan(2.6);
    expect(result.summary).toMatch(/Joint pivot: periodic, period \d\.\d+ s/);
    expect(result.summary).not.toMatch(/not yet steady|still accelerating/);
  });

  it('a steady joint is not periodic and a one-way acceleration still warns', () => {
    const { doc } = sliderCrank({ crankRpm: 3000 });
    const steady = (execute(withMotor(doc, 3000), 'simulate_motion', { duration: 0.3 }).data as Data).joints['crank_j'];
    expect(steady?.periodic).toBeUndefined();
    const fall = build([
      { command: 'add_box', params: { size: [10, 10, 10], position: [0, 0, 0] }, as: 'b' },
      { command: 'add_rigid_body', params: { id: 'b', entityIds: ['$b'] } },
      { command: 'add_body_joint', params: { id: 'rail', kind: 'prismatic', child: 'b', anchor: [0, 0, 0], axis: [0, 0, -1] } },
    ]);
    const result = execute(fall, 'simulate_motion', { duration: 1 });
    expect((result.data as Data).joints['rail']?.periodic).toBeUndefined();
    expect(result.summary).toMatch(/still accelerating/);
  });

  it('the motor line is the cycle mean over the torque period, with the end value beside it', () => {
    const { doc } = sliderCrank({ crankRpm: 3000 });
    const result = execute(withMotor(doc, 3000), 'simulate_motion', { duration: 0.3, sampleRate: 1000, reactions: 'off' });
    const motor = Object.values((result.data as Data).motors)[0];
    expect(motor?.periodS ?? 0).toBeCloseTo(0.02, 3);
    expect(Number.isFinite(motor?.cycleMeanTorque)).toBe(true);
    expect(Number.isFinite(motor?.cycleMeanPower)).toBe(true);
    expect(result.summary).toMatch(/Motor [^:]+: cycle-mean -?[\d.,]+ N·m, -?[\d.,]+ kW \(period 0\.0\d+ s; at the end/);
  });

  it('a free body reports its final position and velocity', () => {
    const fall = build([
      { command: 'add_box', params: { size: [100, 50, 20], position: [0, 0, 1000] }, as: 'blk' },
      { command: 'add_rigid_body', params: { id: 'blk', entityIds: ['$blk'], density: 2700 } },
    ]);
    const result = execute(fall, 'simulate_motion', { duration: 0.5 });
    const body = (result.data as Data).freeBodies?.['blk'];
    expect(body?.finalVelocity[2] ?? 0).toBeCloseTo(-9.81 * 0.5, 1);
    expect(body?.finalPosition[2] ?? 0).toBeCloseTo(1000 - 0.5 * 9.81 * 0.25 * 1000, -1);
    expect(result.summary).toMatch(/Body blk: free, ends at \[0, 0, -?[\d.,]+\] with velocity \[0, 0, -4\.9/);
  });

  it('a non-Grashof four-bar stalls at a toggle: the motor sits at its limit and the run warns', () => {
    const result = execute(build(nonGrashofFourBarActions), 'simulate_motion', { duration: 3 });
    expect((result.data as Data).warnings.some((w) => /toggle \/ lock-up detected/.test(w))).toBe(true);
  });

  it('a Grashof four-bar that turns at its target speed raises no lock-up warning', () => {
    const result = execute(build(lightFourBarActions), 'simulate_motion', { duration: 1 });
    expect((result.data as Data).warnings.some((w) => /lock-up/.test(w))).toBe(false);
  });

  it('says when sampleRate is capped at 6001 samples', () => {
    const result = execute(pendulum(), 'simulate_motion', { duration: 10, sampleRate: 2000, timestep: 0.001 });
    const data = result.data as Data;
    expect(data.samples).toBeLessThanOrEqual(6001);
    expect(data.samples).toBeGreaterThan(4000);
    expect(data.warnings.some((w) => /sampleRate 2000 Hz was reduced to/.test(w))).toBe(true);
    const fine = execute(pendulum(), 'simulate_motion', { duration: 1, sampleRate: 100 }).data as Data;
    expect(fine.warnings.some((w) => /sampleRate/.test(w))).toBe(false);
  });
});

describe('plot_simulation draws the motion as SVG (audit 10)', () => {
  const crank = (): CadDocument => withMotor(sliderCrank({ crankRpm: 600 }).doc, 600);

  it('is pure: the document is returned unchanged and nothing is affected', () => {
    const doc = crank();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'plot_simulation', { duration: 0.05 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('returns an svg with axes, units, legend, title and one polyline per series', () => {
    const result = execute(crank(), 'plot_simulation', {
      quantities: ['joint_velocity', 'joint_angle', 'motor_torque', 'motor_power'],
      duration: 0.2,
      title: 'Slider-crank <test>',
    });
    const data = result.data as {
      svg: string;
      width: number;
      height: number;
      panels: { title: string; unit: string; series: { label: string }[] }[];
    };
    expect(result.affected).toEqual([]);
    expect(result.document).toEqual(crank());
    expect(data.svg.startsWith('<svg')).toBe(true);
    expect(data.svg).toContain('Slider-crank &lt;test&gt;');
    expect(data.svg).toContain('time (s)');
    for (const unit of ['rpm', 'deg', 'm/s', 'N·m', 'kW']) expect(data.svg).toContain(unit);
    expect(data.svg).toContain('crank_j');
    expect((data.svg.match(/<polyline/g) ?? []).length).toBe(data.panels.reduce((n, p) => n + p.series.length, 0));
    expect(data.width).toBe(900);
    expect(data.panels.map((p) => p.unit)).toEqual(expect.arrayContaining(['rpm', 'deg', 'N·m', 'kW']));
    expect(result.summary).toMatch(/^plot_simulation: \d+ panel\(s\), \d+ samples over 0\.2 s\./);
  });

  it('plots reaction forces of joints and loops, and restricts series with `joints`', () => {
    const result = execute(crank(), 'plot_simulation', { quantities: ['reaction_force'], joints: ['wrist_j', 'crank_j'], duration: 0.05 });
    const data = result.data as { panels: { series: { label: string }[] }[] };
    expect(data.panels[0]?.series.map((s) => s.label).sort()).toEqual(['crank_j (joint)', 'wrist_j (loop)']);
  });

  it('is a no-op for an unknown joint, a quantity with nothing to draw, and a missing engine', () => {
    const doc = crank();
    for (const params of [{ joints: ['ghost'] }, { quantities: ['reaction_force'], joints: ['motor-1'], duration: 0.02 }]) {
      const result = execute(doc, 'plot_simulation', params);
      expect(result.data).toBeUndefined();
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
    const noMotor = sliderCrank({ crankRpm: 600 }).doc;
    expect(execute(noMotor, 'plot_simulation', { quantities: ['motor_torque'], duration: 0.02 }).summary).toMatch(/nothing to plot/);
    setPhysicsEngine(null);
    try {
      expect(execute(doc, 'plot_simulation', {}).summary).toMatch(/no physics engine/);
    } finally {
      setPhysicsEngine(engineForTests);
    }
  });
});
