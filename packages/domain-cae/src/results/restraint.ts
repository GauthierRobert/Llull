/** Rigid-body restraint of a part (05 §7.1 FEA_UNDERCONSTRAINED): how many of the six rigid-body motions the supports remove. */

import type { FeaConstraint } from '@core/model/analysis';
import type { DeckContext } from '../decks/context';
import { planeAxis } from '../decks/mechanical';
import { nodeCoordinates, nodeEntities } from './fields';

export interface PartRestraint {
  readonly entityId: string;
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

/**
 * Rank of the restraints on each part: every restrained (node, axis) is a row of the rigid-body map (positions relative to the part centre,
 * scaled by its size, so translations and rotations weigh alike); the rank is the number of independent rows (Gram-Schmidt, at most 6).
 * @invariant a part with no restrained node has rank 0; collinear supports give at most 5 (rotation about their line stays free)
 */
export function partRestraints(ctx: DeckContext): PartRestraint[] {
  const coordinates = nodeCoordinates(ctx.mesh);
  const owner = nodeEntities(ctx.mesh);
  const extent = new Map<string, { lo: number[]; hi: number[] }>();
  for (const [node, point] of coordinates) {
    const box = extent.get(owner.get(node) ?? '') ?? { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
    point.forEach((value, axis) => {
      box.lo[axis] = Math.min(box.lo[axis] ?? Infinity, value);
      box.hi[axis] = Math.max(box.hi[axis] ?? -Infinity, value);
    });
    extent.set(owner.get(node) ?? '', box);
  }
  const basis = new Map<string, number[][]>();
  const counts = new Map<string, number>();
  for (const id of ctx.analysis.constraintOrder) {
    const constraint = ctx.analysis.constraints[id];
    const nodes = Object.hasOwn(ctx.mesh.nodeSets, `C_${id}`) ? (ctx.mesh.nodeSets[`C_${id}`] ?? []) : [];
    if (constraint === undefined || nodes.length === 0) continue;
    const axes = restrainedAxes(ctx, constraint, nodes);
    for (const node of nodes) {
      const entityId = owner.get(node) ?? '';
      const box = extent.get(entityId);
      const point = coordinates.get(node);
      if (box === undefined || point === undefined) continue;
      const centre = box.lo.map((low, axis) => (low + (box.hi[axis] ?? low)) / 2);
      const size = Math.hypot(...box.lo.map((low, axis) => (box.hi[axis] ?? low) - low)) || 1;
      const local: [number, number, number] = [
        (point[0] - (centre[0] ?? 0)) / size,
        (point[1] - (centre[1] ?? 0)) / size,
        (point[2] - (centre[2] ?? 0)) / size,
      ];
      const taken = basis.get(entityId) ?? [];
      basis.set(entityId, taken);
      for (const axis of axes) {
        counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
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
  return Object.keys(ctx.analysis.parts).map((entityId) => ({
    entityId,
    rank: basis.get(entityId)?.length ?? 0,
    restrainedDofs: counts.get(entityId) ?? 0,
  }));
}
