/** Exact construction of a ply solid (06 CMP FR-CMP-54): the region of the tool face lifted by the stack below to the ply thickness, as a `faceSlab` recipe. */

import type { CompositePart, PartSurface } from '@core/model/composites';
import type { ShapeRecipe, Vec2, Vec3 } from '@core/model/types';
import { encodeLoops, encodeSurface } from '@core/geometry/surfaceWire';
import { normalAt } from './surface';

type Slab = Extract<ShapeRecipe, { op: 'faceSlab' }>;
type Region = { readonly outer: readonly Vec2[]; readonly holes: readonly (readonly Vec2[])[] };

/** Chart segments of a cone loop: a straight chart edge is not a straight (azimuth, distance) edge, so each is cut into this many pieces. */
const CONE_EDGE_PIECES = 24;

/** Surface parameters of a chart polygon: the surface description (the kernel wire form) and the chart -> (u, v) map of its loops. */
function parametrization(
  surface: PartSurface,
): {
  readonly surface: Slab['surface'];
  readonly loop: (polygon: readonly Vec2[]) => Vec2[];
  readonly inDomain?: (uv: Vec2) => boolean;
} | null {
  switch (surface.type) {
    case 'plane':
      return { surface: { type: 'plane', data: [...surface.origin, ...surface.xDir, ...surface.yDir] }, loop: (polygon) => [...polygon] };
    case 'cylinder': {
      const { radius } = surface;
      return {
        surface: { type: 'cylinder', data: [...surface.origin, ...surface.axis, ...surface.xDir, radius] },
        loop: (polygon) => polygon.map(([x, y]): Vec2 => [x / radius, y]),
      };
    }
    case 'cone': {
      const sine = Math.sin(surface.semiAngle);
      return {
        surface: { type: 'cone', data: [...surface.apex, ...surface.axis, ...surface.xDir, surface.semiAngle] },
        loop: (polygon) => {
          let previous = Number.NaN;
          return polygon.flatMap((point, index): Vec2[] => {
            const next = polygon[(index + 1) % polygon.length] as Vec2;
            return Array.from({ length: CONE_EDGE_PIECES }, (_, piece): Vec2 => {
              const t = piece / CONE_EDGE_PIECES;
              const x = point[0] + (next[0] - point[0]) * t;
              const y = point[1] + (next[1] - point[1]) * t;
              let theta = Math.atan2(y, x);
              if (Number.isNaN(previous))
                theta = theta < 0 && theta + 2 * Math.PI <= 2 * Math.PI * sine + 1e-9 ? theta + 2 * Math.PI : theta;
              else theta += 2 * Math.PI * Math.round((previous - theta) / (2 * Math.PI));
              previous = theta;
              // the kernel cone runs its azimuth the other way round (right-handed about the axis)
              return [-theta / sine, Math.hypot(x, y)];
            });
          });
        },
      };
    }
    case 'nurbs': {
      const [[u0], [v0]] = surface.domain;
      return {
        surface: { type: 'bspline', data: encodeSurface(surface.surface) },
        loop: (polygon) => polygon.map(([x, y]): Vec2 => [u0 + x / surface.scale[0], v0 + y / surface.scale[1]]),
        // the triangle path clamps a chart point outside the patch (`nurbsFromFlat`); an exact face cannot, so such a region stays triangles
        inDomain: ([u, v]) => u >= u0 - 1e-9 && u <= surface.domain[0][1] + 1e-9 && v >= v0 - 1e-9 && v <= surface.domain[1][1] + 1e-9,
      };
    }
    case 'sphere':
      return null;
  }
}

/**
 * The `faceSlab` recipe of `face` (chart polygons) lifted from `baseHeight` to `baseHeight + thickness` along the tool normal (towards the laminate
 * side), or null when the tool face has no exact parametrization here (a sphere cap) or the region is degenerate.
 * @invariant one outer loop plus the holes, each loop in the (u, v) plane of the surface; the lift direction is the laminate-side normal at the first vertex
 */
export function plySlabRecipe(
  part: CompositePart,
  face: Region,
  baseHeight: number,
  thickness: number,
  tolerance: number,
): ShapeRecipe | null {
  const parameters = parametrization(part.surface);
  const first = face.outer[0];
  if (parameters === null || first === undefined || face.outer.length < 3) return null;
  const loops = [
    { outer: true, polygon: parameters.loop(face.outer) },
    ...face.holes.filter((hole) => hole.length >= 3).map((hole) => ({ outer: false, polygon: parameters.loop(hole) })),
  ];
  if (parameters.inDomain !== undefined && !loops.every((loop) => loop.polygon.every(parameters.inDomain as (uv: Vec2) => boolean)))
    return null;
  const side = part.laminateSide === 'positive_normal' ? 1 : -1;
  const normal = normalAt(part.surface, first);
  const direction: Vec3 = [side * normal[0], side * normal[1], side * normal[2]];
  return {
    op: 'faceSlab',
    surface: parameters.surface,
    loops: encodeLoops(loops),
    from: baseHeight,
    to: baseHeight + thickness,
    direction,
    tolerance,
  };
}
