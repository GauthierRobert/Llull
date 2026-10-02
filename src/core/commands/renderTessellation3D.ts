import type { Vec3 } from '../model/types';
import { revolutionPolygons } from '../geometry/revolution';
import {
  SEG_CIRCLE,
  SEG_SPHERE_LAT,
  SEG_SPHERE_LON,
  SEG_TORUS_TUBE,
  circlePoints as _circlePoints,
  meshTriangles,
} from './tessellation';
import { type PreDepthPolygon } from './renderTypes';
import { sub3, cross3, normalize3 } from './renderMath';

// ---------------------------------------------------------------------------
// Tessellation helpers
// ---------------------------------------------------------------------------

// SEG_CIRCLE, SEG_SPHERE_LAT, SEG_SPHERE_LON, SEG_TORUS_TUBE imported from tessellation.ts

/** Points on a circle in the XY plane at height `cz` (Z-up). Delegates to shared tessellation helper. */
export function circlePoints(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  segments: number,
): Vec3[] {
  return _circlePoints(cx, cy, cz, r, segments);
}

/** Compute outward face normal for a polygon (using the first 3 verts). */
export function faceNormal(verts: Vec3[]): Vec3 {
  if (verts.length < 3) return [0, 0, 1];
  const a = sub3(verts[1]!, verts[0]!);
  const b = sub3(verts[2]!, verts[0]!);
  return normalize3(cross3(a, b));
}

export function makePolygon(verts: Vec3[], color: string, stroke = false): PreDepthPolygon {
  const normal = faceNormal(verts);
  return { verts, color, normal, stroke };
}

// ---------------------------------------------------------------------------
// Per-kind tessellation (Z-up document space)
// ---------------------------------------------------------------------------

export function tessellateBox(e: { position: Vec3; size: Vec3; color: string }): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const x0 = px - w / 2,
    x1 = px + w / 2;
  const y0 = py - h / 2,
    y1 = py + h / 2;
  const z0 = pz - d / 2,
    z1 = pz + d / 2;
  const c = e.color;
  // 6 quads (CCW when viewed from outside, Z-up)
  return [
    // bottom (-Z)
    makePolygon(
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      c,
    ),
    // top (+Z)
    makePolygon(
      [
        [x0, y0, z1],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      c,
    ),
    // front (-Y)
    makePolygon(
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y0, z0],
      ],
      c,
    ),
    // back (+Y)
    makePolygon(
      [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      c,
    ),
    // left (-X)
    makePolygon(
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x0, y1, z1],
        [x0, y0, z1],
      ],
      c,
    ),
    // right (+X)
    makePolygon(
      [
        [x1, y0, z0],
        [x1, y0, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      c,
    ),
  ];
}

/** Z-up cylinder: axis along Z, centered at position. */
export function tessellateCylinder(e: {
  position: Vec3;
  radius: number;
  height: number;
  color: string;
}): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const { radius, height, color } = e;
  const zb = pz - height / 2;
  const zt = pz + height / 2;
  const bottom = circlePoints(px, py, zb, radius, SEG_CIRCLE);
  const top = circlePoints(px, py, zt, radius, SEG_CIRCLE);
  const polys: PreDepthPolygon[] = [];

  // Bottom cap
  polys.push(makePolygon([...bottom].reverse(), color));
  // Top cap
  polys.push(makePolygon([...top], color));
  // Side quads
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    polys.push(makePolygon([bottom[i]!, bottom[j]!, top[j]!, top[i]!], color));
  }
  return polys;
}

