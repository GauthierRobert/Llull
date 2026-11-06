/**
 * The `ActuatorBlock` of a document's datasheet motors (PHY-23 TR-DRV-01): every DC motor that has a drive becomes one electrical + controller
 * state in `aux`, advanced once per physics step with the exact winding law, and a per-motor energy ledger.
 */

import type { ActuatorBlock, LedgerKind } from '@core/dynamics/physicsEngine';
import { compileProfile, isProfileRefusal, profileUnitScale, type CompiledProfile } from '@core/geometry/motionProfile';
import type { DcMotor, MotorDrive } from '@core/model/drives';
import type { DynamicsModel } from '@core/model/dynamics';
import { AUX, AUX_SIZE, MAX_BANDWIDTH_PER_RATE, tunedGains, updateLoop, type LoopGains, type LoopSpec } from './controller';
import { dcParameters, electricalStep, jointTorque, shaftTorqueFor, type DcParameters } from './dcMotor';

/** A profile resolved for a run: compiled, with its unit scale to SI. */
interface ResolvedProfile {
  readonly profile: CompiledProfile;
  readonly scale: number;
  readonly quantity: string;
}

/** A motor with a drive, ready to run. */
export interface DriveRuntime {
  readonly motor: DcMotor;
  readonly drive: MotorDrive;
  readonly params: DcParameters;
  /** Index of the motor's first slot in `aux`. */
  readonly base: number;
  /** Index of the motor's first entry in the ledger. */
  readonly ledgerBase: number;
  /** Joint the controller measures. */
  readonly target: string;
  readonly currentLimitA: number;
  readonly busVoltageV: number;
  /** Constant terminal voltage (voltage mode without a profile), V. */
  readonly constantVolts: number;
  /** The profile the drive follows (any mode), null for a constant voltage. */
  readonly resolved: ResolvedProfile | null;
  readonly loop: LoopSpec | null;
}

export interface ActuatorRefusal {
  readonly code: 'DRV_PROFILE_INVALID' | 'DRV_CONTROL_RATE' | 'DRV_TUNE_NO_INERTIA' | 'DRV_JOINT_INVALID';
  readonly error: string;
}

export interface ActuatorBuild {
  readonly block: ActuatorBlock;
  readonly drives: readonly DriveRuntime[];
}

export interface ActuatorContext {
  readonly timestep: number;
  /** kg·m² about the joint (bodies it carries + armature), or undefined when the joint cannot move. */
  readonly inertiaOf: (joint: string) => number | undefined;
}

const LEDGER_KINDS: readonly LedgerKind[] = ['electrical_input', 'copper', 'magnetic', 'transmission_loss', 'regeneration'];

const MODE_QUANTITY: Readonly<Record<MotorDrive['mode'], readonly string[]>> = {
  voltage: ['voltage'],
  torque: ['torque'],
  velocity: ['velocity'],
  position: ['position'],
  prescribed: ['position', 'velocity'],
};

const refusal = (code: ActuatorRefusal['code'], error: string): ActuatorRefusal => ({ code, error });
const isRefusal = (value: unknown): value is ActuatorRefusal =>
  typeof value === 'object' && value !== null && 'code' in value && 'error' in value;

function resolveProfile(dynamics: DynamicsModel, drive: MotorDrive): ResolvedProfile | null | ActuatorRefusal {
  if (drive.profile === undefined) return null;
  const stored = dynamics.profiles?.[drive.profile];
  if (stored === undefined) return refusal('DRV_PROFILE_INVALID', `drive of '${drive.id}': profile '${drive.profile}' not found`);
  if (!MODE_QUANTITY[drive.mode].includes(stored.quantity))
    return refusal(
      'DRV_PROFILE_INVALID',
      `drive of '${drive.id}' (${drive.mode}) needs a ${MODE_QUANTITY[drive.mode].join(' or ')} profile, '${stored.id}' is ${stored.quantity}`,
    );
  const compiled = compileProfile(stored);
  if (isProfileRefusal(compiled)) return refusal('DRV_PROFILE_INVALID', `profile '${stored.id}': ${compiled.code} — ${compiled.error}`);
  const scale = profileUnitScale(stored.quantity, stored.unit);
  if (scale === null)
    return refusal('DRV_PROFILE_INVALID', `profile '${stored.id}': unit '${stored.unit}' is not a ${stored.quantity} unit`);
  return { profile: compiled, scale, quantity: stored.quantity };
}

