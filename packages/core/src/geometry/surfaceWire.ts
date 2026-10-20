/**
 * Wire form of an exact surface face for an exact kernel (`nurbs_surface` sheets and `faceSlab` recipes): the flat number lists the native
 * kernel reads (solver/crates/llull-kernel-occt/cpp/features.hxx `surface_face`).
 * @invariant pure; the lists carry every field the face depends on
 */

import type { NurbsSurfaceData, UvTrimLoop } from '../lib/nurbs/surfaceTypes';

/**
 * B-spline surface: degree u, degree v, pole counts u / v, distinct knot counts u / v, rational flag, the xyz poles (u index outermost), the weights
 * (rational only), then the distinct knots and multiplicities of u and of v.
 */
export function encodeSurface(surface: NurbsSurfaceData): number[] {
  const rational = surface.weights !== undefined;
  return [
    surface.degreeU,
    surface.degreeV,
    surface.poles.length,
    surface.poles[0]?.length ?? 0,
    surface.knotsU.length,
    surface.knotsV.length,
    rational ? 1 : 0,
    ...surface.poles.flatMap((row) => row.flatMap((pole) => [...pole])),
    ...(surface.weights?.flatMap((row) => [...row]) ?? []),
    ...surface.knotsU,
    ...surface.multiplicitiesU,
    ...surface.knotsV,
    ...surface.multiplicitiesV,
  ];
}

/** Trim loops: the loop count, then per loop its point count, an outer flag (1 / 0) and its (u, v) points. Empty = the natural boundary. */
export function encodeLoops(loops: ReadonlyArray<UvTrimLoop>): number[] {
  if (loops.length === 0) return [];
  return [loops.length, ...loops.flatMap((loop) => [loop.polygon.length, loop.outer ? 1 : 0, ...loop.polygon.flatMap(([u, v]) => [u, v])])];
}
