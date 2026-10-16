/**
 * MuJoCo (Google DeepMind, C, official WASM build `@mujoco/mujoco`) behind the core `PhysicsEngine` interface. Generalised-coordinate
 * multibody dynamics: joints are exact (no drift between linked parts), gear couplings are equality constraints.
 */

import type { PhysicsEngine, Quaternion, SimulationModel, SimulationOptions, SimulationTrace } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { toMjcf } from './mjcf';

/** The slice of the MuJoCo WASM bindings this adapter uses (the generated typings are `any`). */
interface MjModel {
  readonly njnt: number;
  readonly jnt_qposadr: Int32Array;
  readonly jnt_dofadr: Int32Array;
  delete(): void;
}

interface MjData {
  readonly time: number;
  readonly qpos: Float64Array;
  readonly qvel: Float64Array;
  readonly qfrc_applied: Float64Array;
  readonly ctrl: Float64Array;
  readonly act: Float64Array;
  readonly actuator_force: Float64Array;
  readonly xfrc_applied: Float64Array;
  readonly xpos: Float64Array;
  readonly xquat: Float64Array;
  delete(): void;
}

interface MujocoModule {
  readonly MjModel: { from_xml_string(xml: string): MjModel };
  readonly MjData: new (model: MjModel) => MjData;
  mj_name2id(model: MjModel, type: number, name: string): number;
  mj_step(model: MjModel, data: MjData): void;
  mj_forward(model: MjModel, data: MjData): void;
  mj_versionString(): string;
}

/** mjtObj values (mjOBJ_BODY, mjOBJ_JOINT). */
const OBJECT_BODY = 1;
const OBJECT_JOINT = 3;

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
      // the governor's set-point starts at the joint's start angle
      const joint = joints.find((slot) => slot.id === servo.joint);
      data.act[i] = joint === undefined ? 0 : (data.qpos[joint.qpos] ?? 0);
    });
    const record = (): void => {
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
    };
    const steps = Math.round(options.duration / options.timestep);
    const stride = Math.max(1, Math.round(options.sampleInterval / options.timestep));
    record();
    let previousVelocity = joints.map((joint) => data.qvel[joint.dof] ?? 0);
    for (let step = 1; step <= steps; step++) {
      previousVelocity = applyLoads(model, data, { joints, bodies, initialPosition, previousVelocity, timestep: options.timestep });
      mujoco.mj_step(mjModel, data);
      if (!data.qvel.every(Number.isFinite)) throw new Error(`simulation diverged at t = ${data.time.toFixed(4)} s.`);
      if (step % stride === 0 || step === steps) record();
    }
    return trace;
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
