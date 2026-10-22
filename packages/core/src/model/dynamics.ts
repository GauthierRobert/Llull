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
  /** Measured inertia, kg·m², about the centre of mass, world axes at the modelled pose: [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] (tensor components); replaces the geometry's. */
  inertiaKgM2?: readonly [number, number, number, number, number, number];
}

/**
 * A connection: `child` rotates (revolute) about / slides (prismatic) along `axis` through `anchor`, relative to `parent` (a body id or
 * GROUND); a spherical joint is a ball pin (three rotations) that can only close a loop.
 * @invariant parent !== child; a body may be the child of several joints (closed loops: dynamics/topology.ts picks the tree);
 *            axis non-zero (ignored for spherical); damping, friction, stiffness >= 0; spherical joints have damping = friction = stiffness = initialVelocity = 0
 */
export interface DynamicJoint {
  readonly id: string;
  kind: 'revolute' | 'prismatic' | 'spherical';
  parent: string;
  child: string;
  /** World point on the axis, document units. */
  anchor: Vec3;
  axis: Vec3;
  /**
   * Where the pin sits on the child body when it differs from `anchor` (document units). Read only when the joint closes a loop: the
   * distance between the two points is the loop gap (FPR_LOOP_OPEN). Absent = `anchor`.
   */
  anchorOnChild?: Vec3;
  /** Viscous damping: N·m·s/rad (revolute) or N·s/m (prismatic). */
  damping: number;
  /** Dry (Coulomb) friction: N·m (revolute) or N (prismatic). */
  friction: number;
  /** Spring stiffness about / along the joint coordinate: N·m/rad (revolute) or N/m (prismatic). Absent = no spring. */
  stiffness?: number;
  /** Joint coordinate (rad or m, measured from the pose the joint was modelled in) where the spring is relaxed. Absent = 0. */
  springReference?: number;
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
  /** Mesh efficiency in (0, 1] (FR-FPR-74): the share of the transmitted power that reaches the driven shaft. Absent = ideal (1). */
  efficiency?: number;
  /** Tooth counts [driver, driven] the ratio was derived from; `ratio` stays authoritative. */
  teeth?: readonly [driver: number, driven: number];
}

/**
 * Linear point-to-point spring-damper between two bodies (or a body and the ground), a MuJoCo spatial tendon between two attachment
 * points. Force along the line of the points: F = stiffness · (length - freeLengthM) + damping · d(length)/dt, positive = pulling together.
 * @invariant bodyA !== bodyB; stiffness > 0, damping >= 0, freeLengthM >= 0; points distinct at the modelled pose
 */
export interface PointSpring {
  readonly id: string;
  /** Body id or GROUND. */
  bodyA: string;
  bodyB: string;
  /** World points at the pose the bodies are modelled in, document units; each then rides on its body. */
  pointA: Vec3;
  pointB: Vec3;
  /** N/m. */
  stiffness: number;
  /** N·s/m. */
  damping: number;
  /** m: length at which the force is zero. */
  freeLengthM: number;
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
  /** Forward speed of the air relative to the propeller, m/s (>= 0, default 0 = static): J = V / (n D). Read only with `table`. */
  airspeedMps?: number;
  /** C_T(J), C_P(J) table (FR-FPR-75): replaces the static coefficients when J > 0; PCHIP between points, J strictly increasing from 0. */
  table?: PropellerTable;
  /** Moment of inertia of the propeller about its shaft, kg·m², when it is not a rigid body of the model (reported and plausibility-checked). */
  inertiaKgM2?: number;
}

/** Measured propeller coefficients against advance ratio J = V / (n D), with where they come from. */
interface PropellerTable {
  /** [J, C_T, C_P] with strictly increasing J. */
  points: (readonly [advanceRatio: number, thrustCoefficient: number, powerCoefficient: number])[];
  source: string;
  grade: 'A' | 'B' | 'C';
}

/**
 * Gas pressure on a piston (prismatic joint `piston`) whose travel is tied to a crank (revolute joint `crank`) through the connecting rod.
 * Pressure models are functions of the cycle angle φ (0 = firing TDC; 720 deg four-stroke, 360 deg two-stroke).
 * @invariant boreMm > 0; compressionRatio > 1; piston prismatic, crank revolute (both tree joints of the mechanism)
 */
