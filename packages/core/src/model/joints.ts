import type { Vec3 } from './vectors';

/** An InstanceEntity and the frame of it a joint attaches to. */
export interface JointMateRef {
  readonly instanceId: string;
  /** Default 'origin'. */
  readonly frame?: 'origin' | 'axis-x' | 'axis-y' | 'axis-z';
}

/** Travel limit of one joint DOF (radians for rotations, document units for slides); an absent bound is unbounded. */
export interface JointLimit {
  min?: number | undefined;
  max?: number | undefined;
}

interface JointBase<K extends string> {
  readonly id: string;
  readonly kind: K;
  readonly a: JointMateRef;
  readonly b: JointMateRef;
  /** 'x'|'y'|'z' shorthand or a unit Vec3. */
  axis: 'x' | 'y' | 'z' | Vec3;
  /** World point (rest pose) the joint acts about; absent = origin of instance `a`. */
  pivot?: Vec3;
  /** Unknown of a closed loop: its value is solved so the loop closes (the stored value is the initial guess). */
  passive?: boolean;
  /** One entry per DOF in `JOINT_DOF` order. */
  limits?: JointLimit[];
}

/** Joint whose DOFs live in `values` (see `JOINT_DOF` for the order). */
type MultiJoint<K extends string> = JointBase<K> & { values: number[] };

/**
 * Instance `b` moves relative to `a`. revolute: `angle` (rad) about `axis`; prismatic: `displacement` along it; rigid: none;
 * cylindrical: [angle, displacement] on one axis; pin_slot: [angle about `axis`, displacement along `slotAxis`]; planar: [u, v, angle]
 * in the plane normal to `axis`; ball: [rx, ry, rz] Euler XYZ about `pivot`; cam: slide of `b` along `axis` computed from the angle of
 * joint `camJoint` and the 2D profile entity `profileId` (no DOF of its own).
 * @see add_joint, set_joint_value, evaluate_motion
 */
export type Joint =
  | (JointBase<'revolute'> & { angle: number })
  | (JointBase<'prismatic'> & { displacement: number })
  | MultiJoint<'rigid'>
  | MultiJoint<'cylindrical'>
  | (MultiJoint<'pin_slot'> & { slotAxis: 'x' | 'y' | 'z' | Vec3 })
  | MultiJoint<'planar'>
  | MultiJoint<'ball'>
  | (MultiJoint<'cam'> & { camJoint: string; profileId: string });

export type JointKind = Joint['kind'];

/** Degrees of freedom per kind: `r` = rotation (rad), `t` = translation (document units), in `values` order. */
export const JOINT_DOF: Readonly<Record<JointKind, readonly ('r' | 't')[]>> = {
  revolute: ['r'],
  prismatic: ['t'],
  rigid: [],
  cylindrical: ['r', 't'],
  pin_slot: ['r', 't'],
  planar: ['t', 't', 'r'],
  ball: ['r', 'r', 'r'],
  cam: [],
};

/** Named group of body pairs that must not interpenetrate; `motion_study` / `drive_joint_to` stop motion at first contact. */
export interface ContactSet {
  readonly id: string;
  name: string;
  /** Pairs of InstanceEntity ids. */
  pairs: [string, string][];
}

/** One displaced entity of an exploded view. */
export interface ExplodeOffset {
  /** Entity id (instance or solid). */
  target: string;
  /** Displacement in world document units, applied at render time only. */
  vector: Vec3;
  /** 1-based explode step in which this offset appears. */
  step: number;
}

/**
 * Display-only offsets: the parts' real placements never change.
 * @invariant offsets lists each target at most once
 */
export interface ExplodedView {
  readonly id: string;
  name: string;
  offsets: ExplodeOffset[];
}

/** Which exploded view the viewport draws and how many of its steps (absent `step` = all). */
export interface ActiveExplodedView {
  id: string;
  step?: number;
}

/** The `CadDocument` fields of contact sets and exploded views (SC-F4); every one absent until its first command. */
export interface AssemblyPresentationFields {
  /** Absent until the first `create_contact_set`. */
  contactSets?: Record<string, ContactSet>;
  /** Absent until the first `create_exploded_view`; display-only offsets, never moves real placements. */
  explodedViews?: Record<string, ExplodedView>;
  /** Exploded view the viewport draws; absent = none. */
  activeExplodedView?: ActiveExplodedView;
}
