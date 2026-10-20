/**
 * The 05 FEA supports and the imposed motions of an explicit case as job data (RS-8). Supports: `fixed` holds the 3 translations (and the
 * 3 rotations of shell nodes), `pinned` the translations, `displacement` the dofs given as 0, `symmetry` the translation normal to its
 * (axis-aligned) plane and, on shell nodes, the two rotations about the in-plane axes. Nodes: on a structured hex mesh the box face of the part
 * nearest each `facesNear` point (all of the part's nodes on that plane) or the part's node nearest each `pointsNear` point; on a fea_mesh
 * mesh the node set `C_<constraint id>` the mesher resolved. Imposed motions resolve their target the same box-face way on either mesh.
 */

import type { AnalysisCase, FeaConstraint, FeMeshArtifact } from '@core/model/analysis';
import type { ExplicitMotionTarget, ExplicitSpec } from '@core/model/explicit';
import type { Vec3 } from '@core/model/vectors';
import type { ExplicitMesh } from './mesh';

export interface FixedDofs {
  /** One 0/1 per translational dof (3 per node); empty when nothing is held. */
  readonly fixed: readonly number[];
  /** One 0/1 per rotational dof of the shell nodes (3 per node); empty without shells or held rotations. */
  readonly fixedRotation: readonly number[];
}

