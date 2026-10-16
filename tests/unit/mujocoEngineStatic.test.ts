/** Static slider-crank under a constant gas force (VC-FPR-11, VC-FPR-12): crank torque, rod force and side thrust against the exact formulas. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank, travelRate } from './sliderCrankFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const FORCE_N = 1000;
const BORE_MM = 100;
const ANGLES = [30, 60, 90, 120, 150];
const expectedTorque = [31.6936, 49.9111, 49.2125, 35.3274, 17.5189];
const expectedRod = [1013.733, 1042.985, 1058.594, 1042.985, 1013.733];
const expectedSide = [166.294, 296.342, 347.307, 296.342, 166.294];

interface Series {
  loops: Record<string, number[][]>;
  joints: Record<string, { force: number[][] }>;
}
type StaticData = SimulationData & { reactions?: { series?: Series }; loops?: { tier: string; residualM: number } };

/** Crank held at `deg` from TDC by a stiff servo, constant gas force on the piston, no gravity. */
function staticCase(deg: number, wrist: 'revolute' | 'spherical'): { data: StaticData; servo: string } {
  const { doc } = sliderCrank({ wrist, startDeg: deg, pistonKg: 0.001, crankInertia: 0.01 });
  const pressure = FORCE_N / (Math.PI * (BORE_MM / 2000) ** 2);
  const gas = execute(doc, 'add_cylinder_pressure', {
    piston: 'slide_j',
    crank: 'crank_j',
    boreMm: BORE_MM,
    compressionRatio: 10,
    model: {
      kind: 'table',
      points: [
        [0, pressure],
        [720, pressure],
      ],
      source: 'constant test input',
    },
  });
  if (gas.affected.length === 0) throw new Error(gas.summary);
  const hold = execute(gas.document, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: 0, maxTorque: 1e5 });
  const still = execute(hold.document, 'set_gravity', { gravity: [0, 0, 0] }).document;
  const result = execute(still, 'simulate_motion', {
    duration: 0.02,
    timestep: 2e-5,
    sampleRate: 5000,
    detail: 'series',
    reactions: 'series',
  });
  if (result.data === undefined) throw new Error(result.summary);
  return { data: result.data as StaticData, servo: hold.affected[0] ?? '' };
}

const lastOf = <T>(values: readonly T[] | undefined): T | undefined => values?.[values.length - 1];
const magnitude = (v: readonly number[] | undefined): number => Math.hypot(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);

describe('static slider-crank under 1000 N (VC-FPR-11, 12)', () => {
  it.each(ANGLES.map((deg, i) => [deg, i] as const))('crank held at %i deg: torque, rod force, side thrust within 0.5 %', (deg, i) => {
    const { data, servo } = staticCase(deg, 'spherical');
    const torque = lastOf(data.series?.motorTorque[servo]) ?? Number.NaN;
    expect(Math.abs(Math.abs(torque) - (expectedTorque[i] ?? 0)) / (expectedTorque[i] ?? 1)).toBeLessThan(0.005);
    expect(Math.abs(torque) / FORCE_N).toBeCloseTo(travelRate(0.0492125, 0.15, (deg * Math.PI) / 180), 3);
    const series = data.reactions?.series;
    const rod = magnitude(lastOf(series?.loops['wrist_j']));
    expect(Math.abs(rod - (expectedRod[i] ?? 0)) / (expectedRod[i] ?? 1)).toBeLessThan(0.005);
    const slide = lastOf(series?.joints['slide_j']?.force) ?? [];
    expect(Math.abs(Math.abs(slide[1] ?? 0) - (expectedSide[i] ?? 0)) / (expectedSide[i] ?? 1)).toBeLessThan(0.005);
    // along the piston axis a tree joint reports the drive force itself (the gas force enters the joint through the generalised force)
    expect(Math.abs(Math.abs(slide[0] ?? 0) - FORCE_N)).toBeLessThan(5);
    expect(data.loops?.tier).toBe('pass');
  });

  it('a revolute wrist (planar redundancy) gives the same answer as the spherical wrist', () => {
    const { data, servo } = staticCase(60, 'revolute');
    const torque = lastOf(data.series?.motorTorque[servo]) ?? Number.NaN;
    expect(Math.abs(Math.abs(torque) - 49.9111) / 49.9111).toBeLessThan(0.005);
    expect(data.loops?.tier).toBe('pass');
  });
});
