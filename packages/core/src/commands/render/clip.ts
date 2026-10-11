/**
 * Cutaway for render_view: clips solid polygons against half-spaces (split, not dropped) and
 * rebuilds the section outline as capped loops.
 *
 * @layer core/commands
 * @pure
 */

import type { Vec3 } from '../../model/types';
import { add3, dot3, normalize3, scale3, sub3 } from '../../lib/vec3';
import type { CutSpec, PreDepthPolygon } from './types';

/** Unit-normal plane; `signed(p) > 0` is the removed (cut) side. */
export interface UnitPlane {
  normal: Vec3;
  offset: number;
}

const signed = (plane: UnitPlane, p: Vec3): number => dot3(plane.normal, p) - plane.offset;

/** True when every plane has a finite, non-zero normal and a finite offset. */
export function isValidCut(cut: CutSpec): boolean {
  return (
    cut.planes.length > 0 &&
    cut.planes.every(
      ({ normal, offset }) =>
        Number.isFinite(offset) &&
        normal.every(Number.isFinite) &&
        Math.hypot(normal[0], normal[1], normal[2]) > 1e-9,
    )
  );
}

/** Planes with unit normals (the offset is rescaled accordingly). */
export function unitPlanes(cut: CutSpec): UnitPlane[] {
  return cut.planes.map(({ normal, offset }) => {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    return { normal: normalize3(normal), offset: offset / length };
  });
}

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add3(a, scale3(sub3(b, a), t));

/** Sutherland–Hodgman clip of a polygon to one side of `plane` (`keepCut` ⇒ the cut side). */
export function clipToSide(verts: Vec3[], plane: UnitPlane, keepCut: boolean): Vec3[] {
  const out: Vec3[] = [];
  const inside = (s: number): boolean => (keepCut ? s > 0 : s <= 0);
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i] as Vec3;
    const b = verts[(i + 1) % verts.length] as Vec3;
    const sa = signed(plane, a);
    const sb = signed(plane, b);
    if (inside(sa)) out.push(a);
    if (inside(sa) !== inside(sb)) out.push(lerp3(a, b, sa / (sa - sb)));
  }
  return out.length >= 3 ? out : [];
}

/** The parts of `verts` that survive the cut. */
export function surviving(verts: Vec3[], planes: UnitPlane[], mode: CutSpec['mode']): Vec3[][] {
  if (mode === 'union') {
    let rest: Vec3[] = verts;
    for (const plane of planes) {
      rest = clipToSide(rest, plane, false);
      if (rest.length === 0) return [];
    }
    return [rest];
  }
  // Intersection: kept = (P − H1) ∪ (P∩H1 − H2) ∪ (P∩H1∩H2 − H3) …
  const pieces: Vec3[][] = [];
  let rest: Vec3[] = verts;
  for (const plane of planes) {
    const outside = clipToSide(rest, plane, false);
    if (outside.length > 0) pieces.push(outside);
    rest = clipToSide(rest, plane, true);
    if (rest.length === 0) break;
  }
  return pieces;
}

/** Chord segments where polygons cross `plane` (a vertex exactly on the plane counts as cut side). */
function chords(polygons: readonly PreDepthPolygon[], plane: UnitPlane): [Vec3, Vec3][] {
  const segments: [Vec3, Vec3][] = [];
  for (const { verts } of polygons) {
    const hits: Vec3[] = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i] as Vec3;
      const b = verts[(i + 1) % verts.length] as Vec3;
      const sa = signed(plane, a);
      const sb = signed(plane, b);
      if (sa > 0 !== sb > 0) hits.push(lerp3(a, b, sa / (sa - sb)));
    }
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

/** Chain unordered segments into loops (open chains are kept and implicitly closed). */
function chain(segments: readonly [Vec3, Vec3][], tolerance: number): Vec3[][] {
  const key = (p: Vec3): string => p.map((c) => Math.round(c / tolerance)).join(',');
  const byEnd = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    for (const k of [key(a), key(b)]) byEnd.set(k, [...(byEnd.get(k) ?? []), index]);
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const loops: Vec3[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const [first, second] = segments[start] as [Vec3, Vec3];
    const loop: Vec3[] = [first, second];
    let tail = second;
    for (;;) {
      const next = (byEnd.get(key(tail)) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      const [a, b] = segments[next] as [Vec3, Vec3];
      tail = key(a) === key(tail) ? b : a;
      loop.push(tail);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Cap polygon: the section outline of one entity on one cut plane, clipped to the true cut face. */
function capFor(
  source: readonly PreDepthPolygon[],
  plane: UnitPlane,
  others: UnitPlane[],
  mode: CutSpec['mode'],
  color: string,
  tolerance: number,
): PreDepthPolygon | null {
  const loops: Vec3[][] = [];
  for (const loop of chain(chords(source, plane), tolerance)) {
    // The removed region's face on this plane lies inside every other cut side (intersection)
    // or outside all of them (union).
    let clipped: Vec3[] = loop;
    for (const other of others) {
      clipped = clipToSide(clipped, other, mode === 'intersection');
      if (clipped.length === 0) break;
    }
    if (clipped.length >= 3) loops.push(clipped);
  }
  const first = loops[0];
  return first ? { verts: first, loops, color, normal: plane.normal, stroke: false } : null;
}

/** Result of cutting one entity. */
export interface CutResult {
  polygons: PreDepthPolygon[];
  /** True when at least one polygon was touched by the cut. */
  cut: boolean;
}

/**
 * Clip every filled polygon of an entity and append the section caps.
 * @param tolerance chain-matching distance (world units)
 */
export function cutEntityPolygons(
  polygons: readonly PreDepthPolygon[],
  cut: CutSpec,
  planes: UnitPlane[],
  tolerance: number,
): CutResult {
  const solids = polygons.filter((p) => !p.stroke);
  const result: PreDepthPolygon[] = polygons.filter((p) => p.stroke);
  let touched = false;
  for (const poly of solids) {
    const pieces = surviving(poly.verts, planes, cut.mode);
    if (pieces.length !== 1 || (pieces[0] as Vec3[]).length !== poly.verts.length) touched = true;
    for (const verts of pieces) result.push({ ...poly, verts });
  }
  if (!touched) return { polygons: [...polygons], cut: false };
  const color = solids[0]?.color ?? '#cccccc';
  planes.forEach((plane, index) => {
    const others = planes.filter((_, j) => j !== index);
    const cap = capFor(solids, plane, others, cut.mode, color, tolerance);
    if (cap) result.push(cap);
  });
  return { polygons: result, cut: true };
}
