/** set_motor_drive: how a datasheet DC motor is commanded (voltage, torque, velocity, position or prescribed motion). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import { compileProfile, isAngularUnit, isProfileRefusal } from '@core/geometry/motionProfile';
import type { MotorDrive } from '@core/model/drives';
import { MAX_BANDWIDTH_PER_RATE } from '../sim/actuators/controller';
import { buildSimulationModel, jointInertiaOf } from '../sim/simulationModel';
import { dynamicsOf, withDynamics } from './bodies';

const REMEDIATION: Readonly<Record<string, string>> = {
  DRV_PROFILE_INVALID:
    'Create the profile with add_motion_profile (voltage V, torque N*m, velocity or position in angular units) and name it in `profile`.',
  DRV_CONTROL_RATE:
    'Give sampleHz so that the controller period is a whole number of simulation steps and omega_c * T_s <= 0.2 (sampleHz >= 5 * omega_c / 1 rad).',
  DRV_TUNE_NO_INERTIA: 'Add rigid bodies with mass on the driven joint (add_rigid_body), or give explicit `gains` instead of `tune`.',
  DRV_JOINT_INVALID: 'Use a revolute joint of the model as `target`.',
  DRV_MOTOR_KIND_UNSUPPORTED:
    'Only datasheet DC motors (add_motor kind "dc") take a drive; torque_curve and speed motors are set by add_motor.',
};

const QUANTITY: Readonly<Record<MotorDrive['mode'], readonly string[]>> = {
  voltage: ['voltage'],
  torque: ['torque'],
  velocity: ['velocity'],
  position: ['position'],
  prescribed: ['position', 'velocity'],
};

/**
 * @affects sets doc.dynamics.drives[motor] (affected: [motorId])
 * @invariant the drive's profile exists, compiles and has the quantity the mode needs; a closed loop has gains or a tuning, a sample rate and ω_c·T_s <= 0.2
 * @failure unknown motor -> no-op; not a dc motor -> DRV_MOTOR_KIND_UNSUPPORTED; missing / wrong profile -> DRV_PROFILE_INVALID; bad sample rate or bandwidth
 *   -> DRV_CONTROL_RATE; tune without inertia on the joint -> DRV_TUNE_NO_INERTIA; unknown / non-revolute target -> DRV_JOINT_INVALID
 * @invariant kernel-optional: the tuning inertia reads body mass properties through the kernel when present, mesh integration otherwise
 */
