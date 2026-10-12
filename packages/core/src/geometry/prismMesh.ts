/**
 * Pure closed-mesh construction from planar outlines (prisms, lofts, holes) with welded vertices,
 * so the result is watertight by construction. @layer geometry
 */

import type { MeshData } from '../model/types';
import type { Point2 } from '../lib/polygon';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { triangulatePolygon } from '../lib/triangulate';

type Vec3 = readonly [number, number, number];

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
 * Cap of the annulus between two loops that are both CCW and star-shaped about the origin
 * (e.g. a rim circle and a gear outline): a zipper of well-shaped triangles walked by polar angle.
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
    const angles = [...raw.slice(start), ...raw.slice(0, start)].map((a, i, all) =>
      i > 0 && a < all[i - 1]! ? a + turn : a,
    );
    return { points, angles };
  };
  const o = prepare(outer);
  const n = prepare(inner);
  const id = (loop: Point2[], i: number): number => {
    const [x, y] = loop[i % loop.length]!;
    return builder.vertex(x, y, z);
  };
  const emit = (a: number, b: number, c: number): void =>
    up ? builder.triangle(a, b, c) : builder.triangle(a, c, b);
  const angleAt = (loop: { angles: number[] }, i: number): number =>
    i < loop.angles.length ? loop.angles[i]! : loop.angles[0]! + turn;
  let i = 0;
  let j = 0;
  while (i < o.points.length || j < n.points.length) {
    const nextOuter = i < o.points.length ? angleAt(o, i + 1) : Infinity;
    const nextInner = j < n.points.length ? angleAt(n, j + 1) : Infinity;
    if (nextOuter <= nextInner) {
      emit(id(o.points, i), id(o.points, i + 1), id(n.points, j));
      i++;
    } else {
      emit(id(o.points, i), id(n.points, j + 1), id(n.points, j));
      j++;
    }
  }
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
export function ringMesh(
  outer: ReadonlyArray<Point2>,
  inner: ReadonlyArray<Point2>,
  depth: number,
): MeshData {
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
export function addWalls(
  builder: MeshBuilder,
  ring: ReadonlyArray<Point2>,
  z0: number,
  z1: number,
  outward: boolean,
): void {
  addLoftWalls(builder, ring, z0, ring, z1, outward);
}

/** `outer` (CCW) minus `holes` (CCW each) extruded from z = 0 to `depth`; closed and watertight. */
export function prismMesh(
  outer: ReadonlyArray<Point2>,
  holes: ReadonlyArray<ReadonlyArray<Point2>>,
  depth: number,
): MeshData {
  const builder = createMeshBuilder();
  addCap(builder, outer, holes, 0, false);
  addCap(builder, outer, holes, depth, true);
  addWalls(builder, outer, 0, depth, true);
  for (const hole of holes) addWalls(builder, hole, 0, depth, false);
  return builder.build();
}

/** World-space copy of a local mesh: rotated (extrinsic XYZ) about the origin, then moved to `position`. */
export function placeMesh(mesh: MeshData, position: Vec3, rotation: Vec3): MeshData {
  const origin: Vec3 = [0, 0, 0];
  const positions: number[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const rotated = applyEulerXYZ(
      [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!],
      origin,
      rotation,
    );
    positions.push(rotated[0] + position[0], rotated[1] + position[1], rotated[2] + position[2]);
  }
  return { positions, indices: [...mesh.indices] };
}
