/**
 * Flight controller and flight scenario records of the flight slice (13 FLT M2, TR-FLT-05): plain data, every default already resolved when
 * the record was created (`defaulted` names the inputs that took one). SI units; world axes are the document axes (Z up).
 */

import type { Vec3 } from '@core/model/vectors';

/** Proportional / integral / derivative gains of one cascade level, per axis. */
export interface PidGains {
  readonly p: Vec3;
  readonly i: Vec3;
  readonly d: Vec3;
}

/**
 * Cascaded PID (position -> velocity -> attitude -> rate) of one free body and the rotors on it. Gains are normalised by the vehicle: the
 * velocity loop outputs an acceleration (m/s², multiplied by the vehicle mass), the rate loop an angular acceleration (rad/s², multiplied by
 * the body inertia), so the same gains suit vehicles of any size.
 * @invariant bodyId is a non-fixed rigid body; rotorIds non-empty, distinct, every rotor on bodyId
 * @invariant 0 <= minRpm < maxRpm; rateHz > 0; motorTimeConstantS >= 0; mixer, when given, has one row of 4 per rotor
 * @invariant id unique across doc.dynamics records and the flight slice (idTakenInDynamicsOrFlight)
 */
export interface FlightController {
  readonly id: string;
  readonly bodyId: string;
  /** Rotors the controller commands, in mixer row order. */
  readonly rotorIds: readonly string[];
  /** Controller update rate, Hz (the physics step must divide its period). */
  readonly rateHz: number;
  readonly gains: {
    /** 1/s: velocity set-point per metre of position error (world x, y, z). */
    readonly position: Vec3;
    /** Acceleration set-point (m/s²) per m/s of velocity error (p, 1/s), per m of its integral (i, 1/s²), per m/s² of acceleration (d). */
    readonly velocity: PidGains;
    /** 1/s: body-rate set-point per radian of attitude error (roll, pitch, yaw). */
    readonly attitude: Vec3;
    /** Angular-acceleration set-point (rad/s²) per rad/s of rate error (p, 1/s), per rad of its integral (i, 1/s²), per rad/s² (d). */
    readonly rate: PidGains;
  };
  readonly limits: {
    /** Largest commanded tilt of the thrust axis from vertical, deg. */
    readonly maxTiltDeg: number;
    readonly maxHorizontalSpeedMps: number;
    readonly maxVerticalSpeedMps: number;
    /** Largest commanded body rate about roll, pitch, yaw, deg/s. */
    readonly maxRateDegS: Vec3;
  };
  /** Rotor speed range, rev/min (the thrust limits of the mixer, at J = 0). */
  readonly minRpm: number;
  readonly maxRpm: number;
  /** First-order lag of the rotor speed behind its command, s (0 = instantaneous). */
  readonly motorTimeConstantS: number;
  /** Explicit mixer, rotor thrust N per [T N, τx, τy, τz N·m] (rows in rotorIds order); null = pseudo-inverse of the rotor geometry. */
  readonly mixer: readonly (readonly [number, number, number, number])[] | null;
  /** Inputs that took their default (FR-FLT-08: a result built on them is `unverified`). */
  readonly defaulted: readonly string[];
}

/** Set-point from time `t` until the next one: position offset of the centre of mass from its start, m, world; heading, deg. */
export interface FlightSetpoint {
  readonly t: number;
  readonly position: Vec3;
  readonly yawDeg: number;
}

/** 1-cosine gust: air velocity (peak/2)(1 - cos(2π(t - startS)/durationS)) for startS <= t <= startS + durationS. */
interface FlightGust {
  readonly startS: number;
  readonly durationS: number;
  /** m/s, world. */
  readonly peak: Vec3;
}

/** World air velocity: steady + discrete gusts (Dryden turbulence is FLT-M4). */
export interface FlightWind {
  readonly steady: Vec3;
  readonly gusts: readonly FlightGust[];
}

/**
 * One flight: the vehicle body, the controller flying it (null = open loop: rotors at their own rpm), set-points over time, the initial
 * twist of the body and the wind.
 * @invariant bodyId is a non-fixed rigid body; controllerId, when set, is a controller of bodyId
 * @invariant setpoint times strictly increase, the first is 0, all < durationS; gusts start inside the run
 */
export interface FlightScenario {
  readonly id: string;
  readonly bodyId: string;
  readonly controllerId: string | null;
  /** Simulated seconds. */
  readonly durationS: number;
  readonly setpoints: readonly FlightSetpoint[];
  /** Velocity of the centre of mass at t = 0, m/s, world. */
  readonly initialVelocity: Vec3;
  /** Angular velocity at t = 0, rad/s, world. */
  readonly initialAngularVelocity: Vec3;
  readonly wind: FlightWind;
  /** m: position error under which the vehicle counts as recovered after an event (set-point change, gust). */
  readonly settleBandM: number;
  readonly defaulted: readonly string[];
}
