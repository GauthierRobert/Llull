/**
 * Hidden-line classification of projected feature edges: each edge is split into the runs a
 * viewer sees (visible) and the runs other front faces cover (hidden), across every solid of the
 * view. A section plane removes the material in front of it and its cap hides what lies under it.
 * @layer geometry
 * @pure
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { pointInPolygon, projectOntoSegment } from '../lib/polygon';
import { lerp3 } from '../lib/vec3';
import { pointsExtent } from './bounds';
import { clipSegmentToSide } from './planeEdges';
import { type Face, type FeatureEdge, type Segment2, type ViewFrame, depthOf, sectionPlane } from './viewProjection';

export interface EdgeRuns {
  readonly visible: Segment2[];
  readonly hidden: Segment2[];
}

/** One solid of the view: its faces, their feature edges and, under a section, its cut loops (even-odd). */
export interface ViewSource {
  readonly faces: ReadonlyArray<Face>;
  readonly edges: ReadonlyArray<FeatureEdge>;
  readonly cutLoops: ReadonlyArray<ReadonlyArray<Vec2>>;
}

/** A section cap: the cut loops of one solid with their bounding box (quick reject). */
interface Cap {
  readonly loops: ReadonlyArray<ReadonlyArray<Vec2>>;
  readonly box: { minX: number; minY: number; maxX: number; maxY: number };
}

interface ProjectedTriangle {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly c: Vec2;
  readonly depths: Vec3;
  /** Twice the signed area (barycentric denominator). */
  readonly area2: number;
}

/** Barycentric margin: a point on a triangle's own border is not covered by it. */
const INSIDE_MARGIN = 1e-5;
const MAX_PIECES = 48;
const BISECTIONS = 10;

/** Uniform grid over the projected front faces of every source. */
class Occluders {
  private readonly cells = new Map<number, ProjectedTriangle[]>();
  private readonly size: number;
  private readonly cell: number;
  private readonly min: Vec2;

  constructor(triangles: ReadonlyArray<ProjectedTriangle>, bounds: readonly [number, number, number, number]) {
    this.min = [bounds[0], bounds[1]];
    const extent = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 1e-9);
    this.size = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(triangles.length / 4))));
    this.cell = extent / this.size;
    for (const triangle of triangles) {
      const xs = [triangle.a[0], triangle.b[0], triangle.c[0]];
      const ys = [triangle.a[1], triangle.b[1], triangle.c[1]];
      const [i0, j0] = this.index([Math.min(...xs), Math.min(...ys)]);
      const [i1, j1] = this.index([Math.max(...xs), Math.max(...ys)]);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * this.size + j;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(triangle);
          else this.cells.set(key, [triangle]);
        }
      }
    }
  }

  private index(point: Vec2): [number, number] {
    const clampIndex = (value: number): number => Math.min(this.size - 1, Math.max(0, Math.floor(value / this.cell)));
    return [clampIndex(point[0] - this.min[0]), clampIndex(point[1] - this.min[1])];
  }

  /** Is there a face strictly in front of (`point`, `depth`) that survives the cut? */
  covers(point: Vec2, depth: number, tolerance: number, cutDepth: number): boolean {
    const [i, j] = this.index(point);
    for (const triangle of this.cells.get(i * this.size + j) ?? []) {
      const weights = barycentric(triangle, point);
      if (weights === null) continue;
      const faceDepth = weights[0] * triangle.depths[0] + weights[1] * triangle.depths[1] + weights[2] * triangle.depths[2];
      if (faceDepth > depth + tolerance && faceDepth <= cutDepth + tolerance) return true;
    }
    return false;
  }
}

function barycentric(triangle: ProjectedTriangle, [x, y]: Vec2): Vec3 | null {
  const { a, b, c, area2 } = triangle;
  const wa = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / area2;
  const wb = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / area2;
  const wc = 1 - wa - wb;
  return wa > INSIDE_MARGIN && wb > INSIDE_MARGIN && wc > INSIDE_MARGIN ? [wa, wb, wc] : null;
}

function projectTriangle(face: Face, frame: ViewFrame): ProjectedTriangle | null {
  const [p, q, r] = face.triangle;
  const [a, b, c] = [frame.project(p), frame.project(q), frame.project(r)];
  const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area2) < 1e-14) return null;
  return { a, b, c, area2, depths: [depthOf(frame, p), depthOf(frame, q), depthOf(frame, r)] };
}

