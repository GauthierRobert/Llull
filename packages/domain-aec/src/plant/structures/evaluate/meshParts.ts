/** Small mesh helpers of the access evaluators: several swept parts of one element become one mesh entity. */

import type { MeshData } from '@core/model/types';

/** One mesh holding all `parts` (positions concatenated, indices offset); null when there is nothing. */
export function mergeMeshes(parts: ReadonlyArray<MeshData | null>): MeshData | null {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    if (part === null) continue;
    const offset = positions.length / 3;
    for (const value of part.positions) positions.push(value);
    for (const index of part.indices) indices.push(index + offset);
  }
  return positions.length === 0 ? null : { positions, indices };
}
