/**
 * Cutaway for render_view: clips solid polygons against half-spaces (split, not dropped) and
 * rebuilds the section outline as capped loops.
 *
 * @layer core/commands
 * @pure
 */

import type { Vec3 } from '../../model/types';
import { normalize3 } from '../../lib/vec3';
import type { CutSpec, PreDepthPolygon } from './types';
import { type UnitPlane, chainLoops, clipToSide, planeChords } from '../../geometry/planeEdges';

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
  for (const loop of chainLoops(
    planeChords(
      source.map((p) => p.verts),
      plane,
    ),
    tolerance,
  )) {
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
