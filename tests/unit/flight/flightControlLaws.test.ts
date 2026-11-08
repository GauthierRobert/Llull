/** Pure laws of the 13 FLT M2 flight loop: mixer, allocation, wind, attitude algebra, verdict, block composition, controller trim. */
import { describe, expect, it } from 'vitest';
import type { ActuatorBlock, SimulationState } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { multiplyQuaternion } from '@lib/quaternion';
import { controllerUpdate, RESTING_MEMORY, type ControllerRuntime } from '@dynamics/flight/controller';
import type { FlightController } from '@dynamics/flight/controlModel';
import { combineBlocks, meanAxis, setpointAt } from '@dynamics/flight/flightBlock';
import { eulerDeg, type FlightMetrics } from '@dynamics/flight/flightMetrics';
import { stepsPerTick } from '@dynamics/flight/flightRun';
import { DEFAULT_FLIGHT_LIMITS, flightVerdict } from '@dynamics/flight/flightVerdict';
import { conjugate, quaternionFromBasis, rotate, shortestArc } from '@dynamics/flight/frames';
import { allocate, commandedAxes, effectiveness, matrixRank, pseudoInverse, type MixerRotor } from '@dynamics/flight/mixer';
import { airRelative, isCalm, windAt } from '@dynamics/flight/wind';

const KAPPA = 0.016268;
const quadX: MixerRotor[] = [
  { arm: [0.18, -0.18, 0], axis: [0, 0, 1], spin: 1, torquePerThrust: KAPPA },
  { arm: [-0.18, 0.18, 0], axis: [0, 0, 1], spin: 1, torquePerThrust: KAPPA },
  { arm: [0.18, 0.18, 0], axis: [0, 0, 1], spin: -1, torquePerThrust: KAPPA },
  { arm: [-0.18, -0.18, 0], axis: [0, 0, 1], spin: -1, torquePerThrust: KAPPA },
];

describe('mixer', () => {
  it('inverts the quad X geometry exactly: B·M = I, rows [1/4, ∓1/(4L), ∓1/(4L), ∓1/(4κ)]', () => {
    const b = effectiveness(quadX, [0, 0, 1]);
    expect(matrixRank(b)).toBe(4);
    const mixer = pseudoInverse(b) ?? [];
    const identity = commandedAxes(b, mixer);
    identity.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(i === j ? 1 : 0, 12)));
    expect(mixer[0]?.[0]).toBeCloseTo(0.25, 12);
    expect(mixer[0]?.[1]).toBeCloseTo(-1 / (4 * 0.18), 9);
    expect(mixer[0]?.[3]).toBeCloseTo(-1 / (4 * KAPPA), 9);
  });

  it('finds the rank of a coaxial pair (2) and of a planar quad with equal spins (3, no yaw); a singular Gram matrix has no inverse', () => {
    expect(matrixRank(effectiveness(quadX.slice(0, 2), [0, 0, 1]))).toBe(2);
    expect(
      matrixRank(
        effectiveness(
          quadX.map((rotor) => ({ ...rotor, spin: 1 })),
          [0, 0, 1],
        ),
      ),
    ).toBe(3);
    expect(
      pseudoInverse([
        [1, 1],
        [1, 1],
        [0, 0],
        [0, 0],
      ]),
    ).toBeNull();
    expect(
      matrixRank([
        [0, 0],
        [0, 0],
      ]),
    ).toBe(0);
  });

  it('gives up yaw before the other axes, then clamps', () => {
    const mixer = pseudoInverse(effectiveness(quadX, [0, 0, 1])) ?? [];
    const min = [0, 0, 0, 0];
    const max = [4, 4, 4, 4];
    const free = allocate(mixer, [8, 0, 0, 0.01], min, max);
    expect(free.saturated).toBe(false);
    expect(free.thrusts.reduce((a, b) => a + b, 0)).toBeCloseTo(8, 12);
    const yawCut = allocate(mixer, [14, 0, 0, 0.05], min, max);
    expect(yawCut.saturated).toBe(true);
    expect(Math.max(...yawCut.thrusts)).toBeCloseTo(4, 12);
    expect(yawCut.thrusts.reduce((a, b) => a + b, 0)).toBeCloseTo(14, 12);
    const negativeYaw = allocate(mixer, [1, 0, 0, -0.05], min, max);
    expect(Math.min(...negativeYaw.thrusts)).toBeCloseTo(0, 12);
    expect(negativeYaw.saturated).toBe(true);
    const clamped = allocate(mixer, [20, 0, 0, 0], min, max);
    expect(clamped).toEqual({ thrusts: [4, 4, 4, 4], saturated: true });
  });
});

