/** Rigid-body restraint of a part (05 §7.1 FEA_UNDERCONSTRAINED): how many of the six rigid-body motions the supports remove. */

import type { FeaConstraint, FeMeshArtifact } from '@core/model/analysis';
import type { DeckContext } from '../decks/context';
import { planeAxis } from '../decks/mechanical';
import { nodeCoordinates } from './fields';

export interface RestraintGroup {
  /** Analysed parts that move together: parts sharing mesh nodes (conformal bonding) form one group, every other part is its own. */
  readonly entityIds: readonly string[];
  /** Independent rigid-body motions removed (6 = fully restrained). */
  readonly rank: number;
  readonly restrainedDofs: number;
}

const DOF_AXIS: Readonly<Record<string, number>> = { ux: 0, uy: 1, uz: 2 };
/** A restraint row counts as independent when this fraction of it is not spanned by the rows already taken. */
const INDEPENDENCE = 1e-6;

/** Axes (0 x, 1 y, 2 z) a constraint restrains on its node set: all three, the normal of a symmetry plane, or the dofs of a displacement. */
function restrainedAxes(ctx: DeckContext, constraint: FeaConstraint, nodes: readonly number[]): number[] {
  if (constraint.kind === 'fixed' || constraint.kind === 'pinned') return [0, 1, 2];
  if (constraint.kind === 'symmetry') {
    const axis = planeAxis(ctx, nodes);
    return axis === null ? [] : [axis];
  }
  return Object.keys(constraint.dofs ?? {}).flatMap((dof) => (dof in DOF_AXIS ? [DOF_AXIS[dof] ?? 0] : []));
}

/** Row of the rigid-motion map `u_axis = t_axis + (omega x p)_axis` over the unknowns (tx, ty, tz, wx, wy, wz). */
const rigidRow = (axis: number, p: readonly [number, number, number]): number[] =>
  axis === 0 ? [1, 0, 0, 0, p[2], -p[1]] : axis === 1 ? [0, 1, 0, -p[2], 0, p[0]] : [0, 0, 1, p[1], -p[0], 0];

/** Group of each entity (smallest entity id of the connected set) and of each node, parts joined when an element block of another part uses the same node. */
function groupsOf(mesh: FeMeshArtifact): { entityGroup: Map<string, string>; nodeGroup: Map<number, string> } {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    return up === id ? id : find(up);
  };
  const firstOwner = new Map<number, string>();
  for (const block of mesh.blocks) {
    if (!parent.has(block.entityId)) parent.set(block.entityId, block.entityId);
    for (const element of block.elements)
      for (const node of element.slice(1)) {
        const owner = firstOwner.get(node);
        if (owner === undefined) firstOwner.set(node, block.entityId);
        else {
          const [a, b] = [find(owner), find(block.entityId)];
          if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
        }
      }
  }
  return {
    entityGroup: new Map([...parent.keys()].map((id) => [id, find(id)])),
    nodeGroup: new Map([...firstOwner].map(([node, owner]) => [node, find(owner)])),
  };
}

/**
 * Rank of the restraints on each group of parts: every restrained (node, axis) is a row of the rigid-body map (positions relative to the group centre,
 * scaled by its size, so translations and rotations weigh alike); the rank is the number of independent rows (Gram-Schmidt, at most 6).
 * @invariant a group with no restrained node has rank 0; collinear supports give at most 5 (rotation about their line stays free); groups without an analysed part are omitted
 */
export function partRestraints(ctx: DeckContext): RestraintGroup[] {
  const coordinates = nodeCoordinates(ctx.mesh);
  const { entityGroup, nodeGroup } = groupsOf(ctx.mesh);
  const extent = new Map<string, { lo: number[]; hi: number[] }>();
  for (const [node, point] of coordinates) {
    const group = nodeGroup.get(node) ?? '';
    const box = extent.get(group) ?? { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
    point.forEach((value, axis) => {
      box.lo[axis] = Math.min(box.lo[axis] ?? Infinity, value);
      box.hi[axis] = Math.max(box.hi[axis] ?? -Infinity, value);
    });
    extent.set(group, box);
  }
  const basis = new Map<string, number[][]>();
  const counts = new Map<string, number>();
  for (const id of ctx.analysis.constraintOrder) {
    const constraint = ctx.analysis.constraints[id];
    const nodes = Object.hasOwn(ctx.mesh.nodeSets, `C_${id}`) ? (ctx.mesh.nodeSets[`C_${id}`] ?? []) : [];
    if (constraint === undefined || nodes.length === 0) continue;
    const axes = restrainedAxes(ctx, constraint, nodes);
    for (const node of nodes) {
      const group = nodeGroup.get(node) ?? '';
      const box = extent.get(group);
      const point = coordinates.get(node);
      if (box === undefined || point === undefined) continue;
      const centre = box.lo.map((low, axis) => (low + (box.hi[axis] ?? low)) / 2);
      const size = Math.hypot(...box.lo.map((low, axis) => (box.hi[axis] ?? low) - low)) || 1;
      const local: [number, number, number] = [
        (point[0] - (centre[0] ?? 0)) / size,
        (point[1] - (centre[1] ?? 0)) / size,
        (point[2] - (centre[2] ?? 0)) / size,
      ];
      const taken = basis.get(group) ?? [];
      basis.set(group, taken);
      for (const axis of axes) {
        counts.set(group, (counts.get(group) ?? 0) + 1);
        if (taken.length >= 6) continue;
        const row = rigidRow(axis, local);
        const norm = Math.hypot(...row);
        let residual = row;
        for (const direction of taken) {
          const projection = residual.reduce((sum, value, index) => sum + value * (direction[index] ?? 0), 0);
          residual = residual.map((value, index) => value - projection * (direction[index] ?? 0));
        }
        const left = Math.hypot(...residual);
        if (left > INDEPENDENCE * norm) taken.push(residual.map((value) => value / left));
      }
    }
  }
  const partsOf = new Map<string, string[]>();
  for (const entityId of Object.keys(ctx.analysis.parts)) {
    const group = entityGroup.get(entityId) ?? entityId;
    partsOf.set(group, [...(partsOf.get(group) ?? []), entityId]);
  }
  return [...partsOf].map(([group, entityIds]) => ({
    entityIds,
    rank: basis.get(group)?.length ?? 0,
    restrainedDofs: counts.get(group) ?? 0,
  }));
}
