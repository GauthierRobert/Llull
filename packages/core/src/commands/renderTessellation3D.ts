import type { Vec3 } from '../model/types';
import { revolutionPolygons } from '../geometry/revolution';
import {
  SEG_CIRCLE,
  boxExtents,
  circlePoints,
  extrusionRings,
  meshTriangles,
  pyramidCorners,
  sphereQuads,
  torusQuads,
  wedgeCorners,
} from './tessellation';
import { type PreDepthPolygon } from './renderTypes';
import { sub3, cross3, normalize3 } from '../lib/vec3';

/** Compute outward face normal for a polygon (using the first 3 verts). */
function faceNormal(verts: Vec3[]): Vec3 {
  if (verts.length < 3) return [0, 0, 1];
  const a = sub3(verts[1]!, verts[0]!);
  const b = sub3(verts[2]!, verts[0]!);
  return normalize3(cross3(a, b));
}

function makePolygon(verts: Vec3[], color: string, stroke = false): PreDepthPolygon {
  const normal = faceNormal(verts);
  return { verts, color, normal, stroke };
}

export function tessellateBox(e: { position: Vec3; size: Vec3; color: string }): PreDepthPolygon[] {
  const { x0, x1, y0, y1, z0, z1 } = boxExtents(e.position, e.size);
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
  return sphereQuads(e.position, e.radius).map((quad) => makePolygon(quad, e.color));
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
  return torusQuads(e.position, e.ringRadius, e.tubeRadius).map((quad) =>
    makePolygon(quad, e.color),
  );
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
  const { f00, f10, f11, f01, b00, b10 } = wedgeCorners(e.position, e.size);
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
  const { b00, b10, b11, b01, apex } = pyramidCorners(e);
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
  const n = e.profile.length;
  const { bottom, top } = extrusionRings(e);
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