/** Inside the even-odd region of the cap's loops, or on its border (an edge under the cut outline). */
function underCap(point: Vec2, { loops, box }: Cap, tolerance: number): boolean {
  const [x, y] = point;
  if (x < box.minX - tolerance || x > box.maxX + tolerance) return false;
  if (y < box.minY - tolerance || y > box.maxY + tolerance) return false;
  let inside = false;
  for (const loop of loops) {
    if (pointInPolygon(point, loop)) inside = !inside;
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i] as Vec2, loop[(i + 1) % loop.length] as Vec2];
      if (projectOntoSegment(point, a, b).distance <= tolerance) return true;
    }
  }
  return inside;
}

/**
 * Visible and hidden runs of every source's feature edges, as seen through `frame`; material on the
 * viewer's side of `cutDepth` is removed (Infinity = no section).
 * @returns one entry per source, in order
 */
export function classifyEdges(sources: ReadonlyArray<ViewSource>, frame: ViewFrame, cutDepth: number): EdgeRuns[] {
  const triangles: ProjectedTriangle[] = [];
  for (const source of sources) {
    for (const face of source.faces) {
      if (!face.front) continue;
      const projected = projectTriangle(face, frame);
      if (projected) triangles.push(projected);
    }
  }
  const { minX, minY, maxX, maxY } = pointsExtent(triangles.flatMap((t) => [t.a, t.b, t.c]));
  const bounds = [minX, minY, maxX, maxY] as const;
  const extent = Math.hypot(maxX - minX, maxY - minY) || 1;
  const tolerance = Math.max(extent * 1e-6, 1e-9);
  const step = extent / 120;
  const occluders = new Occluders(triangles, Number.isFinite(bounds[0]) ? bounds : [0, 0, 1, 1]);
  const caps: Cap[] = sources.flatMap((source) =>
    source.cutLoops.length > 0 ? [{ loops: source.cutLoops, box: pointsExtent(source.cutLoops.flat()) }] : [],
  );
  const nudge = step * 0.01;
  const coveredAt = (at: Vec2, depth: number): boolean =>
    occluders.covers(at, depth, tolerance, cutDepth) || (depth < cutDepth - tolerance && caps.some((cap) => underCap(at, cap, nudge * 2)));
  // Hidden only when covered on both sides of the edge: an edge on a shared triangle border inside
  // a face is hidden, an edge along an occluder's outline stays visible (visible lines win).
  const hiddenAt = (point: Vec3, side: Vec2): boolean => {
    const [x, y] = frame.project(point);
    const depth = depthOf(frame, point);
    return coveredAt([x + side[0] * nudge, y + side[1] * nudge], depth) && coveredAt([x - side[0] * nudge, y - side[1] * nudge], depth);
  };
  const plane = sectionPlane(frame, cutDepth);
  return sources.map((source) => {
    const runs: EdgeRuns = { visible: [], hidden: [] };
    for (const edge of source.edges) {
      const kept = clipSegmentToSide(edge.a, edge.b, plane);
      if (kept) splitEdge(kept[0], kept[1], frame, step, hiddenAt, runs);
    }
    return runs;
  });
}

/** Splits a→b into visible / hidden runs (pieces of ~`step`, transitions refined by bisection). */
function splitEdge(a: Vec3, b: Vec3, frame: ViewFrame, step: number, hiddenAt: (point: Vec3, side: Vec2) => boolean, runs: EdgeRuns): void {
  const [pa, pb] = [frame.project(a), frame.project(b)];
  const length = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  if (length <= step * 1e-6) return;
  const side: Vec2 = [(pa[1] - pb[1]) / length, (pb[0] - pa[0]) / length];
  const at = (t: number): Vec3 => lerp3(a, b, t);
  const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(length / step)));
  const states = Array.from({ length: pieces }, (_, i) => hiddenAt(at((i + 0.5) / pieces), side));
  let start = 0;
  for (let i = 1; i <= pieces; i++) {
    if (i < pieces && states[i] === states[i - 1]) continue;
    let end = 1;
    if (i < pieces) {
      let [low, high] = [(i - 0.5) / pieces, (i + 0.5) / pieces];
      for (let k = 0; k < BISECTIONS; k++) {
        const mid = (low + high) / 2;
        if (hiddenAt(at(mid), side) === states[i - 1]) low = mid;
        else high = mid;
      }
      end = (low + high) / 2;
    }
    const segment: Segment2 = [frame.project(at(start)), frame.project(at(end))];
    (states[i - 1] === true ? runs.hidden : runs.visible).push(segment);
    start = end;
  }
}
