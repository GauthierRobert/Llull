/** Force laws, document → simulation-model building and the report, below the commands. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createDynamicsModel, type DynamicsModel, type Motor, type PropellerLoad } from '@core/model/dynamics';
import { appliedLoadsFor, motorForce, propellerOutput, speedServoGains } from '@core/dynamics/forceLaws';
import { bodyMassProperties, buildSimulationModel } from '@core/dynamics/simulationModel';
import { setPhysicsEngine, type SimulationTrace } from '@core/dynamics/physicsEngine';
import { simulationData, simulationSummary, type SimulationData } from '@core/dynamics/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const RPM = (2 * Math.PI) / 60;
const engine = (curve: [number, number][], throttle = 1): Extract<Motor, { kind: 'torque_curve' }> => ({
  id: 'm',
  kind: 'torque_curve',
  joint: 'j',
  curve,
  throttle,
});
const propeller: PropellerLoad = {
  id: 'p',
  joint: 'j',
  diameter: 2,
  thrustCoefficient: 0.1,
  powerCoefficient: 0.05,
  airDensity: 1.225,
  thrustDirection: [0, 2, 0],
};

describe('force laws', () => {
  it('interpolates a torque curve linearly and holds its end values', () => {
    const curve: [number, number][] = [
      [1000, 100],
      [2000, 200],
      [3000, 150],
    ];
    expect(motorForce(engine(curve), 500 * RPM)).toBe(100);
    expect(motorForce(engine(curve), 1500 * RPM)).toBeCloseTo(150, 9);
    expect(motorForce(engine(curve), 2500 * RPM)).toBeCloseTo(175, 9);
    expect(motorForce(engine(curve), 4000 * RPM)).toBe(150);
    expect(motorForce(engine(curve, 0.5), 1500 * RPM)).toBeCloseTo(75, 9);
    expect(motorForce(engine([]), 100)).toBe(0);
  });

  it('a propeller absorbs P = Cp·ρ·n³·D⁵ in either rotation direction', () => {
    const forward = propellerOutput(propeller, 20 * 2 * Math.PI);
    expect(forward.power).toBeCloseTo(0.05 * 1.225 * 8000 * 32, 6);
    expect(forward.thrust).toBeCloseTo(0.1 * 1.225 * 400 * 16, 9);
    expect(propellerOutput(propeller, -20 * 2 * Math.PI)).toEqual(forward);
  });

  it('loads: torque against the rotation, thrust along the unit direction on the spinning body', () => {
    const loads = appliedLoadsFor([engine([[0, 10]])], [propeller, { ...propeller, id: 'q', joint: 'unbodied' }], { j: 'rotor' })({
      time: 0,
      jointPosition: {},
      jointVelocity: { j: 40 * Math.PI, unbodied: -1 },
    });
    expect(loads.jointForces['j']).toBeCloseTo(10 - propellerOutput(propeller, 40 * Math.PI).torque, 9);
    expect(loads.jointForces['unbodied']).toBeGreaterThan(0);
    expect(loads.bodyForces['rotor']?.[1]).toBeCloseTo(propellerOutput(propeller, 40 * Math.PI).thrust, 9);
    const still = appliedLoadsFor([], [{ ...propeller, thrustDirection: [0, 0, 0] }], { j: 'rotor' })({
      time: 0,
      jointPosition: {},
      jointVelocity: {},
    });
    expect(still.bodyForces['rotor']).toEqual([0, 0, 0]);
  });

  it('speed-governor gains scale with the driven inertia (critically damped at 1/(8·dt))', () => {
    const { stiffness, damping } = speedServoGains(2, 0.001);
    expect(stiffness).toBeCloseTo(2 * 125 ** 2, 9);
    expect(damping).toBeCloseTo(2 * 2 * 125, 9);
  });
});

/** A document with two discs and the given dynamics model (raw: lets the tests build states the commands refuse). */
function rawDocument(dynamics: (ids: { a: string; b: string }) => DynamicsModel): CadDocument {
  let doc = createEmptyDocument();
  const a = execute(doc, 'add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0] });
  doc = a.document;
  const b = execute(doc, 'add_cylinder', { radius: 50, height: 20, axis: [0, 1, 0], position: [300, 0, 0] });
  doc = b.document;
  return { ...doc, dynamics: dynamics({ a: a.affected[0] ?? '', b: b.affected[0] ?? '' }) };
}

const joint = (id: string, child: string, parent = 'ground', initialVelocity = 0): DynamicsModel['joints'][string] => ({
  id,
  kind: 'revolute',
  parent,
  child,
  anchor: [0, 0, 0],
  axis: [0, 1, 0],
  damping: 0,
  friction: 0,
  initialVelocity,
});

describe('simulation model', () => {
  it('starts a driven joint at ratio × its driver speed through a gear chain', () => {
    const doc = rawDocument(({ a, b }) => ({
      ...createDynamicsModel(),
      bodies: { A: { id: 'A', entityIds: [a], fixed: false }, B: { id: 'B', entityIds: [b], fixed: false } },
      joints: { ja: joint('ja', 'A', 'ground', 10), jb: joint('jb', 'B') },
      gears: { g: { id: 'g', driver: 'ja', driven: 'jb', ratio: -2 } },
    }));
    const built = buildSimulationModel(doc, 0.001);
    if ('error' in built) throw new Error(built.error);
    expect(built.model.bodies.find((body) => body.id === 'B')?.joint?.initialVelocity).toBe(-20);
  });

  it('builds joint loops, reports references to immovable joints, and entities without volume', () => {
    const loop = rawDocument(({ a, b }) => ({
      ...createDynamicsModel(),
      bodies: { A: { id: 'A', entityIds: [a], fixed: false }, B: { id: 'B', entityIds: [b], fixed: false } },
      joints: { ja: joint('ja', 'A', 'B'), jb: joint('jb', 'B', 'A') },
    }));
    const built = buildSimulationModel(loop, 0.001);
    expect('model' in built ? built.model.loops.map((l) => l.id) : built).toEqual(['jb']);
    const fixedDriven = rawDocument(({ a }) => ({
      ...createDynamicsModel(),
      bodies: { A: { id: 'A', entityIds: [a], fixed: true } },
      joints: { ja: joint('ja', 'A') },
      motors: { m: { ...engine([[0, 1]]), joint: 'ja' } },
    }));
    expect(buildSimulationModel(fixedDriven, 0.001)).toEqual({ error: expect.stringMatching(/'m' acts on joint 'ja', which cannot move/) });
    const fixedGear = rawDocument(({ a, b }) => ({
      ...createDynamicsModel(),
      bodies: { A: { id: 'A', entityIds: [a], fixed: true }, B: { id: 'B', entityIds: [b], fixed: false } },
      joints: { ja: joint('ja', 'A'), jb: joint('jb', 'B') },
      gears: { g: { id: 'g', driver: 'ja', driven: 'jb', ratio: 1 } },
    }));
    expect(buildSimulationModel(fixedGear, 0.001)).toEqual({ error: expect.stringMatching(/gear 'g' uses joint 'ja'/) });
    const arc = execute(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 1 });
    const flat = {
      ...arc.document,
      dynamics: { ...createDynamicsModel(), bodies: { A: { id: 'A', entityIds: [arc.affected[0] ?? ''], fixed: false } } },
    };
    expect(buildSimulationModel(flat, 0.001)).toEqual({ error: expect.stringMatching(/has no solid volume/) });
  });

  it('uses an assigned material density (g per unit³), else the body density, and scales to massKg', () => {
    let doc = createEmptyDocument();
    const disc = execute(doc, 'add_cylinder', { radius: 100, height: 20 });
    doc = execute(disc.document, 'create_material', {
      name: 'alu',
      density: 0.0027,
      color: '#cccccc',
      metalness: 1,
      roughness: 0.4,
    }).document;
    doc = execute(doc, 'assign_material', { entityIds: [disc.affected[0]], materialName: 'alu' }).document;
    const volume = Math.PI * 0.1 * 0.1 * 0.02;
    const body = { id: 'A', entityIds: [disc.affected[0] ?? ''], fixed: false, density: 99999 };
    expect(doc.entities[disc.affected[0] ?? '']?.materialId).toBe('alu');
    const props = bodyMassProperties(doc, body);
    if ('error' in props) throw new Error(props.error);
    // the material (2.7 g/cm³ aluminium) wins over the body density
    expect(props.mass).toBeCloseTo(2700 * volume, 6);
    const bare = bodyMassProperties(disc.document, body);
    if ('error' in bare) throw new Error(bare.error);
    expect(bare.mass).toBeCloseTo(99999 * volume, 3);
    const scaled = bodyMassProperties(doc, { ...body, massKg: 1 });
    if ('error' in scaled) throw new Error(scaled.error);
    expect(scaled.mass).toBeCloseTo(1, 12);
    expect(scaled.inertia[2] / props.inertia[2]).toBeCloseTo(1 / props.mass, 9);
  });

  it('component instances contribute their baked solids', () => {
    let doc = createEmptyDocument();
    const box = execute(doc, 'add_box', { size: [100, 100, 100] });
    doc = execute(box.document, 'create_component', { name: 'cube', entityIds: [box.affected[0]] }).document;
    const instance = execute(doc, 'insert_instance', { componentId: Object.keys(doc.components)[0] });
    const props = bodyMassProperties(instance.document, { id: 'A', entityIds: [instance.affected[0] ?? ''], fixed: false });
    if ('error' in props) throw new Error(props.error);
    expect(props.mass).toBeCloseTo(7850 * 0.001, 9);
  });
});

