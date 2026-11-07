/**
 * Joint physics (PHY-23 TR-DRV-15..17): friction models as per-step levels, end stops as one-sided spring-dampers, armature.
 * Friction levels are box bounds on the constraint force of the joint (the engine holds a joint at rest exactly up to the level):
 *   stiction  F_s while the joint is at rest and its friction constraint is inside its limit, F_k otherwise (breakaway is detected on the constraint);
 *   stribeck  F_c + (F_s - F_c) exp(-(v / v_s)²) [Stribeck 1902; Armstrong-Helouvry 1994], finite at v = 0 (F_s);
 *   load_dependent  base + μ · r · (|F_radial| + preload + |M_bending| / arm) on a revolute joint, μ · (|F_radial| + preload) on a prismatic one.
 */

import type { FrictionObservation, JointPhysicsBlock, SimulationState } from '@core/dynamics/physicsEngine';
import type { DynamicJoint, DynamicsModel } from '@core/model/dynamics';
import { transmissionJoints, type JointFriction } from '@core/model/transmissions';
import { coarseStepProblem, stopDampingRatio } from './transmissions';

/** Speed (rad/s or m/s) below which a stiction joint counts as at rest (TR-DRV-15 `v_tol`). */
const REST_SPEED = 1e-4;

/** What replaces the `friction` / `damping` shortcut of a joint once it has joint physics. */
interface EffectiveFriction {
  /** Constant dry friction N·m or N (the engine's `frictionloss`; integrated from the sampled speed by the energy report). */
  readonly dry: number;
  readonly damping: number;
  /** State-dependent level, null when the friction is constant. */
  readonly dynamic: Exclude<JointFriction, { model: 'coulomb' }> | null;
}

/** The friction and damping the simulation uses for `joint`: its shortcut numbers, or those of its friction model. */
export function effectiveFriction(dynamics: DynamicsModel, joint: DynamicJoint): EffectiveFriction {
  const model = dynamics.jointPhysics?.[joint.id]?.friction;
  if (model === undefined) return { dry: joint.friction, damping: joint.damping, dynamic: null };
  const damping = model.viscous ?? joint.damping;
  return model.model === 'coulomb' ? { dry: model.kinetic, damping, dynamic: null } : { dry: 0, damping, dynamic: model };
}

function levelOf(
  friction: Exclude<JointFriction, { model: 'coulomb' }>,
  prismatic: boolean,
  velocity: number,
  observed: FrictionObservation,
  k: number,
): number {
  switch (friction.model) {
    case 'stiction':
      return Math.abs(velocity) < REST_SPEED && observed.saturated[k] === 0 ? friction.static : friction.kinetic;
    case 'stribeck': {
      const ratio = velocity / friction.stribeckVelocity;
      return friction.coulomb + (friction.static - friction.coulomb) * Math.exp(-ratio * ratio);
    }
    case 'load_dependent': {
      const arm = friction.frictionArmMm === undefined ? 0 : friction.frictionArmMm * 1e-3;
      const bending = arm > 0 ? (observed.bendingMoment[k] ?? 0) / arm : 0;
      const normal = (observed.radialLoad[k] ?? 0) + (friction.preloadN ?? 0) + bending;
      const radius = prismatic ? 1 : friction.pinRadiusMm * 1e-3;
      return (friction.base ?? 0) + friction.mu * radius * normal;
    }
  }
}

export interface JointPhysicsContext {
  readonly timestep: number;
  readonly sign: (jointId: string) => number;
  /** kg·m² (kg) the joint's coordinate pushes, couplings and armature included. */
  readonly inertiaOf: (jointId: string) => number | undefined;
  /** Joints whose rest latch is switched off, with the reason (see `latchBlockers`). */
  readonly unlatched: ReadonlyMap<string, string>;
}

export interface BuiltJointPhysics {
  readonly block: JointPhysicsBlock;
  /** Notes the report states (DRV_STICTION_NOT_LATCHED). */
  readonly notes: readonly string[];
}

export interface JointPhysicsRefusal {
  readonly error: string;
  readonly code: 'DRV_STEP_TOO_COARSE' | 'DRV_LIMITS_INVALID';
}