describe('wind', () => {
  const wind = { steady: [1, 0, 0] as Vec3, gusts: [{ startS: 1, durationS: 2, peak: [0, 4, -2] as Vec3 }] };
  it('adds a 1-cosine gust to the steady wind: zero at its ends, the peak at its middle', () => {
    expect(windAt(wind, 0.5)).toEqual([1, 0, 0]);
    expect(windAt(wind, 1)).toEqual([1, 0, 0]);
    const middle = windAt(wind, 2);
    expect(middle[1]).toBeCloseTo(4, 12);
    expect(middle[2]).toBeCloseTo(-2, 12);
    expect(windAt(wind, 1.5)[1]).toBeCloseTo(2, 12);
    expect(windAt(wind, 3)[1]).toBeCloseTo(0, 12);
    expect(windAt(wind, 3.5)).toEqual([1, 0, 0]);
    expect(isCalm(wind)).toBe(false);
    expect(isCalm({ steady: [0, 0, 0], gusts: [] })).toBe(true);
  });
  it('takes the body velocity relative to the air', () => {
    const body = {
      position: [0, 0, 0] as Vec3,
      orientation: [1, 0, 0, 0] as const,
      linearVelocity: [2, 0, 0] as Vec3,
      angularVelocity: [0, 0, 1] as Vec3,
    };
    expect(airRelative(body, [3, 1, 0])).toEqual({ ...body, linearVelocity: [-1, -1, 0] });
  });
});

describe('attitude algebra', () => {
  it('builds the quaternion of a basis and the shortest arc between two vectors', () => {
    const half = Math.SQRT1_2;
    const q = quaternionFromBasis([0, 1, 0], [-1, 0, 0], [0, 0, 1]);
    rotate(q, [1, 0, 0]).forEach((value, i) => expect(value).toBeCloseTo([0, 1, 0][i] ?? 0, 12));
    for (const basis of [
      [
        [1, 0, 0],
        [0, -1, 0],
        [0, 0, -1],
      ],
      [
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, -1],
      ],
      [
        [-1, 0, 0],
        [0, -1, 0],
        [0, 0, 1],
      ],
    ] as const) {
      const r = quaternionFromBasis(basis[0], basis[1], basis[2]);
      basis.forEach((column, j) =>
        rotate(r, [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0]).forEach((value, i) => expect(value).toBeCloseTo(column[i] ?? 0, 12)),
      );
    }
    const arc = shortestArc([0, 0, 1], [half, 0, half]);
    rotate(arc, [0, 0, 1]).forEach((value, i) => expect(value).toBeCloseTo([half, 0, half][i] ?? 0, 12));
    const flip = shortestArc([1, 0, 0], [-1, 0, 0]);
    rotate(flip, [1, 0, 0]).forEach((value, i) => expect(value).toBeCloseTo([-1, 0, 0][i] ?? 0, 12));
    const flipX = shortestArc([0.95, 0.3122499, 0], [-0.95, -0.3122499, 0]);
    expect(rotate(flipX, [0.95, 0.3122499, 0])[0]).toBeCloseTo(-0.95, 6);
    expect(multiplyQuaternion(q, conjugate(q))[0]).toBeCloseTo(1, 12);
  });
  it('reads roll, pitch and yaw of a rotation', () => {
    const yaw = eulerDeg([Math.cos(Math.PI / 12), 0, 0, Math.sin(Math.PI / 12)]);
    expect(yaw.yawDeg).toBeCloseTo(30, 10);
    expect(yaw.rollDeg).toBeCloseTo(0, 10);
    expect(eulerDeg([Math.cos(Math.PI / 8), 0, Math.sin(Math.PI / 8), 0]).pitchDeg).toBeCloseTo(45, 10);
  });
  it('averages the rotor axes and falls back to +Z when they cancel', () => {
    const rotor = (axis: Vec3): never => ({ axis }) as never;
    meanAxis([rotor([0, 0, 1]), rotor([1, 0, 0])]).forEach((value, i) =>
      expect(value).toBeCloseTo([Math.SQRT1_2, 0, Math.SQRT1_2][i] ?? 0, 15),
    );
    expect(meanAxis([rotor([0, 0, 1]), rotor([0, 0, -1])])).toEqual([0, 0, 1]);
  });
});

