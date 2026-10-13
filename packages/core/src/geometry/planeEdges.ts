/**
 * Polygons and segments against a plane — signed distances, crossings, Sutherland–Hodgman
 * clipping, section chords and their chaining into loops. The one section engine shared by the
 * render cutaway, decal clipping and the technical views (sections, elevations).
 *
 * @layer core/geometry
 * @pure
 */

import type { Vec3 } from '../model/types';
import { dot3, lerp3, sub3 } from '../lib/vec3';
import { quantizedKey } from '../lib/quantize';

/** Unit-normal plane; `signedDistance(plane, p) > 0` is its positive side. */
export interface UnitPlane {
  normal: Vec3;
  offset: number;
}

const signedDistance = (plane: UnitPlane, p: Vec3): number => dot3(plane.normal, p) - plane.offset;

/** Visit each edge `a→b` of the closed polygon `verts` with both ends' signed plane distances. */
export function forEachEdge(
  verts: readonly Vec3[],
  plane: UnitPlane,
  visit: (a: Vec3, b: Vec3, sa: number, sb: number) => void,
): void {
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i] as Vec3;
    const b = verts[(i + 1) % verts.length] as Vec3;
    visit(a, b, signedDistance(plane, a), signedDistance(plane, b));
  }
}

/** Where edge `a→b` (signed distances `sa`, `sb` of opposite sides) meets the plane. */
export const edgeCrossing = (a: Vec3, b: Vec3, sa: number, sb: number): Vec3 =>
  lerp3(a, b, sa / (sa - sb));

/** Sutherland–Hodgman clip of a polygon to one side of `plane` (`keepCut` ⇒ the positive side). */
export function clipToSide(verts: readonly Vec3[], plane: UnitPlane, keepCut: boolean): Vec3[] {
  const out: Vec3[] = [];
  const inside = (s: number): boolean => (keepCut ? s > 0 : s <= 0);
  forEachEdge(verts, plane, (a, b, sa, sb) => {
    if (inside(sa)) out.push(a);
    if (inside(sa) !== inside(sb)) out.push(edgeCrossing(a, b, sa, sb));
  });
  return out.length >= 3 ? out : [];
}

/** The part of segment a→b on the non-positive side of `plane`, or null. */
export function clipSegmentToSide(a: Vec3, b: Vec3, plane: UnitPlane): [Vec3, Vec3] | null {
  const [sa, sb] = [signedDistance(plane, a), signedDistance(plane, b)];
  if (sa > 0 && sb > 0) return null;
  if (sa <= 0 && sb <= 0) return [a, b];
  const crossing = edgeCrossing(a, b, sa, sb);
  return sa <= 0 ? [a, crossing] : [crossing, b];
}

/** Chord segments where polygons cross `plane` (a vertex exactly on the plane counts as cut side). */
export function planeChords(
  polygons: readonly (readonly Vec3[])[],
  plane: UnitPlane,
): [Vec3, Vec3][] {
  const segments: [Vec3, Vec3][] = [];
  for (const verts of polygons) {
    const hits: Vec3[] = [];
    forEachEdge(verts, plane, (a, b, sa, sb) => {
      if (sa > 0 !== sb > 0) hits.push(edgeCrossing(a, b, sa, sb));
    });
    // Pair crossings along the plane (convex faces have exactly two).
    if (hits.length === 2) segments.push([hits[0] as Vec3, hits[1] as Vec3]);
    else if (hits.length > 2) {
      const axis = sub3(hits[hits.length - 1] as Vec3, hits[0] as Vec3);
      hits.sort((p, q) => dot3(axis, p) - dot3(axis, q));
      for (let i = 0; i + 1 < hits.length; i += 2)
        segments.push([hits[i] as Vec3, hits[i + 1] as Vec3]);
    }
  }
  return segments;
}

/** Consecutive points of a chain; a closed chain does not repeat its first point. */
export interface SegmentChain<P> {
  readonly points: P[];
  readonly closed: boolean;
}

/**
 * Chains unordered segments by shared endpoints (welded at `tolerance`), extending each chain both
 * ways. `stopAtJunctions`: a chain only continues through a point where exactly two segments meet
 * (a T or X junction ends it); otherwise it takes any unused segment. Works for 2D and 3D points.
 */
export function chainSegments<P extends readonly number[]>(
  segments: ReadonlyArray<readonly [P, P]>,
  tolerance: number,
  stopAtJunctions: boolean,
): SegmentChain<P>[] {
  const key = (p: P): string => quantizedKey(p, tolerance);
  const meeting = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const end of segment) meeting.set(key(end), [...(meeting.get(key(end)) ?? []), index]);
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const continuation = (point: P): number | undefined => {
    const ids = meeting.get(key(point)) ?? [];
    if (stopAtJunctions && ids.length !== 2) return undefined;
    return ids.find((id) => !used[id]);
  };
  const otherEnd = (index: number, point: P): P => {
    const [a, b] = segments[index] as readonly [P, P];
    return key(a) === key(point) ? b : a;
  };
  const chains: SegmentChain<P>[] = [];
  segments.forEach(([first, second], start) => {
    if (used[start]) return;
    used[start] = true;
    const points: P[] = [first, second];
    let closed = false;
    for (
      let next = continuation(second);
      next !== undefined;
      next = continuation(points[points.length - 1] as P)
    ) {
      used[next] = true;
      const point = otherEnd(next, points[points.length - 1] as P);
      if (key(point) === key(first)) {
        closed = true;
        break;
      }
      points.push(point);
    }
    for (
      let prev = closed ? undefined : continuation(first);
      prev !== undefined;
      prev = continuation(points[0] as P)
    ) {
      used[prev] = true;
      points.unshift(otherEnd(prev, points[0] as P));
    }
    chains.push({ points, closed });
  });
  return chains;
}

/**
 * Chains unordered section segments into loops (open chains are kept and implicitly closed).
 */
export function chainLoops<P extends readonly number[]>(
  segments: ReadonlyArray<readonly [P, P]>,
  tolerance: number,
): P[][] {
  return chainSegments(segments, tolerance, false)
    .map((chain) => chain.points)
    .filter((points) => points.length >= 3);
}
