/** Three-link planar arm (serial 3-level kinematic chain) under speed-governor servos: gravity hold, commanded move, saturation warning. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@dynamics/sim/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const G = 9.80665;
/** Link masses (kg) and their centre x (m); joints at x = 0, 0.4, 0.7 m, all axes +Y, arm horizontal along +X. */
const MASS = [2, 1.5, 2.5] as const;
const CENTER = [0.2, 0.55, 0.775] as const;
const JOINT_X = [0, 0.4, 0.7] as const;
const JOINTS = ['shoulder', 'elbow', 'wrist'] as const;

/** Static gravity moment at joint k: g · Σ_{i ≥ k} m_i (x_i − x_joint_k). */
const holdTorque = (k: number): number =>
  G * MASS.reduce((sum, m, i) => (i < k ? sum : sum + m * ((CENTER[i] ?? 0) - (JOINT_X[k] ?? 0))), 0);

function arm(motors: Record<(typeof JOINTS)[number], { rpm: number; maxTorque: number }>): CadDocument {
  const lengths = [400, 300, 150];
  const actions: Record<string, unknown>[] = [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', as: 'ped', params: { size: [100, 100, 270], position: [0, 0, 135] } },
    ...lengths.map((length, i) => ({
      command: 'add_box',
      as: `l${i}`,
      params: { size: [length, 40, 40], position: [(CENTER[i] ?? 0) * 1000, 0, 300] },
    })),
    { command: 'add_rigid_body', params: { id: 'base', entityIds: ['$ped'], fixed: true } },
    ...MASS.map((massKg, i) => ({ command: 'add_rigid_body', params: { id: `link${i}`, entityIds: [`$l${i}`], massKg } })),
    ...JOINTS.map((id, i) => ({
      command: 'add_body_joint',
      params: {
        id,
        kind: 'revolute',
        child: `link${i}`,
        parent: i === 0 ? 'base' : `link${i - 1}`,
        anchor: [(JOINT_X[i] ?? 0) * 1000, 0, 300],
        axis: [0, 1, 0],
      },
    })),
    { command: 'set_gravity', params: { gravity: [0, 0, -G] } },
    ...JOINTS.map((joint) => ({ command: 'add_motor', params: { id: `m_${joint}`, joint, kind: 'speed', ...motors[joint] } })),
  ];
  return execute(createEmptyDocument(), 'build_project', { actions }).document;
}

const run = (doc: CadDocument, duration: number): SimulationData => {
  const result = execute(doc, 'simulate_motion', { duration });
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as SimulationData;
};

describe('3-link arm under speed servos', () => {
  it('holding position: motor torques equal the static gravity moments (1 %), joints at rest, no warnings', () => {
    const holds = { rpm: 0, maxTorque: 50 };
    const data = run(arm({ shoulder: holds, elbow: holds, wrist: holds }), 2);
    JOINTS.forEach((joint, k) => {
      const expected = holdTorque(k);
      const motor = data.motors[`m_${joint}`];
      expect(Math.abs(Math.abs(motor?.torque ?? 0) - expected) / expected).toBeLessThan(0.01);
      expect(Math.abs(data.joints[joint]?.finalRpm ?? 1)).toBeLessThan(0.05);
      expect(Math.abs(data.joints[joint]?.finalPosition ?? 1)).toBeLessThan(0.01);
    });
    expect(data.warnings).toEqual([]);
  });

  it('a commanded elbow move ends at the target angle while the others hold', () => {
    const holds = { rpm: 0, maxTorque: 50 };
    const data = run(arm({ shoulder: holds, elbow: { rpm: 5, maxTorque: 50 }, wrist: holds }), 1);
    const target = (5 * 2 * Math.PI) / 60;
    expect(data.joints['elbow']?.finalPosition ?? 0).toBeGreaterThan(target * 0.98);
    expect(data.joints['elbow']?.finalPosition ?? 0).toBeLessThan(target * 1.02);
    expect(data.joints['elbow']?.finalRpm ?? 0).toBeCloseTo(5, 1);
    expect(Math.abs(data.joints['shoulder']?.finalRpm ?? 1)).toBeLessThan(0.1);
    expect(data.warnings.filter((warning) => warning.includes('pinned'))).toEqual([]);
  });

  it('flags a position-hold motor pinned at its torque limit for most of the run', () => {
    const data = run(arm({ shoulder: { rpm: 0, maxTorque: 50 }, elbow: { rpm: 0, maxTorque: 5 }, wrist: { rpm: 0, maxTorque: 50 } }), 2);
    const pinned = data.warnings.filter((warning) => warning.includes('pinned at its 5 N·m torque limit'));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toContain("motor 'm_elbow'");
    expect(data.warnings.some((warning) => warning.includes('m_shoulder'))).toBe(false);
  });
});