describe('controller timing and set-points', () => {
  it('needs whole physics steps per controller update', () => {
    expect(stepsPerTick(400, 0.0005)).toBe(5);
    expect(stepsPerTick(400, 0.0025)).toBe(1);
    expect(stepsPerTick(400, 0.001)).toBeNull();
    expect(stepsPerTick(400, 0.005)).toBeNull();
  });
  it('holds each set-point until the next', () => {
    const scenario = {
      setpoints: [
        { t: 0, position: [0, 0, 0], yawDeg: 0 },
        { t: 2, position: [0, 0, 1], yawDeg: 5 },
      ],
    } as never;
    expect(setpointAt(scenario, 1.999).yawDeg).toBe(0);
    expect(setpointAt(scenario, 2).yawDeg).toBe(5);
    expect(setpointAt({ setpoints: [] } as never, 3)).toEqual({ t: 0, position: [0, 0, 0], yawDeg: 0 });
  });
});

describe('controller update', () => {
  const controller: FlightController = {
    id: 'fc',
    bodyId: 'frame',
    rotorIds: ['r1', 'r2', 'r3', 'r4'],
    rateHz: 400,
    gains: {
      position: [1, 1, 1],
      velocity: { p: [2, 2, 3], i: [0.5, 0.5, 1], d: [0.1, 0.1, 0.1] },
      attitude: [6, 6, 3],
      rate: { p: [20, 20, 10], i: [5, 5, 2], d: [0.01, 0.01, 0.01] },
    },
    limits: { maxTiltDeg: 30, maxHorizontalSpeedMps: 2, maxVerticalSpeedMps: 1, maxRateDegS: [200, 200, 100] },
    minRpm: 0,
    maxRpm: 7000,
    motorTimeConstantS: 0,
    mixer: null,
    defaulted: [],
  };
  const k = 1.6402e-7;
  const runtime: ControllerRuntime = {
    controller,
    mixer: pseudoInverse(effectiveness(quadX, [0, 0, 1])) ?? [],
    thrustAxis: [0, 0, 1],
    axisOffset: [1, 0, 0, 0],
    massKg: 1.115,
    inertia: [
      [0.012, 0, 0],
      [0, 0.012, 0],
      [0, 0, 0.022],
    ],
    gravity: [0, 0, -9.80665],
    start: [0, 0, 0],
    minThrust: [0, 0, 0, 0],
    maxThrust: [k * 7000 ** 2, k * 7000 ** 2, k * 7000 ** 2, k * 7000 ** 2],
    thrustPerRpmSquared: [k, k, k, k],
    period: 1 / 400,
  };
  const rest = {
    position: [0, 0, 0] as Vec3,
    orientation: [1, 0, 0, 0] as const,
    linearVelocity: [0, 0, 0] as Vec3,
    angularVelocity: [0, 0, 0] as Vec3,
  };
  const hold = { t: 0, position: [0, 0, 0] as Vec3, yawDeg: 0 };

  it('commands the hover speed sqrt(m g / (4 k)) at rest on its set-point, unsaturated', () => {
    const out = controllerUpdate(runtime, rest, hold, RESTING_MEMORY);
    for (const rpm of out.rpm) expect(rpm).toBeCloseTo(Math.sqrt((1.115 * 9.80665) / (4 * k)), 6);
    expect(out.saturated).toBe(false);
    expect(out.memory.hasPrevious).toBe(true);
  });

  it('limits the commanded tilt and the horizontal speed for a far set-point, and integrates only while unsaturated', () => {
    const far = controllerUpdate(runtime, rest, { t: 0, position: [100, 0, 0], yawDeg: 0 }, RESTING_MEMORY);
    expect(far.memory.velocityIntegral[0]).toBeCloseTo(2 / 400, 12);
    const held = controllerUpdate(runtime, rest, { t: 0, position: [100, 0, 0], yawDeg: 0 }, { ...RESTING_MEMORY, saturated: true });
    expect(held.memory.velocityIntegral).toEqual([0, 0, 0]);
    // tilting towards +x is a pitch-up demand: the rear rotors (x < 0) speed up
    expect((far.rpm[1] ?? 0) + (far.rpm[3] ?? 0)).toBeGreaterThan((far.rpm[0] ?? 0) + (far.rpm[2] ?? 0));
    const upside = controllerUpdate(runtime, { ...rest, orientation: [0, 1, 0, 0] }, hold, RESTING_MEMORY);
    expect(upside.rpm.every((rpm) => Number.isFinite(rpm))).toBe(true);
  });
});

