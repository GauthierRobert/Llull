/**
 * Injected rigid-body physics engine (architecture L9, like `GeometryKernel`). Interface only: no WASM, no async. `simulate_motion` reads
 * it from `ctx.physics` and no-ops when it is null; the composition root installs it (`@physics-mujoco`).
 *
 * The boundary is an engine-neutral multibody model in SI units with mass properties already computed; force laws (engines, propellers)
 * stay in core as the `loads` callback, so every engine integrates the same physics.
 */

import type { Vec3 } from '../model/vectors';
import type { InertiaTensor } from '../geometry/massProperties';

export interface SimulationJoint {
  readonly id: string;
  readonly kind: 'revolute' | 'prismatic';
  /** World point on the axis, m. */
  readonly anchor: Vec3;
  /** Unit vector, world. */
  readonly axis: Vec3;
  readonly damping: number;
  readonly friction: number;
  /** N·m/rad or N/m; 0 / absent = no spring. */
  readonly stiffness?: number;
  /** Joint coordinate (rad or m, from the start pose) where the spring is relaxed. */
  readonly springReference?: number;
  readonly initialVelocity: number;
}

/**
 * One rigid body; its frame sits at its centre of mass with world-aligned axes at t = 0.
 * @invariant bodies are ordered parent before child
 */
export interface SimulationBody {
  readonly id: string;
  /** Body this one hangs from; null = the world. */
  readonly parentId: string | null;
  /** kg. */
  readonly mass: number;
  /** World, m. */
  readonly centerOfMass: Vec3;
  /** kg·m² about the centre of mass, world axes. */
  readonly inertia: InertiaTensor;
  /** Connection to the parent; null = welded to it when `fixed`, else a free 6-DOF body. */
  readonly joint: SimulationJoint | null;
  readonly fixed: boolean;
}

/** velocity(driven) = ratio × velocity(driver), as a constraint. */
interface SimulationGear {
  readonly id: string;
  readonly driver: string;
  readonly driven: string;
  readonly ratio: number;
}

/**
 * Speed governor on a joint, integrated by the engine itself: a servo on the joint position chasing a set-point that advances at
 * `targetVelocity`, force = clamp(stiffness · (setpoint − q) − damping · v, ±maxForce). Zero steady speed error below maxForce.
 * Gain scheduling (an engine must match it): with `naturalFrequency` wn the engine measures the constrained effective inertia I_eff of the
 * joint coordinate at every step (the inertia the joint really drives, with loops, gears, free joints below it and a moving parent taken
 * into account: I_eff = 1 / (acceleration of the coordinate per unit generalised force, constraint forces included)) and uses
 * stiffness = I_eff · wn², damping = 2 · I_eff · wn, so the servo pole stays at wn · dt in every configuration. `stiffness` and `damping`
 * are then only the values of the first step (and the fixed gains when `naturalFrequency` is absent). Not a property of the model: no
 * static inertia can be right (it overestimates by factors of 10 or more and an explicit integrator diverges).
 * Anti-windup: when `targetVelocity` is not 0, after every step the set-point is limited to q + damping · v / stiffness ± maxForce /
 * stiffness (the gains in force), the window in which the unclamped force stays within ±maxForce. The angle lost while saturated is NOT
 * caught up afterwards (the servo governs speed, so a saturated spin-up does not overshoot the target). A hold (`targetVelocity` 0) is
 * exempt: its set-point is the position to return to, and a hold that cannot keep it stays pinned at maxForce.
 */
export interface SimulationServo {
  readonly id: string;
  readonly joint: string;
  /** rad/s or m/s. */
  readonly targetVelocity: number;
  /** N·m/rad or N/m: first-step value (fixed value without `naturalFrequency`). */
  readonly stiffness: number;
  /** N·m·s/rad or N·s/m: first-step value (fixed value without `naturalFrequency`). */
  readonly damping: number;
  /** rad/s: undamped natural frequency of the governor (critical damping); the engine schedules the gains to hold it. */
  readonly naturalFrequency?: number;
  readonly maxForce: number;
}

export interface SimulationState {
  readonly time: number;
  readonly jointPosition: Readonly<Record<string, number>>;
  readonly jointVelocity: Readonly<Record<string, number>>;
}

export interface AppliedLoads {
  /** Generalised force along each joint: N·m (revolute) or N (prismatic). */
  readonly jointForces: Readonly<Record<string, number>>;
  /** World force at each body's centre of mass, N. */
  readonly bodyForces: Readonly<Record<string, Vec3>>;
}

/**
 * A joint that closes a kinematic loop: a constraint between two bodies, not a coordinate. A revolute loop pins two points on its axis;
 * a spherical loop pins one point. `bodyA` is the joint parent ('world' allowed), `bodyB` the child.
 */
export interface SimulationLoop {
  /** The DynamicJoint id that closes the loop. */
  readonly id: string;
  readonly kind: 'revolute' | 'spherical';
  readonly bodyA: string;
  readonly bodyB: string;
  /** World, m. */
  readonly anchor: Vec3;
  /** Unit vector, world. */
  readonly axis: Vec3;
  /** m: the two pins of a revolute loop sit at anchor ± axis · halfSpan (half the shorter body's extent along the axis, >= 5 mm). */
  readonly halfSpan: number;
}