export const setMotorDrive = defineCommand({
  name: 'set_motor_drive',
  annotations: { kernelOptional: true, readsMeshTriangles: true },
  description:
    'Command a datasheet DC motor (add_motor kind "dc") for simulate_motion; replaces the motor\'s previous drive, a motor without a drive is an open circuit. ' +
    'mode "voltage": terminal voltage `volts` (constant) or a voltage `profile`; the current follows the exact winding law (back-EMF, inductance) and is clamped ' +
    'to `currentLimitA` (default the motor peak current, else U/R). mode "torque": a torque `profile` (N*m at the motor SHAFT, before the gearhead) through an ' +
    'ideal current loop. mode "velocity" / "position": a discrete cascade controller (velocity PI, plus a position P loop for position) following a velocity / ' +
    'position `profile` of the target joint; give `gains` {kp N*m per rad/s, ki, kpPosition} or `tune` {bandwidthHz, dampingRatio} (k_p = 2*zeta*w_c*J, ' +
    'k_i = w_c^2*J on the reflected inertia J of the joint, k_p,pos = w_c/4), and `sampleHz` (the period must be a whole number of simulation steps and ' +
    'w_c*T_s <= 0.2, else DRV_CONTROL_RATE); `feedforward` adds J*accel of the profile; the integrator stops winding up when the current limit saturates ' +
    '(`busVoltageV` also limits the current by R*i + ke*w <= bus). mode "prescribed": a high-gain servo that forces the joint along a position or velocity ' +
    'profile with effort limited to `effortLimit` (default the motor peak torque at the joint): the reported effort is then the inverse dynamics of the motion ' +
    '(sizing), and a tracking error above 1 % of the move warns DRV_TRACKING_ERROR. Profiles come from add_motion_profile (velocity / position units are angular). ' +
    'Returns the motor id in affected[0].',
  params: z.object({
    motor: z.string().describe('Id of a datasheet DC motor (add_motor kind "dc").'),
    mode: z.enum(['voltage', 'torque', 'velocity', 'position', 'prescribed']).describe('How the motor is commanded.'),
    volts: z.number().optional().describe('voltage: constant terminal voltage in V (negative reverses). Instead of `profile`.'),
    profile: z
      .string()
      .optional()
      .describe('Profile id (add_motion_profile): voltage V, torque N*m, velocity, position, or the prescribed motion.'),
    currentLimitA: z.number().positive().optional().describe('Current limit in A. Default the motor peak current, else U/R.'),
    target: z
      .string()
      .optional()
      .describe('velocity / position / prescribed: joint the controller measures and follows. Default the motor joint.'),
    gains: z
      .object({
        kp: z.number().min(0).describe('Velocity loop proportional gain, N*m per rad/s at the joint.'),
        ki: z.number().min(0).optional().describe('Velocity loop integral gain, N*m per rad. Default 0.'),
        kpPosition: z
          .number()
          .positive()
          .optional()
          .describe('Position loop gain, rad/s per rad (required in position mode; 0 otherwise).'),
      })
      .optional()
      .describe('Explicit controller gains (instead of `tune`).'),
    tune: z
      .object({
        bandwidthHz: z.number().positive().describe('Velocity loop bandwidth f_c in Hz.'),
        dampingRatio: z.number().positive().describe('Damping ratio zeta (1 = critical).'),
      })
      .optional()
      .describe('Automatic tuning from the reflected inertia of the joint (instead of `gains`).'),
    feedforward: z
      .boolean()
      .optional()
      .describe('velocity / position: add the profile acceleration times the joint inertia (and velocity for position). Default false.'),
    busVoltageV: z.number().positive().optional().describe('Supply voltage limit in V for the current-driven modes. Default unlimited.'),
    sampleHz: z.number().positive().optional().describe('velocity / position: controller sample rate in Hz (required there).'),
    effortLimit: z
      .number()
      .positive()
      .optional()
      .describe('prescribed: largest torque in N*m at the joint. Default the motor peak torque.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const name = 'set_motor_drive';
    const fail = failer(doc, name);
    const refuse = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      codedRejection(doc, name, code, message, REMEDIATION[code] ?? '', ids);
    const dynamics = dynamicsOf(doc);
    const motor = dynamics.motors[params.motor];
    if (motor === undefined) return fail(`motor '${params.motor}' not found (add_motor first)`);
    if (motor.kind !== 'dc') return refuse('DRV_MOTOR_KIND_UNSUPPORTED', `motor '${motor.id}' is a ${motor.kind} motor`, [motor.id]);
    const { mode } = params;
    const target = params.target ?? motor.joint;
    const targetJoint = dynamics.joints[target];
    if (targetJoint === undefined || targetJoint.kind !== 'revolute')
      return refuse('DRV_JOINT_INVALID', `target joint '${target}' is missing or not revolute`, [target]);
    if (mode === 'voltage' && params.volts === undefined && params.profile === undefined)
      return fail('voltage mode needs `volts` or a voltage `profile`');
    if (mode === 'voltage' && params.volts !== undefined && params.profile !== undefined)
      return fail('give `volts` or `profile`, not both');
    if (mode !== 'voltage' && params.profile === undefined) return refuse('DRV_PROFILE_INVALID', `${mode} mode needs a profile`);
    if (params.profile !== undefined) {
      const profile = dynamics.profiles?.[params.profile];
      if (profile === undefined) return refuse('DRV_PROFILE_INVALID', `profile '${params.profile}' not found (add_motion_profile first)`);
      if (!QUANTITY[mode].includes(profile.quantity))
        return refuse(
          'DRV_PROFILE_INVALID',
          `${mode} mode needs a ${QUANTITY[mode].join(' or ')} profile, '${profile.id}' is ${profile.quantity}`,
        );
      if ((profile.quantity === 'position' || profile.quantity === 'velocity') && !isAngularUnit(profile.unit))
        return refuse(
          'DRV_PROFILE_INVALID',
          `profile '${profile.id}' is in '${profile.unit}'; a revolute joint needs an angular unit (rad, deg, rev, rad/s, rpm, deg/s)`,
        );
      const compiled = compileProfile(profile);
      if (isProfileRefusal(compiled)) return refuse(compiled.code, `profile '${profile.id}': ${compiled.error}`);
    }
    if (mode === 'velocity' || mode === 'position') {
      if (params.sampleHz === undefined) return refuse('DRV_CONTROL_RATE', `${mode} mode needs sampleHz`);
      if ((params.gains === undefined) === (params.tune === undefined)) return fail('give exactly one of `gains` and `tune`');
      if (mode === 'position' && params.gains !== undefined && params.gains.kpPosition === undefined)
        return fail('position mode with explicit gains needs gains.kpPosition > 0');
      if (params.tune !== undefined) {
        const ratio = (2 * Math.PI * params.tune.bandwidthHz) / params.sampleHz;
        if (ratio > MAX_BANDWIDTH_PER_RATE)
          return refuse(
            'DRV_CONTROL_RATE',
            `omega_c * T_s = ${ratio.toPrecision(3)} exceeds ${MAX_BANDWIDTH_PER_RATE} (bandwidth ${params.tune.bandwidthHz} Hz at ${params.sampleHz} Hz)`,
          );
      }
    }
    if (params.tune !== undefined || mode === 'prescribed') {
      const built = buildSimulationModel(doc, 1e-3, ctx?.kernel ?? null);
      const inertia = 'error' in built ? undefined : jointInertiaOf(built, target);
      if (inertia === undefined || !(inertia > 0))
        return refuse(
          'DRV_TUNE_NO_INERTIA',
          `joint '${target}' has no inertia to ${mode === 'prescribed' ? 'servo' : 'tune'} against${'error' in built ? ` (${built.error})` : ''}`,
          [target],
        );
    }
    const drive: MotorDrive = {
      id: motor.id,
      mode,
      ...(params.volts === undefined ? {} : { volts: params.volts }),
      ...(params.profile === undefined ? {} : { profile: params.profile }),
      ...(params.currentLimitA === undefined ? {} : { currentLimitA: params.currentLimitA }),
      ...(params.target === undefined ? {} : { target: params.target }),
      ...(params.gains === undefined
        ? {}
        : {
            gains: {
              kp: params.gains.kp,
              ki: params.gains.ki === undefined ? 0 : params.gains.ki,
              kpPosition: params.gains.kpPosition === undefined ? 0 : params.gains.kpPosition,
            },
          }),
      ...(params.tune === undefined ? {} : { tune: params.tune }),
      ...(params.feedforward === undefined ? {} : { feedforward: params.feedforward }),
      ...(params.busVoltageV === undefined ? {} : { busVoltageV: params.busVoltageV }),
      ...(params.sampleHz === undefined ? {} : { sampleHz: params.sampleHz }),
      ...(params.effortLimit === undefined ? {} : { effortLimit: params.effortLimit }),
    };
    const what =
      mode === 'voltage'
        ? params.volts === undefined
          ? `profile '${params.profile}'`
          : `${params.volts} V`
        : `profile '${params.profile}'`;
    return changed(
      withDynamics(doc, { ...dynamics, drives: { ...dynamics.drives, [motor.id]: drive } }),
      `set_motor_drive: '${motor.id}' ${mode} on joint '${motor.joint}' — ${what}` +
        `${params.sampleHz === undefined ? '' : `, ${params.sampleHz} Hz`}${params.tune === undefined ? '' : `, tuned ${params.tune.bandwidthHz} Hz zeta ${params.tune.dampingRatio}`}.`,
      [motor.id],
    );
  },
});
