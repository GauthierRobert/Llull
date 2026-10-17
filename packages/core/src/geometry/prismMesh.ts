/**
 * Pure closed-mesh construction from planar outlines (prisms, lofts, holes) with welded vertices, so the result is watertight by
 * construction. @layer geometry
 */

import type { MeshData } from '../model/types';
import { polygonArea, type Point2 } from '../lib/polygon';
import { orient2 } from '../lib/vec2';
import { entityLocalToWorld } from './entityFrame';
import { vec3At } from '../lib/vec3';
import { triangulatePolygon } from '../lib/triangulate';
import type { Vec3 } from '../model/vectors';

export interface MeshBuilder {
  /** Index of the vertex at (x, y, z); identical coordinates share one vertex. */
  vertex(x: number, y: number, z: number): number;
  triangle(a: number, b: number, c: number): void;
  build(): MeshData;
}

export function createMeshBuilder(): MeshBuilder {
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();
  return {
    vertex(x, y, z) {
      const key = `${x},${y},${z}`;
      const known = lookup.get(key);
      if (known !== undefined) return known;
      const index = positions.length / 3;
      positions.push(x, y, z);
      lookup.set(key, index);
      return index;
    },
    triangle(a, b, c) {
      if (a !== b && b !== c && a !== c) indices.push(a, b, c);
    },
    build: () => ({ positions: [...positions], indices: [...indices] }),
  };
}

/** Planar cap of `outer` minus `holes` at height `z`, facing +Z (`up`) or −Z. */
export function addCap(
  builder: MeshBuilder,
  outer: ReadonlyArray<Point2>,
  holes: ReadonlyArray<ReadonlyArray<Point2>>,
  z: number,
  up: boolean,
): void {
  const { vertices, triangles } = triangulatePolygon(outer, holes);
  const ids = vertices.map(([x, y]) => builder.vertex(x, y, z));
  for (const [a, b, c] of triangles) {
    const [ia, ib, ic] = [ids[a]!, ids[b]!, ids[c]!];
    if (up) builder.triangle(ia, ib, ic);
    else builder.triangle(ia, ic, ib);
  }
}

/**
 * Cap of the annulus between two CCW loops around the origin (e.g. a rim circle and a gear outline): a zipper of well-shaped
 * triangles walked by polar angle when both loops are star-shaped about the origin.
 * @invariant the zipper is used only if every triangle is CCW and they tile exactly the annulus; otherwise (re-entrant outline) the cap
 *   is triangulated as a polygon with a hole (`addCap`)
 */
export function addStarAnnulusCap(
  builder: MeshBuilder,
  outer: ReadonlyArray<Point2>,
  inner: ReadonlyArray<Point2>,
  z: number,
  up: boolean,
): void {
  const turn = 2 * Math.PI;
  const prepare = (loop: ReadonlyArray<Point2>): { points: Point2[]; angles: number[] } => {
    const raw = loop.map(([x, y]) => (Math.atan2(y, x) + turn) % turn);
    const start = raw.indexOf(Math.min(...raw));
    const points = [...loop.slice(start), ...loop.slice(0, start)];
    const angles = [...raw.slice(start), ...raw.slice(0, start)].map((a, i, all) => (i > 0 && a < all[i - 1]! ? a + turn : a));
    return { points, angles };
  };
  const o = prepare(outer);
  const n = prepare(inner);
  const emit = (a: number, b: number, c: number): void => (up ? builder.triangle(a, b, c) : builder.triangle(a, c, b));
  const angleAt = (loop: { angles: number[] }, i: number): number => (i < loop.angles.length ? loop.angles[i]! : loop.angles[0]! + turn);
  const zipper: Array<[Point2, Point2, Point2]> = [];
  const at = (loop: Point2[], k: number): Point2 => loop[k % loop.length]!;
  let i = 0;
  let j = 0;
  while (i < o.points.length || j < n.points.length) {
    const nextOuter = i < o.points.length ? angleAt(o, i + 1) : Infinity;
    const nextInner = j < n.points.length ? angleAt(n, j + 1) : Infinity;
    if (nextOuter <= nextInner) {
      zipper.push([at(o.points, i), at(o.points, i + 1), at(n.points, j)]);
      i++;
    } else {
      zipper.push([at(o.points, i), at(n.points, j + 1), at(n.points, j)]);
      j++;
    }
  }
  const area = zipper.reduce((sum, [a, b, c]) => sum + orient2(a, b, c) / 2, 0);
  const target = polygonArea(outer) - polygonArea(inner);
  const tiles = zipper.every(([a, b, c]) => orient2(a, b, c) > -1e-12) && target > 0 && Math.abs(area - target) <= target * 1e-6;
  if (!tiles) return addCap(builder, outer, [inner], z, up);
  for (const [a, b, c] of zipper) emit(builder.vertex(a[0], a[1], z), builder.vertex(b[0], b[1], z), builder.vertex(c[0], c[1], z));
}

