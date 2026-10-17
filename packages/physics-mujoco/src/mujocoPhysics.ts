/**
 * MuJoCo (Google DeepMind, C, official WASM build `@mujoco/mujoco`) behind the core `PhysicsEngine` interface. Generalised-coordinate
 * multibody dynamics: joints are exact (no drift between linked parts), gear couplings are equality constraints.
 */

import type {
  PhysicsEngine,
  Quaternion,
  SimulationModel,
  SimulationOptions,
  SimulationTrace,
  StepPeak,
} from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { OBJECT_BODY, OBJECT_JOINT, type MjData, type MjModel, type MujocoModule } from './bindings';
import { jointReaction, loopReader, loopSlots, type ReactionSlot } from './constraintForces';
import { toMjcf } from './mjcf';

interface JointSlot {
  readonly id: string;
  readonly qpos: number;
  readonly dof: number;
}

/** Quaternion product a · conj(b): the rotation from orientation b to orientation a. */
function relativeQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = [b[0], -b[1], -b[2], -b[3]];
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

function lookup(mujoco: MujocoModule, model: MjModel, type: number, name: string): number {
  const index = mujoco.mj_name2id(model, type, name);
  if (index < 0) throw new Error(`MuJoCo model has no element '${name}'.`);
  return index;
}

