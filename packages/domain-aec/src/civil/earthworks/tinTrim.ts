/** Trims the existing-ground TIN mesh under graded pads so the pad, its batters and the daylight line stay visible. */

import type { Vec2, Vec3 } from '@core/model/types';
import type { CivilModel, PlatformObject, SurfaceObject } from '@aec/civil/types';
import { triangulatePolygon } from '@lib/triangulate';
import { orient2 } from '@lib/vec2';
import { daylightPoints } from './platformDaylight';
import { tinMesh, type Tin } from '../surface/tin';
import { surfaceTin } from '../surface/surfaceTin';

type Triangle = readonly [Vec2, Vec2, Vec2];
type Polygon = Vec3[];

const MIN_AREA = 1e-9;
/** Cross-product slack (m²) within which a point counts as on a footprint edge, i.e. inside the closed footprint. */
const EDGE_TOLERANCE = 1e-9;
/** Clipped contour parts shorter than this (m) are slivers at a footprint corner and dropped. */
const MIN_PART_LENGTH = 1e-3;

/** Plan triangles covered by a pad: the pad itself plus its batter quads (pad edge -> daylight). */
export function platformFootprint(tin: Tin, platform: PlatformObject): Triangle[] {
  const outline = platform.boundary;
  if (outline.length < 3) return [];
  const pad = triangulatePolygon(outline as Vec2[]);
  const triangles: Triangle[] = pad.triangles.map(([a, b, c]) => [
    pad.vertices[a] as Vec2,
    pad.vertices[b] as Vec2,
    pad.vertices[c] as Vec2,
  ]);
  const points = daylightPoints(tin, outline, platform.elevation, platform.cutSlope, platform.fillSlope);
  points.forEach((current, i) => {
    const next = points[(i + 1) % points.length] ?? current;
    triangles.push([current.edge, next.edge, next.daylight], [current.edge, next.daylight, current.daylight]);
  });
  return triangles.filter((triangle) => Math.abs(orient2(...triangle)) > MIN_AREA).map((t) => (orient2(...t) > 0 ? t : [t[0], t[2], t[1]]));
}

/** Part of `polygon` on the left (keepLeft) or right of the directed line a->b; z is interpolated along cut edges. */
function clipHalfPlane(polygon: Polygon, a: Vec2, b: Vec2, keepLeft: boolean): Polygon {
  const side = (p: Vec3): number => (keepLeft ? 1 : -1) * orient2(a, b, [p[0], p[1]]);
  const result: Polygon = [];
  polygon.forEach((current, i) => {
    const next = polygon[(i + 1) % polygon.length] as Vec3;
    const sc = side(current);
    const sn = side(next);
    if (sc >= 0) result.push(current);
    if ((sc > 0 && sn < 0) || (sc < 0 && sn > 0)) {
      const t = sc / (sc - sn);
      result.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        current[2] + (next[2] - current[2]) * t,
      ]);
    }
  });
  return result;
}

function polygonArea(polygon: Polygon): number {
  let sum = 0;
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length] as Vec3;
    sum += p[0] * q[1] - q[0] * p[1];
  });
  return sum / 2;
}

/** `polygon` minus the convex CCW `cutter`, as convex pieces. */
function subtract(polygon: Polygon, cutter: Triangle): Polygon[] {
  const pieces: Polygon[] = [];
  let inside = polygon;
  for (let i = 0; i < 3 && inside.length >= 3; i++) {
    const a = cutter[i] as Vec2;
    const b = cutter[(i + 1) % 3] as Vec2;
    pieces.push(clipHalfPlane(inside, a, b, false));
    inside = clipHalfPlane(inside, a, b, true);
  }
  return pieces.filter((piece) => piece.length >= 3 && polygonArea(piece) > MIN_AREA);
}

type Box = readonly [number, number, number, number];

const boxOf = (points: ReadonlyArray<Vec2 | Vec3>): Box => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  return [minX, minY, maxX, maxY];
};

const boxesOverlap = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** TIN mesh with everything under `footprint` removed (triangles are cut along the footprint edges, z preserved). */
export function trimmedTinMesh(tin: Tin, footprint: ReadonlyArray<Triangle>): { positions: number[]; indices: number[] } {
  if (footprint.length === 0) return tinMesh(tin);
  const cutters = footprintBoxes(footprint);
  const extent = boxOf(footprint.flat());
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t + 2 < tin.triangles.length; t += 3) {
    const corners = [0, 1, 2].map((k) => tin.points[tin.triangles[t + k] as number] as Vec3);
    let pieces: Polygon[] = [corners];
    if (boxesOverlap(boxOf(corners), extent)) {
      for (const cutter of cutters) {
        pieces = pieces.flatMap((piece) => (boxesOverlap(boxOf(piece), cutter.box) ? subtract(piece, cutter.triangle) : [piece]));
        if (pieces.length === 0) break;
      }
    }
    for (const piece of pieces) {
      const base = positions.length / 3;
      piece.forEach((p) => positions.push(p[0], p[1], p[2]));
      for (let k = 1; k + 1 < piece.length; k++) indices.push(base, base + k, base + k + 1);
    }
  }
  return { positions, indices };
}

