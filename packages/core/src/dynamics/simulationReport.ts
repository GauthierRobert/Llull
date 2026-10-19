/**
 * Turns a raw `SimulationTrace` into what a designer (or an agent) asks of a mechanism: final speeds, whether and when it settled, engine
 * and propeller torque / power / thrust, and self-checks (measured gear ratios) — plus optional series and body poses for playback.
 */

import type { DynamicsModel } from '../model/dynamics';
import type { Vec3 } from '../model/vectors';
import { RAD_PER_S_PER_RPM, motorForce, propellerOutput } from './forceLaws';
import type { Quaternion, SimulationTrace } from './physicsEngine';
import type { BodyMassDistribution } from './simulationModel';
import { warnJams } from './jamDetection';
import { findPeriod, tailMean, type Period } from './periodicity';
import { energyOf, type EnergyData, type EnergySeries } from './energyReport';
import { speedTrend, trendWarning } from './speedTrend';

export type SimulationDetail = 'summary' | 'series' | 'poses';

/** A speed has settled once it stays within this fraction of its final value. */
const SETTLE_BAND = 0.02;
/** ISA sea-level speed of sound, m/s. */
const SPEED_OF_SOUND = 340.3;
/** Above this tip Mach number compressibility (not modelled) raises the propeller's power and noise sharply. */
const MAX_TIP_MACH = 0.85;
/** No real static propeller exceeds ~0.75 (NACA TR-684); above this the Ct / Cp pair is not physical. */
const MAX_FIGURE_OF_MERIT = 0.8;

interface JointResult {
  readonly kind: 'revolute' | 'prismatic';
  /** rad/s or m/s at the end. */
  readonly finalVelocity: number;
  /** Revolute only. */
  readonly finalRpm?: number;
  /** Peak |velocity| (rad/s or m/s). */
  readonly peakVelocity: number;
  /** Total travel: rad or m. */
  readonly finalPosition: number;
  /** First time after which the speed stays within 2 % of the final speed; null if it never does before the end. */
  readonly settledAfter: number | null;
  /** Speed changed by less than 0.5 % over the last 10 % of the run. */
  readonly steady: boolean;
  /** Not steady but repeating: the last two cycles of the speed match (a pendulum, an oscillating arm, a crank with speed ripple). */
  readonly periodic?: true;
  /** Seconds per cycle, when periodic. */
  readonly periodS?: number;
  /** Mean speed over the last full cycle (rad/s or m/s), when periodic. */
  readonly cycleMeanVelocity?: number;
  /** Revolute only, when periodic. */
  readonly cycleMeanRpm?: number;
}

/** Final state of a body that no joint carries (free fall, thrown): document units and m/s. */
interface FreeBodyResult {
  readonly finalPosition: Vec3;
  /** m/s, last two samples. */
  readonly finalVelocity: Vec3;
  /** m/s. */
  readonly speed: number;
}

export interface SimulationData {
  readonly engine: string;
  readonly duration: number;
  readonly timestep: number;
  readonly samples: number;
  readonly bodies: Record<string, { name?: string; massKg: number; centerOfMass: Vec3 }>;
  readonly joints: Record<string, JointResult>;
  /** torque / power are the values at the end; cycleMean* are averages over the last full cycle when the torque or speed repeats. */
  readonly motors: Record<
    string,
    { joint: string; torque: number; power: number; cycleMeanTorque?: number; cycleMeanPower?: number; periodS?: number }
  >;
  readonly freeBodies?: Record<string, FreeBodyResult>;
  /** tipMach: helical tip Mach number at the end (static: tip speed / 340.3 m/s); figureOfMerit: Ct^1.5 / (Cp·sqrt(π/2)). */
  readonly propellers: Record<
    string,
    { joint: string; rpm: number; thrust: number; torque: number; power: number; tipMach: number; figureOfMerit: number | null }
  >;
  /** measuredRatio = driven / driver speed at the end; maxRatioError over all samples with motion. */
  readonly gears: Record<string, { ratio: number; measuredRatio: number | null; maxRatioError: number }>;
  readonly warnings: string[];
  /** Energy balance in J, present when the run recorded energy (simulate_motion `energy: true`, or the model has a joint spring). */
  readonly energy?: EnergyData;
  /** Point springs (add_spring) of the run: lengths in m, forces in N (positive = pulling the bodies together). */
  readonly springs?: Record<
    string,
    { freeLengthM: number; finalLengthM: number; minLengthM: number; maxLengthM: number; finalForceN: number; peakForceN: number }
  >;
  readonly series?: {
    readonly times: number[];
    readonly jointVelocity: Record<string, number[]>;
    readonly jointPosition: Record<string, number[]>;
    readonly motorTorque: Record<string, number[]>;
    readonly propellerThrust: Record<string, number[]>;
    readonly propellerPower: Record<string, number[]>;
    /** Per sample, J (with `energy`). */
    readonly energy?: EnergySeries;
  };
  /** Body centre of mass (document units) and rotation from the start pose, per sample. */
  readonly poses?: { readonly times: number[]; readonly bodies: Record<string, { position: Vec3[]; orientation: Quaternion[] }> };
}