function runSimulation(mujoco: MujocoModule, model: SimulationModel, options: SimulationOptions): SimulationTrace {
  const mjModel = mujoco.MjModel.from_xml_string(toMjcf(model, options.timestep));
  const data = new mujoco.MjData(mjModel);
  try {
    const joints: JointSlot[] = model.bodies.flatMap((body) => {
      if (body.joint === null) return [];
      const index = lookup(mujoco, mjModel, OBJECT_JOINT, body.joint.id);
      return [{ id: body.joint.id, qpos: mjModel.jnt_qposadr[index] ?? 0, dof: mjModel.jnt_dofadr[index] ?? 0 }];
    });
    const bodies = model.bodies.map((body) => ({ id: body.id, index: lookup(mujoco, mjModel, OBJECT_BODY, body.id) }));
    for (const body of model.bodies) if (body.joint !== null) data.qvel[jointDof(joints, body.joint.id)] = body.joint.initialVelocity;
    mujoco.mj_forward(mjModel, data);
    const initialOrientation = new Map(bodies.map(({ id, index }) => [id, readQuaternion(data, index)]));
    const wantReactions = options.reactions === true;
    const slots = loopSlots(mujoco, mjModel, model.loops);
    const reader = loopReader(slots);
    const reactionSlots: ReactionSlot[] = wantReactions
      ? model.bodies.flatMap((body, i) =>
          body.joint === null
            ? []
            : [
                {
                  jointId: body.joint.id,
                  bodyIndex: bodies[i]?.index ?? 0,
                  jointIndex: lookup(mujoco, mjModel, OBJECT_JOINT, body.joint.id),
                },
              ],
        )
      : [];
    const loopForce: Record<string, Vec3[]> = Object.fromEntries(model.loops.map((loop) => [loop.id, []]));
    const reaction: Record<string, { force: Vec3[]; moment: Vec3[] }> = Object.fromEntries(
      reactionSlots.map((slot) => [slot.jointId, { force: [], moment: [] }]),
    );
    let residual = 0;
    const trace: SimulationTrace = {
      times: [],
      jointPosition: Object.fromEntries(joints.map((joint) => [joint.id, []])),
      jointVelocity: Object.fromEntries(joints.map((joint) => [joint.id, []])),
      bodyPosition: Object.fromEntries(bodies.map((body) => [body.id, []])),
      bodyOrientation: Object.fromEntries(bodies.map((body) => [body.id, []])),
      servoForce: Object.fromEntries(model.servos.map((servo) => [servo.id, []])),
    };
    const initialPosition = new Map(joints.map((joint) => [joint.id, data.qpos[joint.qpos] ?? 0]));
    model.servos.forEach((servo, i) => {
      data.ctrl[i] = servo.targetVelocity;
      // the set-point starts where the servo force is zero at the joint's start state: q + damping · v / stiffness
      const joint = joints.find((slot) => slot.id === servo.joint);
      data.act[i] =
        joint === undefined
          ? 0
          : (data.qpos[joint.qpos] ?? 0) + (servo.stiffness > 0 ? (servo.damping * (data.qvel[joint.dof] ?? 0)) / servo.stiffness : 0);
    });
    const peaks: Record<string, { force: StepPeak; moment: StepPeak | null }> = {};
    const keepPeak = (id: string, force: Vec3, moment: Vec3 | null): void => {
      const [f, m] = [Math.hypot(force[0], force[1], force[2]), moment === null ? 0 : Math.hypot(moment[0], moment[1], moment[2])];
      const held = peaks[id];
      const forceUp = held === undefined || f > held.force.value;
      const momentUp = moment !== null && (held?.moment == null || m > held.moment.value);
      if (!forceUp && !momentUp) return; // the common case: no allocation per step
      peaks[id] = {
        force: forceUp || held === undefined ? { value: f, timeS: data.time } : held.force,
        moment: moment === null ? null : momentUp || held?.moment == null ? { value: m, timeS: data.time } : held.moment,
      };
    };
    interface Reactions {
      readonly loops: Vec3[];
      readonly joints: { force: Vec3; moment: Vec3 }[];
    }
    // constraint forces of the current state: forward pass, redundant multipliers removed, then the inverse dynamics that fills cfrc_int
    const readReactions = (): Reactions => {
      mujoco.mj_forward(mjModel, data);
      reader.dropRedundantForces(mjModel, data);
      mujoco.mj_rnePostConstraint(mjModel, data);
      const loops = reader.forces(data);
      const joints = reactionSlots.map((slot) => jointReaction(mjModel, data, slot));
      loops.forEach((force, i) => keepPeak(model.loops[i]?.id ?? '', force, null));
      reactionSlots.forEach((slot, i) => keepPeak(slot.jointId, joints[i]?.force ?? [0, 0, 0], joints[i]?.moment ?? [0, 0, 0]));
      return { loops, joints };
    };
    const pushReactions = (read: Reactions): void => {
      read.loops.forEach((force, i) => loopForce[model.loops[i]?.id ?? '']?.push(force));
      reactionSlots.forEach((slot, i) => {
        reaction[slot.jointId]?.force.push(read.joints[i]?.force ?? [0, 0, 0]);
        reaction[slot.jointId]?.moment.push(read.joints[i]?.moment ?? [0, 0, 0]);
      });
    };
    mujoco.mj_forward(mjModel, data); // actuator forces of the start state, with the set-points above
    const record = (read?: Reactions): void => {
      trace.times.push(data.time);
      for (const joint of joints) {
        trace.jointPosition[joint.id]?.push((data.qpos[joint.qpos] ?? 0) - (initialPosition.get(joint.id) ?? 0));
        trace.jointVelocity[joint.id]?.push(data.qvel[joint.dof] ?? 0);
      }
      model.servos.forEach((servo, i) => trace.servoForce[servo.id]?.push(data.actuator_force[i] ?? 0));
      for (const { id, index } of bodies) {
        const xpos = data.xpos;
        trace.bodyPosition[id]?.push([xpos[3 * index] ?? 0, xpos[3 * index + 1] ?? 0, xpos[3 * index + 2] ?? 0]);
        const start = initialOrientation.get(id) ?? [1, 0, 0, 0];
        trace.bodyOrientation[id]?.push(relativeQuaternion(readQuaternion(data, index), start));
      }
      if (wantReactions) pushReactions(read ?? readReactions());
    };
    const steps = Math.round(options.duration / options.timestep);
    const stride = Math.max(1, Math.round(options.sampleInterval / options.timestep));
    record();
    let previousVelocity = joints.map((joint) => data.qvel[joint.dof] ?? 0);
    for (let step = 1; step <= steps; step++) {
      previousVelocity = applyLoads(model, data, { joints, bodies, initialPosition, previousVelocity, timestep: options.timestep });
      mujoco.mj_step(mjModel, data);
      if (!data.qvel.every(Number.isFinite)) throw new Error(`simulation diverged at t = ${data.time.toFixed(4)} s.`);
      if (slots.length > 0) residual = Math.max(residual, reader.residual(data));
      const sampled = step % stride === 0 || step === steps;
      if (wantReactions) {
        const read = readReactions();
        if (sampled) record(read);
      } else if (sampled) record();
    }
    return {
      ...trace,
      ...(wantReactions ? { jointReaction: reaction, reactionPeaks: peaks, ...(slots.length > 0 ? { loopForce } : {}) } : {}),
      ...(slots.length > 0 ? { loopResidual: residual } : {}),
    };
  } finally {
    data.delete();
    mjModel.delete();
  }
}

