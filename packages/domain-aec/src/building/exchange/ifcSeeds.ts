/**
 * The ONE derivation of an IFC GlobalId (`globalIdFor`) and the seed names of the products `export_ifc` writes for a building element. `export_ifc`
 * (`Context.guid`) and the BCF projection (`../projections.ts`) both call these, so a BCF IfcGuid is the GlobalId in the IFC file by construction.
 * @invariant pure; the salt is the building uid (`llull` when absent)
 */

import type { Vec3 } from '@core/model/types';
import { ifcGuid } from '@lib/ifcGuid';
import { len3, sub3 } from '@lib/vec3';

/** GlobalId of `seed` in the file of the building `uid`. */
export const globalIdFor = (uid: string | undefined, seed: string): string => ifcGuid(`${uid ?? 'llull'}:${seed}`);

export const pipeSegmentSeed = (pipeId: string, index: number): string => `${pipeId}:seg:${index}`;
export const pipeBendSeed = (pipeId: string, index: number): string => `${pipeId}:bend:${index}`;
export const connectionPartSeed = (connectionId: string, part: string): string => `${connectionId}:${part}`;
export const connectionBoltsSeed = (connectionId: string): string => `${connectionId}:bolts`;
/** Sub-product `<kind>-<n>` of an element (railing post, ladder stile / rung / landing, steel stair stringer / flight / landing, building stair flight). */
export const partSeed = (parentId: string, kind: string, n: number): string => `${parentId}:${kind}-${n}`;
export const landingSeed = (stairId: string): string => `${stairId}:landing`;
export const openingVoidSeed = (openingId: string): string => `${openingId}:void`;
export const slabVoidSeed = (slabId: string, index: number): string => `${slabId}:void-${index}`;
export const plateBoltsSeed = (plateId: string): string => `${plateId}:bolts`;

/** The points with consecutive duplicates removed (the straights and bends of a pipe are written between these). */
export function distinctPoints(points: readonly Vec3[]): Vec3[] {
  const kept: Vec3[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last === undefined || len3(sub3(point, last)) > 1e-9) kept.push(point);
  }
  return kept;
}
