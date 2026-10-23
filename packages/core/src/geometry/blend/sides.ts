/**
 * Which of the two faces at an edge is "side 1" for asymmetric blends (BLD M1, TECHNICAL_SPEC §4, §5.7): chosen by a point on the face (the
 * face of the edge nearest to it) or by persistent face name. Pure over the kernel's face graph and `projectOnFace`.
 * @failure an edge without exactly two faces, a name that is not a face of the edge, or a point equally near both faces -> a problem with BLD_ASYMMETRIC_SIDE_MISSING
 */

import type { Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeTopology } from '../kernel';
import type { ShapeHandle } from '../kernelTypes';

export interface SideSelector {
  readonly near?: Vec3 | undefined;
  readonly name?: string | undefined;
}

export interface SideProblem {
  readonly code: 'BLD_ASYMMETRIC_SIDE_MISSING';
  readonly message: string;
}

/** Two faces are "equally near" below this distance difference (document units). */
const TIE = 1e-9;

/** The unique face index of side 1 at each of `edges`, in order. */
export function sideFaces(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  topology: ShapeTopology,
  edges: readonly number[],
  side: SideSelector,
): readonly number[] | SideProblem {
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  if (graph === null)
    return {
      code: 'BLD_ASYMMETRIC_SIDE_MISSING',
      message: 'this kernel has no exact face adjacency to tell the two faces of an edge apart',
    };
  const chosen: number[] = [];
  for (const edge of edges) {
    const around = [...new Set(graph.edgeFaces[edge] ?? [])];
    const [first, second] = around;
    if (around.length !== 2 || first === undefined || second === undefined)
      return { code: 'BLD_ASYMMETRIC_SIDE_MISSING', message: `edge ${edge} does not join exactly two faces (found ${around.length})` };
    if (side.name !== undefined) {
      const match = around.find((face) => topology.faces[face]?.name === side.name);
      if (match === undefined)
        return {
          code: 'BLD_ASYMMETRIC_SIDE_MISSING',
          message: `"${side.name}" is not a face of edge ${edge} (its faces: ${around.map((face) => topology.faces[face]?.name ?? face).join(', ')})`,
        };
      chosen.push(match);
      continue;
    }
    if (side.near === undefined)
      return { code: 'BLD_ASYMMETRIC_SIDE_MISSING', message: 'side1Near (a point on the first face) or side1Name is required' };
    const distances = around.map((face) => kernel.faceQuery?.projectOnFace(shape, face, [side.near as Vec3])?.[0]?.distance ?? Number.NaN);
    const [near1, near2] = distances;
    if (near1 === undefined || near2 === undefined || Number.isNaN(near1) || Number.isNaN(near2))
      return { code: 'BLD_ASYMMETRIC_SIDE_MISSING', message: `the kernel could not measure the point against the faces of edge ${edge}` };
    if (Math.abs(near1 - near2) <= TIE)
      return {
        code: 'BLD_ASYMMETRIC_SIDE_MISSING',
        message: `side1Near is equally near both faces of edge ${edge}; move it onto the face that carries the first distance`,
      };
    chosen.push(near1 < near2 ? first : second);
  }
  return chosen;
}

export const isSideProblem = (value: readonly number[] | SideProblem): value is SideProblem => 'code' in value;
