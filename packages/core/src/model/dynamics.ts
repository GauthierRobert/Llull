/**
 * Rigid-body dynamics definition of a document (`CadDocument.dynamics`): which entities move together (bodies), how bodies are connected
 * (joints), coupled (gears) and loaded (motors, propellers). Physical quantities are SI (kg, m, s, N, N·m, rad); joint anchors are world
 * points in DOCUMENT units like every other coordinate.
 */

import type { Vec3 } from './vectors';

/** Parent of a joint that is attached to the fixed world. */
export const GROUND = 'ground';

/**
 * A set of entities that moves as one rigid part. Mass and inertia come from the entities' geometry and density.
 * @invariant entityIds non-empty, every id a 3D entity; density / massKg > 0 when set
 */
export interface RigidBody {
  readonly id: string;
  name?: string;
  entityIds: string[];
  /** Welded to the ground: never moves (a frame, a crankcase). */
  fixed: boolean;
  /** kg/m³ for entities without an assigned material; default steel 7850. */
  density?: number;
  /** Measured mass in kg: the geometry's mass distribution is scaled to it (hollow or lightweight parts). */
  massKg?: number;
}

/**
 * A one-degree-of-freedom connection: `child` rotates (revolute) about / slides (prismatic) along `axis` through `anchor`, relative to
 * `parent` (a body id or GROUND).
 * @invariant parent !== child; each body is the child of at most one joint; axis non-zero; damping, friction >= 0
 */
export interface DynamicJoint {
  readonly id: string;
  kind: 'revolute' | 'prismatic';
  parent: string;
  child: string;
  /** World point on the axis, document units. */
  anchor: Vec3;
  axis: Vec3;
  /** Viscous damping: N·m·s/rad (revolute) or N·s/m (prismatic). */
  damping: number;
  /** Dry (Coulomb) friction: N·m (revolute) or N (prismatic). */
  friction: number;
  /** Speed at t = 0: rad/s (revolute) or m/s (prismatic). */
  initialVelocity: number;
}

/**
 * Rigid gear / belt / chain coupling: velocity(driven) = ratio × velocity(driver), enforced as a constraint (both inertias interact).
 * @invariant driver !== driven, both existing joints; ratio finite, non-zero
 */
interface GearCoupling {
  readonly id: string;
  driver: string;
  driven: string;
  ratio: number;
}

/** One point of a torque curve: shaft speed (rpm) → torque (N·m) at full throttle. */
export type TorquePoint = readonly [rpm: number, torque: number];

/**
 * Drive on a joint. 'torque_curve': an engine — torque(rpm) × throttle, linear between points, held at the end values outside them.
 * 'speed': a governed drive holding `rpm` with at most `maxTorque` (N·m).
 */
export type Motor =
  | { readonly id: string; readonly kind: 'torque_curve'; joint: string; curve: TorquePoint[]; throttle: number }
  | { readonly id: string; readonly kind: 'speed'; joint: string; rpm: number; maxTorque: number };

/**
 * Propeller on a revolute joint, static-thrust model from the propeller's measured coefficients (n = rev/s, D = diameter):
 * thrust T = Ct·ρ·n²·D⁴ along `thrustDirection`, absorbed power P = Cp·ρ·n³·D⁵, drag torque Q = P / (2πn) opposing the rotation.
 * @invariant diameter, airDensity > 0; thrustCoefficient, powerCoefficient >= 0
 */
export interface PropellerLoad {
  readonly id: string;
  joint: string;
  /** m. */
  diameter: number;
  thrustCoefficient: number;
  powerCoefficient: number;
  /** kg/m³, ISA sea level 1.225. */
  airDensity: number;
  /** World direction the thrust pushes the propeller (pulls the aircraft). */
  thrustDirection: Vec3;
}

export interface DynamicsModel {
  /** m/s², world axes (Z up: [0, 0, -9.81]). */
  gravity: Vec3;
  bodies: Record<string, RigidBody>;
  joints: Record<string, DynamicJoint>;
  gears: Record<string, GearCoupling>;
  motors: Record<string, Motor>;
  propellers: Record<string, PropellerLoad>;
}

export function createDynamicsModel(): DynamicsModel {
  return { gravity: [0, 0, -9.81], bodies: {}, joints: {}, gears: {}, motors: {}, propellers: {} };
}
