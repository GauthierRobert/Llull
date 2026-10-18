/** The slice of the MuJoCo WASM bindings this adapter uses (the generated typings are `any`). Names verified against 3.14.0. */

export interface MjModel {
  readonly njnt: number;
  readonly nv: number;
  readonly jnt_qposadr: Int32Array;
  readonly jnt_dofadr: Int32Array;
  readonly body_rootid: Int32Array;
  delete(): void;
}

export interface MjData {
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
  /** World position of each joint anchor, 3 per joint. */
  readonly xanchor: Float64Array;
  /** World centre of mass of each body's subtree, 3 per body. */
  readonly subtree_com: Float64Array;
  /** Interaction force of each body with its parent after `mj_rnePostConstraint`: [torque(3), force(3)] about the root subtree COM. */
  readonly cfrc_int: Float64Array;
  /** [potential, kinetic] J of the state evaluated by the last forward pass (needs the MJCF energy flag). Potential: gravity + joint springs. */
  readonly energy: Float64Array;
  /** Length m and rate of change m/s of each tendon (point springs). */
  readonly ten_length: Float64Array;
  readonly ten_velocity: Float64Array;
  readonly nefc: number;
  readonly efc_type: Int32Array;
  readonly efc_id: Int32Array;
  readonly efc_force: Float64Array;
  readonly efc_pos: Float64Array;
  /** Constraint Jacobian, row-major nefc x nv (dense: the MJCF sets jacobian="dense"). */
  readonly efc_J: Float64Array;
  delete(): void;
}

export interface MujocoModule {
  readonly MjModel: { from_xml_string(xml: string): MjModel };
  readonly MjData: new (model: MjModel) => MjData;
  mj_name2id(model: MjModel, type: number, name: string): number;
  mj_step(model: MjModel, data: MjData): void;
  mj_forward(model: MjModel, data: MjData): void;
  mj_rnePostConstraint(model: MjModel, data: MjData): void;
  mj_versionString(): string;
}

/** mjtObj values. */
export const OBJECT_BODY = 1;
export const OBJECT_JOINT = 3;
export const OBJECT_TENDON = 18;
export const OBJECT_EQUALITY = 17;
/** mjtConstraint: equality rows (connect / joint equalities). */
export const CONSTRAINT_EQUALITY = 0;
