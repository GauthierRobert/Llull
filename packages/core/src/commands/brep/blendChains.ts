/**
 * The law record of every blend face of a solid, including the faces OCCT rounded as part of the tangent chain of a picked edge (BLD M2): they are
 * not in the recipe, but they share the section of the face they continue, so a profile reaches them across the shared edges of the face graph.
 * @invariant pure over a topology, its face graph and the `tangent` test of an edge (the kernel's measured angle between the two faces, not its
 *   convexity label, which reads a tangent junction as concave); only non-circular profiles spread, only across a tangent edge (a blend that meets
 *   the profile at a crease, e.g. a fillet_faces blend next to a profiled face, is another blend), a face with its own record keeps it
 */

import type { ShapeTopology } from '../../geometry/kernel';
import type { FaceGraph } from '../../geometry/kernelPorts';
import { blendSource } from '../../geometry/blend/continuity';
import type { LawRecord } from './checkBlendRadius';

/** Record by face index for the faces of `records` (keyed by source edge name) and the blend faces that continue a profiled one. */
export function recordsByFace(
  topology: ShapeTopology,
  graph: FaceGraph,
  records: ReadonlyMap<string, LawRecord>,
  tangent: (edge: number) => boolean,
): Map<number, LawRecord> {
  const byFace = new Map<number, LawRecord>();
  const blends = new Set<number>();
  for (const face of topology.faces) {
    const source = face.name === undefined ? null : blendSource(face.name);
    if (source === null) continue;
    blends.add(face.index);
    const record = records.get(source.edge);
    if (record !== undefined) byFace.set(face.index, record);
  }
  const queue = [...byFace.keys()].filter((face) => {
    const type = byFace.get(face)?.profile?.type;
    return type !== undefined && type !== 'circular';
  });
  for (let next = 0; next < queue.length; next++) {
    const face = queue[next] ?? 0;
    const record = byFace.get(face);
    if (record === undefined) continue;
    for (const [edge, around] of graph.edgeFaces.entries()) {
      if (around.length !== 2 || !around.includes(face) || !tangent(edge)) continue;
      const other = around.find((candidate) => candidate !== face);
      if (other === undefined || !blends.has(other) || byFace.has(other)) continue;
      byFace.set(other, record);
      queue.push(other);
    }
  }
  return byFace;
}
