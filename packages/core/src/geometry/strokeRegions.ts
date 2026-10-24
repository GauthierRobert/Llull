/**
 * The area a flat-bottomed tool of a given width sweeps along planar polylines (03 WRP M5, engraving): every segment becomes a stadium (a rectangle with half-disc ends), the stadiums
 * are united, and the result is grouped into regions (an outer boundary and its holes: a stroked O leaves an island). Round ends and joins; the boundary is polygonal.
 * @invariant the swept area lies within width / 2 of the polylines and covers every point within width / 2 of them, up to the polygon approximation of the half-discs
 * @failure fewer than one usable segment, a width <= 0, a union that leaves no closed boundary -> `{ error }`
 */

import type { Vec2 } from '../model/vectors';
import { pointInPolygon, signedArea } from '../lib/polygon';
import { unionBoundary } from '../lib/polygonBoolean';

export interface PolygonRegion {
  readonly outer: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
}

/** Points on each half-disc of a stadium. */
const CAP_STEPS = 8;
const MAX_SEGMENTS = 3000;

/** Clockwise stadium around the segment a -> b of half width `half` (clockwise = a filled loop in the outline convention). */
function stadium(a: Vec2, b: Vec2, half: number): Vec2[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d: Vec2 = length > 0 ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : [1, 0];
  const base = Math.atan2(d[1], d[0]);
  const cap = (centre: Vec2, from: number): Vec2[] =>
    Array.from({ length: CAP_STEPS + 1 }, (_, k): Vec2 => {
      const angle = from + (Math.PI * k) / CAP_STEPS;
      return [centre[0] + half * Math.cos(angle), centre[1] + half * Math.sin(angle)];
    });
  // counter-clockwise: the right side out, the cap round b, the left side back, the cap round a
  const ccw = [...cap(b, base - Math.PI / 2), ...cap(a, base + Math.PI / 2)];
  return ccw.reverse();
}

export function strokeRegions(polylines: readonly (readonly Vec2[])[], width: number): PolygonRegion[] | { readonly error: string } {
  if (!(width > 0) || !Number.isFinite(width)) return { error: 'the tool width must be a finite number > 0' };
  const stadiums: Vec2[][] = [];
  for (const line of polylines) {
    if (line.length === 1) stadiums.push(stadium(line[0] as Vec2, line[0] as Vec2, width / 2));
    for (let k = 1; k < line.length; k++) {
      const [a, b] = [line[k - 1] as Vec2, line[k] as Vec2];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-12) stadiums.push(stadium(a, b, width / 2));
    }
  }
  if (stadiums.length === 0) return { error: 'the strokes have no length' };
  if (stadiums.length > MAX_SEGMENTS) return { error: `${stadiums.length} stroke segments exceed the limit of ${MAX_SEGMENTS}` };
  const { outers, holes } = unionBoundary(stadiums);
  if (outers.length === 0) return { error: 'the union of the stroked segments left no closed boundary' };
  const owned = new Map<number, Vec2[][]>();
  for (const hole of holes) {
    // a hole belongs to the smallest outer ring that contains it
    const owners = outers
      .map((outer, k) => ({ k, area: signedArea(outer) }))
      .filter(({ k }) => pointInPolygon(hole[0] as Vec2, outers[k] as Vec2[]))
      .sort((p, q) => p.area - q.area);
    const owner = owners[0];
    if (owner !== undefined) owned.set(owner.k, [...(owned.get(owner.k) ?? []), hole]);
  }
  return outers.map((outer, k) => ({ outer, holes: owned.get(k) ?? [] }));
}
