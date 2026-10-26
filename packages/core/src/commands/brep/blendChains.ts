/**
 * The law record of every blend face of a solid, including the faces OCCT rounded as part of the tangent chain of a picked edge (BLD M2): they are
 * not in the recipe, but they share the section of the picked edge's fillet node. The chain is the kernel's: each record carries the names of the
 * blend faces its node's build added (`LawRecord.chain`), the same read-back fillet_faces uses, so no geometric closure rule is needed.
 * @invariant pure over a topology and the records; only non-circular profiles spread, only to blend faces of the same node's build; a face with
 *   its own record keeps it
 */

import type { ShapeTopology } from '../../geometry/kernel';
import { blendSource } from '../../geometry/blend/continuity';
import type { LawRecord } from './checkBlendRadius';

/** Record by face index for the faces of `records` (keyed by source edge name) and the chain faces of a profiled record's node. */
export function recordsByFace(topology: ShapeTopology, records: ReadonlyMap<string, LawRecord>): Map<number, LawRecord> {
  const byFace = new Map<number, LawRecord>();
  const profiled = [...records.values()].filter((record) => record.profile !== undefined && record.profile.type !== 'circular');
  for (const face of topology.faces) {
    const source = face.name === undefined ? null : blendSource(face.name);
    if (source === null || face.name === undefined) continue;
    const own = records.get(source.edge);
    const chained = own ?? profiled.find((record) => record.chain.has(face.name ?? ''));
    if (chained !== undefined) byFace.set(face.index, chained);
  }
  return byFace;
}