const last = (values: readonly number[]): number => values[values.length - 1] ?? 0;

/** A recorded series by id (every joint / body / servo of the model has one; absent ids read as empty). */
const seriesOf = <T>(record: Readonly<Record<string, T[]>>, id: string): T[] => record[id] ?? [];

function jointResult(
  kind: 'revolute' | 'prismatic',
  times: readonly number[],
  velocity: readonly number[],
  position: readonly number[],
): JointResult {
  const final = last(velocity);
  const band = Math.max(Math.abs(final) * SETTLE_BAND, 1e-6);
  let settleIndex = velocity.length - 1;
  while (settleIndex > 0 && Math.abs((velocity[settleIndex - 1] ?? 0) - final) <= band) settleIndex--;
  // steady = the whole last 10 % stays in a 0.5 % band (comparing two samples reads a periodic signal sampled in phase as steady)
  const tail = velocity.slice(Math.floor(velocity.length * 0.9));
  const tailSpread = tail.reduce((spread, v) => Math.max(spread, Math.abs(v - final)), 0);
  const steady = tailSpread <= Math.max(Math.abs(final) * 0.005, 1e-6);
  const period = steady ? null : findPeriod(velocity, times);
  const cycleMean = period === null ? null : tailMean(velocity, period.windowSamples);
  return {
    kind,
    finalVelocity: final,
    ...(kind === 'revolute' ? { finalRpm: final / RAD_PER_S_PER_RPM } : {}),
    peakVelocity: velocity.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0),
    finalPosition: last(position),
    settledAfter: steady ? (times[settleIndex] ?? null) : null,
    steady,
    ...(period !== null && cycleMean !== null
      ? {
          periodic: true as const,
          periodS: period.periodS,
          cycleMeanVelocity: cycleMean,
          ...(kind === 'revolute' ? { cycleMeanRpm: cycleMean / RAD_PER_S_PER_RPM } : {}),
        }
      : {}),
  };
}

/** Worst |measured/ratio - 1| over samples where the driver moves (> 1 % of its peak), and the sample index where it occurs. */
function gearRatioError(ratio: number, driver: readonly number[], driven: readonly number[]): { worst: number; index: number } {
  const peak = driver.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  let worst = 0;
  let index = 0;
  driver.forEach((v, i) => {
    const error = Math.abs(v) > peak * 0.01 ? Math.abs((driven[i] ?? 0) / (v * ratio) - 1) : 0;
    if (error > worst) [worst, index] = [error, i];
  });
  return { worst, index };
}

