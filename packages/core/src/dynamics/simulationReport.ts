/**
 * Turns a raw `SimulationTrace` into what a designer (or an agent) asks of a mechanism: final speeds, whether and when it settled, engine
 * and propeller torque / power / thrust, and self-checks (measured gear ratios) — plus optional series and body poses for playback.
 */

import type { DynamicsModel } from '../model/dynamics';
import type { Vec3 } from '../model/vectors';
import { RAD_PER_S_PER_RPM, motorForce, propellerOutput } from './forceLaws';
import type { Quaternion, SimulationTrace } from './physicsEngine';
import type { BodyMassProperties } from './simulationModel';

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
}

export interface SimulationData {
  readonly engine: string;
  readonly duration: number;
  readonly timestep: number;
  readonly samples: number;
  readonly bodies: Record<string, { name?: string; massKg: number; centerOfMass: Vec3 }>;
  readonly joints: Record<string, JointResult>;
  readonly motors: Record<string, { joint: string; torque: number; power: number }>;
  /** tipMach: helical tip Mach number at the end (static: tip speed / 340.3 m/s); figureOfMerit: Ct^1.5 / (Cp·sqrt(π/2)). */
  readonly propellers: Record<
    string,
    { joint: string; rpm: number; thrust: number; torque: number; power: number; tipMach: number; figureOfMerit: number | null }
  >;
  /** measuredRatio = driven / driver speed at the end; maxRatioError over all samples with motion. */
  readonly gears: Record<string, { ratio: number; measuredRatio: number | null; maxRatioError: number }>;
  readonly warnings: string[];
  readonly series?: {
    readonly times: number[];
    readonly jointVelocity: Record<string, number[]>;
    readonly jointPosition: Record<string, number[]>;
    readonly motorTorque: Record<string, number[]>;
    readonly propellerThrust: Record<string, number[]>;
    readonly propellerPower: Record<string, number[]>;
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
  const tailStart = velocity[Math.floor(velocity.length * 0.9)] ?? final;
  const steady = Math.abs(final - tailStart) <= Math.max(Math.abs(final) * 0.005, 1e-6);
  return {
    kind,
    finalVelocity: final,
    ...(kind === 'revolute' ? { finalRpm: final / RAD_PER_S_PER_RPM } : {}),
    peakVelocity: velocity.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0),
    finalPosition: last(position),
    settledAfter: steady ? (times[settleIndex] ?? null) : null,
    steady,
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

/** The structured result of one run (all forces re-evaluated on the samples with the same laws the engine applied). */
export function simulationData(
  dynamics: DynamicsModel,
  mass: Readonly<Record<string, BodyMassProperties>>,
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
    if (!result.steady && result.peakVelocity > 1e-6)
      warnings.push(`joint '${id}' is still accelerating at the end: simulate longer for its steady speed`);
  const motorTorque = Object.fromEntries(
    Object.values(dynamics.motors).map((m) => [
      m.id,
      m.kind === 'speed' ? seriesOf(trace.servoForce, m.id) : velocityOf(m.joint).map((v) => motorForce(m, v)),
    ]),
  );
  const motors = Object.fromEntries(
    Object.values(dynamics.motors).map((m) => {
      const torque = last(seriesOf(motorTorque, m.id));
      return [m.id, { joint: m.joint, torque, power: torque * last(velocityOf(m.joint)) }];
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
  const base = { engine: run.engine, duration: run.duration, timestep: run.timestep, samples: trace.times.length };
  const data: SimulationData = { ...base, bodies, joints, motors, propellers, gears, warnings };
  if (run.detail === 'summary') return data;
  const series = {
    times: trace.times,
    jointVelocity: trace.jointVelocity,
    jointPosition: trace.jointPosition,
    motorTorque,
    propellerThrust: Object.fromEntries(Object.entries(outputs).map(([id, o]) => [id, o.map((x) => x.thrust)])),
    propellerPower: Object.fromEntries(Object.entries(outputs).map(([id, o]) => [id, o.map((x) => x.power)])),
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
    const speed = joint.finalRpm !== undefined ? `${formatNumber(joint.finalRpm, 1)} rpm` : `${formatNumber(joint.finalVelocity, 4)} m/s`;
    const settled = joint.steady ? `steady after ${formatNumber(joint.settledAfter ?? 0, 2)} s` : 'not yet steady';
    parts.push(`Joint ${id}: ${speed} (${settled}).`);
  }
  for (const [id, motor] of Object.entries(data.motors))
    parts.push(`Motor ${id}: ${formatNumber(motor.torque, 1)} N·m, ${formatNumber(motor.power / 1000, 2)} kW.`);
  for (const [id, prop] of Object.entries(data.propellers))
    parts.push(
      `Propeller ${id}: ${formatNumber(prop.rpm, 1)} rpm, thrust ${formatNumber(prop.thrust, 1)} N, ` +
        `torque ${formatNumber(prop.torque, 1)} N·m, absorbing ${formatNumber(prop.power / 1000, 2)} kW.`,
    );
  for (const [id, gear] of Object.entries(data.gears))
    parts.push(`Gear ${id}: ratio ${formatNumber(gear.ratio, 4)} held within ${formatNumber(gear.maxRatioError * 100, 3)} %.`);
  if (data.warnings.length > 0) parts.push(`Warnings: ${data.warnings.join('; ')}.`);
  return parts.join(' ');
}