export interface JobImposedMotion {
  readonly name: string;
  readonly nodes: readonly number[];
  /** 0 = x, 1 = y, 2 = z. */
  readonly dof: number;
  readonly kind: 'velocity' | 'displacement';
  /** (time s, value) in the case units. */
  readonly curve: readonly (readonly [number, number])[];
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** Relative tolerance of "on the face plane" (of the part's largest extent): nodes of a structured grid sit on it to round-off. */
const ON_PLANE = 1e-6;

const AXES = ['x', 'y', 'z'] as const;

interface Located {
  readonly nodes: readonly number[];
  /** The one axis every selected face is normal to (null for points or faces of several orientations). */
  readonly axis: number | null;
}

/** Nodes of a part selected by its box faces / nearest nodes (case length unit points), or the reason it cannot. */
function locate(
  mesh: ExplicitMesh,
  target: ExplicitMotionTarget & { readonly edgesNear?: unknown; readonly intersectPlane?: unknown },
  toCase: number,
): Located | string {
  if (target.edgesNear !== undefined || target.intersectPlane !== undefined)
    return 'edge and plane-section targets are not built for llull_explicit (use facesNear or pointsNear)';
  const part = mesh.nodePart.flatMap((entityId, node) => (entityId === target.entityId ? [node] : []));
  if (part.length === 0) return `part '${target.entityId}' has no nodes in the explicit mesh`;
  const at = (node: number, axis: number): number => mesh.nodes[3 * node + axis] ?? 0;
  const low = [0, 1, 2].map((axis) => Math.min(...part.map((node) => at(node, axis))));
  const high = [0, 1, 2].map((axis) => Math.max(...part.map((node) => at(node, axis))));
  const tolerance = ON_PLANE * Math.max(...[0, 1, 2].map((axis) => (high[axis] ?? 0) - (low[axis] ?? 0)), 1e-300);
  const scaled = (point: Vec3): Vec3 => [point[0] * toCase, point[1] * toCase, point[2] * toCase];
  const selected = new Set<number>();
  const axes = new Set<number>();
  for (const point of (target.facesNear ?? []).map(scaled)) {
    let best: { axis: number; plane: number; distance: number } | null = null;
    for (const axis of [0, 1, 2])
      for (const plane of [low[axis] ?? 0, high[axis] ?? 0]) {
        const outside = [0, 1, 2]
          .filter((other) => other !== axis)
          .map((other) => Math.max((low[other] ?? 0) - (point[other] ?? 0), (point[other] ?? 0) - (high[other] ?? 0), 0));
        const distance = Math.hypot((point[axis] ?? 0) - plane, ...outside);
        if (best === null || distance < best.distance) best = { axis, plane, distance };
      }
    if (best === null) continue;
    axes.add(best.axis);
    for (const node of part) if (Math.abs(at(node, best.axis) - best.plane) <= tolerance) selected.add(node);
  }
  for (const point of (target.pointsNear ?? []).map(scaled)) {
    const distance = (node: number): number => Math.hypot(at(node, 0) - point[0], at(node, 1) - point[1], at(node, 2) - point[2]);
    selected.add(part.reduce((nearest, node) => (distance(node) < distance(nearest) ? node : nearest)));
  }
  const axis = target.pointsNear === undefined && axes.size === 1 ? ([...axes][0] ?? null) : null;
  return { nodes: [...selected].sort((a, b) => a - b), axis };
}

/** Nodes of the fea_mesh node set the mesher resolved for the constraint, and the axis its nodes share a coordinate on (if one). */
function meshSet(mesh: ExplicitMesh, artifact: FeMeshArtifact, constraint: FeaConstraint): Located | string {
  const key = `C_${constraint.id}`;
  const ids = Object.hasOwn(artifact.nodeSets, key) ? (artifact.nodeSets[key] ?? []) : [];
  if (ids.length === 0) return 'the mesh has no nodes for it (re-run fea_mesh)';
  const index = new Map(artifact.nodes.map(([id], at) => [id, at] as const));
  const nodes = ids.flatMap((id) => {
    const at = index.get(id);
    return at === undefined ? [] : [at];
  });
  const spread = [0, 1, 2].map((axis) => {
    const values = nodes.map((node) => mesh.nodes[3 * node + axis] ?? 0);
    return Math.max(...values) - Math.min(...values);
  });
  const extent = Math.max(...spread, 1e-300);
  const flat = [0, 1, 2].filter((axis) => (spread[axis] ?? 0) <= ON_PLANE * extent);
  return { nodes, axis: flat.length === 1 ? (flat[0] ?? null) : null };
}

/** Held dofs [ux, uy, uz, rx, ry, rz] of a constraint on its located nodes, or why it cannot be held. */
function heldDofs(constraint: FeaConstraint, located: Located): readonly boolean[] | string {
  if (constraint.kind === 'fixed') return [true, true, true, true, true, true];
  if (constraint.kind === 'pinned') return [true, true, true, false, false, false];
  if (constraint.kind === 'symmetry') {
    const { axis } = located;
    if (axis === null) return 'a symmetry support needs one axis-aligned plane (faces normal to x, y or z)';
    return [0, 1, 2, 3, 4, 5].map((dof) => (dof < 3 ? dof === axis : dof - 3 !== axis));
  }
  const dofs = constraint.dofs ?? {};
  const moving = Object.entries(dofs).find(([, value]) => value !== 0);
  if (moving !== undefined)
    return `a static displacement ${moving[0]} = ${moving[1]} has no history for an explicit run (use add_imposed_motion with a curve)`;
  return (['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const).map((dof) => dofs[dof] === 0);
}

/**
 * Fixed dofs of every constraint of the case, in constraint order.
 * @failure symmetry off an axis-aligned plane, non-zero static displacement, edge / plane targets, a part with no mesh nodes or an empty
 *   fea_mesh node set -> EXP_CONSTRAINT_UNSUPPORTED
 */
export function fixedDofs(
  analysisCase: AnalysisCase,
  mesh: ExplicitMesh,
  meshArtifact: FeMeshArtifact | null,
  toCase: number,
): FixedDofs | Refusal {
  const nodes = mesh.nodes.length / 3;
  const fixed = new Array<number>(3 * nodes).fill(0);
  const rotation = new Array<number>(3 * nodes).fill(0);
  let anyFixed = false;
  let anyRotation = false;
  const shellNodes = new Set(mesh.shell4);
  for (const id of analysisCase.constraintOrder) {
    const constraint = analysisCase.constraints[id];
    if (constraint === undefined) continue;
    const refuse = (message: string): Refusal => ({
      code: 'EXP_CONSTRAINT_UNSUPPORTED',
      message: `constraint '${constraint.id}' (${constraint.name}): ${message}`,
      ids: [constraint.id],
    });
    const located = meshArtifact !== null ? meshSet(mesh, meshArtifact, constraint) : locate(mesh, constraint.target, toCase);
    if (typeof located === 'string') return refuse(located);
    const held = heldDofs(constraint, located);
    if (typeof held === 'string') return refuse(held);
    for (const node of located.nodes)
      for (let axis = 0; axis < 3; axis += 1) {
        if (held[axis] === true) {
          fixed[3 * node + axis] = 1;
          anyFixed = true;
        }
        if (held[3 + axis] === true && shellNodes.has(node)) {
          rotation[3 * node + axis] = 1;
          anyRotation = true;
        }
      }
  }
  return { fixed: anyFixed ? fixed : [], fixedRotation: anyRotation ? rotation : [] };
}

/**
 * The imposed motions of the case on mesh nodes, in order.
 * @failure an unresolvable target, or a dof imposed twice -> EXP_CONSTRAINT_UNSUPPORTED
 */
export function jobImposedMotions(spec: ExplicitSpec, mesh: ExplicitMesh, toCase: number): readonly JobImposedMotion[] | Refusal {
  const motions: JobImposedMotion[] = [];
  const taken = new Set<number>();
  for (const id of spec.imposedMotionOrder ?? []) {
    const motion = spec.imposedMotions?.[id];
    if (motion === undefined) continue;
    const refuse = (message: string): Refusal => ({
      code: 'EXP_CONSTRAINT_UNSUPPORTED',
      message: `imposed motion '${motion.name}': ${message}`,
      ids: [id],
    });
    const located = locate(mesh, motion.target, toCase);
    if (typeof located === 'string') return refuse(located);
    const dof = AXES.indexOf(motion.dof);
    if (located.nodes.some((node) => taken.has(3 * node + dof)))
      return refuse(`a node's ${motion.dof} motion is already imposed by another motion`);
    for (const node of located.nodes) taken.add(3 * node + dof);
    motions.push({ name: motion.name, nodes: located.nodes, dof, kind: motion.kind, curve: motion.curve });
  }
  return motions;
}