/** Length range and force of every point spring over the run, or null when there is none. */
function springResults(dynamics: DynamicsModel, trace: SimulationTrace): NonNullable<SimulationData['springs']> | null {
  const entries = Object.values(dynamics.springs ?? {}).flatMap((spring) => {
    const recorded = trace.springs?.[spring.id];
    if (recorded === undefined || recorded.length.length === 0) return [];
    return [
      [
        spring.id,
        {
          freeLengthM: spring.freeLengthM,
          finalLengthM: last(recorded.length),
          minLengthM: Math.min(...recorded.length),
          maxLengthM: Math.max(...recorded.length),
          finalForceN: last(recorded.force),
          peakForceN: recorded.force.reduce((peak, force) => Math.max(peak, Math.abs(force)), 0),
        },
      ] as const,
    ];
  });
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/** The structured result of one run (all forces re-evaluated on the samples with the same laws the engine applied). */
export function simulationData(
  dynamics: DynamicsModel,
  mass: Readonly<Record<string, BodyMassDistribution>>,
  trace: SimulationTrace,
  run: { engine: string; duration: number; timestep: number; detail: SimulationDetail; metresPerUnit: number },
): SimulationData {
  const velocityOf = (joint: string): number[] => seriesOf(trace.jointVelocity, joint);
  const warnings: string[] = [];
  const joints = Object.fromEntries(
    Object.values(dynamics.joints).flatMap((joint) =>
      joint.kind === 'spherical' || trace.jointVelocity[joint.id] === undefined
        ? []
        : [[joint.id, jointResult(joint.kind, trace.times, velocityOf(joint.id), seriesOf(trace.jointPosition, joint.id))] as const],
    ),
  );
  for (const [id, result] of Object.entries(joints))
    if (!result.steady && !result.periodic && result.peakVelocity > 1e-6) warnings.push(trendWarning(id, speedTrend(velocityOf(id))));
  const motorTorque = Object.fromEntries(
    Object.values(dynamics.motors).map((m) => [
      m.id,
      m.kind === 'speed' ? seriesOf(trace.servoForce, m.id) : velocityOf(m.joint).map((v) => motorForce(m, v)),
    ]),
  );
  const motors = Object.fromEntries(
    Object.values(dynamics.motors).map((m) => {
      const [torques, speeds] = [seriesOf(motorTorque, m.id), velocityOf(m.joint)];
      const torque = last(torques);
      const period: Period | null = findPeriod(torques, trace.times) ?? findPeriod(speeds, trace.times);
      const cycle =
        period === null
          ? {}
          : {
              periodS: period.periodS,
              cycleMeanTorque: tailMean(torques, period.windowSamples),
              cycleMeanPower: tailMean(
                torques.map((t, i) => t * (speeds[i] ?? 0)),
                period.windowSamples,
              ),
            };
      return [m.id, { joint: m.joint, torque, power: torque * last(speeds), ...cycle }];
    }),
  );
  warnJams(dynamics, trace, motorTorque, warnings);
  const freeCarried = new Set(Object.values(dynamics.joints).map((joint) => joint.child));
  const freeBodies = Object.fromEntries(
    Object.values(dynamics.bodies).flatMap((body) => {
      const track = seriesOf(trace.bodyPosition, body.id);
      const [end, before] = [track[track.length - 1], track[track.length - 2]];
      if (body.fixed || freeCarried.has(body.id) || end === undefined) return [];
      const [t0, t1] = [trace.times[track.length - 1] ?? 0, trace.times[track.length - 2] ?? 0];
      const dt = t0 - t1;
      const older = track[track.length - 3];
      // backward difference of second order (uniform samples) so a falling body's speed is the end value, not the last interval's mean
      const velocity = (before === undefined || dt <= 0
        ? [0, 0, 0]
        : end.map((c, k) =>
            older === undefined ? (c - (before[k] ?? c)) / dt : (3 * c - 4 * (before[k] ?? c) + (older[k] ?? c)) / (2 * dt),
          )) as unknown as Vec3;
      return [
        [
          body.id,
          {
            finalPosition: end.map((c) => c / run.metresPerUnit) as unknown as Vec3,
            finalVelocity: velocity,
            speed: Math.hypot(velocity[0], velocity[1], velocity[2]),
          },
        ] as const,
      ];
    }),
  );
  const outputs = Object.fromEntries(
    Object.values(dynamics.propellers).map((p) => [p.id, velocityOf(p.joint).map((v) => propellerOutput(p, v))]),
  );
  const propellers = Object.fromEntries(
    Object.values(dynamics.propellers).map((p) => {
      const omega = last(velocityOf(p.joint));
      const end = propellerOutput(p, omega);
      const tipMach = (Math.abs(omega) * p.diameter) / 2 / SPEED_OF_SOUND;
      if (end.outsideTable === true)
        warnings.push(
          `FPR_OUTSIDE_VALIDATED_RANGE: propeller '${p.id}' runs at J = ${(end.advanceRatio ?? 0).toFixed(3)}, beyond its table (last J ${Math.max(...(p.table?.points.map((point) => point[0]) ?? [0]))}): the coefficients are held at the last point`,
        );
      const figureOfMerit = p.powerCoefficient > 0 ? p.thrustCoefficient ** 1.5 / (p.powerCoefficient * Math.sqrt(Math.PI / 2)) : null;
      if (tipMach > MAX_TIP_MACH)
        warnings.push(
          `propeller '${p.id}' tips reach Mach ${tipMach.toFixed(2)}: compressibility (not modelled) makes real thrust lower and power higher`,
        );
      if (figureOfMerit !== null && figureOfMerit > MAX_FIGURE_OF_MERIT)
        warnings.push(
          `propeller '${p.id}' coefficients give a figure of merit of ${figureOfMerit.toFixed(2)} (> ${MAX_FIGURE_OF_MERIT}, beyond any real propeller): check Ct / Cp`,
        );
      return [p.id, { joint: p.joint, rpm: omega / RAD_PER_S_PER_RPM, ...end, tipMach, figureOfMerit }];
    }),
  );
  const gears = Object.fromEntries(
    Object.values(dynamics.gears).map((gear) => {
      const [driver, driven] = [velocityOf(gear.driver), velocityOf(gear.driven)];
      const { worst: error, index } = gearRatioError(gear.ratio, driver, driven);
      if (error > 0.01) {
        const at = last(trace.times.slice(0, index + 1));
        const late = at > run.duration * 0.1;
        warnings.push(
          `gear '${gear.id}' deviated from its ratio by up to ${(error * 100).toFixed(2)} % at t = ${at.toFixed(3)} s` +
            (late
              ? ' — the coupled inertias are too different for this timestep: lower the timestep'
              : ' (start transient: the light driver accelerates violently; a lower timestep or the real crankshaft inertia reduces it)'),
        );
      }
      return [gear.id, { ratio: gear.ratio, measuredRatio: last(driver) !== 0 ? last(driven) / last(driver) : null, maxRatioError: error }];
    }),
  );
  const bodies = Object.fromEntries(
    Object.entries(mass).map(([id, props]) => {
      const name = dynamics.bodies[id]?.name;
      const centerOfMass = props.centerOfMass.map((c) => c / run.metresPerUnit) as unknown as Vec3;
      return [id, { ...(name !== undefined ? { name } : {}), massKg: props.mass, centerOfMass }];
    }),
  );
  const balance = energyOf(dynamics, trace);
  const springs = springResults(dynamics, trace);
  const base = { engine: run.engine, duration: run.duration, timestep: run.timestep, samples: trace.times.length };
  const data: SimulationData = {
    ...base,
    bodies,
    joints,
    motors,
    ...(Object.keys(freeBodies).length > 0 ? { freeBodies } : {}),
    propellers,
    gears,
    warnings,
    ...(balance !== null ? { energy: balance.data } : {}),
    ...(springs !== null ? { springs } : {}),
  };
  if (run.detail === 'summary') return data;
  const series = {
    times: trace.times,
    jointVelocity: trace.jointVelocity,
    jointPosition: trace.jointPosition,
    motorTorque,
    propellerThrust: Object.fromEntries(Object.entries(outputs).map(([id, o]) => [id, o.map((x) => x.thrust)])),
    propellerPower: Object.fromEntries(Object.entries(outputs).map(([id, o]) => [id, o.map((x) => x.power)])),
    ...(balance !== null ? { energy: balance.series } : {}),
  };
  if (run.detail === 'series') return { ...data, series };
  const poses = {
    times: trace.times,
    bodies: Object.fromEntries(
      Object.keys(trace.bodyPosition).map((id) => [
        id,
        {
          position: seriesOf(trace.bodyPosition, id).map((p) => p.map((c) => c / run.metresPerUnit) as unknown as Vec3),
          orientation: seriesOf(trace.bodyOrientation, id),
        },
      ]),
    ),
  };
  return { ...data, series, poses };
}

const formatNumber = (value: number, digits: number): string => value.toLocaleString('en-US', { maximumFractionDigits: digits });

/** One-paragraph human / agent summary of a run. */
export function simulationSummary(data: SimulationData): string {
  const parts = [`simulate_motion: ${formatNumber(data.duration, 3)} s with ${data.engine}.`];
  for (const [id, joint] of Object.entries(data.joints)) {
    const unit = joint.finalRpm !== undefined ? 'rpm' : 'm/s';
    const show = (rpm: number | undefined, velocity: number): string =>
      rpm !== undefined ? `${formatNumber(rpm, 1)} rpm` : `${formatNumber(velocity, 4)} ${unit}`;
    if (joint.periodic && joint.periodS !== undefined)
      parts.push(
        `Joint ${id}: periodic, period ${formatNumber(joint.periodS, 3)} s, cycle-mean ${show(joint.cycleMeanRpm, joint.cycleMeanVelocity ?? 0)}, ` +
          `peak ${show(joint.kind === 'revolute' ? joint.peakVelocity / RAD_PER_S_PER_RPM : undefined, joint.peakVelocity)}, travel ${formatNumber(joint.finalPosition, 4)} ${joint.kind === 'revolute' ? 'rad' : 'm'} at the end.`,
      );
    else {
      const settled = joint.steady ? `steady after ${formatNumber(joint.settledAfter ?? 0, 2)} s` : 'not yet steady';
      parts.push(`Joint ${id}: ${show(joint.finalRpm, joint.finalVelocity)} (${settled}).`);
    }
  }
  for (const [id, motor] of Object.entries(data.motors))
    parts.push(
      motor.cycleMeanTorque !== undefined && motor.cycleMeanPower !== undefined
        ? `Motor ${id}: cycle-mean ${formatNumber(motor.cycleMeanTorque, 1)} N·m, ${formatNumber(motor.cycleMeanPower / 1000, 2)} kW ` +
            `(period ${formatNumber(motor.periodS ?? 0, 3)} s; at the end ${formatNumber(motor.torque, 1)} N·m).`
        : `Motor ${id}: ${formatNumber(motor.torque, 1)} N·m, ${formatNumber(motor.power / 1000, 2)} kW.`,
    );
  for (const [id, body] of Object.entries(data.freeBodies ?? {}))
    parts.push(
      `Body ${id}: free, ends at [${body.finalPosition.map((c) => formatNumber(c, 2)).join(', ')}] with velocity ` +
        `[${body.finalVelocity.map((c) => formatNumber(c, 3)).join(', ')}] m/s (speed ${formatNumber(body.speed, 3)} m/s).`,
    );
  for (const [id, prop] of Object.entries(data.propellers))
    parts.push(
      `Propeller ${id}: ${formatNumber(prop.rpm, 1)} rpm, thrust ${formatNumber(prop.thrust, 1)} N, ` +
        `torque ${formatNumber(prop.torque, 1)} N·m, absorbing ${formatNumber(prop.power / 1000, 2)} kW.`,
    );
  for (const [id, gear] of Object.entries(data.gears))
    parts.push(`Gear ${id}: ratio ${formatNumber(gear.ratio, 4)} held within ${formatNumber(gear.maxRatioError * 100, 3)} %.`);
  if (data.energy !== undefined) {
    const e = data.energy;
    const joules = (value: number): string => formatNumber(Math.abs(value) < 1e-9 ? 0 : value, 4);
    parts.push(
      `Energy: total ${joules(e.initialTotalJ)} -> ${joules(e.finalTotalJ)} J (end: kinetic ${joules(e.finalKineticJ)}, ` +
        `potential ${joules(e.finalPotentialJ)} J relative to the start pose), dissipated by damping and friction ${joules(e.dissipatedJ)} J, ` +
        `largest departure from the initial total ${formatNumber(e.maxDeviationFraction * 100, 3)} % of the peak energy.`,
    );
    if (e.inputWorkJ !== undefined && (e.inputWorkJ !== 0 || (e.propellerWorkJ ?? 0) !== 0 || e.dissipatedJ > 0))
      parts.push(
        `Input work ${joules(e.inputWorkJ)} J (motors, governors, gas pressure), absorbed by propellers ${joules(e.propellerWorkJ ?? 0)} J; ` +
          `balance initial + input - dissipated - propellers - final = ${joules(e.balanceErrorJ ?? 0)} J (${formatNumber((e.balanceErrorFraction ?? 0) * 100, 3)} %).`,
      );
  }
  for (const [id, spring] of Object.entries(data.springs ?? {}))
    parts.push(
      `Spring ${id}: length ${formatNumber(spring.minLengthM * 1000, 3)} to ${formatNumber(spring.maxLengthM * 1000, 3)} mm (free ${formatNumber(spring.freeLengthM * 1000, 3)} mm), ` +
        `force ${formatNumber(spring.finalForceN, 3)} N at the end, peak ${formatNumber(spring.peakForceN, 3)} N.`,
    );
  if (data.warnings.length > 0) parts.push(`Warnings: ${data.warnings.join('; ')}.`);
  return parts.join(' ');
}
