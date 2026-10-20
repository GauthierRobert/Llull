/** The drape solver's view of a tool face (06 CMP §5.4): a projection onto the surface with its chart position, and a containment test. */

import type { CompositePart } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { dot3 } from '@lib/vec3';
import { nurbsHit, sphereHit } from '../curved';
import { boundaryDistance, insideOrOn } from '../geometry2d';
import { fromFlat, normalAt, toFlat } from '../surface';

export interface DrapeHit {
  /** Point of the surface. */
  readonly point: Vec3;
  /** Unit tool-outward normal. */
  readonly normal: Vec3;
  /** Chart coordinates (the part's 2D frame). */
  readonly uv: Vec2;
  /** Warm start for the next projection (nurbs). */
  readonly param?: Vec2;
}

export interface DrapeSurface {
  /** Nearest surface point to `query`, or null when the surface is degenerate there. `hint` is a neighbouring hit (warm start). */
  project(query: Vec3, hint?: DrapeHit): DrapeHit | null;
  /** True when the hit lies on the face or within `margin` (chart units) of its outline. */
  contains(hit: DrapeHit, margin: number): boolean;
}

const finite = (v: Vec3): boolean => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/** Drape view of the part's tool face: closed-form on plane / cylinder / cone / sphere, Newton projection on a NURBS sheet. */
export function drapeSurfaceOf(part: CompositePart, region: readonly Vec2[] = part.outline): DrapeSurface {
  const { surface } = part;
  const outline = region;
  const contains = (hit: DrapeHit, margin: number): boolean =>
    insideOrOn(hit.uv, outline, 1e-9) || boundaryDistance(hit.uv, outline) <= margin;
  if (surface.type === 'sphere')
    return {
      project: (query) => {
        const hit = sphereHit(surface, query);
        return hit === null ? null : { point: hit.point, normal: hit.normal, uv: hit.uv };
      },
      contains,
    };
  if (surface.type === 'nurbs')
    return {
      project: (query, hint) => {
        const hit = nurbsHit(surface, query, hint?.param);
        return finite(hit.normal)
          ? { point: hit.point, normal: hit.normal, uv: hit.uv, ...(hit.param === undefined ? {} : { param: hit.param }) }
          : null;
      },
      contains,
    };
  return {
    project: (query) => {
      const uv = toFlat(surface, query).uv;
      const point = fromFlat(surface, uv);
      const normal = normalAt(surface, uv);
      return finite(point) && finite(normal) && dot3(normal, normal) > 0.5 ? { point, normal, uv } : null;
    },
    contains,
  };
}
