/**
 * Engine report of a run with cylinder pressures (FR-FPR-16, TR-FPR §5.4): torque against crank angle per cylinder and total over the
 * last full cycle (1 deg grid), mean torque, indicated power, IMEP, cycle-energy closure, speed ripple, peak pressure and the derived
 * bearing / pin / thrust loads. Reactions are read from the trace when it has them.
 */

import type { DynamicsModel } from '../model/dynamics';
import type { Vec3 } from '../model/vectors';
import { cylinderState, type CylinderRuntime } from './cylinderLoads';
import { cycleLength } from './pressureCurve';
import type { Quaternion, SimulationTrace } from './physicsEngine';
import { childForceSeries, peakOf, type Peak } from './reactions';
import { inertiaAboutAxis, type BodyMassProperties } from './simulationModel';
import { sliderRate } from './slider';
import type { Topology } from './topology';

/** Cycle-energy closure gate, 0.5 % (named, FR-FPR-16). */
const ENERGY_CLOSURE_GATE = 0.005;
/** Angular spacing of the reported curves, deg. */
const RESAMPLE_DEG = 1;
/** Samples further apart than this on the crank angle make the curves unreliable (FPR_SAMPLING_COARSE), deg. */
const COARSE_SAMPLING_DEG = 2;
/** The closure is not evaluated when the net work is below this fraction of the gross (peak gauge pressure x displacement). */
const MIN_NET_WORK_FRACTION = 1e-3;

const RADIANS_PER_DEG = Math.PI / 180;

interface DerivedLoads {
  readonly wristPinN: Peak;
  readonly rodAxialN: Peak;
  readonly sideThrustN: Peak;
  readonly crankPinN: Peak;
  readonly mainBearingN: Peak;
}

interface CylinderReport {
  readonly id: string;
  readonly piston: string;
  readonly crank: string;
  readonly boreMm: number;
  readonly strokeMm: number;
  readonly crankRadiusMm: number;
  readonly rodLengthMm: number;
  readonly offsetCylinder: boolean;
  readonly displacementCm3: number;
  readonly topCrankDeg: number;
  readonly model: string;
  /** IMEP from the pressure curve (net, bar) and the peak absolute pressure and its cycle angle. */
  readonly imepBar: number;
  readonly peakPressureBar: number;
  readonly peakAngleDeg: number;
  readonly heatJ: number | null;
  readonly unverified: boolean;
  readonly derived: DerivedLoads | null;
}

export interface EngineData {
  readonly crankJoint: string;
  readonly cycle: 'four_stroke' | 'two_stroke';
  readonly cylinders: CylinderReport[];
  /** Last full cycle used for the curves and means; null when the run is shorter than one cycle. */
  readonly lastCycle: { fromS: number; toS: number; meanRpm: number; resolutionDeg: number } | null;
  readonly meanTorqueNm: number | null;
  readonly indicatedPowerKW: number | null;
  readonly energyClosure: {
    ratio: number | null;
    gate: number;
    status: 'pass' | 'fail' | 'not_evaluated';
    integralJ: number;
    expectedJ: number;
  } | null;
  readonly speedRipple: { measured: number; analytic: number | null; crankInertiaKgM2: number; relativeDifference: number | null } | null;
  readonly governor: { meanTorqueNm: number; balanceError: number } | null;
  readonly torqueCurve?: { angleDeg: number[]; totalNm: number[]; perCylinderNm: Record<string, number[]> };
  readonly warnings: string[];
}

/** Linear interpolation of `ys` at `x` over increasing `xs`; clamps outside. */
function lerpAt(xs: readonly number[], ys: readonly number[], x: number): number {
  let [lo, hi] = [0, xs.length - 1];
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0;
  if (x >= (xs[hi] ?? 0)) return ys[hi] ?? 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) <= x) lo = mid;
    else hi = mid;
  }
  const span = (xs[hi] ?? 0) - (xs[lo] ?? 0);
  const fraction = span > 0 ? (x - (xs[lo] ?? 0)) / span : 0;
  return (ys[lo] ?? 0) * (1 - fraction) + (ys[hi] ?? 0) * fraction;
}