/**
 * Linear spring-damper between two points, each fixed on a body (`'world'` allowed). Force along the line of the points,
 * F = stiffness · (length - freeLength) + damping · d(length)/dt, positive = pulling together.
 */
export interface SimulationSpring {
  readonly id: string;
  readonly bodyA: string;
  readonly bodyB: string;
  /** World points at t = 0, m. */
  readonly pointA: Vec3;
  readonly pointB: Vec3;
  /** N/m. */
  readonly stiffness: number;
  /** N·s/m. */
  readonly damping: number;
  /** m. */
  readonly freeLength: number;
}

/** Engine-neutral solver settings. */
interface SimulationSolver {
  readonly integrator: 'rk4' | 'implicitfast';
  /** s: reference time constant of the loop constraints. */
  readonly loopTimeConstant: number;
  /** Loop constraint impedance in (0, 0.9999]. */
  readonly loopImpedance: number;
}

export interface SimulationModel {
  readonly gravity: Vec3;
  readonly bodies: readonly SimulationBody[];
  readonly gears: readonly SimulationGear[];
  readonly loops: readonly SimulationLoop[];
  readonly solver: SimulationSolver;
  readonly servos: readonly SimulationServo[];
  /** Point springs; absent = none. */
  readonly springs?: readonly SimulationSpring[];
  /** Force laws, evaluated by the engine at every step (at the step midpoint) from the state. Must be pure. */
  readonly loads: (state: SimulationState) => AppliedLoads;
}

export interface SimulationOptions {
  /** s. */
  readonly duration: number;
  /** Integration step, s. */
  readonly timestep: number;
  /** Interval between recorded samples, s (>= timestep). */
  readonly sampleInterval: number;
  /** Record joint reactions and loop forces at every sample (costs one extra pass per sample). Default false. */
  readonly reactions?: boolean;
  /** Record kinetic and potential energy at every sample. Default false. */
  readonly energy?: boolean;
}

/** Unit quaternion [w, x, y, z]. */
export type Quaternion = readonly [number, number, number, number];

/** Largest magnitude seen, and when. */
export interface StepPeak {
  readonly value: number;
  readonly timeS: number;
}

/** Sampled motion; every series has one value per entry of `times`. */
export interface SimulationTrace {
  readonly times: number[];
  readonly jointPosition: Record<string, number[]>;
  readonly jointVelocity: Record<string, number[]>;
  /** Centre of mass, world, m. */
  readonly bodyPosition: Record<string, Vec3[]>;
  /** Rotation from the t = 0 orientation. */
  readonly bodyOrientation: Record<string, Quaternion[]>;
  /** Force each servo applied: N·m or N. */
  readonly servoForce: Record<string, number[]>;
  /** Force the constraint of each loop exerts on its `bodyB`, world axes, N, per sample (needs `options.reactions`). */
  readonly loopForce?: Record<string, Vec3[]>;
  /**
   * Per tree joint (keyed by joint id): force and moment the tree parent exerts on the body carried by the joint, at the joint anchor,
   * world axes, N and N·m, per sample (needs `options.reactions`). Omitted by engines that cannot report reactions.
   */
  readonly jointReaction?: Record<string, { force: Vec3[]; moment: Vec3[] }>;
  /**
   * Largest |force| (N) and |moment| (N·m, tree joints only) of every loop / tree joint, read between the recorded samples too (every
   * integration step, or at least 50 times per sample interval when samples are further apart; needs `options.reactions`; omitted by
   * engines that cannot). Sampling can miss a sharp peak; this resolves it.
   */
  readonly reactionPeaks?: Record<string, { force: StepPeak; moment: StepPeak | null }>;
  /**
   * Per sample, J (needs `options.energy`; omitted by engines that cannot): kinetic energy and potential energy (gravity + joint springs),
   * the potential referenced to the start pose (zero at the first sample); `appliedWork`: cumulative work J of the applied loads and
   * servos on the joints (motors, gas pressure, propeller drag, speed governors; zero at the first sample), when the engine reports it.
   */
  readonly energy?: { readonly kinetic: number[]; readonly potential: number[]; readonly appliedWork?: number[] };
  /** Per point spring (needs `options.energy`): length m, rate of change m/s and force N (positive = pulling together), per sample. */
  readonly springs?: Record<string, { length: number[]; velocity: number[]; force: number[] }>;
  /** m: largest loop-constraint violation over every integration step (present when the model has loops). */
  readonly loopResidual?: number;
}

export interface PhysicsEngine {
  /** Engine name and version, reported with every result (e.g. "MuJoCo 3.14.0"). */
  readonly name: string;
  /** Deterministic: the same model and options give the same trace. Throws on a model the engine rejects. */
  simulate(model: SimulationModel, options: SimulationOptions): SimulationTrace;
}

let installed: PhysicsEngine | null = null;

/** Install (or with null, remove) the process physics engine. Composition roots only. */
export function setPhysicsEngine(engine: PhysicsEngine | null): void {
  installed = engine;
}

/** The installed physics engine, or null (headless before install, tests without one). */
export function getPhysicsEngine(): PhysicsEngine | null {
  return installed;
}