export interface CylinderPressure {
  readonly id: string;
  piston: string;
  crank: string;
  boreMm: number;
  compressionRatio: number;
  cycle: 'four_stroke' | 'two_stroke';
  /** Cycle angle φ when the crank is at this piston's TDC position. */
  firingOffsetDeg: number;
  /** Crank joint angle (rad from its t = 0 pose) at this piston's TDC; null = computed from the geometry. */
  tdcCrankAngleRad: number | null;
  /** Pa, default 101 325 (ISA sea level). */
  ambientPressurePa: number;
  model:
    | { kind: 'table'; points: (readonly [cycleDeg: number, gaugePa: number])[]; source?: string }
    | {
        kind: 'wiebe';
        startDeg: number;
        durationDeg: number;
        a: number;
        m: number;
        compressionIndex: number;
        expansionIndex: number;
        intakePressurePa: number;
        heat: { kind: 'per_cycle_J'; value: number } | { kind: 'target_imep_Pa'; value: number };
        source?: string;
      }
    | {
        kind: 'single_zone';
        burn:
          | { ca50Deg: number; durationDeg: number; a: number; m: number; rpmExponent: number }
          | { startDeg: number; durationDeg: number; a: number; m: number; rpmExponent: number };
        woschni: { c1: number; c2Closed: number; c2Exchange: number; c3: number; tempExponent: number; wallTempK: number };
        intakePressurePa: number;
        intakeTempK: number;
        heat: { kind: 'per_cycle_J'; value: number } | { kind: 'table_vs_rpm'; points: (readonly [rpm: number, joulesPerCycle: number])[] };
        /** rpm values whose heat release was calibrated to a brake target (`origin: calibrated` there only; every other speed is a prediction). */
        calibratedRpm?: number[];
        source?: string;
      };
}

/**
 * Mechanical losses of an engine crank (FR-FPR-71), reported as FMEP and applied as a torque against the rotation of `crank`.
 * `component` (PNH / Sandoval-Heywood) is NOT implemented: its equations are unchecked against a primary source (TECHNICAL_SPEC 11 Q8).
 * @invariant crank revolute; every listed cylinder is on that crank; every model has a source; oilTempFactor > 0
 */
export interface EngineLosses {
  readonly id: string;
  crank: string;
  /** Cylinder pressure ids whose displacement and peak pressure the friction reads; empty = every cylinder pressure on `crank`. */
  cylinders: string[];
  model:
    | { kind: 'chen_flynn'; aPa: number; bRatio: number; cPaPerRpm: number; dPaPerRpm2: number; source: string }
    | { kind: 'fmep_table'; points: (readonly [rpm: number, fmepPa: number])[]; source: string };
  /** Multiplier on the FMEP, 1 = hot oil; cold about 2.1 [E-R9]. */
  oilTempFactor: number;
}

/** Engine-neutral solver settings of loop-closed mechanisms (absent in the document = these defaults). */
export interface DynamicsSolverSettings {
  /** s, or 'auto' = min(1 ms, 0.5 deg of crank at the highest expected speed). */
  timestepS: number | 'auto';
  integrator: 'rk4' | 'implicitfast';
  /** Loop constraint reference time constant in timesteps (>= 2, MuJoCo refsafe). */
  loopTimeConstantSteps: number;
  /** Loop constraint impedance in (0, 0.9999]. */
  loopImpedance: number;
  /** m: a residual up to this passes (5 % of a 0.020 mm pin clearance). */
  loopResidualPassM: number;
  /** m: a residual above this fails. */
  loopResidualFailM: number;
  /** Relative change between a run and its half-step run above which results are flagged (reserved for the realism slice). */
  timestepSensitivityGate: number;
}

export const DEFAULT_SOLVER_SETTINGS: DynamicsSolverSettings = {
  timestepS: 'auto',
  integrator: 'rk4',
  loopTimeConstantSteps: 2,
  loopImpedance: 0.9999,
  loopResidualPassM: 1e-6,
  loopResidualFailM: 1e-5,
  timestepSensitivityGate: 0.01,
};

export interface DynamicsModel {
  /** m/s², world axes (Z up: [0, 0, -9.81]). */
  gravity: Vec3;
  bodies: Record<string, RigidBody>;
  joints: Record<string, DynamicJoint>;
  gears: Record<string, GearCoupling>;
  motors: Record<string, Motor>;
  propellers: Record<string, PropellerLoad>;
  /** Absent in documents saved before PHY-21. */
  cylinders?: Record<string, CylinderPressure>;
  /** Absent in documents saved before the realism slice (FPR M3b). */
  losses?: Record<string, EngineLosses>;
  /** Absent in documents saved before point springs. */
  springs?: Record<string, PointSpring>;
  solver?: DynamicsSolverSettings;
}

export function createDynamicsModel(): DynamicsModel {
  return { gravity: [0, 0, -9.81], bodies: {}, joints: {}, gears: {}, motors: {}, propellers: {} };
}
