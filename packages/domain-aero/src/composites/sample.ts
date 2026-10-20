/** Core samples: the ordered plies of a part at a flat point (06 CMP FR-CMP-11). */

import type { CompositePart, CompositesModel, LaminaMaterial, Ply, Zone } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { polygonCentroid } from '@lib/polygon';
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

/**
 * A flat point where `zone` governs: the first of its centroid and a grid of interior points whose ply stack has as many plies as the zone
 * (higher-priority zones covering the centroid are skipped); the centroid when no such point exists.
 */
export function representativePoint(model: CompositesModel, part: CompositePart, zone: Zone): Vec2 {
  const centre = polygonCentroid(zone.boundary);
  const xs = zone.boundary.map(([x]) => x);
  const ys = zone.boundary.map(([, y]) => y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const grid: Vec2[] = [];
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) grid.push([x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * j) / 12]);
  const candidates = [centre, ...grid].filter((point) => insideOrOn(point, zone.boundary, 0));
  const hit = candidates.find((point) => stackAt(model, part, point).length === zone.angles.length);
  return hit ?? candidates[0] ?? centre;
}
