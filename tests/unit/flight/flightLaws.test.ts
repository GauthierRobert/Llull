/** The 13 FLT force laws as pure functions (no engine): rotor wrench in the body frame, body drag, and data.flight from a recorded trace. */
import { describe, expect, it } from 'vitest';
import type { BodyKinematics, SimulationTrace } from '@core/dynamics/physicsEngine';
import type { Rotor } from '@dynamics/flight/model';
import { bodyDragForce, compileRotor, rotorOutput } from '@dynamics/flight/rotorLaw';
import { flightData, flightSummary } from '@dynamics/flight/flightReport';

const rotor = (overrides: Partial<Rotor>): Rotor => ({
  id: 'r',
  bodyId: 'b',
  hub: [0, 0, 0],
  axis: [0, 0, 2],
  spin: 'ccw',
  rpm: 6000,
  diameter: 0.25,
  coefficients: { kind: 'static', thrustCoefficient: 0.1, powerCoefficient: 0.05, source: 's' },
  airDensity: 1.2,
  spinInertiaKgM2: 0,
  ...overrides,
});

const still: BodyKinematics = { position: [0, 0, 0], orientation: [1, 0, 0, 0], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
/** 90° about +x: body z points along world -y. */
const rolled: BodyKinematics = { ...still, orientation: [Math.SQRT1_2, Math.SQRT1_2, 0, 0] };

const T = 0.1 * 1.2 * 100 * 100 * 0.25 ** 4;
const Q = (0.05 * 1.2 * 100 * 100 * 0.25 ** 5) / (2 * Math.PI);

describe('rotor law', () => {
  it('thrust along the rotated body axis, reaction torque against the spin, r × F from a hub in millimetres', () => {
    const ccw = rotorOutput(compileRotor(rotor({}), [0, 0, 0], 0.001), rolled);
    expect(ccw.force[1]).toBeCloseTo(-T, 12);
    expect(ccw.force[2]).toBeCloseTo(0, 12);
    expect(ccw.moment[1]).toBeCloseTo(Q, 12);
    expect(ccw.power).toBeCloseTo(Q * 2 * Math.PI * 100, 10);
    const cw = rotorOutput(compileRotor(rotor({ spin: 'cw', hub: [100, 0, 0] }), [0, 0, 0], 0.001), still);
    // reaction +Q ẑ for cw; arm 0.1 x̂ × T ẑ = -0.1 T ŷ
    expect(cw.moment).toEqual([expect.closeTo(0, 12), expect.closeTo(-0.1 * T, 12), expect.closeTo(Q, 12)]);
  });

  it('gyroscopic torque -ω × H and advance ratio from the hub velocity v + ω × r', () => {
    const gyro = compileRotor(
      rotor({ spinInertiaKgM2: 1e-3, coefficients: { kind: 'static', thrustCoefficient: 0, powerCoefficient: 0, source: 's' } }),
      [0, 0, 0],
      1,
    );
    const out = rotorOutput(gyro, { ...still, angularVelocity: [2, 0, 0] });
    const h = 1e-3 * 2 * Math.PI * 100;
    expect(out.moment).toEqual([0, expect.closeTo(2 * h, 12), 0]);
    const offset = compileRotor(rotor({ hub: [0, 1, 0] }), [0, 0, 0], 1);
    // ω = 3 x̂ at r = ŷ: hub velocity 3 ẑ, J = 3 / (100 · 0.25)
    const spun = rotorOutput(offset, { ...still, angularVelocity: [3, 0, 0], linearVelocity: [0, 0, 1] });
    expect(spun.axialVelocity).toBeCloseTo(4, 12);
    expect(spun.advanceRatio).toBeCloseTo(4 / 25, 12);
    expect(spun.outsideRange).toBe(true);
    expect(rotorOutput(compileRotor(rotor({ rpm: 0 }), [0, 0, 0], 1), { ...still, linearVelocity: [0, 0, 5] }).advanceRatio).toBe(0);
  });

  it('a table is interpolated through its rows and held (flagged) outside them, descent included', () => {
    const table = compileRotor(
      rotor({
        coefficients: {
          kind: 'table',
          points: [
            [0, 0.12, 0.05],
            [0.2, 0.1, 0.045],
            [0.4, 0.06, 0.035],
          ],
          source: 's',
          grade: 'A',
        },
      }),
      [0, 0, 0],
      1,
    );
    const at = (v: number): ReturnType<typeof rotorOutput> => rotorOutput(table, { ...still, linearVelocity: [0, 0, v] });
    expect(at(0.2 * 25).thrust).toBeCloseTo(0.1 * 1.2 * 100 * 100 * 0.25 ** 4, 12);
    expect(at(0.2 * 25).outsideRange).toBe(false);
    expect(at(-2).thrust).toBeCloseTo(0.12 * 1.2 * 100 * 100 * 0.25 ** 4, 12);
    expect(at(-2).outsideRange).toBe(true);
    expect(at(20).outsideRange).toBe(true);
  });

  it('body drag -½ ρ CdA_i |v| v_i in the body axes', () => {
    const drag = { bodyId: 'b', cdaM2: [0.1, 0.2, 0.3] as const, airDensity: 1.2 };
    expect(bodyDragForce(drag, { ...still, linearVelocity: [0, 0, -10] })).toEqual([0, 0, expect.closeTo(0.5 * 1.2 * 0.3 * 100, 12)]);
    // rolled 90° about x: world -y is body +z
    const rolledForce = bodyDragForce(drag, { ...rolled, linearVelocity: [0, -10, 0] });
    expect(rolledForce[1]).toBeCloseTo(0.5 * 1.2 * 0.3 * 100, 12);
  });
});

describe('data.flight from a recorded trace', () => {
  const trace = (withVelocity: boolean): SimulationTrace => ({
    times: [0, 1],
    jointPosition: {},
    jointVelocity: {},
    bodyPosition: {
      b: [
        [0, 0, 0],
        [0, 0, 1],
      ],
    },
    bodyOrientation: {
      b: [
        [1, 0, 0, 0],
        [1, 0, 0, 0],
      ],
    },
    servoForce: {},
    ...(withVelocity
      ? {
          bodyVelocity: {
            b: {
              linear: [
                [0, 0, 0],
                [0, 0, 10],
              ],
              angular: [
                [0, 0, 0],
                [0, 0, 0],
              ],
            },
          },
        }
      : {}),
  });
  const runtime = {
    rotors: [
      compileRotor(rotor({}), [0, 0, 0], 1),
      compileRotor(
        rotor({
          id: 't',
          coefficients: {
            kind: 'table',
            points: [
              [0, 0.1, 0.05],
              [0.1, 0.09, 0.05],
            ],
            source: 's',
            grade: 'B',
          },
        }),
        [0, 0, 0],
        1,
      ),
    ],
    drags: [{ bodyId: 'b', cdaM2: [0, 0, 0.1] as const, airDensity: 1.2 }],
    bodies: ['b'],
  };

  it('reports thrust, power, J range, drag, warnings and the series', () => {
    const { data, warnings } = flightData(runtime, trace(true), { series: true, energy: true });
    expect(data.rotors['r']).toMatchObject({ body: 'b', coefficients: 'static', thrustN: expect.closeTo(T, 12), outsideRangeSamples: 1 });
    expect(data.rotors['r']?.advanceRatio).toEqual({ min: 0, max: 0.4, final: 0.4 });
    expect(data.bodyDrag['b']).toEqual({ finalSpeedMps: 10, finalForceN: expect.closeTo(6, 12), peakForceN: expect.closeTo(6, 12) });
    expect(data.series?.advanceRatio['t']).toEqual([0, 0.4]);
    expect(data.series?.dragForce['b']).toHaveLength(2);
    expect(warnings).toEqual([
      expect.stringMatching(/^FLT_OUTSIDE_VALIDATED_RANGE: rotor 'r' .*static pair is valid at \|J\| <= 0\.05/),
      expect.stringMatching(/^FLT_OUTSIDE_VALIDATED_RANGE: rotor 't' .*covers J 0 to 0\.1/),
      expect.stringMatching(/^FLT_ENERGY_UNCOUNTED/),
    ]);
    expect(flightSummary(data)).toContain('Rotor r (body b): thrust');
    expect(flightSummary(data)).toContain('Drag of body b: 6.000 N at 10.00 m/s');
  });

  it('an engine that records no body velocity reports nothing for those bodies, with a warning', () => {
    const { data, warnings } = flightData(runtime, trace(false), { series: false, energy: false });
    expect(data).toEqual({ rotors: {}, bodyDrag: {} });
    expect(warnings).toEqual(["the physics engine recorded no velocity for 'b': their flight loads are not reported"]);
  });
});
