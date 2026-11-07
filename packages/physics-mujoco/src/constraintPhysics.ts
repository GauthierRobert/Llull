/**
 * Friction levels, transmission losses and the energy of end stops (PHY-23 DRV-M2) on top of MuJoCo's constraint rows.
 *
 * Before every step the adapter runs a forward pass of the start state (loads and actuator forces already applied) and reads the rows it
 * produced: the friction row of each friction joint (is it at its limit?), the constraint a transmission transmits (its torque on the input
 * joint), the limit rows (penetration, force). It then writes the friction level of each friction DOF (`dof_frictionloss`, DRV-M0 13.1) as
 *   constant + level of the joint physics + sum over transmissions of the loss level of that transmission (port: `TransmissionCoupling`).
 * Heat: friction does `level · |Δq|` of work per step (the part above the constant, which the report integrates itself); an end stop or a
 * backlash edge does work `f · Δ(penetration)` through its row (trapezoid of the start and end forces), of which the spring keeps ½ K x²
 * (`stop` heat = minus the work minus that spring energy).
 */

import type {
  FrictionObservation,
  JointPhysicsBlock,
  SimulationModel,
  SimulationState,
  SimulationTrace,
  TransmissionCoupling,
} from '@core/dynamics/physicsEngine';
import {
  CONSTRAINT_EQUALITY,
  CONSTRAINT_FRICTION_DOF,
  CONSTRAINT_LIMIT_JOINT,
  CONSTRAINT_LIMIT_TENDON,
  OBJECT_EQUALITY,
  OBJECT_JOINT,
  OBJECT_TENDON,
  type MjData,
  type MjModel,
  type MujocoModule,
} from './bindings';
import { jointReaction } from './constraintForces';
import { lossyInputs, transmissionName } from './mjcf';

/** Speed (rad/s or m/s) below which a joint counts as at rest when the direction of power flow is decided (TR-DRV-15 default `v_tol`). */
const REST_SPEED = 1e-4;
/** A friction row at this fraction of its level is saturated (breakaway or slip). */
const SATURATION = 1 - 1e-5;

interface JointSlot {
  readonly id: string;
  readonly qpos: number;
  readonly dof: number;
}

type HeatEntry = NonNullable<SimulationTrace['heat']>['layout'][number];

interface LossSlot {
  readonly coupling: TransmissionCoupling;
  readonly efficiency: { readonly forward: number; readonly backward: number };
  readonly dofA: number;
  /** Row owner: equality (rigid) or fixed tendon (backlash) index in MuJoCo. */
  readonly rowType: number;
  readonly rowObject: number;
  readonly heat: number;
}

interface FrictionDof {
  readonly joint: JointSlot;
  readonly constant: number;
  /** Index in `JointPhysicsBlock.frictionJoints`, -1 when the joint has only transmission losses. */
  readonly physicsIndex: number;
  readonly heat: number;
  readonly losses: readonly LossSlot[];
}

interface StopElement {
  readonly key: string;
  readonly stiffness: number;
  readonly heat: number;
  readonly rowType: number;
  readonly rowObject: number;
}

/** Force (N·m or N) and penetration of the limit rows of one stop element at one state. */
interface StopState {
  readonly force: Float64Array;
  readonly depth: Float64Array;
}

export interface ConstraintPhysics {
  /** Forward pass of the start state and the friction levels of the coming step; call after the loads were applied, before `mj_step`. */
  prepare(data: MjData): void;
  /** Heat and stop work of the step just taken. */
  finish(data: MjData): void;
  /** Cumulative heat of every layout entry at the current sample (after a forward pass of the sampled state). */
  sample(data: MjData): number[];
  readonly layout: readonly HeatEntry[];
  stops(): Record<string, { peakPenetration: number; peakForce: number }>;
}

/** Coupling torque (force) the rows of one owner put on `dof`: sum of J[row, dof] · force over the rows. */
function rowTorque(data: MjData, nv: number, type: number, object: number, dof: number): number {
  let total = 0;
  for (let row = 0; row < data.nefc; row++)
    if (data.efc_type[row] === type && data.efc_id[row] === object) total += (data.efc_J[row * nv + dof] ?? 0) * (data.efc_force[row] ?? 0);
  return total;
}

/**
 * Adapter-side machinery of the model's transmissions with loss or backlash, joint physics and end stops; null when it has none.
 * `bodyIndexOfJoint` is the MuJoCo body that carries a joint; `initialPosition` the qpos of the start pose.
 */
