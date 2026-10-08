/**
 * Edge selection for fillet_edge / chamfer_edge against a solid's exact topology: explicit indices,
 * points (`edgesNear`: the roundable edge whose mid point is nearest each point), and the checks
 * that reject a selection the kernel would silently drop.
 *
 * @layer core/commands
 * @pure
 * @invariant points resolve against the topology of the solid AS IT IS NOW, so a feature-history step
 *   that recorded points keeps selecting the same edge after an upstream parametric edit reorders the
 *   kernel's edge numbering (indices do not)
 */

import type { Vec3 } from '../model/types';
import type { ShapeEdge, ShapeTopology } from '../geometry/kernel';

const roundable = (edge: ShapeEdge): boolean => !edge.seam && !edge.degenerate;

const distanceSquared = (a: Vec3, b: Vec3): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Index of the roundable edge whose mid point is nearest `point`, or undefined when none is. */
function nearestEdge(topology: ShapeTopology, point: Vec3): number | undefined {
  let best: ShapeEdge | undefined;
  for (const edge of topology.edges) {
    if (!roundable(edge)) continue;
    if (best === undefined || distanceSquared(edge.mid, point) < distanceSquared(best.mid, point))
      best = edge;
  }
  return best?.index;
}

/**
 * Why `edges` cannot be selected on a shape of `topology` (out of range, repeated, seam or degenerate),
 * or null; a kernel without exact topology (null) cannot check, so it accepts.
 */
function selectionProblem(topology: ShapeTopology | null, edges: readonly number[]): string | null {
  if (topology === null) return null;
  const count = topology.edges.length;
  const outOfRange = edges.filter((index) => index >= count);
  if (outOfRange.length > 0) {
    return `edge index ${outOfRange.join(', ')} out of range (the solid has ${count} edges, 0..${count - 1}; inspect_topology lists them)`;
  }
  const repeated = edges.filter((index, at) => edges.indexOf(index) !== at);
  if (repeated.length > 0) return `edge index ${[...new Set(repeated)].join(', ')} selected twice`;
  const unroundable = edges.filter((index) => {
    const edge = topology.edges[index];
    return edge !== undefined && !roundable(edge);
  });
  return unroundable.length > 0
    ? `edge ${unroundable.join(', ')} is a seam or degenerate edge (no corner to round)`
    : null;
}

export type EdgeSelection = { readonly edges: number[] } | { readonly problem: string };

/**
 * The unique-edge indices selected by `indices` plus `near` points (a point naming an edge already
 * selected adds nothing); [] with no indices and no points = all edges.
 * @failure points without exact topology, an index out of range / repeated / on a seam -> problem
 */
export function selectEdges(
  topology: ShapeTopology | null,
  indices: readonly number[],
  near: readonly Vec3[],
): EdgeSelection {
  if (near.length > 0 && topology === null) {
    return { problem: 'edgesNear needs the exact B-rep topology of the OCC kernel' };
  }
  const picked = topology === null ? [] : near.map((point) => nearestEdge(topology, point));
  if (picked.some((index) => index === undefined)) {
    return { problem: 'edgesNear found no roundable edge (the solid has only seams)' };
  }
  const fromPoints = (picked as number[]).filter((index) => !indices.includes(index));
  const edges = [...indices, ...new Set(fromPoints)];
  const problem = selectionProblem(topology, edges);
  return problem === null ? { edges } : { problem };
}
