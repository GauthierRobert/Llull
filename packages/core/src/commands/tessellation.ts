/**
 * Shared tessellation constants and low-level pure geometry helpers.
 *
 * Both `render.ts` (SVG painter) and `export.ts` (STL/triangle-mesh) use the same
 * segmentation constants and `circlePoints` helper. Centralising them here ensures
 * both callers stay in sync and removes the duplicated definitions.
 *
 * @layer core/commands
 * @pure all exports are side-effect-free pure functions
 */

import type { Vec3 } from '../model/types';

// ---------------------------------------------------------------------------
// Segmentation constants (shared between render.ts and export.ts)
// ---------------------------------------------------------------------------

/** Segments used for circular cross-sections (cylinder, cone, torus ring). */
export const SEG_CIRCLE = 24;

/** Latitude bands for sphere tessellation. */
export const SEG_SPHERE_LAT = 12;

/** Longitude slices for sphere tessellation. */
export const SEG_SPHERE_LON = 16;

/** Tube cross-section segments for torus tessellation. */
export const SEG_TORUS_TUBE = 12;

// ---------------------------------------------------------------------------
// circlePoints
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// earClipTriangulate
// ---------------------------------------------------------------------------

/**
 * Ear-clipping triangulation for a simple (non-self-intersecting) 2D polygon.
 *
 * Handles both convex and non-convex polygons correctly. `fanTriangulate` is only
 * correct for strictly convex polygons; this function handles the general case
 * needed for arbitrary extrusion profiles (gear teeth, star shapes, etc.).
 *
 * Returns an array of [ia, ib, ic] index triplets into the original `pts` array.
 * The returned triangles have the same winding as the input polygon (CCW → CCW).
 *
 * @pure
 * @param pts - 2D polygon vertices in order. The polygon is treated as closed.
 *              Must have >= 3 distinct points. No duplicate consecutive vertices.
 * @returns Array of triangle index triplets.
 */
export function earClipTriangulate(
  pts: ReadonlyArray<readonly [number, number]>,
): Array<[number, number, number]> {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  // Work with a mutable index list so we can remove ear tips without copying points.
  const indices = Array.from({ length: n }, (_, i) => i);
  const result: Array<[number, number, number]> = [];

  /** Cross product of 2D vectors (a→b) and (a→c); positive = CCW. */
  function cross2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  /** Is point P strictly inside triangle (A, B, C)? */
  function pointInTriangle(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): boolean {
    const d1 = cross2(ax, ay, bx, by, px, py);
    const d2 = cross2(bx, by, cx, cy, px, py);
    const d3 = cross2(cx, cy, ax, ay, px, py);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  /** True if the i-th vertex of the current `indices` list is a convex ear. */
  function isEar(i: number): boolean {
    const len = indices.length;
    const prev = indices[(i - 1 + len) % len]!;
    const curr = indices[i]!;
    const next = indices[(i + 1) % len]!;
    const [ax, ay] = pts[prev]!;
    const [bx, by] = pts[curr]!;
    const [cx, cy] = pts[next]!;

    // Must be a convex vertex (CCW winding assumed).
    if (cross2(ax, ay, bx, by, cx, cy) <= 0) return false;

    // No other polygon vertex may lie strictly inside this triangle.
    for (let j = 0; j < len; j++) {
      const ji = indices[j]!;
      if (ji === prev || ji === curr || ji === next) continue;
      const [px, py] = pts[ji]!;
      if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) return false;
    }
    return true;
  }

  // Ensure CCW winding (shoelace sign).
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % n]!;
    area2 += ax * by - bx * ay;
  }
  if (area2 < 0) {
    // CW polygon — reverse so all isEar tests use CCW convention.
    indices.reverse();
  }

  // Ear-clipping loop: remove ears one by one until a triangle remains.
  let attempts = 0;
  const maxAttempts = indices.length * indices.length + 4;
  let i = 0;
  while (indices.length > 3 && attempts < maxAttempts) {
    if (isEar(i % indices.length)) {
      const len = indices.length;
      const prev = indices[(i - 1 + len) % len]!;
      const curr = indices[i % len]!;
      const next = indices[(i + 1) % len]!;
      result.push([prev, curr, next]);
      indices.splice(i % len, 1);
      // Don't advance i — the previous index now points to the next vertex.
      attempts = 0;
    } else {
      i++;
      attempts++;
    }
  }

  if (indices.length === 3) {
    result.push([indices[0]!, indices[1]!, indices[2]!]);
  }

  return result;
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

/** Bottom (z = position.z) and top (z + depth) vertex rings of an extruded profile. */
export function extrusionRings(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
}): { bottom: Vec3[]; top: Vec3[] } {
  const [px, py, pz] = e.position;
  return {
    bottom: e.profile.map(([x, y]): Vec3 => [px + x, py + y, pz]),
    top: e.profile.map(([x, y]): Vec3 => [px + x, py + y, pz + e.depth]),
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
