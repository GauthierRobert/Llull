/**
 * Injected rigid-body physics engine (architecture L9, like `GeometryKernel`). Interface only: no WASM, no async. `simulate_motion` reads
 * it from `ctx.physics` and no-ops when it is null; the composition root installs it (`@physics-mujoco`).
 *
 * The boundary is an engine-neutral multibody model in SI units with mass properties already computed; force laws (engines, propellers)
 * stay in core as the `loads` callback, so every engine integrates the same physics.
 */

import type { Quaternion, Vec3 } from '../model/vectors';
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
  /** kg·m² (or kg) of extra inertia on the joint coordinate that belongs to no body (a motor rotor seen through its gearhead); absent = none. */
  readonly armature?: number;
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

/**
 * A kinematic coupling between two joints (PHY-23 TR-DRV-03): q_b = ratio · q_a, as a constraint (both inertias interact). `a` is the INPUT
 * (driver) joint: the power the coupling loses is a friction level on it, scheduled every step from the force the coupling transmits.
 * - Forward (the input drives: the coupling force opposes the input velocity, or at rest the applied input torque exceeds the coupling's):
 *   level = |T_c| (1 - η_f) / η_f, T_c the ideal coupling torque on the input joint.
 * - Back-drive (the driven side drives the input): level = |T_c| (1 - η_b); η_b <= 0 therefore holds the joint (self-locking).
 * - With `backlash` the coupling is free inside a gap of total width `gap` (driven units) and transmits through a one-sided spring-damper
 *   of stiffness K / damping B at each edge; it then carries force only while a gap edge is engaged.
 * @invariant the coupling has no loss and no gap when `efficiency` and `backlash` are absent
 */
export interface TransmissionCoupling {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  /** q_b per q_a (rad/rad, or m/rad for a screw or rack). */
  readonly ratio: number;
  readonly efficiency?: { readonly forward: number; readonly backward: number };
  readonly backlash?: {
    /** Total gap in the driven joint's units (rad or m). */
    readonly gap: number;
    /** N·m/rad or N/m at the driven joint. */
    readonly stiffness: number;
    /** N·m·s/rad or N·s/m at the driven joint. */
    readonly damping: number;
    /** kg·m² or kg at the driven joint: the engine divides K and B by it where its constraint law is an acceleration law. */
    readonly effectiveInertia: number;
  };
}

/** What the engine observed in the last forward pass of the step about one friction joint (see `JointPhysicsBlock`). */
export interface FrictionObservation {
  /** Radial load N on the joint (reaction force perpendicular to the axis); zero unless `needsLoad`. */
  readonly radialLoad: Float64Array;
  /** Bending moment N·m on the joint (reaction moment perpendicular to the axis); zero unless `needsLoad`. */
  readonly bendingMoment: Float64Array;
  /** 1 when the friction constraint of the joint was at its limit (it is slipping or about to), else 0. */
  readonly saturated: Uint8Array;
}

/**
 * Joint physics (PHY-23 TR-DRV-02, 15-17): state-dependent friction levels and end stops. The engine owns the friction constraint (dry friction
 * as a box on the constraint force, holding a joint at rest exactly); this block only decides the level before every step.
 * @invariant `frictionLevel` is pure and total (finite output for finite input, never NaN at zero speed)
 */
export interface JointPhysicsBlock {
  /** Joints `frictionLevel` is indexed by. */
  readonly frictionJoints: readonly string[];
  /**
   * Per friction joint: true = Karnopp dead band. While the joint is at rest and its friction constraint is inside its limit, the engine sets
   * its velocity to zero after the step, which removes the creep of a soft friction row (a held load leaks about 1e-4 · Δt · its free acceleration).
   * The plugin switches it off (false) for joints a transmission, a loop or a servo / drive touches, and reports it (DRV_STICTION_NOT_LATCHED).
   */
  readonly restLatch: readonly boolean[];
  /** True when a level reads `radialLoad` / `bendingMoment` (the engine then reads the joint reactions every step). */
  readonly needsLoad: boolean;
  /** Level N·m or N of each friction joint for the step, from the start-of-step state and the observation of the last forward pass. */
  frictionLevel(state: SimulationState, observed: FrictionObservation): Float64Array;
  /** End stops: a one-sided spring-damper at each of `min`, `max` (joint coordinate from the start pose). */
  readonly limits: readonly {
    readonly joint: string;
    readonly min: number;
    readonly max: number;
    readonly stiffness: number;
    readonly damping: number;
    /** kg·m² or kg of the joint coordinate (see `TransmissionCoupling.backlash.effectiveInertia`). */
    readonly effectiveInertia: number;
  }[];
}