describe('verdict', () => {
  const metrics = (patch: Partial<Record<string, unknown>>): FlightMetrics =>
    ({
      attitude: { maxTiltDeg: 10 },
      tracking: { finalPositionErrorM: 0.01 },
      events: [{ kind: 'gust', timeS: 1, recoveryTimeS: 1, peakErrorM: 0.2 }],
      recoveryTimeS: 1,
      control: { thrustMargin: 0.6, saturationFraction: 0 },
      divergedAtS: null,
      ...patch,
    }) as unknown as FlightMetrics;
  it('passes, marks a check within 10 % of its limit MARGINAL and fails past it', () => {
    expect(flightVerdict(metrics({}), DEFAULT_FLIGHT_LIMITS).verdict).toBe('PASS');
    const marginal = flightVerdict(metrics({ attitude: { maxTiltDeg: 42 } }), DEFAULT_FLIGHT_LIMITS);
    expect(marginal.verdict).toBe('MARGINAL');
    expect(marginal.checks.find((entry) => entry.name === 'max_attitude_deg')?.status).toBe('MARGINAL');
    expect(flightVerdict(metrics({ control: { thrustMargin: 0.31, saturationFraction: 0 } }), DEFAULT_FLIGHT_LIMITS).verdict).toBe(
      'MARGINAL',
    );
    expect(flightVerdict(metrics({ attitude: { maxTiltDeg: 50 } }), DEFAULT_FLIGHT_LIMITS).verdict).toBe('FAIL');
  });
  it('fails an event that never recovers and a divergence; open-loop checks are not applicable', () => {
    const never = flightVerdict(
      metrics({ recoveryTimeS: null, events: [{ kind: 'gust', timeS: 1, recoveryTimeS: null, peakErrorM: 1 }] }),
      DEFAULT_FLIGHT_LIMITS,
    );
    expect(never.checks.find((entry) => entry.name === 'recovery_time_s')).toMatchObject({ status: 'FAIL', value: null });
    const diverged = flightVerdict(metrics({ divergedAtS: 1.5 }), DEFAULT_FLIGHT_LIMITS);
    expect(diverged.verdict).toBe('FAIL');
    expect(diverged.checks.at(-1)?.note).toContain('t = 1.500 s');
    const open = flightVerdict(metrics({ control: null, events: [], recoveryTimeS: null }), DEFAULT_FLIGHT_LIMITS);
    expect(open.checks.filter((entry) => entry.status === 'not_applicable').map((entry) => entry.name)).toEqual([
      'thrust_margin',
      'saturation_fraction',
      'final_position_error_m',
      'recovery_time_s',
    ]);
    expect(open.verdict).toBe('PASS');
  });
});

describe('combineBlocks', () => {
  const block = (size: number, value: number, joint: string | null): ActuatorBlock => ({
    size,
    aux0: new Float64Array(size).fill(value),
    joints: joint === null ? [] : [joint],
    ledgerLayout: joint === null ? [] : [{ element: joint, kind: 'copper' }],
    advance: (_state, aux) => ({
      aux: aux.map((entry) => entry + value),
      jointForces: new Float64Array(joint === null ? 0 : 1).fill(value),
      bodyForces: [{ body: 'b', force: [value, 0, 0] }],
      ...(joint === null ? { bodyMoments: [{ body: 'b', moment: [0, 0, value] as Vec3 }] } : {}),
      ledger: new Float64Array(joint === null ? 0 : 1).fill(value),
    }),
  });
  it('runs two blocks as one: aux, joints, forces, moments and ledger concatenated in order', () => {
    const combined = combineBlocks(block(2, 1, 'j'), block(3, 10, null));
    expect(combined.size).toBe(5);
    expect([...combined.aux0]).toEqual([1, 1, 10, 10, 10]);
    expect(combined.joints).toEqual(['j']);
    expect(combined.ledgerLayout).toEqual([{ element: 'j', kind: 'copper' }]);
    const out = combined.advance({ time: 0, jointPosition: {}, jointVelocity: {} } as SimulationState, combined.aux0, 0.001);
    expect([...out.aux]).toEqual([2, 2, 20, 20, 20]);
    expect([...out.jointForces]).toEqual([1]);
    expect(out.bodyForces).toEqual([
      { body: 'b', force: [1, 0, 0] },
      { body: 'b', force: [10, 0, 0] },
    ]);
    expect(out.bodyMoments).toEqual([{ body: 'b', moment: [0, 0, 10] }]);
    expect([...out.ledger]).toEqual([1]);
  });
});
