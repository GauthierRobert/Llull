/**
 * The junctions of a chain of blends (DES-6c step 2): the edges where one blend face meets the next blend face of a tangent chain. They are not
 * contacts with a support face, so `check_blends` measured nothing there; a re-skinned chain (profile blends) can open or kink at them.
 * @invariant pure over a topology, its face graph and `chained` (the two faces are blends of one fillet node's profiled chain); each junction is reported
 *   once, from the lower face index. Blends of two steps, or a mitre of two blends of one step, are creases the user asked for, never junctions.
 */

import type { ShapeTopology } from '../../geometry/kernel';
import type { FaceGraph } from '../../geometry/kernelPorts';
import { blendSource } from '../../geometry/blend/continuity';

export interface Junction {
  readonly edge: number;
  /** Persistent name of the blend face on the other side. */
  readonly neighbour: string;
}

/** The junction edges of blend face `face` with the higher-indexed blend faces it is not a support of (nor they of it). */
export function junctionsOf(
  topology: ShapeTopology,
  graph: FaceGraph,
  face: number,
  chained: (a: number, b: number) => boolean,
): Junction[] {
  const own = topology.faces[face]?.name;
  const ownSource = own === undefined ? null : blendSource(own);
  if (own === undefined || ownSource === null) return [];
  const found: Junction[] = [];
  for (const [edge, around] of graph.edgeFaces.entries()) {
    if (around.length !== 2 || !around.includes(face)) continue;
    const other = around.find((candidate) => candidate !== face);
    const name = other === undefined ? undefined : topology.faces[other]?.name;
    const source = name === undefined ? null : blendSource(name);
    if (other === undefined || other < face || name === undefined || source === null) continue;
    if (ownSource.supports.includes(name) || source.supports.includes(own) || !chained(face, other)) continue;
    found.push({ edge, neighbour: name });
  }
  return found;
}
