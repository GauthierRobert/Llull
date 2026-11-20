/** 14 FLL-M2b: the rotor torque of a mount (reaction -s Q a plus the gyroscopic -omega x H) on synthetic instants, and the spin read. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument } from '@core/model/types';
import type { FlightInstant } from '@cae/flightLoads/flightInstants';
import { flightInstants } from '@cae/flightLoads/flightInstants';
import { rotorMountMoment, rotorSpins } from '@cae/flightLoads/rotorTorque';

const instant = (rpm: number, powerW: number, angularVelocity: [number, number, number] = [0, 0, 0]): FlightInstant => ({
  index: 0,
  timeS: 0,
  accelMps2: [0, 0, 0],
  gravityMps2: [0, 0, -9.80665],
  angularVelocity,
  angularAccel: [0, 0, 0],
  thrustN: { r: 3 },
  rotorRpm: { r: rpm },
  shaftPowerW: { r: powerW },
});

const CCW = { spin: 1 as const, spinInertiaKgM2: 0 };
const CW = { spin: -1 as const, spinInertiaKgM2: 0 };

describe('rotorMountMoment', () => {
  it('is Q = P / (2 pi n) about -axis for a ccw rotor and about +axis for a cw rotor', () => {
    // 6000 rpm = 100 rev/s = 628.3 rad/s; 62.83 W -> Q = 0.1 N m
    const ccw = rotorMountMoment(instant(6000, 20 * Math.PI), 'r', [0, 0, 1], CCW);
    const cw = rotorMountMoment(instant(6000, 20 * Math.PI), 'r', [0, 0, 1], CW);
    if (typeof ccw === 'string' || typeof cw === 'string') throw new Error('refused');
    expect(ccw[2]).toBeCloseTo(-0.1, 12);
    expect(cw[2]).toBeCloseTo(0.1, 12);
    expect([ccw[0], ccw[1], cw[0], cw[1]].map(Math.abs)).toEqual([0, 0, 0, 0]);
    // the torque follows the thrust axis
    const tilted = rotorMountMoment(instant(6000, 20 * Math.PI), 'r', [1, 0, 0], CCW);
    if (typeof tilted === 'string') throw new Error(tilted);
    expect(tilted[0]).toBeCloseTo(-0.1, 12);
    expect(Math.hypot(tilted[1], tilted[2])).toBe(0);
  });

  it('adds the gyroscopic moment -omega x H (H = I_s 2 pi n s a) when the body rotates', () => {
    // roll rate 1 rad/s, ccw rotor along +z at 6000 rpm, I_s 1e-4: H = 0.06283 z; -omega x H = -(x cross z) 0.06283 = +0.06283 y
    const moment = rotorMountMoment(instant(6000, 0, [1, 0, 0]), 'r', [0, 0, 1], { spin: 1, spinInertiaKgM2: 1e-4 });
    if (typeof moment === 'string') throw new Error('refused');
    expect(moment[0]).toBeCloseTo(0, 15);
    expect(moment[1]).toBeCloseTo(1e-4 * 200 * Math.PI, 12);
    expect(moment[2]).toBeCloseTo(0, 15);
    const reversed = rotorMountMoment(instant(6000, 0, [1, 0, 0]), 'r', [0, 0, 1], { spin: -1, spinInertiaKgM2: 1e-4 });
    if (typeof reversed === 'string') throw new Error('refused');
    expect(reversed[1]).toBeCloseTo(-moment[1], 12);
  });

  it('a stopped rotor carries no torque; a rotor the series does not record is refused by name', () => {
    const stopped = rotorMountMoment(instant(0, 5), 'r', [0, 0, 1], CCW);
    if (typeof stopped === 'string') throw new Error(stopped);
    expect(stopped.map(Math.abs)).toEqual([0, 0, 0]);
    expect(rotorMountMoment(instant(6000, 5), 'other', [0, 0, 1], CCW)).toBe("the run has no speed or shaft power of rotor 'other'");
  });

  it('flightInstants reads the speed and shaft power of each rotor sample (absent series give empty maps)', () => {
    const times = [0, 0.1, 0.2];
    const series = {
      times,
      velocityMps: times.map(() => [0, 0, 0]),
      attitudeDeg: times.map(() => [0, 0, 0]),
      bodyRateDegS: times.map(() => [0, 0, 0]),
      rotors: { r1: { thrustN: [1, 2, 3], rpm: [100, 200, 300], shaftPowerW: [4, 5, 6] }, r2: { thrustN: [1, 1, 1] } },
    };
    const instants = flightInstants(series, [0, 0, -9.8]);
    if (typeof instants === 'string') throw new Error(instants);
    expect(instants[1]?.rotorRpm).toEqual({ r1: 200 });
    expect(instants[1]?.shaftPowerW).toEqual({ r1: 5 });
    expect(instants[1]?.thrustN).toEqual({ r1: 2, r2: 1 });
  });
});

describe('rotorSpins', () => {
  it('names the missing dynamics plugin and a document without rotors', () => {
    const doc = createEmptyDocument();
    expect(rotorSpins(doc, undefined)).toBe('inspect_dynamics is not registered (the dynamics plugin is not installed)');
    expect(rotorSpins(doc, defaultContext())).toBe('the document has no flight rotors (add_rotor)');
  });
});
