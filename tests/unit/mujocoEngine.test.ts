/**
 * A cylinder-driven slider-crank on MuJoCo: cycle-energy closure (VC-FPR-14), gear ratio (VC-FPR-16), flywheel speed ripple (VC-FPR-17),
 * derived bearing loads against the analytic peaks, loop residual (VC-FPR-13), sampling and run-length warnings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import type { EngineData } from '@core/dynamics/engineReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank } from './sliderCrankFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

type EngineRun = SimulationData & {
  reactions?: { quality: string };
  engineReport?: EngineData;
  loops?: { tier: string; residualM: number; solver: { timestepS: number } };
};

const BORE_MM = 84;
const AREA = (Math.PI * (BORE_MM / 1000) ** 2) / 4;
const R = 0.0305;
const L = 0.13;

const wiebe = (imepBar: number): Record<string, unknown> => ({
  kind: 'wiebe',
  startDeg: -15,
  durationDeg: 50,
  a: 5,
  m: 2,
  compressionIndex: 1.32,
  expansionIndex: 1.28,
  intakePressurePa: 95000,
  heat: { kind: 'target_imep_Pa', value: imepBar * 1e5 },
  source: 'test input',
});

function engine(options: {
  rpm: number;
  crankInertia: number;
  pistonKg?: number;
  rodKg?: number;
  imepBar?: number;
  model?: Record<string, unknown>;
}): { doc: CadDocument; cylinder: string } {
  const { doc } = sliderCrank({
    rMm: R * 1000,
    lMm: L * 1000,
    crankRpm: options.rpm,
    crankInertia: options.crankInertia,
    pistonKg: options.pistonKg ?? 0.4,
    rodKg: options.rodKg ?? 0.4,
    startDeg: 25,
  });
  const added = execute(doc, 'add_cylinder_pressure', {
    piston: 'slide_j',
    crank: 'crank_j',
    boreMm: BORE_MM,
    compressionRatio: 10.8,
    model: options.model ?? wiebe(options.imepBar ?? 10),
  });
  if (added.affected.length === 0) throw new Error(added.summary);
  const weightless = execute(added.document, 'set_gravity', { gravity: [0, 0, 0] }).document;
  return { doc: weightless, cylinder: added.affected[0] ?? '' };
}

const governed = (doc: CadDocument, rpm: number): CadDocument =>
  execute(doc, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm, maxTorque: 1e6 }).document;

function run(doc: CadDocument, params: Record<string, unknown>): EngineRun {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  expect(result.document).toBe(doc);
  return result.data as EngineRun;
}

describe('engine run at a governed speed', () => {
  const imepBar = 10;
  const { doc } = engine({ rpm: 2000, crankInertia: 0.2, imepBar });
  let data: EngineRun;
  let report: EngineData | undefined;
  beforeAll(() => {
    data = run(governed(doc, 2000), { duration: 0.2, detail: 'series', reactions: 'peaks' });
    report = data.engineReport;
  });

  it('closes the cycle energy within the 0.5 % gate (VC-FPR-14) and reports IMEP, mean torque and power', () => {
    expect(report?.energyClosure?.status).toBe('pass');
    expect(report?.energyClosure?.ratio ?? 1).toBeLessThan(0.005);
    const displacement = AREA * 2 * R;
    const expectedTorque = (imepBar * 1e5 * displacement) / (4 * Math.PI);
    expect(report?.cylinders[0]?.imepBar).toBeCloseTo(imepBar, 6);
    expect(Math.abs((report?.meanTorqueNm ?? 0) - expectedTorque) / expectedTorque).toBeLessThan(2e-3);
    expect(report?.lastCycle?.meanRpm ?? 0).toBeCloseTo(2000, -1);
    expect(report?.indicatedPowerKW ?? 0).toBeCloseTo(((report?.meanTorqueNm ?? 0) * 2000 * 2 * Math.PI) / 60 / 1000, 6);
    expect(report?.cylinders[0]?.peakPressureBar ?? 0).toBeGreaterThan(30);
    expect(report?.torqueCurve?.angleDeg).toHaveLength(721);
  });

  it('the governor supplies the opposite of the gas torque: mean torque balance within 1 %', () => {
    expect(report?.governor?.balanceError ?? 1).toBeLessThan(0.01);
  });

  it('keeps the loop residual in the pass tier and samples every crank degree', () => {
    expect(data.loops?.tier).toBe('pass');
    expect(data.loops?.residualM ?? 1).toBeLessThan(1e-6);
    expect(report?.warnings.filter((w) => w.startsWith('FPR_SAMPLING_COARSE'))).toEqual([]);
    expect(data.loops?.solver.timestepS ?? 0).toBeCloseTo((0.5 * Math.PI) / 180 / ((2000 * 2 * Math.PI) / 60), 9);
  });

  it('the summary names the engine results', () => {
    const summary = execute(governed(doc, 2000), 'simulate_motion', { duration: 0.2 }).summary;
    expect(summary).toMatch(/Engine crank_j: mean torque [\d.]+ N·m, indicated [\d.]+ kW at 20\d\d rpm, energy closure 0\.\d+ %/);
  });
});

describe('derived loads against the analytic peaks at low speed (VC-FPR-12 dynamic)', () => {
  it('wrist-pin, rod, side-thrust, crank-pin and main-bearing peaks follow F/cos(beta) and F tan(beta) of the gas force', () => {
    const { doc, cylinder } = engine({ rpm: 300, crankInertia: 2, pistonKg: 0.05, rodKg: 0.05 });
    const data = run(governed(doc, 300), { duration: 0.45, timestep: 2e-5, reactions: 'peaks' });
    const derived = data.engineReport?.cylinders.find((c) => c.id === cylinder)?.derived;
    // analytic peaks from the pressure model itself
    const probe = execute(doc, 'engine_quick_check', { cylinder, anglesDeg: Array.from({ length: 721 }, (_, k) => k * 1), rpm: 300 })
      .data as { angles: { angleDeg: number; rodForceN?: number; sideThrustN?: number }[] };
    const rodPeak = Math.max(...probe.angles.map((a) => Math.abs(a.rodForceN ?? 0)));
    const sidePeak = Math.max(...probe.angles.map((a) => Math.abs(a.sideThrustN ?? 0)));
    expect(Math.abs((derived?.wristPinN.value ?? 0) - rodPeak) / rodPeak).toBeLessThan(0.02);
    expect(Math.abs((derived?.rodAxialN.value ?? 0) - rodPeak) / rodPeak).toBeLessThan(0.02);
    expect(Math.abs((derived?.crankPinN.value ?? 0) - rodPeak) / rodPeak).toBeLessThan(0.02);
    expect(Math.abs((derived?.mainBearingN.value ?? 0) - rodPeak) / rodPeak).toBeLessThan(0.03);
    expect(Math.abs((derived?.sideThrustN.value ?? 0) - sidePeak) / sidePeak).toBeLessThan(0.03);
    // the peak lands near firing TDC (cycle angle 0..40 deg)
    expect(derived?.wristPinN.angleDeg ?? -1).toBeGreaterThan(0);
    expect(derived?.wristPinN.angleDeg ?? 999).toBeLessThan(40);
    expect(data.loops?.tier).toBe('pass');
  });

  it('light bodies under a 27 kN gas force at a 1 ms step drift past the fail tier: flagged, reactions unreliable (VC-FPR-35)', () => {
    const { doc } = engine({ rpm: 60, crankInertia: 2, pistonKg: 0.001, rodKg: 0.001 });
    const data = run(governed(doc, 60), { duration: 2.2, reactions: 'peaks' });
    expect(data.loops?.tier).toBe('fail');
    expect(data.loops?.residualM ?? 0).toBeGreaterThan(1e-5);
    expect(data.warnings.some((w) => w.startsWith('FPR_LOOP_DRIFT (fail)'))).toBe(true);
    expect(data.reactions?.quality).toBe('unreliable');
  });
});

describe('flywheel speed ripple (VC-FPR-17)', () => {
  it('the measured ripple matches dE / (I w0^2) from the run torque curve within 5 %', () => {
    const imepBar = 10;
    const displacement = AREA * 2 * R;
    const meanTorque = (imepBar * 1e5 * displacement) / (4 * Math.PI);
    const { doc } = engine({ rpm: 1500, crankInertia: 0.3, pistonKg: 0.05, rodKg: 0.05, imepBar });
    const loaded = execute(doc, 'add_motor', { joint: 'crank_j', kind: 'torque_curve', torque: -meanTorque }).document;
    const data = run(loaded, { duration: 0.6, reactions: 'off' });
    const ripple = data.engineReport?.speedRipple;
    expect(ripple?.measured ?? 0).toBeGreaterThan(0.002);
    expect(ripple?.analytic ?? 0).toBeGreaterThan(0.002);
    expect(ripple?.relativeDifference ?? 1).toBeLessThan(0.05);
    expect(data.engineReport?.cylinders[0]?.derived).toBeNull();
  });
});

describe('gear ratio through the loop mechanism (VC-FPR-16)', () => {
  it('a 51/21 reduction turns the propeller at 2388.24 rpm for a crank at 5800 rpm', () => {
    const { doc } = sliderCrank({ crankRpm: 5800 });
    const disc = execute(doc, 'add_cylinder', { radius: 150, height: 15, axis: [0, 0, 1], position: [0, 200, 0] });
    const body = execute(disc.document, 'add_rigid_body', { entityIds: [disc.affected[0]], id: 'prop', density: 600 });
    const joint = execute(body.document, 'add_body_joint', {
      kind: 'revolute',
      child: 'prop',
      anchor: [0, 200, 0],
      axis: [0, 0, 1],
      id: 'prop_j',
    });
    const gear = execute(joint.document, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', ratio: 21 / 51 });
    const data = run(governed(gear.document, 5800), { duration: 0.03 });
    expect(Math.abs((data.joints['prop_j']?.finalRpm ?? 0) - 2388.24) / 2388.24).toBeLessThan(1e-3);
    expect(data.joints['crank_j']?.finalRpm ?? 0).toBeCloseTo(5800, -1);
    expect(data.loops?.tier).toBe('pass');
  });
});

describe('engine run diagnostics', () => {
  it('a run shorter than one cycle says so instead of inventing curves', () => {
    const { doc } = engine({ rpm: 1000, crankInertia: 0.2 });
    const data = run(governed(doc, 1000), { duration: 0.05 });
    expect(data.engineReport?.lastCycle).toBeNull();
    expect(data.engineReport?.meanTorqueNm).toBeNull();
    expect(data.warnings.some((w) => /less than one four_stroke cycle/.test(w))).toBe(true);
  });

  it('coarse sampling is reported (FPR_SAMPLING_COARSE)', () => {
    const { doc } = engine({ rpm: 2000, crankInertia: 0.2 });
    const data = run(governed(doc, 2000), { duration: 0.1, sampleRate: 200 });
    expect(data.warnings.some((w) => w.startsWith('FPR_SAMPLING_COARSE'))).toBe(true);
  });

  it('a cylinder on a piston that lost its rod refuses to simulate with the reason', () => {
    const { doc } = engine({ rpm: 1000, crankInertia: 0.2 });
    const broken = execute(doc, 'delete_dynamics_item', { id: 'wrist_j' });
    const stripped = execute(broken.document, 'delete_dynamics_item', { id: 'rod_j' }).document;
    const result = execute(stripped, 'simulate_motion', { duration: 0.01 });
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/cylinder .*no connecting rod/);
  });
});