describe('report', () => {
  it('reports a prismatic joint in m/s and a free fall that never settles', () => {
    let doc = createEmptyDocument();
    const box = execute(doc, 'add_box', { size: [100, 100, 100], position: [0, 0, 1000] });
    doc = execute(box.document, 'add_rigid_body', { entityIds: [box.affected[0]], id: 'slider' }).document;
    doc = execute(doc, 'add_body_joint', {
      id: 'rail',
      kind: 'prismatic',
      child: 'slider',
      anchor: [0, 0, 1000],
      axis: [0, 0, 1],
    }).document;
    const result = execute(doc, 'simulate_motion', { duration: 1, detail: 'series' });
    const data = result.data as SimulationData;
    expect(data.joints['rail']?.kind).toBe('prismatic');
    expect(data.joints['rail']?.finalRpm).toBeUndefined();
    expect(data.joints['rail']?.finalVelocity).toBeCloseTo(-9.81, 6);
    expect(data.joints['rail']?.settledAfter).toBeNull();
    expect(result.summary).toMatch(/Joint rail: -9\.81\d* m\/s \(not yet steady\)/);
    expect(data.poses).toBeUndefined();
  });
});

describe('report on a hand-built trace', () => {
  const dynamics: DynamicsModel = {
    ...createDynamicsModel(),
    bodies: { A: { id: 'A', name: 'crank', entityIds: ['x'], fixed: false }, B: { id: 'B', entityIds: ['y'], fixed: false } },
    joints: { ja: joint('ja', 'A'), jb: joint('jb', 'B') },
    gears: { g: { id: 'g', driver: 'ja', driven: 'jb', ratio: 0.5 } },
    motors: { gov: { id: 'gov', kind: 'speed', joint: 'ja', rpm: 100, maxTorque: 10 } },
    propellers: { idle: { ...propeller, id: 'idle', joint: 'jb', powerCoefficient: 0 } },
  };
  const mass = {
    A: { mass: 2, centerOfMass: [1, 0, 0] as [number, number, number], inertia: [1, 1, 1, 0, 0, 0] as const },
    B: { mass: 1, centerOfMass: [0, 0, 0] as [number, number, number], inertia: [1, 1, 1, 0, 0, 0] as const },
  };
  const times = Array.from({ length: 21 }, (_, i) => i * 0.1);
  const trace = (driven: (t: number) => number, driver: (t: number) => number = () => 10): SimulationTrace => ({
    times,
    jointPosition: { ja: times.map(() => 0), jb: times.map(() => 0) },
    jointVelocity: { ja: times.map(driver), jb: times.map(driven) },
    bodyPosition: { A: times.map((): [number, number, number] => [1, 0, 0]) },
    bodyOrientation: { A: times.map((): [number, number, number, number] => [1, 0, 0, 0]) },
    servoForce: { gov: times.map(() => 3) },
  });
  const run = { engine: 'test', duration: 2, timestep: 0.001, metresPerUnit: 0.001 };

  it('flags a gear that slips late in the run, reports the governor torque and a body in document units', () => {
    const data = simulationData(
      dynamics,
      mass,
      trace((t) => (t > 1.5 ? 6 : 5)),
      { ...run, detail: 'poses' },
    );
    expect(data.warnings.some((w) => /gear 'g' deviated .* at t = 1\.600 s — the coupled inertias/.test(w))).toBe(true);
    expect(data.motors['gov']).toEqual({ joint: 'ja', torque: 3, power: 30 });
    expect(data.bodies['A']).toEqual({ name: 'crank', massKg: 2, centerOfMass: [1000, 0, 0] });
    expect(data.bodies['B']).toEqual({ massKg: 1, centerOfMass: [0, 0, 0] });
    expect(data.propellers['idle']?.figureOfMerit).toBeNull();
    expect(data.poses?.bodies['A']?.position[0]).toEqual([1000, 0, 0]);
    expect(simulationSummary(data)).toMatch(/Motor gov: 3 N·m, 0\.03 kW.*Gear g: ratio 0\.5 held within 20 %/);
  });

  it('calls an early slip a start transient and leaves the ratio unmeasured for a stopped driver', () => {
    const early = simulationData(
      dynamics,
      mass,
      trace((t) => (t < 0.15 ? 6 : 5)),
      { ...run, detail: 'summary' },
    );
    expect(early.warnings.some((w) => w.includes('start transient'))).toBe(true);
    const stopped = simulationData(
      dynamics,
      mass,
      trace(
        () => 0,
        () => 0,
      ),
      { ...run, detail: 'summary' },
    );
    expect(stopped.gears['g']).toEqual({ ratio: 0.5, measuredRatio: null, maxRatioError: 0 });
    expect(stopped.warnings).toEqual([]);
  });
});
