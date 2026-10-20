/** Sandwich cores of a part (06 CMP FR-CMP-13): chamfered thickness profile, stack heights above and below a core, core volume. */

import type { CompositePart, CompositesModel, CoreRegion, Ply } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { offsetPolygon, signedArea } from '@lib/polygon';
import { boundaryDistance, insideOrOn, plyCovers } from './geometry2d';
import { pliesOf } from './state';

export const coresOf = (model: CompositesModel, partId: string): CoreRegion[] =>
  Object.values(model.cores ?? {})
    .filter((core) => core.partId === partId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/** Run of the chamfer: the horizontal distance over which the core grows from 0 to its full thickness. */
export const chamferRun = (core: CoreRegion): number => core.thickness / Math.tan((core.chamferAngle * Math.PI) / 180);

/** Core thickness at a flat point: 0 outside, growing linearly with the distance to the edge at the chamfer slope up to the full thickness. */
export function coreThicknessAt(core: CoreRegion, uv: Vec2): number {
  if (!insideOrOn(uv, core.boundary, 0)) return 0;
  return Math.min(core.thickness, boundaryDistance(uv, core.boundary) * Math.tan((core.chamferAngle * Math.PI) / 180));
}

export interface CoreSlice {
  readonly core: CoreRegion;
  /** Height above the tool face of the underside and the top of the core, document units. */
  readonly z0: number;
  readonly z1: number;
  readonly thickness: number;
}

/** The core of `part` at `uv` with its position in the stack (the plies below it counted where they cover `uv`); null when none lies there. */
export function coreAt(model: CompositesModel, part: CompositePart, uv: Vec2): CoreSlice | null {
  for (const core of coresOf(model, part.id)) {
    const thickness = coreThicknessAt(core, uv);
    if (thickness <= 0) continue;
    const z0 = pliesOf(model, part.id)
      .filter((ply) => ply.order < core.afterOrder && plyCovers(ply, part, uv))
      .reduce((sum, ply) => sum + (model.materials[ply.materialName]?.plyThickness ?? 0), 0);
    return { core, z0, z1: z0 + thickness, thickness };
  }
  return null;
}

/** Height of the underside of `ply` at `uv`: the plies below it that cover `uv`, plus any core between. */
export function heightBelow(model: CompositesModel, part: CompositePart, ply: Ply, uv: Vec2): number {
  const below = pliesOf(model, part.id)
    .filter((other) => other.order < ply.order && plyCovers(other, part, uv))
    .reduce((sum, other) => sum + (model.materials[other.materialName]?.plyThickness ?? 0), 0);
  const slice = coreAt(model, part, uv);
  return slice !== null && slice.core.afterOrder <= ply.order ? below + slice.thickness : below;
}

/**
 * Volume of the chamfered core: tan(chamfer) times the integral over depth s of the area still deeper than s (level sets of the edge distance, midpoint rule).
 * @invariant exact for a constant-thickness region when the chamfer run exceeds the half width (no plateau), otherwise within about 0.5 % for convex polygons
 */
export function coreVolume(core: CoreRegion): number {
  const tan = Math.tan((core.chamferAngle * Math.PI) / 180);
  const run = chamferRun(core);
  const steps = 64;
  let integral = 0;
  for (let k = 0; k < steps; k++) {
    const depth = ((k + 0.5) * run) / steps;
    const inner = offsetPolygon(core.boundary, -depth);
    const area = inner.length >= 3 ? Math.max(0, signedArea(inner)) : 0;
    integral += (area * run) / steps;
  }
  return tan * integral;
}