/** The controller of a velocity / position / prescribed drive, or why it cannot run at `context.timestep`. */
function loopOf(
  drive: MotorDrive,
  params: DcParameters,
  context: ActuatorContext,
  resolved: ResolvedProfile,
  inertia: number,
): LoopSpec | ActuatorRefusal {
  const mode = drive.mode as LoopSpec['mode'];
  const hz = drive.sampleHz;
  let gains: LoopGains | null = drive.gains ?? null;
  if (drive.tune !== undefined) {
    if (!(inertia > 0)) return refusal('DRV_TUNE_NO_INERTIA', `tuning '${drive.id}' needs bodies with mass on the driven joint`);
    gains = tunedGains(inertia, drive.tune.bandwidthHz, drive.tune.dampingRatio);
    if (hz !== undefined && (2 * Math.PI * drive.tune.bandwidthHz) / hz > MAX_BANDWIDTH_PER_RATE)
      return refusal(
        'DRV_CONTROL_RATE',
        `ω_c·T_s = ${((2 * Math.PI * drive.tune.bandwidthHz) / hz).toPrecision(3)} exceeds ${MAX_BANDWIDTH_PER_RATE}: raise sampleHz or lower the bandwidth`,
      );
  }
  let period = 1;
  if (mode !== 'prescribed') {
    if (hz === undefined) return refusal('DRV_CONTROL_RATE', `drive of '${drive.id}' (${mode}) needs sampleHz`);
    period = Math.round(1 / (hz * context.timestep));
    if (period < 1 || Math.abs(period * context.timestep * hz - 1) > 1e-6)
      return refusal(
        'DRV_CONTROL_RATE',
        `sampleHz ${hz} is not a whole number of ${context.timestep} s steps (the controller period must be k·Δt)`,
      );
    if (gains === null) return refusal('DRV_TUNE_NO_INERTIA', `drive of '${drive.id}' needs gains or tune`);
    if (mode === 'position' && !(gains.kpPosition > 0))
      return refusal('DRV_TUNE_NO_INERTIA', `position drive of '${drive.id}' needs gains.kpPosition or tune`);
  } else if (!(inertia > 0))
    return refusal('DRV_TUNE_NO_INERTIA', `prescribed drive of '${drive.id}' needs bodies with mass on the driven joint`);
  const peakTorque =
    params.gearRatio *
    params.efficiencyForward *
    params.torqueConstant *
    (drive.currentLimitA === undefined ? params.currentLimitA : drive.currentLimitA);
  return {
    mode,
    profile: resolved.profile,
    scale: resolved.scale,
    quantity: resolved.quantity === 'position' ? 'position' : 'velocity',
    gains: gains === null ? { kp: 0, ki: 0, kpPosition: 0 } : gains,
    feedforward: drive.feedforward === true,
    inertia,
    periodSteps: period,
    torqueLimit: drive.effortLimit === undefined ? peakTorque : drive.effortLimit,
  };
}

/** Runtimes of the document's driven DC motors, or why not. */
function runtimes(dynamics: DynamicsModel, context: ActuatorContext): DriveRuntime[] | ActuatorRefusal {
  const out: DriveRuntime[] = [];
  for (const motor of Object.values(dynamics.motors)) {
    const drive = dynamics.drives?.[motor.id];
    if (motor.kind !== 'dc' || drive === undefined) continue;
    const params = dcParameters(motor);
    const target = drive.target === undefined ? motor.joint : drive.target;
    const inertia = context.inertiaOf(target);
    if (inertia === undefined) return refusal('DRV_JOINT_INVALID', `drive of '${motor.id}' measures joint '${target}', which cannot move`);
    const resolved = resolveProfile(dynamics, drive);
    if (isRefusal(resolved)) return resolved;
    if (resolved === null && drive.mode !== 'voltage')
      return refusal('DRV_PROFILE_INVALID', `drive of '${motor.id}' (${drive.mode}) needs a profile`);
    if (resolved === null && drive.volts === undefined)
      return refusal('DRV_PROFILE_INVALID', `drive of '${motor.id}' (voltage) needs volts or a profile`);
    const closed = drive.mode === 'velocity' || drive.mode === 'position' || drive.mode === 'prescribed';
    const loop = closed && resolved !== null ? loopOf(drive, params, context, resolved, inertia) : null;
    if (isRefusal(loop)) return loop;
    out.push({
      motor,
      drive,
      params,
      base: out.length * AUX_SIZE,
      ledgerBase: out.length * LEDGER_KINDS.length,
      target,
      currentLimitA: drive.currentLimitA === undefined ? params.currentLimitA : drive.currentLimitA,
      busVoltageV: drive.busVoltageV === undefined ? Infinity : drive.busVoltageV,
      constantVolts: drive.volts === undefined ? 0 : drive.volts,
      resolved,
      loop,
    });
  }
  return out;
}

