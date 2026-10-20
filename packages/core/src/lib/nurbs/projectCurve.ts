/** Projection of a 3D curve onto a surface into the (u, v) plane: by closest point, or along a fixed direction (ray hit), with continuation. */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, sub3 } from '../vec3';
import { closestOnSurface, refineOnSurface, surfaceProbe, type SurfaceProbe } from './closest';
import { surfaceDerivatives, surfaceDomain } from './surface';
import type { NurbsSurfaceData } from './surfaceTypes';

export type Uv = readonly [number, number];

export interface ProjectedPoint {
  readonly uv: Uv;
  /** True when the parameter sits on the boundary of the domain (a clamped projection). */
  readonly onBoundary: boolean;
  /** Distance between the curve point and its projection (closest mode); 0 for a ray hit. */
  readonly gap: number;
}

export interface CurveProjector {
  /** Projection of the curve point at parameter `t` (continuing from `seed`, else from the previous result), (a ray that misses the surface comes back `onBoundary` with an infinite gap). */
  project(t: number, seed?: Uv): ProjectedPoint;
}

const RAY_STEPS = 40;

/** Newton solution of S(u, v) + t d = P from (u0, v0); null when it does not converge to a hit within `tolerance`. */
function rayHit(surface: NurbsSurfaceData, target: Vec3, direction: Vec3, u0: number, v0: number, tolerance: number): Uv | null {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  let [u, v] = [u0, v0];
  const start = (surfaceDerivatives(surface, u, v, 0)[0] as Vec3[])[0] as Vec3;
  let t = dot3(sub3(target, start), direction) / dot3(direction, direction);
  for (let step = 0; step < RAY_STEPS; step++) {
    const d = surfaceDerivatives(surface, u, v, 1);
    const [point, su, sv] = [(d[0] as Vec3[])[0] as Vec3, (d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
    const residual: Vec3 = [
      point[0] + t * direction[0] - target[0],
      point[1] + t * direction[1] - target[1],
      point[2] + t * direction[2] - target[2],
    ];
    if (Math.hypot(...residual) <= tolerance) return [u, v];
    const determinant = dot3(su, cross3(sv, direction));
    if (!(Math.abs(determinant) > 1e-300)) return null;
    const r: Vec3 = [-residual[0], -residual[1], -residual[2]];
    const du = dot3(r, cross3(sv, direction)) / determinant;
    const dv = dot3(r, cross3(direction, su)) / determinant;
    t += dot3(r, cross3(su, sv)) / determinant;
    [u, v] = [Math.min(uMax, Math.max(uMin, u + du)), Math.min(vMax, Math.max(vMin, v + dv))];
  }
  return null;
}

/**
 * Projector of the curve `pointAt` (any parameter) onto `surface`. Without `direction` each point goes to its closest point on the surface
 * (always defined); with it the point is carried along `direction` (both ways) onto the surface and null is returned where that line misses it.
 * The first call searches the whole patch, the following ones continue from the previous result, so consecutive parameters must be close.
 */
export function curveProjector(
  surface: NurbsSurfaceData,
  pointAt: (t: number) => Vec3,
  direction: Vec3 | null,
  hitTolerance: number,
): CurveProjector {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  const snap = 1e-10 * Math.max(uMax - uMin, vMax - vMin);
  const probe: SurfaceProbe = surfaceProbe(surface);
  let last: Uv | null = null;
  return {
    project(t, seed) {
      const point = pointAt(t);
      const seeded = seed ?? last;
      let uv: Uv;
      let gap = 0;
      if (direction === null) {
        const found = seeded === null ? closestOnSurface(surface, point, probe) : refineOnSurface(surface, point, seeded[0], seeded[1]);
        uv = [found.u, found.v];
        gap = found.distance;
      } else {
        const start = seeded ?? ((found) => [found.u, found.v] as const)(closestOnSurface(surface, point, probe));
        const hit = rayHit(surface, point, direction, start[0], start[1], hitTolerance);
        // a ray that misses the sheet is off the sheet: the same as a clamped projection (the curve leaves the domain there)
        if (hit === null) return { uv: start, onBoundary: true, gap: Number.POSITIVE_INFINITY };
        uv = hit;
      }
      last = uv;
      const onBoundary = uv[0] <= uMin + snap || uv[0] >= uMax - snap || uv[1] <= vMin + snap || uv[1] >= vMax - snap;
      return { uv, onBoundary, gap };
    },
  };
}
