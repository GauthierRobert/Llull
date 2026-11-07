/**
 * The DC motor outputs did not move when DRV-M4 generalised the actuator block (AUX_SIZE 12 -> 19, per-kind step, `power` slot): the series of three DC runs
 * (voltage with L and a gearhead, torque with limits, velocity loop with anti-windup) hash to the values recorded on the commit before DRV-M4 (219508830,
 * computed by this same test against that commit's sources). A change in the least significant bit of any sample changes a hash.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { MAXON_SHEET, dataOf, inertiaBench, seriesOf, simulate } from './fixtures';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const PINNED = { voltage: '2ec8408020813d49', torque: 'e314caa9cd07d71c', velocity: '7686c80e6a8eb209' } as const;

const hashOf = (arrays: readonly (readonly number[])[]): string =>
  createHash('sha256')
    .update(arrays.map((values) => values.map((v) => v.toString()).join(',')).join(';'))
    .digest('hex')
    .slice(0, 16);

function runHash(doc: ReturnType<typeof inertiaBench>, params: Record<string, unknown>): string {
  const result = simulate(doc, { detail: 'drives', energy: true, ...params });
  const data = dataOf(result) as unknown as {
    drives: { m: { series: Record<string, number[]> } };
    ledger: { entries: { joules: number }[] };
  };
  const series = data.drives.m.series;
  return hashOf([
    series['voltageV'] ?? [],
    series['currentA'] ?? [],
    series['shaftTorqueNm'] ?? [],
    series['jointTorqueNm'] ?? [],
    series['shaftSpeedRpm'] ?? [],
    series['electricalPowerW'] ?? [],
    seriesOf(result, 'jointPosition', 'j'),
    data.ledger.entries.map((entry) => entry.joules),
  ]);
}

const profile = (id: string, quantity: string, unit: string, value: number): { command: string; params: Record<string, unknown> } => ({
  command: 'add_motion_profile',
  params: { id, quantity, unit, start: value, segments: [{ kind: 'dwell', duration: 1 }] },
});

describe('DC motor series are bit-identical to the commit before DRV-M4', () => {
  it('voltage mode, inductance, gearhead 10:1 eta 0.9 (back 0.8), no-load friction', () => {
    const doc = inertiaBench(
      1.37e-3,
      { sheet: MAXON_SHEET, gearhead: { ratio: 10, efficiency: 0.9, efficiencyBack: 0.8, inertiaKgM2: 1e-6 } },
      [{ command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 24, currentLimitA: 20 } }],
    );
    expect(runHash(doc, { duration: 0.3, timestep: 1e-4, sampleRate: 2000 })).toBe(PINNED.voltage);
  });

  it('torque mode through the gearhead with a current limit and a bus voltage', () => {
    const doc = inertiaBench(1.37e-3, { sheet: MAXON_SHEET, gearhead: { ratio: 5, efficiency: 0.85 } }, [
      profile('tau', 'torque', 'N*m', 0.2),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'tau', busVoltageV: 30, currentLimitA: 6 } },
    ]);
    expect(runHash(doc, { duration: 0.3, timestep: 1e-4, sampleRate: 2000 })).toBe(PINNED.torque);
  });

  it('velocity loop that saturates on the way (anti-windup path)', () => {
    const doc = inertiaBench(1.37e-3, { sheet: MAXON_SHEET }, [
      profile('w', 'velocity', 'rad/s', 300),
      {
        command: 'set_motor_drive',
        params: {
          motor: 'm',
          mode: 'velocity',
          profile: 'w',
          tune: { bandwidthHz: 20, dampingRatio: 1 },
          sampleHz: 1000,
          currentLimitA: 4,
        },
      },
    ]);
    expect(runHash(doc, { duration: 0.5, timestep: 1e-4, sampleRate: 2000 })).toBe(PINNED.velocity);
  });
});