function rotate(q: Quaternion, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const t: Vec3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

/** Cycle angle (deg) of `runtime` at each recorded sample of the trace; null when the trace has no crank series. */
export function cycleAngleSeries(runtime: CylinderRuntime, trace: SimulationTrace): number[] | null {
  const theta = trace.jointPosition[runtime.layout.crankJoint];
  if (theta === undefined) return null;
  const cycleDeg = cycleLength(runtime.cylinder.cycle);
  return theta.map(
    (t) => ((((t - runtime.topAngleRad) / RADIANS_PER_DEG + runtime.cylinder.firingOffsetDeg) % cycleDeg) + cycleDeg) % cycleDeg,
  );
}

/** World track (metres) of the anchor of joint `jointId` carried by `body`, at each sample, from the body's pose. */
function pinTrack(input: EngineInput, body: string, jointId: string): Vec3[] {
  const { dynamics, mass, trace, metresPerUnit: m } = input;
  const joint = dynamics.joints[jointId];
  const props = mass[body];
  const positions = trace.bodyPosition[body];
  const orientations = trace.bodyOrientation[body];
  if (joint === undefined || props === undefined || positions === undefined || orientations === undefined) return [];
  const local: Vec3 = [
    joint.anchor[0] * m - props.centerOfMass[0],
    joint.anchor[1] * m - props.centerOfMass[1],
    joint.anchor[2] * m - props.centerOfMass[2],
  ];
  return positions.map((p, i) => {
    const r = rotate(orientations[i] ?? [1, 0, 0, 0], local);
    return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
  });
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function derivedLoads(runtime: CylinderRuntime, input: EngineInput, angleDeg: readonly number[] | null): DerivedLoads | null {
  const { topology, trace } = input;
  const { layout } = runtime;
  const wrist = childForceSeries(topology, trace, layout.wristJoint);
  const pin = childForceSeries(topology, trace, layout.crankPinJoint);
  const bearing = childForceSeries(topology, trace, layout.crankJoint);
  const slide = childForceSeries(topology, trace, layout.pistonJoint);
  if (wrist === null || pin === null || bearing === null || slide === null) return null;
  const head = layout.headDirection;
  const lateral = slide.map((f): Vec3 => {
    const along = dot(f, head);
    return [f[0] - along * head[0], f[1] - along * head[1], f[2] - along * head[2]];
  });
  const wristTrack = pinTrack(input, layout.rodBody, layout.wristJoint);
  const pinPoints = pinTrack(input, layout.rodBody, layout.crankPinJoint);
  const axial = wrist.map((f, i): Vec3 => {
    const [a, b] = [wristTrack[i], pinPoints[i]];
    if (a === undefined || b === undefined) return f;
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(d[0], d[1], d[2]);
    return [length > 0 ? dot(f, d) / length : 0, 0, 0];
  });
  return {
    wristPinN: peakOf(wrist, trace.times, angleDeg),
    rodAxialN: peakOf(axial, trace.times, angleDeg),
    sideThrustN: peakOf(lateral, trace.times, angleDeg),
    crankPinN: peakOf(pin, trace.times, angleDeg),
    mainBearingN: peakOf(bearing, trace.times, angleDeg),
  };
}

export interface EngineInput {
  readonly dynamics: DynamicsModel;
  readonly topology: Topology;
  readonly runtimes: readonly CylinderRuntime[];
  readonly trace: SimulationTrace;
  readonly mass: Readonly<Record<string, BodyMassProperties>>;
  readonly metresPerUnit: number;
  /** Include the torque curves. */
  readonly series: boolean;
}

/** Trapezoid integral of `values` over a uniform grid of `step`. */
const integrate = (values: readonly number[], step: number): number =>
  values.reduce((sum, v, i) => (i === 0 ? 0 : sum + 0.5 * (v + (values[i - 1] ?? 0)) * step), 0);

/** The engine report of the first crank that has cylinder pressures; null when the model has none. */
export function engineData(input: EngineInput): EngineData | null {
  const first = input.runtimes[0];
  if (first === undefined) return null;
  const crank = first.layout.crankJoint;
  const runtimes = input.runtimes.filter((runtime) => runtime.layout.crankJoint === crank);
  const { trace } = input;
  const warnings: string[] = [];
  if (runtimes.length < input.runtimes.length) warnings.push(`cylinders on other cranks than '${crank}' are not reported here`);
  if (runtimes.some((runtime) => runtime.cylinder.model.kind === 'table' && runtime.cylinder.model.source === undefined))
    warnings.push('unverified: a pressure table has no source');
  const theta = trace.jointPosition[crank] ?? [];
  const omega = trace.jointVelocity[crank] ?? [];
  const cycleDeg = cycleLength(first.cylinder.cycle);
  const angleDeg = cycleAngleSeries(first, trace);
  const lastRpm = Math.max(0, ((omega[omega.length - 1] ?? 0) * 60) / (2 * Math.PI));
  const cylinders: CylinderReport[] = runtimes.map((runtime) => {
    const curve = runtime.curveAt(lastRpm);
    const { layout } = runtime;
    return {
      id: runtime.cylinder.id,
      piston: layout.pistonJoint,
      crank: layout.crankJoint,
      boreMm: runtime.cylinder.boreMm,
      strokeMm: layout.strokeM * 1000,
      crankRadiusMm: layout.slider.r * 1000,
      rodLengthMm: layout.slider.l * 1000,
      offsetCylinder: layout.offset,
      displacementCm3: layout.displacementM3 * 1e6,
      topCrankDeg: (runtime.topAngleRad / RADIANS_PER_DEG) % 360,
      model: runtime.cylinder.model.kind,
      imepBar: curve.imepPa / 1e5,
      peakPressureBar: curve.peakPa / 1e5,
      peakAngleDeg: curve.peakAngleDeg,
      heatJ: curve.heatJ,
      unverified: runtime.cylinder.model.kind === 'table' && runtime.cylinder.model.source === undefined,
      derived: derivedLoads(runtime, input, angleDeg),
    };
  });
  const swept = (theta[theta.length - 1] ?? 0) - (theta[0] ?? 0);
  const cycleRad = cycleDeg * RADIANS_PER_DEG;
  const spacing = theta.length > 1 ? Math.abs(swept) / (theta.length - 1) / RADIANS_PER_DEG : Infinity;
  if (spacing > COARSE_SAMPLING_DEG)
    warnings.push(
      `FPR_SAMPLING_COARSE: samples are ${spacing.toFixed(1)} deg of crank apart (> ${COARSE_SAMPLING_DEG}); set sampleRate higher for peaks and curves`,
    );
  const increasing = theta.every((t, i) => i === 0 || t >= (theta[i - 1] ?? 0));
  if (swept < 0 || !increasing)
    warnings.push(`the crank '${crank}' does not turn steadily in its positive sense: cycle angles run backwards; flip the joint axis`);
  const base = { crankJoint: crank, cycle: first.cylinder.cycle, cylinders, warnings };
  if (swept < cycleRad || !increasing) {
    warnings.push(
      `the run covers ${(swept / RADIANS_PER_DEG).toFixed(0)} deg of crank, less than one ${first.cylinder.cycle} cycle (${cycleDeg}): simulate longer for curves, closure and ripple`,
    );
    return { ...base, lastCycle: null, meanTorqueNm: null, indicatedPowerKW: null, energyClosure: null, speedRipple: null, governor: null };
  }
  const end = theta[theta.length - 1] ?? 0;
  const grid = Array.from(
    { length: Math.round(cycleDeg / RESAMPLE_DEG) + 1 },
    (_, k) => end - cycleRad + k * RESAMPLE_DEG * RADIANS_PER_DEG,
  );
  const times = grid.map((angle) => lerpAt(theta, trace.times, angle));
  const speeds = grid.map((angle) => lerpAt(theta, omega, angle));
  const perCylinder: Record<string, number[]> = {};
  for (const runtime of runtimes) {
    perCylinder[runtime.cylinder.id] = grid.map((angle, k) => {
      const state = cylinderState(runtime, angle, speeds[k] ?? 0);
      return state.forceN * sliderRate(runtime.layout.slider, angle - runtime.topAngleRad);
    });
  }
  const total = grid.map((_, k) => runtimes.reduce((sum, runtime) => sum + (perCylinder[runtime.cylinder.id]?.[k] ?? 0), 0));
  const step = RESAMPLE_DEG * RADIANS_PER_DEG;
  const integral = integrate(total, step);
  const duration = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  const meanOmega = duration > 0 ? cycleRad / duration : 0;
  const meanRpm = (meanOmega * 60) / (2 * Math.PI);
  const meanTorque = integral / cycleRad;
  const curves = runtimes.map((runtime) => ({ curve: runtime.curveAt(meanRpm), displacement: runtime.layout.displacementM3 }));
  const expected = curves.reduce((sum, { curve }) => sum + curve.workJ, 0);
  const gross = curves.reduce((sum, { curve, displacement }) => sum + curve.peakPa * displacement, 0);
  const ratio = Math.abs(expected) > MIN_NET_WORK_FRACTION * gross ? Math.abs(integral - expected) / Math.abs(expected) : null;
  const status = ratio === null ? 'not_evaluated' : ratio <= ENERGY_CLOSURE_GATE ? 'pass' : 'fail';
  if (status === 'fail')
    warnings.push(
      `FPR_ENERGY_CLOSURE (fail): the torque curve integrates to ${integral.toPrecision(5)} J but the cylinders do ${expected.toPrecision(5)} J ` +
        `(${((ratio ?? 0) * 100).toFixed(2)} %, gate ${ENERGY_CLOSURE_GATE * 100} %): use a smaller timestep or set_dynamics_solver`,
    );
  const crankJoint = input.dynamics.joints[crank];
  const crankBody = crankJoint === undefined ? undefined : input.mass[crankJoint.child];
  const inertia =
    crankJoint === undefined || crankBody === undefined
      ? 0
      : inertiaAboutAxis(crankBody, crankJoint.anchor.map((c) => c * input.metresPerUnit) as unknown as Vec3, crankJoint.axis);
  const inLastCycle = trace.times.flatMap((t, i) => (t >= (times[0] ?? 0) - 1e-12 ? [omega[i] ?? 0] : []));
  const measured = meanOmega > 0 ? (Math.max(...inLastCycle) - Math.min(...inLastCycle)) / meanOmega : 0;
  let [cumulative, high, low] = [0, 0, 0];
  total.forEach((value, k) => {
    if (k > 0) cumulative += 0.5 * (value + (total[k - 1] ?? 0) - 2 * meanTorque) * step;
    [high, low] = [Math.max(high, cumulative), Math.min(low, cumulative)];
  });
  const analytic = inertia > 0 && meanOmega > 0 ? (high - low) / (inertia * meanOmega ** 2) : null;
  const governor = Object.values(input.dynamics.motors).find((motor) => motor.kind === 'speed' && motor.joint === crank);
  const governed =
    governor === undefined ? undefined : trace.servoForce[governor.id]?.filter((_, i) => (trace.times[i] ?? 0) >= (times[0] ?? 0) - 1e-12);
  const governorMean = governed === undefined || governed.length === 0 ? null : governed.reduce((sum, v) => sum + v, 0) / governed.length;
  return {
    ...base,
    lastCycle: { fromS: times[0] ?? 0, toS: times[times.length - 1] ?? 0, meanRpm, resolutionDeg: RESAMPLE_DEG },
    meanTorqueNm: meanTorque,
    indicatedPowerKW: (meanTorque * meanOmega) / 1000,
    energyClosure: { ratio, gate: ENERGY_CLOSURE_GATE, status, integralJ: integral, expectedJ: expected },
    speedRipple: {
      measured,
      analytic,
      crankInertiaKgM2: inertia,
      relativeDifference: analytic !== null && analytic > 0 ? Math.abs(measured - analytic) / analytic : null,
    },
    governor:
      governorMean === null
        ? null
        : {
            meanTorqueNm: governorMean,
            balanceError: meanTorque !== 0 ? Math.abs(governorMean + meanTorque) / Math.abs(meanTorque) : Math.abs(governorMean),
          },
    ...(input.series
      ? { torqueCurve: { angleDeg: grid.map((_, k) => k * RESAMPLE_DEG), totalNm: total, perCylinderNm: perCylinder } }
      : {}),
  };
}
