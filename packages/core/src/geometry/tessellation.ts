/**
 * Tessellation constants and low-level pure geometry helpers shared by the SVG renderer
 * (`renderTessellation.ts`) and the triangle exporters (`exportTriangulate.ts`), so both
 * segment and wind every primitive the same way.
 *
 * @layer core/commands
 * @pure all exports are side-effect-free pure functions
 */

import type { Vec3 } from '../model/types';
import { cross3, normalize3, sub3 } from '../lib/vec3';
import { signedArea } from '../lib/polygon';
import { triangulatePolygon } from '../lib/triangulate';

/** Segments used for circular cross-sections (cylinder, cone, torus ring). */
export const SEG_CIRCLE = 24;

/** Latitude bands for sphere tessellation. */
export const SEG_SPHERE_LAT = 12;

/** Longitude slices for sphere tessellation. */
export const SEG_SPHERE_LON = 16;

/** Tube cross-section segments for torus tessellation. */
export const SEG_TORUS_TUBE = 12;

/**
 * Generate `segs` equally-spaced vertices on a circle in the XY plane at height `cz` (Z-up).
 *
 * The first vertex is at angle 0 (positive-X direction).
 * Points are in counter-clockwise order when viewed from above.
 *
 * @pure
 * @param cx - X coordinate of the circle centre
 * @param cy - Y coordinate of the circle centre
 * @param cz - Z coordinate (height) of the circle plane
 * @param r  - Circle radius
 * @param segs - Number of vertices (== number of segments)
 */
export function circlePoints(cx: number, cy: number, cz: number, r: number, segs: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), cz]);
  }
  return pts;
}

/** Unit facet normal of triangle `v0 v1 v2` (right-hand rule: counter-clockwise ⇒ outward). */
export function facetNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  return normalize3(cross3(sub3(v1, v0), sub3(v2, v0)));
}

/** Consecutive vertex pairs `[ring[i], ring[i + 1]]` around a closed ring (the last wraps to the first). */
export function ringEdges(ring: readonly Vec3[]): Array<[Vec3, Vec3]> {
  return ring.map((vertex, i) => [vertex, ring[(i + 1) % ring.length] as Vec3]);
}

/** Side wall between two equal-length rings: one quad `[bottom[i], bottom[j], top[j], top[i]]` per edge (j = i + 1, wrapping). */
export function sideQuads(
  bottom: readonly Vec3[],
  top: readonly Vec3[],
): Array<[Vec3, Vec3, Vec3, Vec3]> {
  return bottom.map((_, i) => {
    const j = (i + 1) % bottom.length;
    return [bottom[i] as Vec3, bottom[j] as Vec3, top[j] as Vec3, top[i] as Vec3];
  });
}

/**
 * Triangulation of a simple (non-self-intersecting) 2D polygon, convex or not (`lib/triangulate`).
 *
 * Returns [ia, ib, ic] index triplets into `pts`; every triangle is counter-clockwise (CCW,
 * normal +Z) regardless of the input winding.
 *
 * @pure
 * @param pts - 2D polygon vertices in order; the polygon is treated as closed.
 */
export function earClipTriangulate(
  pts: ReadonlyArray<readonly [number, number]>,
): Array<[number, number, number]> {
  const n = pts.length;
  if (n < 3) return [];
  const clockwise = signedArea(pts) < 0;
  const ordered = clockwise ? [...pts].reverse() : pts;
  const original = (index: number): number => (clockwise ? n - 1 - index : index);
  return triangulatePolygon(ordered).triangles.map(([a, b, c]) => [
    original(a),
    original(b),
    original(c),
  ]);
}

/**
 * Triangles of a mesh entity's data. Kernel output is indexed (shared vertices); an empty
 * `indices` means `positions` is a triangle soup (9 numbers per triangle).
 * @pure
 */
export function meshTriangles(mesh: {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}): Array<[Vec3, Vec3, Vec3]> {
  const p = mesh.positions;
  const vertex = (i: number): Vec3 => [p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0];
  const indexed = mesh.indices.length > 0;
  const cornerCount = indexed ? mesh.indices.length : Math.floor(p.length / 3);
  const corner = (n: number): number => (indexed ? (mesh.indices[n] ?? 0) : n);
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  for (let n = 0; n + 2 < cornerCount; n += 3) {
    triangles.push([vertex(corner(n)), vertex(corner(n + 1)), vertex(corner(n + 2))]);
  }
  return triangles;
}