/** Parameter intervals [t0, t1] of the segment a->b that lie inside the convex CCW `triangle`. */
function insideInterval(a: Vec2, b: Vec2, triangle: Triangle): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const p = triangle[i] as Vec2;
    const q = triangle[(i + 1) % 3] as Vec2;
    const raw = [orient2(p, q, a), orient2(p, q, b)] as const;
    const [sa, sb] = raw.map((value) => (Math.abs(value) <= EDGE_TOLERANCE ? 0 : value)) as [number, number];
    if (sa <= 0 && sb <= 0 && (sa < 0 || sb < 0)) return null;
    if (sa < 0 || sb < 0) {
      const t = sa / (sa - sb);
      if (sa < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t1 - t0 > 1e-12 ? [t0, t1] : null;
}

const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Parts of the polyline `line` outside every `footprint` triangle (cut at the boundary, bbox-culled per segment).
 * @invariant no footprint hit -> `[line]` unchanged (same array); a closed loop cut open is returned as open parts
 */
export function clipPolylineOutside(
  line: ReadonlyArray<Vec2>,
  footprint: ReadonlyArray<Triangle>,
  cutters = footprintBoxes(footprint),
): Vec2[][] {
  if (cutters.length === 0) return [line.slice()];
  const extent = boxOf(footprint.flat());
  const parts: Vec2[][] = [];
  let current: Vec2[] = [];
  let clipped = false;
  const flush = (): void => {
    if (
      current.length >= 2 &&
      current.some((point) => Math.hypot(point[0] - (current[0] as Vec2)[0], point[1] - (current[0] as Vec2)[1]) > MIN_PART_LENGTH)
    )
      parts.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Vec2;
    const b = line[i + 1] as Vec2;
    const box = boxOf([a, b]);
    const inside: Array<[number, number]> = [];
    if (boxesOverlap(box, extent)) {
      for (const cutter of cutters) {
        if (!boxesOverlap(box, cutter.box)) continue;
        const interval = insideInterval(a, b, cutter.triangle);
        if (interval) inside.push(interval);
      }
    }
    inside.sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    const outside: Array<[number, number]> = [];
    for (const [t0, t1] of inside) {
      if (t0 > cursor) outside.push([cursor, t0]);
      cursor = Math.max(cursor, t1);
    }
    if (cursor < 1) outside.push([cursor, 1]);
    if (outside.length !== 1 || outside[0]?.[0] !== 0 || outside[0][1] !== 1) clipped = true;
    for (const [t0, t1] of outside) {
      if (t0 === 0 && current.length > 0) current.push(t1 === 1 ? b : lerp2(a, b, t1));
      else {
        flush();
        current = [t0 === 0 ? a : lerp2(a, b, t0), t1 === 1 ? b : lerp2(a, b, t1)];
      }
      if (t1 < 1) flush();
    }
    if (outside.length === 0) flush();
  }
  flush();
  if (!clipped) return [line.slice()];
  const first = parts[0];
  const last = parts[parts.length - 1];
  const closedLoop = line.length > 3 && line[0]?.[0] === line.at(-1)?.[0] && line[0]?.[1] === line.at(-1)?.[1];
  if (closedLoop && parts.length > 1 && first && last && first[0] === line[0] && last.at(-1) === line.at(-1)) {
    parts.splice(parts.length - 1, 1);
    parts[0] = [...last, ...first.slice(1)];
  }
  return parts;
}

/** Triangles with their bounding boxes, for repeated `clipPolylineOutside` calls. */
export function footprintBoxes(footprint: ReadonlyArray<Triangle>): Array<{ triangle: Triangle; box: Box }> {
  return footprint.map((triangle) => ({ triangle, box: boxOf(triangle) }));
}

/** Footprints of every pad graded against `surface`. */
export function surfaceFootprint(civil: CivilModel, surface: SurfaceObject): Triangle[] {
  const tin = surfaceTin(civil, surface);
  return civil.order.flatMap((id) => {
    const object = civil.objects[id];
    return object?.category === 'platform' && object.surfaceId === surface.id ? platformFootprint(tin, object) : [];
  });
}