/** Terminal voltage commanded by a voltage-mode drive at `time`. */
function commandedVolts(run: DriveRuntime, time: number): number {
  return run.resolved === null ? run.constantVolts : run.resolved.profile.evaluate(time).value * run.resolved.scale;
}

/** Motor shaft torque (N·m) a torque-mode drive commands at `time`. */
function commandedShaftTorque(run: DriveRuntime, time: number): number {
  return run.resolved === null ? 0 : run.resolved.profile.evaluate(time).value * run.resolved.scale;
}

/** The actuator block of the document at step `timestep`, null when no motor is driven, or the reason it cannot be built. */
export function buildActuators(dynamics: DynamicsModel, context: ActuatorContext): ActuatorBuild | null | ActuatorRefusal {
  const drives = runtimes(dynamics, context);
  if (isRefusal(drives)) return drives;
  if (drives.length === 0) return null;
  const joints = [...new Set(drives.map((run) => run.motor.joint))];
  const block: ActuatorBlock = {
    size: drives.length * AUX_SIZE,
    aux0: new Float64Array(drives.length * AUX_SIZE),
    joints,
    ledgerLayout: drives.flatMap((run) => LEDGER_KINDS.map((kind) => ({ element: run.motor.id, kind }))),
    advance: (state, previous, dt) => {
      const aux = previous.slice();
      const jointForces = new Float64Array(joints.length);
      const ledger = new Float64Array(drives.length * LEDGER_KINDS.length);
      for (const run of drives) {
        const { params, base } = run;
        const omegaMotor = params.gearRatio * (state.jointVelocity[run.motor.joint] ?? Number.NaN);
        if (run.loop !== null) {
          const position = state.jointPosition[run.target];
          const velocity = state.jointVelocity[run.target];
          if (position !== undefined && velocity !== undefined) updateLoop(run.loop, aux, base, state.time, position, velocity, dt);
        }
        const i0 = aux[base + AUX.current];
        const ke = params.torqueConstant;
        let volts = 0;
        let limited = 0;
        let step;
        if (run.drive.mode === 'voltage') {
          volts = commandedVolts(run, state.time);
          const steady = (volts - ke * omegaMotor) / params.resistanceOhm;
          if (Math.abs(steady) > run.currentLimitA) {
            volts = ke * omegaMotor + params.resistanceOhm * Math.sign(steady) * run.currentLimitA;
            limited = 1;
          }
          step = electricalStep(params, volts, omegaMotor, i0 === undefined ? 0 : i0, dt);
        } else {
          const held = aux[base + AUX.heldTorque];
          const wanted =
            run.drive.mode === 'torque'
              ? commandedShaftTorque(run, state.time) / ke
              : shaftTorqueFor(params, held === undefined ? 0 : held, omegaMotor) / ke;
          const upper = Math.min(run.currentLimitA, (run.busVoltageV - ke * omegaMotor) / params.resistanceOhm);
          const lower = Math.max(-run.currentLimitA, (-run.busVoltageV - ke * omegaMotor) / params.resistanceOhm);
          const current = Math.min(upper, Math.max(lower, wanted));
          const saturated = run.loop !== null && Math.abs(held === undefined ? 0 : held) >= run.loop.torqueLimit * (1 - 1e-12);
          limited = current === wanted && !saturated ? 0 : 1;
          volts = params.resistanceOhm * current + ke * omegaMotor;
          step = { current, meanCurrent: current, copperJ: params.resistanceOhm * current * current * dt, magneticJ: 0 };
        }
        const shaftTorque = ke * step.meanCurrent;
        const joint = jointTorque(params, shaftTorque, omegaMotor, dt);
        const electrical = volts * step.meanCurrent * dt;
        const slot = joints.indexOf(run.motor.joint);
        jointForces[slot] = (jointForces[slot] ?? 0) + joint.torque;
        aux[base + AUX.current] = step.current;
        aux[base + AUX.voltage] = volts;
        aux[base + AUX.meanCurrent] = step.meanCurrent;
        aux[base + AUX.shaftTorque] = shaftTorque;
        aux[base + AUX.jointTorque] = joint.torque;
        aux[base + AUX.limited] = limited;
        aux[base + AUX.steps] = (aux[base + AUX.steps] ?? 0) + 1;
        ledger[run.ledgerBase] = electrical;
        ledger[run.ledgerBase + 1] = step.copperJ;
        ledger[run.ledgerBase + 2] = step.magneticJ;
        ledger[run.ledgerBase + 3] = joint.gearLossJ;
        ledger[run.ledgerBase + 4] = Math.min(electrical, 0);
      }
      return { aux, jointForces, bodyForces: [], ledger };
    },
  };
  return { block, drives };
}