/** Axis-aligned extents of a box centred at `position`. */
export function boxExtents(
  position: Vec3,
  size: Vec3,
): { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } {
  const [px, py, pz] = position;
  const [w, h, d] = size;
  return {
    x0: px - w / 2,
    x1: px + w / 2,
    y0: py - h / 2,
    y1: py + h / 2,
    z0: pz - d / 2,
    z1: pz + d / 2,
  };
}

/** The six corners of a wedge whose lower-front-left corner is at `position` (size = [w, h, d]). */
export function wedgeCorners(
  position: Vec3,
  size: Vec3,
): { f00: Vec3; f10: Vec3; f11: Vec3; f01: Vec3; b00: Vec3; b10: Vec3 } {
  const [px, py, pz] = position;
  const [w, h, d] = size;
  const p = (dx: number, dy: number, dz: number): Vec3 => [px + dx, py + dy, pz + dz];
  return {
    f00: p(0, 0, 0),
    f10: p(w, 0, 0),
    f11: p(w, h, 0),
    f01: p(0, h, 0),
    b00: p(0, 0, d),
    b10: p(w, 0, d),
  };
}

/** Base corners (`bXY`, X/Y = low/high) and apex of a pyramid whose base centre is `position`. */
export function pyramidCorners(e: {
  position: Vec3;
  baseWidth: number;
  baseDepth: number;
  height: number;
}): { b00: Vec3; b10: Vec3; b11: Vec3; b01: Vec3; apex: Vec3 } {
  const [px, py, pz] = e.position;
  const hw = e.baseWidth / 2,
    hd = e.baseDepth / 2;
  return {
    b00: [px - hw, py - hd, pz],
    b10: [px + hw, py - hd, pz],
    b11: [px + hw, py + hd, pz],
    b01: [px - hw, py + hd, pz],
    apex: [px, py, pz + e.height],
  };
}

/**
 * Bottom (z = position.z) and top (z + depth) vertex rings of an extruded profile, both
 * counter-clockwise seen from +Z (a clockwise profile is reversed) so side quads face outward.
 */
export function extrusionRings(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
}): { bottom: Vec3[]; top: Vec3[] } {
  const [px, py, pz] = e.position;
  const profile = signedArea(e.profile) < 0 ? [...e.profile].reverse() : e.profile;
  return {
    bottom: profile.map(([x, y]): Vec3 => [px + x, py + y, pz]),
    top: profile.map(([x, y]): Vec3 => [px + x, py + y, pz + e.depth]),
  };
}

/** One quad per lat/lon cell of a sphere, as [v00, v01, v11, v10] (lat-major, lon-minor). */
export function sphereQuads(position: Vec3, radius: number): Array<[Vec3, Vec3, Vec3, Vec3]> {
  const [px, py, pz] = position;
  const quads: Array<[Vec3, Vec3, Vec3, Vec3]> = [];
  const at = (lat: number, lon: number): Vec3 => {
    const a = (Math.PI * lat) / SEG_SPHERE_LAT - Math.PI / 2;
    const b = (2 * Math.PI * lon) / SEG_SPHERE_LON;
    return [
      px + radius * Math.cos(a) * Math.cos(b),
      py + radius * Math.cos(a) * Math.sin(b),
      pz + radius * Math.sin(a),
    ];
  };
  for (let lat = 0; lat < SEG_SPHERE_LAT; lat++) {
    for (let lon = 0; lon < SEG_SPHERE_LON; lon++) {
      quads.push([at(lat, lon), at(lat, lon + 1), at(lat + 1, lon + 1), at(lat + 1, lon)]);
    }
  }
  return quads;
}

/** One quad per ring/tube cell of a torus (ring in XY, tube in Z), as [v00, v10, v11, v01]. */
export function torusQuads(
  position: Vec3,
  ringRadius: number,
  tubeRadius: number,
): Array<[Vec3, Vec3, Vec3, Vec3]> {
  const [px, py, pz] = position;
  const quads: Array<[Vec3, Vec3, Vec3, Vec3]> = [];
  const at = (ring: number, tube: number): Vec3 => {
    const a = (2 * Math.PI * ring) / SEG_CIRCLE;
    const b = (2 * Math.PI * tube) / SEG_TORUS_TUBE;
    const radial = ringRadius + tubeRadius * Math.cos(b);
    return [px + radial * Math.cos(a), py + radial * Math.sin(a), pz + tubeRadius * Math.sin(b)];
  };
  for (let i = 0; i < SEG_CIRCLE; i++) {
    for (let j = 0; j < SEG_TORUS_TUBE; j++) {
      quads.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
    }
  }
  return quads;
}
