/**
 * Chord-error bound of a display mesh (see `assemblyParts`): max(0.1, 1e-3 x bounding-box diagonal) document units. A curved solid sticks out of
 * its tessellation by at most this much, so every mesh-derived separation test (boxes, OBBs, mesh distance) must grow by the bound of both parts.
 */

import type { AssemblyPart } from './partTypes';

export function chordBound(part: AssemblyPart): number {
  const diagonal = Math.hypot(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]);
  return Math.max(0.1, 1e-3 * diagonal);
}
