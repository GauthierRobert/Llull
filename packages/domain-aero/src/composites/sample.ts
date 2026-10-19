/** Core samples: the ordered plies of a part at a flat point (06 CMP FR-CMP-11). */

import type { CompositePart, CompositesModel, LaminaMaterial, Ply } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { insideOrOn, plyCovers } from './geometry2d';
import { pliesOf } from './state';
import { toFlat } from './surface';

export interface StackEntry {
  readonly ply: Ply;
  readonly material: LaminaMaterial;
  /** Height above the tool face, document units. */
  readonly z0: number;
  readonly z1: number;
}

/** The flat point under a world point, or null when it projects outside the part outline. */
export function locate(part: CompositePart, point: Vec3): Vec2 | null {
  const { uv } = toFlat(part.surface, point);
  return insideOrOn(uv, part.outline, 1e-6 * (1 + Math.hypot(uv[0], uv[1]))) ? uv : null;
}

/**
 * Plies covering `uv`, tool side first, with cumulative heights.
 * @invariant plies whose material record is missing are skipped (the document validator rejects such files)
 */
export function stackAt(model: CompositesModel, part: CompositePart, uv: Vec2): StackEntry[] {
  let z = 0;
  const entries: StackEntry[] = [];
  for (const ply of pliesOf(model, part.id)) {
    const material = model.materials[ply.materialName];
    if (material === undefined || !plyCovers(ply, part, uv)) continue;
    entries.push({ ply, material, z0: z, z1: z + material.plyThickness });
    z += material.plyThickness;
  }
  return entries;
}