export function tessellateSphere(e: {
  position: Vec3;
  radius: number;
  color: string;
}): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const { radius, color } = e;
  const polys: PreDepthPolygon[] = [];

  for (let lat = 0; lat < SEG_SPHERE_LAT; lat++) {
    const a0 = (Math.PI * lat) / SEG_SPHERE_LAT - Math.PI / 2;
    const a1 = (Math.PI * (lat + 1)) / SEG_SPHERE_LAT - Math.PI / 2;
    for (let lon = 0; lon < SEG_SPHERE_LON; lon++) {
      const b0 = (2 * Math.PI * lon) / SEG_SPHERE_LON;
      const b1 = (2 * Math.PI * (lon + 1)) / SEG_SPHERE_LON;
      const v00: Vec3 = [
        px + radius * Math.cos(a0) * Math.cos(b0),
        py + radius * Math.cos(a0) * Math.sin(b0),
        pz + radius * Math.sin(a0),
      ];
      const v01: Vec3 = [
        px + radius * Math.cos(a0) * Math.cos(b1),
        py + radius * Math.cos(a0) * Math.sin(b1),
        pz + radius * Math.sin(a0),
      ];
      const v10: Vec3 = [
        px + radius * Math.cos(a1) * Math.cos(b0),
        py + radius * Math.cos(a1) * Math.sin(b0),
        pz + radius * Math.sin(a1),
      ];
      const v11: Vec3 = [
        px + radius * Math.cos(a1) * Math.cos(b1),
        py + radius * Math.cos(a1) * Math.sin(b1),
        pz + radius * Math.sin(a1),
      ];
      polys.push(makePolygon([v00, v01, v11, v10], color));
    }
  }
  return polys;
}

/** Z-up cone: base circle in XY at position, apex at position+[0,0,height]. */
export function tessellateCone(e: {
  position: Vec3;
  radius: number;
  height: number;
  color: string;
}): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const { radius, height, color } = e;
  const base = circlePoints(px, py, pz, radius, SEG_CIRCLE);
  const apex: Vec3 = [px, py, pz + height];
  const polys: PreDepthPolygon[] = [];

  // Base cap (reversed winding = face down)
  polys.push(makePolygon([...base].reverse(), color));
  // Side triangles
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    polys.push(makePolygon([base[i]!, base[j]!, apex], color));
  }
  return polys;
}

/** Torus: ring in XY plane, tube extends ±tubeRadius in Z. */
export function tessellateTorus(e: {
  position: Vec3;
  ringRadius: number;
  tubeRadius: number;
  color: string;
}): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const { ringRadius, tubeRadius, color } = e;
  const RING_SEGS = SEG_CIRCLE;
  const TUBE_SEGS = SEG_TORUS_TUBE;
  const polys: PreDepthPolygon[] = [];

  for (let i = 0; i < RING_SEGS; i++) {
    const a0 = (2 * Math.PI * i) / RING_SEGS;
    const a1 = (2 * Math.PI * (i + 1)) / RING_SEGS;
    const ca0 = Math.cos(a0),
      sa0 = Math.sin(a0);
    const ca1 = Math.cos(a1),
      sa1 = Math.sin(a1);
    for (let j = 0; j < TUBE_SEGS; j++) {
      const b0 = (2 * Math.PI * j) / TUBE_SEGS;
      const b1 = (2 * Math.PI * (j + 1)) / TUBE_SEGS;
      // tube cross-section: radial direction in XY + Z
      const cb0 = Math.cos(b0),
        sb0 = Math.sin(b0);
      const cb1 = Math.cos(b1),
        sb1 = Math.sin(b1);

      const v00: Vec3 = [
        px + (ringRadius + tubeRadius * cb0) * ca0,
        py + (ringRadius + tubeRadius * cb0) * sa0,
        pz + tubeRadius * sb0,
      ];
      const v01: Vec3 = [
        px + (ringRadius + tubeRadius * cb1) * ca0,
        py + (ringRadius + tubeRadius * cb1) * sa0,
        pz + tubeRadius * sb1,
      ];
      const v10: Vec3 = [
        px + (ringRadius + tubeRadius * cb0) * ca1,
        py + (ringRadius + tubeRadius * cb0) * sa1,
        pz + tubeRadius * sb0,
      ];
      const v11: Vec3 = [
        px + (ringRadius + tubeRadius * cb1) * ca1,
        py + (ringRadius + tubeRadius * cb1) * sa1,
        pz + tubeRadius * sb1,
      ];
      polys.push(makePolygon([v00, v10, v11, v01], color));
    }
  }
  return polys;
}

/**
 * Wedge: lower-front-left corner at position.
 * Vertices (Z-up): front face has 4 corners; back face tapers to 2 (bottom edge only).
 * size=[w,h,d]:
 *   front (z=0): (0,0,0),(w,0,0),(w,h,0),(0,h,0)
 *   back  (z=d): (0,0,d),(w,0,d) — height is 0 at back
 */