/** The engine block of the document's joint physics (state-dependent friction levels, end stops), null when it has none. */
export function buildJointPhysics(dynamics: DynamicsModel, context: JointPhysicsContext): BuiltJointPhysics | null | JointPhysicsRefusal {
  const entries = Object.values(dynamics.jointPhysics ?? {}).filter((physics) => dynamics.joints[physics.id] !== undefined);
  const dynamicFriction = entries.flatMap((physics) => {
    const { dynamic } = effectiveFriction(dynamics, dynamics.joints[physics.id] as DynamicJoint);
    return dynamic === null ? [] : [{ joint: dynamics.joints[physics.id] as DynamicJoint, friction: dynamic }];
  });
  const limits: JointPhysicsBlock['limits'][number][] = [];
  for (const physics of entries) {
    if (physics.limits === undefined) continue;
    const inertia = context.inertiaOf(physics.id);
    if (inertia === undefined || !(inertia > 0))
      return { error: `joint '${physics.id}' has end stops but no inertia to push (no mass on it)`, code: 'DRV_LIMITS_INVALID' };
    const { min, max, stiffness } = physics.limits;
    const coarse = coarseStepProblem(`end stop of '${physics.id}'`, stiffness, inertia, context.timestep);
    if (coarse !== null) return { error: coarse, code: 'DRV_STEP_TOO_COARSE' };
    const zeta = stopDampingRatio(physics.limits.dampingRatio, physics.limits.restitution);
    const flipped = context.sign(physics.id) < 0;
    limits.push({
      joint: physics.id,
      min: flipped ? -max : min,
      max: flipped ? -min : max,
      stiffness,
      damping: 2 * zeta * Math.sqrt(stiffness * inertia),
      effectiveInertia: inertia,
    });
  }
  if (dynamicFriction.length === 0 && limits.length === 0) return null;
  const latching = dynamicFriction.filter((entry) => entry.friction.model === 'stiction' || entry.friction.model === 'stribeck');
  const notes = latching.flatMap((entry) => {
    const reason = context.unlatched.get(entry.joint.id);
    return reason === undefined
      ? []
      : [
          `DRV_STICTION_NOT_LATCHED: joint '${entry.joint.id}' ${reason}, so its rest latch is off: the soft friction row lets a held load creep at about 1e-4 · Δt · its free acceleration (use a smaller timestep for a tight hold)`,
        ];
  });
  const block: JointPhysicsBlock = {
    frictionJoints: dynamicFriction.map((entry) => entry.joint.id),
    restLatch: dynamicFriction.map((entry) => latching.includes(entry) && !context.unlatched.has(entry.joint.id)),
    needsLoad: dynamicFriction.some((entry) => entry.friction.model === 'load_dependent'),
    frictionLevel: (state: SimulationState, observed: FrictionObservation): Float64Array =>
      Float64Array.from(dynamicFriction, (entry, k) =>
        levelOf(entry.friction, entry.joint.kind === 'prismatic', state.jointVelocity[entry.joint.id] ?? 0, observed, k),
      ),
    limits,
  };
  return { block, notes };
}

/**
 * Joints whose Karnopp rest latch must stay off, with why: a coupled joint (transmission), any joint of a model with loops, and a joint a servo,
 * a speed governor or a datasheet drive acts on (restoring its position would wind up their set-point or integrator).
 */
export function latchBlockers(dynamics: DynamicsModel, hasLoops: boolean): Map<string, string> {
  const reasons = new Map<string, string>();
  const block = (joint: string, reason: string): void => void (reasons.has(joint) ? undefined : reasons.set(joint, reason));
  if (hasLoops) for (const joint of Object.keys(dynamics.joints)) block(joint, 'is in a model with kinematic loops');
  for (const t of Object.values(dynamics.transmissions ?? {}))
    for (const joint of Object.values(transmissionJoints(t))) block(joint, `is coupled by transmission '${t.id}'`);
  for (const motor of Object.values(dynamics.motors)) {
    if (motor.kind === 'torque_curve') continue;
    block(motor.joint, `is acted on by ${motor.kind} motor '${motor.id}' (its set-point or controller would wind up)`);
    const target = dynamics.drives?.[motor.id]?.target;
    if (target !== undefined) block(target, `is the target of the drive of motor '${motor.id}'`);
  }
  return reasons;
}
