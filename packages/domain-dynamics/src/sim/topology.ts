/**
 * Spanning tree of the body-joint graph of `doc.dynamics` (TR-FPR-05). Joints may close loops: the tree joints become the engine's
 * generalised coordinates, every other joint a `SimulationLoop` (constraint). Pure and deterministic.
 */

import { GROUND, type DynamicJoint, type DynamicsModel } from '@core/model/dynamics';

/** A joint of the spanning tree, seen in the direction the tree is rooted (ground outwards). */
interface TreeJoint {
  readonly joint: DynamicJoint;
  /** Body (or GROUND) nearer the root. */
  readonly parent: string;
  /** Body carried by the joint. */
  readonly child: string;
  /** True when the tree direction is opposite to the declared parent -> child sense (axis sign flipped, reaction sign reversed). */
  readonly flipped: boolean;
}

export interface Topology {
  readonly tree: readonly TreeJoint[];
  /** Joints that close loops (constraints), in creation order. */
  readonly loops: readonly DynamicJoint[];
  /** Ids of the flipped tree joints. */
  readonly flipped: readonly string[];
  /** Body ids, tree parents before children (level, then declaration order). */
  readonly bodyOrder: readonly string[];
  /** The tree joint that carries each body (absent for fixed bodies and free roots). */
  readonly jointOfBody: ReadonlyMap<string, TreeJoint>;
}

type TopologyCode = 'FPR_LOOP_PRISMATIC' | 'FPR_SPHERICAL_TREE' | 'FPR_JOINT_DANGLING';

export interface TopologyRefusal {
  readonly error: string;
  readonly code: TopologyCode;
  readonly ids: readonly string[];
}

/** Tree preference: prismatic joints first (a loop cannot close through one), then revolute, spherical last. */
const KIND_RANK: Readonly<Record<DynamicJoint['kind'], number>> = { prismatic: 0, revolute: 2, spherical: 3 };
/** Rank of the crank joint of a cylinder pressure: after prismatic joints, ahead of other revolute joints (it must be a tree joint). */
const CRANK_RANK = 1;

/**
 * Tree and loop closures of `dynamics`. Joints are taken in the order (kind rank, creation order); a joint joins the tree unless its
 * ends are already connected (fixed bodies count as ground), then it closes a loop. The tree is rooted by breadth-first search from
 * ground and the fixed bodies; bodies unreachable from them root at their first declared parent-most body (free bodies).
 */
export function buildTopology(dynamics: DynamicsModel): Topology | TopologyRefusal {
  const bodies = Object.values(dynamics.bodies);
  const index = new Map(bodies.map((body, i) => [body.id, i]));
  const declared = Object.values(dynamics.joints);
  for (const joint of declared)
    for (const end of [joint.parent, joint.child])
      if (end !== GROUND && !index.has(end))
        return { error: `joint '${joint.id}' references missing body '${end}'`, code: 'FPR_JOINT_DANGLING', ids: [joint.id, end] };
  const nodeOf = (id: string): string => (id === GROUND || dynamics.bodies[id]?.fixed === true ? GROUND : id);
  // a joint between two grounded things never moves: it is inert (neither tree nor loop). A fixed child with a moving parent joins the
  // tree from the fixed side (flipped), so the parent is held by it.
  const joints = declared.filter((joint) => nodeOf(joint.parent) !== GROUND || nodeOf(joint.child) !== GROUND);
  const cranks = new Set(Object.values(dynamics.cylinders ?? {}).map((cylinder) => cylinder.crank));
  const rankOf = (joint: DynamicJoint): number => (cranks.has(joint.id) && joint.kind === 'revolute' ? CRANK_RANK : KIND_RANK[joint.kind]);
  const unionParent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const next = unionParent.get(root);
      if (next === undefined || next === root) return root;
      root = next;
    }
  };
  const ranked = joints
    .map((joint, creation) => ({ joint, creation }))
    .sort((a, b) => rankOf(a.joint) - rankOf(b.joint) || a.creation - b.creation)
    .map(({ joint }) => joint);
  const treeSet = new Set<string>();
  for (const joint of ranked) {
    const [a, b] = [find(nodeOf(joint.parent)), find(nodeOf(joint.child))];
    if (a === b) {
      if (joint.kind === 'prismatic')
        return {
          error:
            `joint '${joint.id}' (prismatic) would close a loop, and a loop cannot close through a sliding constraint between two bodies: make a ` +
            `different joint of the loop the closing one (re-order or replace it by a revolute joint)`,
          code: 'FPR_LOOP_PRISMATIC',
          ids: [joint.id],
        };
      continue;
    }
    unionParent.set(a, b);
    treeSet.add(joint.id);
  }
  const treeJoints = joints.filter((joint) => treeSet.has(joint.id));
  const loops = joints.filter((joint) => !treeSet.has(joint.id));
  const incident = new Map<string, DynamicJoint[]>();
  for (const joint of treeJoints) for (const end of [joint.parent, joint.child]) incident.set(end, [...(incident.get(end) ?? []), joint]);
  const assigned = new Map<string, TreeJoint>();
  const visited = new Set<string>([GROUND]);
  const level = new Map<string, number>();
  const rootFrom = (start: string[]): void => {
    for (const id of start) visited.add(id);
    const queue = [...start];
    for (let head = 0; head < queue.length; head++) {
      const from = queue[head] ?? GROUND;
      for (const joint of incident.get(from) ?? []) {
        if (assigned.has(joint.id)) continue;
        const to = joint.parent === from ? joint.child : joint.parent;
        if (visited.has(to)) continue;
        const entry: TreeJoint = { joint, parent: from, child: to, flipped: joint.child === from };
        assigned.set(joint.id, entry);
        visited.add(to);
        level.set(to, from === GROUND ? 0 : (level.get(from) ?? 0) + 1);
        queue.push(to);
      }
    }
  };
  for (const body of bodies) if (body.fixed) level.set(body.id, 0);
  rootFrom([GROUND, ...bodies.filter((body) => body.fixed).map((body) => body.id)]);
  const declaredChildren = new Set(treeJoints.map((joint) => joint.child));
  for (const body of bodies)
    if (!visited.has(body.id) && !declaredChildren.has(body.id)) {
      level.set(body.id, 0);
      rootFrom([body.id]);
    }
  for (const body of bodies) if (!visited.has(body.id)) level.set(body.id, 0);
  const tree = treeJoints.flatMap((joint) => {
    const entry = assigned.get(joint.id);
    return entry === undefined ? [] : [entry];
  });
  const spherical = tree.find((entry) => entry.joint.kind === 'spherical');
  if (spherical !== undefined)
    return {
      error:
        `spherical joint '${spherical.joint.id}' would have to carry '${spherical.child}' on its own: a ball pin can only close a loop ` +
        `(connect the body with a revolute or prismatic joint first)`,
      code: 'FPR_SPHERICAL_TREE',
      ids: [spherical.joint.id],
    };
  const bodyOrder = bodies
    .map((body, declaration) => ({ id: body.id, declaration, depth: level.get(body.id) ?? 0 }))
    .sort((a, b) => a.depth - b.depth || a.declaration - b.declaration)
    .map(({ id }) => id);
  return {
    tree,
    loops,
    flipped: tree.filter((entry) => entry.flipped).map((entry) => entry.joint.id),
    bodyOrder,
    jointOfBody: new Map(tree.map((entry) => [entry.child, entry])),
  };
}

export function isRefusal(result: Topology | TopologyRefusal): result is TopologyRefusal {
  return 'error' in result;
}