export function tessellateWedge(e: {
  position: Vec3;
  size: Vec3;
  color: string;
}): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const p = (dx: number, dy: number, dz: number): Vec3 => [px + dx, py + dy, pz + dz];
  // 8 possible corners but top-back edge collapses:
  const f00 = p(0, 0, 0);
  const f10 = p(w, 0, 0);
  const f11 = p(w, h, 0);
  const f01 = p(0, h, 0);
  const b00 = p(0, 0, d);
  const b10 = p(w, 0, d);
  // back top = same as back bottom (wedge tapers to zero height at z=d)
  return [
    // front face
    makePolygon([f00, f10, f11, f01], e.color),
    // bottom face
    makePolygon([f00, b00, b10, f10], e.color),
    // back edge (degenerate line — skip; back is just the 2 bottom verts)
    // left triangle
    makePolygon([f00, f01, b00], e.color),
    // right triangle
    makePolygon([f10, b10, f11], e.color),
    // top slope (ramp)
    makePolygon([f01, f11, b10, b00], e.color),
  ];
}

/**
 * Pyramid: rectangular base centered at position in XY, apex at position+[0,0,height].
 */
export function tessellatePyramid(e: {
  position: Vec3;
  baseWidth: number;
  baseDepth: number;
  height: number;
  color: string;
}): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const hw = e.baseWidth / 2,
    hd = e.baseDepth / 2;
  const b00: Vec3 = [px - hw, py - hd, pz];
  const b10: Vec3 = [px + hw, py - hd, pz];
  const b11: Vec3 = [px + hw, py + hd, pz];
  const b01: Vec3 = [px - hw, py + hd, pz];
  const apex: Vec3 = [px, py, pz + e.height];
  return [
    // base (CCW looking down = face down)
    makePolygon([b00, b01, b11, b10], e.color),
    // 4 triangular faces
    makePolygon([b00, b10, apex], e.color),
    makePolygon([b10, b11, apex], e.color),
    makePolygon([b11, b01, apex], e.color),
    makePolygon([b01, b00, apex], e.color),
  ];
}

/**
 * Revolution: closed 2D profile swept around an axis by `angle` radians.
 *
 * The profile points are [radialOffset, axialOffset]. We build a ring of
 * profile copies spaced `segments` times around the axis and stitch them
 * into quads. Caps are added when `angle < 2π` (open sweep).
 *
 * Coordinate convention (Z-up):
 *   - Y-axis revolution: radial→X, axial→Y  (three.js LatheGeometry native)
 *   - Z-axis revolution: radial→X, axial→Z  (default/natural for Z-up)
 *   - X-axis revolution: radial→Y, axial→X
 */
export function tessellateRevolution(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  axis: Vec3;
  angle: number;
  segments: number;
  color: string;
}): PreDepthPolygon[] {
  return revolutionPolygons(e.profile, e.axis, e.angle, e.segments, e.position).map((vertices) =>
    makePolygon(vertices, e.color),
  );
}

/** Extrusion: closed XY profile at position, extruded +Z by depth. */
export function tessellateExtrusion(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
  color: string;
}): PreDepthPolygon[] {
  if (e.profile.length < 3) return [];
  const [px, py, pz] = e.position;
  const n = e.profile.length;
  const bottom: Vec3[] = e.profile.map(([x, y]) => [px + x, py + y, pz]);
  const top: Vec3[] = e.profile.map(([x, y]) => [px + x, py + y, pz + e.depth]);
  const polys: PreDepthPolygon[] = [];

  // Bottom cap (reversed for outward-facing normal)
  polys.push(makePolygon([...bottom].reverse(), e.color));
  // Top cap
  polys.push(makePolygon([...top], e.color));
  // Side quads
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    polys.push(makePolygon([bottom[i]!, bottom[j]!, top[j]!, top[i]!], e.color));
  }
  return polys;
}

/** Mesh solid: world-space triangles — indexed (kernel output) or a soup when indices is empty. */
export function tessellateMesh(e: {
  position: Vec3;
  mesh: { positions: readonly number[]; indices: readonly number[] };
  color: string;
}): PreDepthPolygon[] {
  return meshTriangles(e.mesh).map((triangle) => makePolygon(triangle, e.color));
}