export function createConstraintPhysics(
  mujoco: MujocoModule,
  mjModel: MjModel,
  model: SimulationModel,
  joints: readonly JointSlot[],
  bodyIndexOfJoint: ReadonlyMap<string, number>,
  initialPosition: ReadonlyMap<string, number>,
  trackEnergy: boolean,
): ConstraintPhysics | null {
  const physics: JointPhysicsBlock | undefined = model.jointPhysics;
  const lossy = lossyInputs(model);
  const stopsInModel = physics?.limits ?? [];
  const backlash = model.transmissions.filter((coupling) => coupling.backlash !== undefined);
  if (physics === undefined && lossy.length === 0 && backlash.length === 0) return null;
  const nv = mjModel.nv;
  const slotOf = (id: string): JointSlot => {
    const slot = joints.find((entry) => entry.id === id);
    if (slot === undefined) throw new Error(`joint physics names '${id}', which is not a moving joint of the model`);
    return slot;
  };
  const layout: HeatEntry[] = [];
  const entry = (element: string, kind: HeatEntry['kind']): number => layout.push({ element, kind }) - 1;
  const constantOf = (id: string): number => model.bodies.find((body) => body.joint?.id === id)?.joint?.friction ?? 0;

  const losses: LossSlot[] = model.transmissions.flatMap((coupling) => {
    if (coupling.efficiency === undefined) return [];
    const backlashed = coupling.backlash !== undefined;
    const object = mujoco.mj_name2id(mjModel, backlashed ? OBJECT_TENDON : OBJECT_EQUALITY, transmissionName(coupling.id));
    if (object < 0) throw new Error(`MuJoCo model has no constraint for transmission '${coupling.id}'.`);
    return [
      {
        coupling,
        efficiency: coupling.efficiency,
        dofA: slotOf(coupling.a).dof,
        rowType: backlashed ? CONSTRAINT_LIMIT_TENDON : CONSTRAINT_EQUALITY,
        rowObject: object,
        heat: entry(`transmission:${coupling.id}`, 'transmission_loss'),
      },
    ];
  });
  const frictionIds = [...new Set([...(physics?.frictionJoints ?? []), ...lossy])];
  const frictionDofs: FrictionDof[] = frictionIds.map((id) => {
    const physicsIndex = physics?.frictionJoints.indexOf(id) ?? -1;
    return {
      joint: slotOf(id),
      constant: constantOf(id),
      physicsIndex,
      heat: physicsIndex < 0 ? -1 : entry(`friction:${id}`, 'friction'),
      losses: losses.filter((slot) => slot.coupling.a === id),
    };
  });
  const stopElements: StopElement[] = [
    ...stopsInModel.map((limit) => ({
      key: limit.joint,
      stiffness: limit.stiffness,
      heat: entry(`stop:${limit.joint}`, 'stop'),
      rowType: CONSTRAINT_LIMIT_JOINT,
      rowObject: mujoco.mj_name2id(mjModel, OBJECT_JOINT, limit.joint),
    })),
    ...backlash.map((coupling) => ({
      key: coupling.id,
      stiffness: coupling.backlash?.stiffness ?? 0,
      heat: entry(`backlash:${coupling.id}`, 'stop'),
      rowType: CONSTRAINT_LIMIT_TENDON,
      rowObject: mujoco.mj_name2id(mjModel, OBJECT_TENDON, transmissionName(coupling.id)),
    })),
  ];
  const reactions =
    physics?.needsLoad === true
      ? new Map(
          frictionDofs.flatMap((fd) => {
            const bodyIndex = bodyIndexOfJoint.get(fd.joint.id);
            return bodyIndex === undefined || fd.physicsIndex < 0
              ? []
              : [
                  [
                    fd.joint.id,
                    { jointId: fd.joint.id, bodyIndex, jointIndex: mujoco.mj_name2id(mjModel, OBJECT_JOINT, fd.joint.id) },
                  ] as const,
                ];
          }),
        )
      : new Map();

  const cumulative = new Float64Array(layout.length);
  let stopWork = new Float64Array(stopElements.length);
  const peaks = stopElements.map(() => ({ peakPenetration: 0, peakForce: 0 }));
  const levelsOfStep = frictionDofs.map(() => ({ dynamic: 0, transmissions: [] as number[] }));
  const coupled = new Set(model.transmissions.flatMap((coupling) => [coupling.a, coupling.b]));
  const latchable = frictionDofs.map(
    (fd) => fd.physicsIndex >= 0 && physics?.restLatch[fd.physicsIndex] === true && !coupled.has(fd.joint.id) && model.loops.length === 0,
  );
  const stuck = new Uint8Array(frictionDofs.length);
  /** State of the stops at the start of the last step, until the state at its end is read. */
  let pendingStop: StopState | null = null;
  let positionBefore = new Float64Array(frictionDofs.length);
  const radial = new Float64Array(physics?.frictionJoints.length ?? 0);
  const bending = new Float64Array(physics?.frictionJoints.length ?? 0);
  const saturated = new Uint8Array(physics?.frictionJoints.length ?? 0);
  const observation: FrictionObservation = { radialLoad: radial, bendingMoment: bending, saturated };

  const startState = (data: MjData): SimulationState => ({
    time: data.time,
    jointPosition: Object.fromEntries(
      joints.map((joint) => [joint.id, (data.qpos[joint.qpos] ?? 0) - (initialPosition.get(joint.id) ?? 0)]),
    ),
    jointVelocity: Object.fromEntries(joints.map((joint) => [joint.id, data.qvel[joint.dof] ?? 0])),
  });

  /** Perpendicular part of a world vector with respect to unit `axis`. */
  const perpendicular = (vector: readonly number[], axis: readonly number[]): number => {
    const along = (vector[0] ?? 0) * (axis[0] ?? 0) + (vector[1] ?? 0) * (axis[1] ?? 0) + (vector[2] ?? 0) * (axis[2] ?? 0);
    return Math.hypot(
      (vector[0] ?? 0) - along * (axis[0] ?? 0),
      (vector[1] ?? 0) - along * (axis[1] ?? 0),
      (vector[2] ?? 0) - along * (axis[2] ?? 0),
    );
  };

  /** Force and penetration of the limit rows of the state in `data` (after a forward pass), summed per stop element. */
  const limitState = (data: MjData): StopState => {
    const state = { force: new Float64Array(stopElements.length), depth: new Float64Array(stopElements.length) };
    for (let row = 0; row < data.nefc; row++) {
      const type = data.efc_type[row];
      if (type !== CONSTRAINT_LIMIT_JOINT && type !== CONSTRAINT_LIMIT_TENDON) continue;
      const element = stopElements.findIndex((candidate) => candidate.rowType === type && candidate.rowObject === data.efc_id[row]);
      if (element < 0) continue;
      state.force[element] = (state.force[element] ?? 0) + (data.efc_force[row] ?? 0);
      state.depth[element] = (state.depth[element] ?? 0) + Math.max(0, -(data.efc_pos[row] ?? 0));
    }
    return state;
  };

  /**
   * Work of the stops over the last step, now that the state at its end is read. A stop force is discontinuous where contact begins or ends (the
   * dashpot acts at once), so a step with the stop active at one end only integrates over the active part with the dashpot force of that end:
   * trapezoid when both ends are active, else the force at the active end minus the spring part (K x) at the other, which is 0 there.
   */
  const settleStopWork = (data: MjData): void => {
    if (pendingStop === null) return;
    const [start, end] = [pendingStop, limitState(data)];
    stopWork = stopWork.map((work, element) => {
      const [f0, f1, x0, x1] = [start.force[element] ?? 0, end.force[element] ?? 0, start.depth[element] ?? 0, end.depth[element] ?? 0];
      const stiffness = stopElements[element]?.stiffness ?? 0;
      if (x0 > 0 && x1 > 0) return work - 0.5 * (f0 + f1) * (x1 - x0);
      if (x1 > 0) return work - 0.5 * (2 * f1 - stiffness * x1) * x1;
      if (x0 > 0) return work + 0.5 * (2 * f0 - stiffness * x0) * x0;
      return work;
    });
    pendingStop = null;
  };

  const trackPeaks = (data: MjData): void => {
    const state = limitState(data);
    state.force.forEach((force, element) => {
      const peak = peaks[element];
      if (peak === undefined) return;
      peak.peakPenetration = Math.max(peak.peakPenetration, state.depth[element] ?? 0);
      peak.peakForce = Math.max(peak.peakForce, force);
    });
    if (trackEnergy) pendingStop = state;
  };

  return {
    layout,
    prepare(data) {
      mujoco.mj_forward(mjModel, data);
      settleStopWork(data);
      if (reactions.size > 0) mujoco.mj_rnePostConstraint(mjModel, data);
      if (stopElements.length > 0) trackPeaks(data);
      const state = physics === undefined ? null : startState(data);
      frictionDofs.forEach((fd, i) => {
        const written = mjModel.dof_frictionloss[fd.joint.dof] ?? 0;
        if (fd.physicsIndex >= 0) {
          let friction = 0;
          for (let row = 0; row < data.nefc; row++)
            if (data.efc_type[row] === CONSTRAINT_FRICTION_DOF && data.efc_id[row] === fd.joint.dof) friction += data.efc_force[row] ?? 0;
          saturated[fd.physicsIndex] = written > 0 && Math.abs(friction) >= SATURATION * written ? 1 : 0;
          const reaction = reactions.get(fd.joint.id);
          if (reaction !== undefined) {
            const read = jointReaction(mjModel, data, reaction);
            const axis = [0, 1, 2].map((k) => data.xaxis[3 * reaction.jointIndex + k] ?? 0);
            radial[fd.physicsIndex] = perpendicular(read.force, axis);
            bending[fd.physicsIndex] = perpendicular(read.moment, axis);
          }
        }
        levelsOfStep[i] = { dynamic: 0, transmissions: [] };
        stuck[i] =
          latchable[i] === true &&
          fd.physicsIndex >= 0 &&
          saturated[fd.physicsIndex] === 0 &&
          Math.abs(data.qvel[fd.joint.dof] ?? 0) < REST_SPEED
            ? 1
            : 0;
        positionBefore[i] = data.qpos[fd.joint.qpos] ?? 0;
      });
      const dynamic = physics !== undefined && state !== null ? physics.frictionLevel(state, observation) : new Float64Array(0);
      frictionDofs.forEach((fd, i) => {
        const level = levelsOfStep[i];
        if (level === undefined) return;
        level.dynamic = fd.physicsIndex < 0 ? 0 : Math.max(0, dynamic[fd.physicsIndex] ?? 0);
        for (const slot of fd.losses) {
          const torque = rowTorque(data, nv, slot.rowType, slot.rowObject, fd.joint.dof);
          const velocity = data.qvel[fd.joint.dof] ?? 0;
          const applied = (data.qfrc_applied[fd.joint.dof] ?? 0) + (data.qfrc_actuator[fd.joint.dof] ?? 0);
          // the input drives when the coupling opposes its motion; at rest when the applied torque opposes the coupling and exceeds it
          const forward =
            Math.abs(velocity) > REST_SPEED ? torque * velocity < 0 : applied * torque < 0 && Math.abs(applied) > Math.abs(torque);
          const { forward: etaForward, backward: etaBackward } = slot.efficiency;
          level.transmissions.push(Math.abs(torque) * (forward ? (1 - etaForward) / etaForward : 1 - etaBackward));
        }
        mjModel.dof_frictionloss[fd.joint.dof] = fd.constant + level.dynamic + level.transmissions.reduce((sum, value) => sum + value, 0);
      });
      positionBefore = Float64Array.from(frictionDofs, (fd) => data.qpos[fd.joint.qpos] ?? 0);
    },
    finish(data) {
      frictionDofs.forEach((fd, i) => {
        if (stuck[i] !== 1) return;
        data.qvel[fd.joint.dof] = 0;
        data.qpos[fd.joint.qpos] = positionBefore[i] ?? 0;
      });
      if (!trackEnergy) return;
      frictionDofs.forEach((fd, i) => {
        const travel = Math.abs((data.qpos[fd.joint.qpos] ?? 0) - (positionBefore[i] ?? 0));
        const level = levelsOfStep[i];
        if (level === undefined) return;
        if (fd.heat >= 0) cumulative[fd.heat] = (cumulative[fd.heat] ?? 0) + level.dynamic * travel;
        fd.losses.forEach((slot, k) => {
          cumulative[slot.heat] = (cumulative[slot.heat] ?? 0) + (level.transmissions[k] ?? 0) * travel;
        });
      });
    },
    sample(data) {
      settleStopWork(data);
      const spring = new Float64Array(stopElements.length);
      for (let row = 0; row < data.nefc; row++) {
        const type = data.efc_type[row];
        if (type !== CONSTRAINT_LIMIT_JOINT && type !== CONSTRAINT_LIMIT_TENDON) continue;
        const element = stopElements.findIndex((candidate) => candidate.rowType === type && candidate.rowObject === data.efc_id[row]);
        const depth = Math.max(0, -(data.efc_pos[row] ?? 0));
        const stop = stopElements[element];
        if (stop !== undefined) spring[element] = (spring[element] ?? 0) + 0.5 * stop.stiffness * depth * depth;
      }
      const values = Array.from(cumulative);
      stopElements.forEach((stop, element) => {
        values[stop.heat] = -(stopWork[element] ?? 0) - (spring[element] ?? 0);
      });
      return values;
    },
    stops() {
      return Object.fromEntries(stopElements.map((stop, element) => [stop.key, peaks[element] ?? { peakPenetration: 0, peakForce: 0 }]));
    },
  };
}