function jointDof(joints: readonly JointSlot[], id: string): number {
  return joints.find((joint) => joint.id === id)?.dof ?? 0;
}

function readQuaternion(data: MjData, index: number): Quaternion {
  const q = data.xquat;
  return [q[4 * index] ?? 1, q[4 * index + 1] ?? 0, q[4 * index + 2] ?? 0, q[4 * index + 3] ?? 0];
}

interface LoadContext {
  readonly joints: readonly JointSlot[];
  readonly bodies: readonly { id: string; index: number }[];
  readonly initialPosition: ReadonlyMap<string, number>;
  /** Joint velocities at the start of the previous step. */
  readonly previousVelocity: readonly number[];
  readonly timestep: number;
}

/**
 * Evaluate the force laws at the step MIDPOINT — velocities extrapolated from the last step, v(t+h/2) ≈ v + (v - v_prev)/2 — and hold them
 * for the step. A plain start-of-step evaluation is first-order accurate in h; the midpoint makes velocity-dependent loads (propeller
 * drag) second-order. Returns the current velocities (the next call's `previousVelocity`).
 */
function applyLoads(model: SimulationModel, data: MjData, context: LoadContext): number[] {
  const { joints, bodies, initialPosition, previousVelocity, timestep } = context;
  const { qpos, qvel, qfrc_applied: jointForce, xfrc_applied: bodyForce } = data;
  const velocity = joints.map((joint) => qvel[joint.dof] ?? 0);
  const midVelocity = velocity.map((v, i) => v + 0.5 * (v - (previousVelocity[i] ?? v)));
  const loads = model.loads({
    time: data.time + 0.5 * timestep,
    jointPosition: Object.fromEntries(
      joints.map((joint, i) => [
        joint.id,
        (qpos[joint.qpos] ?? 0) - (initialPosition.get(joint.id) ?? 0) + 0.5 * timestep * (velocity[i] ?? 0),
      ]),
    ),
    jointVelocity: Object.fromEntries(joints.map((joint, i) => [joint.id, midVelocity[i] ?? 0])),
  });
  for (const joint of joints) jointForce[joint.dof] = loads.jointForces[joint.id] ?? 0;
  for (const { id, index } of bodies) {
    const force: Vec3 = loads.bodyForces[id] ?? [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) bodyForce[6 * index + axis] = force[axis] ?? 0;
  }
  return velocity;
}

/** Load the MuJoCo WASM module (once per call) and wrap it as a `PhysicsEngine`. */
export async function createMujocoPhysics(): Promise<PhysicsEngine> {
  const { default: loadMujoco } = (await import('@mujoco/mujoco')) as unknown as { default: () => Promise<MujocoModule> };
  const mujoco = await loadMujoco();
  return { name: `MuJoCo ${mujoco.mj_versionString()}`, simulate: (model, options) => runSimulation(mujoco, model, options) };
}