/**
 * Circle of `radius` with one point on every ray through a point of `loop` (same angles, so the
 * annulus between the two is zippered with purely radial rungs). Points on the same ray collapse to one.
 */
export function circleThrough(loop: ReadonlyArray<Point2>, radius: number): Point2[] {
  const points = loop.map(([x, y]): Point2 => {
    const length = Math.hypot(x, y);
    return [(x / length) * radius, (y / length) * radius];
  });
  return points.filter((p, i) => {
    const previous = points[(i - 1 + points.length) % points.length]!;
    return Math.hypot(p[0] - previous[0], p[1] - previous[1]) > 1e-9 * radius;
  });
}

/** Annulus prism (`outer` minus `inner`, both CCW and star-shaped about the origin) from z = 0 to `depth`. */
export function ringMesh(outer: ReadonlyArray<Point2>, inner: ReadonlyArray<Point2>, depth: number): MeshData {
  const builder = createMeshBuilder();
  addStarAnnulusCap(builder, outer, inner, 0, false);
  addStarAnnulusCap(builder, outer, inner, depth, true);
  addWalls(builder, outer, 0, depth, true);
  addWalls(builder, inner, 0, depth, false);
  return builder.build();
}

/**
 * Side wall joining `lower` (at `zLower`) to `upper` (at `zUpper`), same point count. `ring` points are
 * CCW; `outward` walls face away from the enclosed area, inward walls (holes) face into it.
 */
export function addLoftWalls(
  builder: MeshBuilder,
  lower: ReadonlyArray<Point2>,
  zLower: number,
  upper: ReadonlyArray<Point2>,
  zUpper: number,
  outward: boolean,
): void {
  const n = lower.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [l0, l1, u0, u1] = [lower[i]!, lower[j]!, upper[i]!, upper[j]!];
    const a = builder.vertex(l0[0], l0[1], zLower);
    const b = builder.vertex(l1[0], l1[1], zLower);
    const c = builder.vertex(u1[0], u1[1], zUpper);
    const d = builder.vertex(u0[0], u0[1], zUpper);
    if (outward) {
      builder.triangle(a, b, c);
      builder.triangle(a, c, d);
    } else {
      builder.triangle(a, c, b);
      builder.triangle(a, d, c);
    }
  }
}

/** Straight walls of one ring between two heights. */
export function addWalls(builder: MeshBuilder, ring: ReadonlyArray<Point2>, z0: number, z1: number, outward: boolean): void {
  addLoftWalls(builder, ring, z0, ring, z1, outward);
}

/** `outer` (CCW) minus `holes` (CCW each) extruded from z = 0 to `depth`; closed and watertight. */
export function prismMesh(outer: ReadonlyArray<Point2>, holes: ReadonlyArray<ReadonlyArray<Point2>>, depth: number): MeshData {
  const builder = createMeshBuilder();
  addCap(builder, outer, holes, 0, false);
  addCap(builder, outer, holes, depth, true);
  addWalls(builder, outer, 0, depth, true);
  for (const hole of holes) addWalls(builder, hole, 0, depth, false);
  return builder.build();
}

/** World-space copy of a local mesh: rotated (extrinsic XYZ) about the origin, then moved to `position`. */
export function placeMesh(mesh: MeshData, position: Vec3, rotation: Vec3): MeshData {
  const positions: number[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3)
    positions.push(...entityLocalToWorld({ position, rotation }, vec3At(mesh.positions, i)));
  return { positions, indices: [...mesh.indices] };
}
