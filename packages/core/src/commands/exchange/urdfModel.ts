/**
 * Kinematic tree for URDF export: rigid bodies and joints read from the dynamics model (bodies + joints) or from the assembly (instances +
 * `add_joint` joints), reduced to a tree rooted at the fixed `world` link. Joints that cannot be in a URDF tree are reported, not dropped
 * silently.
 */

import type { CadDocument, Vec3 } from '../../model/types';
import { GROUND, type RigidBody } from '../../model/dynamics';
import { axisVector } from '../../lib/axis';

export const WORLD = 'world';

export type UrdfJointType = 'fixed' | 'floating' | 'revolute' | 'prismatic';

export interface UrdfBody {
  /** Unique link name (XML-safe is the writer's job). */
  readonly name: string;
  readonly body: RigidBody;
}

export interface UrdfJoint {
  readonly id: string;
  readonly type: UrdfJointType;
  /** Link name or WORLD. */
  readonly parent: string;
  readonly child: string;
  /** World point (document units) that becomes the child link's origin. */
  readonly anchor: Vec3;
  /** Unit world axis (revolute / prismatic); [0, 0, 1] otherwise. */
  readonly axis: Vec3;
  readonly damping: number;
  readonly friction: number;
}

export interface UrdfTree {
  readonly source: 'dynamics' | 'assembly';
  /** Parent-first. */
  readonly bodies: readonly UrdfBody[];
  readonly joints: readonly UrdfJoint[];
  /** Human-readable reasons for bodies or joints left out. */
  readonly notes: readonly string[];
}

interface Candidate {
  readonly id: string;
  readonly kind: 'revolute' | 'prismatic' | 'fixed' | 'spherical';
  readonly parent: string;
  readonly child: string;
  readonly anchor: Vec3;
  readonly axis: Vec3;
  readonly damping: number;
  readonly friction: number;
}

interface RawModel {
  readonly source: 'dynamics' | 'assembly';
  readonly bodies: readonly RigidBody[];
  readonly candidates: readonly Candidate[];
  /** Bodies welded to the world with their anchor (fixed dynamics bodies, assembly roots). */
  readonly fixedAt: ReadonlyMap<string, Vec3>;
  /** Joints of a kind URDF cannot express, with the reason. */
  readonly skipped: readonly string[];
}

/** URDF joint for an assembly joint kind; null = no URDF equivalent (2+ DOF or a cam). */
const URDF_KIND_OF: Readonly<Record<string, Candidate['kind'] | null>> = {
  revolute: 'revolute',
  prismatic: 'prismatic',
  rigid: 'fixed',
  cylindrical: null,
  pin_slot: null,
  planar: null,
  ball: null,
  cam: null,
};

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
};

function fromDynamics(doc: CadDocument): RawModel | null {
  const dynamics = doc.dynamics;
  if (dynamics === undefined || Object.keys(dynamics.bodies).length === 0) return null;
  const bodies = Object.values(dynamics.bodies);
  return {
    source: 'dynamics',
    bodies,
    candidates: Object.values(dynamics.joints).map((j) => ({
      id: j.id,
      kind: j.kind,
      parent: j.parent,
      child: j.child,
      anchor: j.anchor,
      axis: unit(j.axis),
      damping: j.damping,
      friction: j.friction,
    })),
    fixedAt: new Map(bodies.filter((b) => b.fixed).map((b): [string, Vec3] => [b.id, [0, 0, 0]])),
    skipped: [],
  };
}

function fromAssembly(doc: CadDocument): RawModel | null {
  const joints = Object.values(doc.joints);
  if (joints.length === 0) return null;
  const instanceIds = [...new Set(joints.flatMap((j) => [j.a.instanceId, j.b.instanceId]))].filter(
    (id) => doc.entities[id]?.kind === 'instance',
  );
  const skipped = joints
    .filter((j) => (URDF_KIND_OF[j.kind] ?? null) === null)
    .map((j) => `joint '${j.id}' is ${j.kind}: URDF has no single joint for it, left out.`);
  const usable = joints.filter(
    (j) => (URDF_KIND_OF[j.kind] ?? null) !== null && instanceIds.includes(j.a.instanceId) && instanceIds.includes(j.b.instanceId),
  );
  const children = new Set(usable.map((j) => j.b.instanceId));
  const fixedAt = new Map(
    instanceIds.filter((id) => !children.has(id)).map((id): [string, Vec3] => [id, doc.entities[id]?.position ?? [0, 0, 0]]),
  );
  return {
    source: 'assembly',
    bodies: instanceIds.map((id): RigidBody => {
      const name = doc.entities[id]?.name;
      return { id, ...(name !== undefined ? { name } : {}), entityIds: [id], fixed: fixedAt.has(id) };
    }),
    candidates: usable.map((j) => ({
      id: j.id,
      kind: URDF_KIND_OF[j.kind] ?? 'fixed',
      parent: j.a.instanceId,
      child: j.b.instanceId,
      anchor: doc.entities[j.a.instanceId]?.position ?? [0, 0, 0],
      axis: unit(axisVector(j.axis)),
      damping: 0,
      friction: 0,
    })),
    fixedAt,
    skipped,
  };
}