/**
 * Speed governor on a joint, integrated by the engine itself: a servo on the joint position chasing a set-point that advances at
 * `targetVelocity`, force = clamp(stiffness · (setpoint − q) − damping · v, ±maxForce). Zero steady speed error below maxForce.
 *
 * Gain scheduling (an engine must match the behaviour; bit-identical hashes across engines are NOT expected, the soft-constraint
 * compliance is engine-specific). With `naturalFrequency` wn the engine measures, once per step at the start-of-step state with that
 * step's loads already applied, the constrained effective inertia I_eff of the joint coordinate, and holds
 * stiffness = I_eff · wn², damping = 2 · I_eff · wn through all the integrator stages of the step, so the servo pole stays at wn · dt in
 * every configuration (loops, gears, free joints below the joint and a moving parent included: no static inertia can be right, it is off by
 * factors of 10 either way and an explicit integrator diverges or the servo is far too soft).
 * - Measurement: finite difference of the coordinate's acceleration for a unit generalised force on it, constraint forces and their
 *   regularisation included: I_eff = 1 / (a(F + 1) − a(F)).
 * - Dry friction is excluded (a stuck joint reads as an inertia up to 10^4 times the true one), and the measured value is capped at 10 times
 *   the static inertia stiffness / wn² as a guard against any other switching row.
 * - A response that is not positive and finite keeps the previous gains.
 * - The set-point starts at q + damping · v / stiffness of the start state (= q + 2 v / wn when scheduled).
 * `stiffness` and `damping` are the fallback gains: the ones of an engine that does not schedule (no `naturalFrequency`) and the ones in
 * force until a response can be measured.
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
  /** N·m/rad or N/m: fallback gain (see above). */
  readonly stiffness: number;
  /** N·m·s/rad or N·s/m: fallback gain (see above). */
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

/** A force at a body's centre of mass produced by an actuator, world axes, N. */
interface BodyForce {
  readonly body: string;
  readonly force: Vec3;
}

export type LedgerKind = 'electrical_input' | 'copper' | 'magnetic' | 'transmission_loss' | 'regeneration';

/**
 * Actuators with internal state (PHY-23 TR-DRV-01): electrical current, controller integrators, held commands. The engine calls `advance` exactly
 * once per physics step with the same midpoint state it gives `loads`, applies the returned forces for the whole step, and stores the new `aux`.
 * @invariant `advance` is deterministic and pure (no closure state); `aux` is the whole state, `aux0` its value at t = 0
 * @invariant jointForces[k] acts on joint `joints[k]`; ledger[k] is the energy (J) of `ledgerLayout[k]` over this step
 */
export interface ActuatorBlock {
  readonly size: number;
  readonly aux0: Float64Array;
  /** Joint ids the returned `jointForces` are indexed by. */
  readonly joints: readonly string[];
  advance(
    state: SimulationState,
    aux: Float64Array,
    dt: number,
  ): {
    readonly aux: Float64Array;
    readonly jointForces: Float64Array;
    readonly bodyForces: readonly BodyForce[];
    readonly ledger: Float64Array;
  };
  readonly ledgerLayout: readonly { readonly element: string; readonly kind: LedgerKind }[];
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
  /** Kinematic couplings between joints (gears, belts, screws, racks); empty = none. */
  readonly transmissions: readonly TransmissionCoupling[];
  readonly loops: readonly SimulationLoop[];
  readonly solver: SimulationSolver;
  readonly servos: readonly SimulationServo[];
  /** Point springs; absent = none. */
  readonly springs?: readonly SimulationSpring[];
  /** Actuators with state (datasheet motors and their controllers); absent = none. */
  readonly actuators?: ActuatorBlock;
  /** Friction models and end stops (PHY-23); absent = joints keep their constant `friction`. */
  readonly jointPhysics?: JointPhysicsBlock;
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
  /** Per aux slot of `model.actuators`, the value at every sample (the last step's outputs for the slots that hold them). */
  readonly aux?: number[][];
  /** Cumulative energy J of every `ledgerLayout` entry at every sample (zero at the first). */
  readonly ledger?: number[][];
  /** Cumulative work J of the actuator joint forces on the joints (needs `options.energy`), part of `energy.appliedWork`. */
  readonly actuatorWork?: number[];
  /**
   * Heat J of every `dissipation` entry at every sample, cumulative (needs `options.energy`, present when the model has transmissions, joint physics or
   * stops): friction of joint physics (kind 'friction'), power a transmission lost (kind 'transmission_loss'), what an end stop or a backlash edge
   * absorbed (kind 'stop': minus the work of its force, minus the spring energy still stored).
   */
  readonly heat?: {
    readonly layout: readonly { readonly element: string; readonly kind: 'friction' | 'transmission_loss' | 'stop' }[];
    readonly joules: number[][];
  };
  /** Per joint with an end stop (needs `options.energy`): largest penetration (rad or m) and largest stop force (N·m or N) of the run. */
  readonly stops?: Record<string, { readonly peakPenetration: number; readonly peakForce: number }>;
  /** m: largest loop-constraint violation over every integration step (present when the model has loops). */
  readonly loopResidual?: number;
}

export interface PhysicsEngine {
  /** Engine name and version, reported with every result (e.g. "MuJoCo 3.16.0"). */
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
