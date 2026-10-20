/**
 * The 05 FEA supports of an explicit case as fixed degrees of freedom of the job (RS-8): `fixed` holds the 3 translations (and the 3 rotations
 * of shell nodes), `pinned` the translations, `displacement` the dofs given as 0. The nodes come from the 05 target: on a structured hex mesh
 * the box face of the part nearest each `facesNear` point (all of the part's nodes on that plane), the part's node nearest each `pointsNear`
 * point (add_fea_constraint requires one of them); on a fea_mesh mesh the node set `C_<constraint id>` the mesher resolved.
 */

import type { AnalysisCase, FeaConstraint, FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import type { ExplicitMesh } from './mesh';

export interface FixedDofs {
  /** One 0/1 per translational dof (3 per node); empty when nothing is held. */
  readonly fixed: readonly number[];
  /** One 0/1 per rotational dof of the shell nodes (3 per node); empty without shells or held rotations. */
  readonly fixedRotation: readonly number[];
}

interface ConstraintRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** Relative tolerance of "on the face plane" (of the part's largest extent): nodes of a structured grid sit on it to round-off. */
const ON_PLANE = 1e-6;

const refusal = (constraint: FeaConstraint, message: string): ConstraintRefusal => ({
  code: 'EXP_CONSTRAINT_UNSUPPORTED',
  message: `constraint '${constraint.id}' (${constraint.name}): ${message}`,
  ids: [constraint.id],
});

/** Held dofs [ux, uy, uz, rx, ry, rz] of a constraint, or a refusal. */
function heldDofs(constraint: FeaConstraint): readonly boolean[] | ConstraintRefusal {
  if (constraint.kind === 'fixed') return [true, true, true, true, true, true];
  if (constraint.kind === 'pinned') return [true, true, true, false, false, false];
  if (constraint.kind === 'symmetry') return refusal(constraint, 'symmetry supports are not built for llull_explicit');
  const dofs = constraint.dofs ?? {};
  const moving = Object.entries(dofs).find(([, value]) => value !== 0);
  if (moving !== undefined) return refusal(constraint, `prescribed motion ${moving[0]} = ${moving[1]} is not built (only 0 holds a dof)`);
  return (['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const).map((dof) => dofs[dof] === 0);
}

/** Nodes of a structured-mesh part selected by the target (case length unit points). */
function structuredNodes(mesh: ExplicitMesh, constraint: FeaConstraint, toCase: number): number[] | ConstraintRefusal {
  const { target } = constraint;
  if (target.edgesNear !== undefined || target.intersectPlane !== undefined)
    return refusal(constraint, 'edge and plane-section targets are not built for llull_explicit (use facesNear or pointsNear)');
  const part = mesh.nodePart.flatMap((entityId, node) => (entityId === target.entityId ? [node] : []));
  if (part.length === 0) return refusal(constraint, `part '${target.entityId}' has no nodes in the explicit mesh`);
  const at = (node: number, axis: number): number => mesh.nodes[3 * node + axis] ?? 0;
  const low = [0, 1, 2].map((axis) => Math.min(...part.map((node) => at(node, axis))));
  const high = [0, 1, 2].map((axis) => Math.max(...part.map((node) => at(node, axis))));
  const tolerance = ON_PLANE * Math.max(...[0, 1, 2].map((axis) => (high[axis] ?? 0) - (low[axis] ?? 0)), 1e-300);
  const scaled = (point: Vec3): Vec3 => [point[0] * toCase, point[1] * toCase, point[2] * toCase];
  const selected = new Set<number>();
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
    if (best !== null) for (const node of part) if (Math.abs(at(node, best.axis) - best.plane) <= tolerance) selected.add(node);
  }
  for (const point of (target.pointsNear ?? []).map(scaled)) {
    const distance = (node: number): number => Math.hypot(at(node, 0) - point[0], at(node, 1) - point[1], at(node, 2) - point[2]);
    selected.add(part.reduce((nearest, node) => (distance(node) < distance(nearest) ? node : nearest)));
  }
  return [...selected].sort((a, b) => a - b);
}

/** Nodes of the fea_mesh node set the mesher resolved for the constraint (indices in the artifact's node order). */
function meshSetNodes(artifact: FeMeshArtifact, constraint: FeaConstraint): number[] | ConstraintRefusal {
  const key = `C_${constraint.id}`;
  const ids = Object.hasOwn(artifact.nodeSets, key) ? (artifact.nodeSets[key] ?? []) : [];
  if (ids.length === 0) return refusal(constraint, 'the mesh has no nodes for it (re-run fea_mesh)');
  const index = new Map(artifact.nodes.map(([id], at) => [id, at] as const));
  return ids.flatMap((id) => {
    const at = index.get(id);
    return at === undefined ? [] : [at];
  });
}

/**
 * Fixed dofs of every constraint of the case, in constraint order.
 * @failure symmetry, non-zero prescribed displacement, edge / plane targets, a part with no mesh nodes or an empty fea_mesh node set ->
 *   EXP_CONSTRAINT_UNSUPPORTED
 */
export function fixedDofs(
  analysisCase: AnalysisCase,
  mesh: ExplicitMesh,
  meshArtifact: FeMeshArtifact | null,
  toCase: number,
): FixedDofs | ConstraintRefusal {
  const nodes = mesh.nodes.length / 3;
  const fixed = new Array<number>(3 * nodes).fill(0);
  const rotation = new Array<number>(3 * nodes).fill(0);
  let anyFixed = false;
  let anyRotation = false;
  const shellNodes = new Set(mesh.shell4);
  for (const id of analysisCase.constraintOrder) {
    const constraint = analysisCase.constraints[id];
    if (constraint === undefined) continue;
    const held = heldDofs(constraint);
    if ('code' in held) return held;
    const selected = meshArtifact !== null ? meshSetNodes(meshArtifact, constraint) : structuredNodes(mesh, constraint, toCase);
    if ('code' in selected) return selected;
    for (const node of selected)
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