function uniqueNames(bodies: readonly RigidBody[]): Map<string, string> {
  const taken = new Set<string>([WORLD]);
  const names = new Map<string, string>();
  for (const body of bodies) {
    const base = (body.name ?? body.id).trim() || body.id;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    names.set(body.id, name);
  }
  return names;
}

/**
 * The URDF tree of `doc`, or an explanation. `source` 'auto' prefers the dynamics model, then the assembly joints.
 * @failure no bodies / joints in the chosen source -> { error }
 */
export function buildUrdfTree(doc: CadDocument, source: 'auto' | 'dynamics' | 'assembly'): UrdfTree | { error: string } {
  const raw =
    source === 'assembly' ? fromAssembly(doc) : source === 'dynamics' ? fromDynamics(doc) : (fromDynamics(doc) ?? fromAssembly(doc));
  if (raw === null)
    return {
      error:
        source === 'dynamics'
          ? 'the document has no dynamics bodies (add_rigid_body, add_body_joint)'
          : source === 'assembly'
            ? 'the document has no assembly joints between instances (create_component, insert_instance, add_joint)'
            : 'the document has neither dynamics bodies nor assembly joints (add_rigid_body + add_body_joint, or instances + add_joint)',
    };
  const names = uniqueNames(raw.bodies);
  const notes: string[] = [...raw.skipped];
  const treeJointOf = new Map<string, Candidate>();
  for (const joint of raw.candidates) {
    if (joint.kind === 'spherical') {
      notes.push(`joint '${joint.id}' is spherical: URDF has no ball joint, left out.`);
      continue;
    }
    if (treeJointOf.has(joint.child)) notes.push(`joint '${joint.id}' closes a loop on '${joint.child}': URDF is a tree, left out.`);
    else if (names.has(joint.child) && (names.has(joint.parent) || joint.parent === GROUND)) treeJointOf.set(joint.child, joint);
    else notes.push(`joint '${joint.id}' references an unknown body: left out.`);
  }
  const bodyOf = new Map(raw.bodies.map((b) => [b.id, b]));
  const placed = new Set<string>();
  const bodies: UrdfBody[] = [];
  const joints: UrdfJoint[] = [];
  const attach = (id: string, joint: UrdfJoint): void => {
    placed.add(id);
    bodies.push({ name: names.get(id) ?? id, body: bodyOf.get(id) as RigidBody });
    joints.push(joint);
  };
  const link = (id: string): string => (id === GROUND ? WORLD : (names.get(id) ?? id));
  const roots = raw.bodies.filter((b) => !treeJointOf.has(b.id) || treeJointOf.get(b.id)?.parent === GROUND);
  for (const root of roots) {
    const treeJoint = treeJointOf.get(root.id);
    if (treeJoint !== undefined)
      attach(root.id, { ...treeJoint, type: treeJoint.kind as UrdfJointType, parent: WORLD, child: link(root.id) });
    else {
      const anchor = raw.fixedAt.get(root.id);
      attach(root.id, {
        id: `${root.id}_to_world`,
        type: anchor !== undefined ? 'fixed' : 'floating',
        parent: WORLD,
        child: link(root.id),
        anchor: anchor ?? [0, 0, 0],
        axis: [0, 0, 1],
        damping: 0,
        friction: 0,
      });
      if (anchor === undefined) notes.push(`body '${root.id}' has no joint to a parent: exported with a floating joint to world.`);
    }
  }
  for (let progress = true; progress; ) {
    progress = false;
    for (const [childId, joint] of treeJointOf) {
      if (placed.has(childId) || !placed.has(joint.parent)) continue;
      attach(childId, { ...joint, type: joint.kind as UrdfJointType, parent: link(joint.parent), child: link(childId) });
      progress = true;
    }
  }
  for (const body of raw.bodies)
    if (!placed.has(body.id)) notes.push(`body '${body.id}' is part of a joint cycle without a root: left out.`);
  return { source: raw.source, bodies, joints, notes };
}
