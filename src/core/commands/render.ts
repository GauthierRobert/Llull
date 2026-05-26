/**
 * render_view — pure SVG renderer for the "AI vision loop".
 *
 * Renders the document to a self-contained SVG string using pure math and string
 * building. No three.js, no DOM, no React. The document coordinate convention is
 * Z-up throughout: +X right, +Y forward, +Z up. This matches the model/types.ts
 * entity contracts (box, cone, pyramid, wedge, extrusion are all Z-up).
 *
 * NOTE on cylinder: scene.ts entityBounds uses Y-axis (three.js CylinderGeometry
 * convention). The tessellation here uses Z-axis (Z-up, matching the model). The
 * bounds used for framing come from computeSceneSnapshot which uses scene.ts
 * entityBounds — the slight inconsistency only affects framing; rendering is
 * Z-up throughout.
 *
 * @command render_view
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a complete <svg> document; document === input doc
 * @failure invalid params are clamped; empty doc returns a valid empty SVG
 */

import type { CadDocument, Entity, Vec3, Vec2 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { computeSceneSnapshot } from './scene';
import type { Bounds } from './scene';

// ---------------------------------------------------------------------------
// Public result type — a second agent depends on these field names exactly.
// ---------------------------------------------------------------------------

export interface RenderViewData {
  /** The resolved view name ('top'|'bottom'|'front'|'back'|'left'|'right'|'iso'). */
  view: string;
  /** Width of the rendered image in pixels. */
  width: number;
  /** Height of the rendered image in pixels. */
  height: number;
  /** Number of entities in the document at render time. */
  entityCount: number;
  /** World-space AABB of all entities, or null when the document is empty. */
  bounds: Bounds | null;
  /** Camera position, target, and up vector used for the render. */
  camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number] };
  /** Complete, self-contained SVG document string. */
  svg: string;
}

// ---------------------------------------------------------------------------
// Types used during rendering (internal only)
// ---------------------------------------------------------------------------

/** Polygon before depth is computed (all tessellation helpers return this). */
interface PreDepthPolygon {
  verts: Vec3[];
  /** CSS color string for this face. */
  color: string;
  /** Pre-computed world-space face normal (unit). */
  normal: Vec3;
  /** True when this is a 2D stroke path rather than a filled polygon. */
  stroke: boolean;
}

/** A flat polygon of world-space 3D points, with associated color, normal, and camera depth. */
interface Polygon3D extends PreDepthPolygon {
  /** Camera-space depth of centroid (for painter's sort). */
  depth: number;
}

// ---------------------------------------------------------------------------
// Math helpers (pure, no dependencies on any external library)
// ---------------------------------------------------------------------------

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-10 ? scale3(a, 1 / l) : [0, 0, 1];
}

function centroid3(verts: Vec3[]): Vec3 {
  if (verts.length === 0) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const v of verts) { x += v[0]; y += v[1]; z += v[2]; }
  const n = verts.length;
  return [x / n, y / n, z / n];
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Camera / view
// ---------------------------------------------------------------------------

type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';
const VALID_VIEWS: ReadonlySet<string> = new Set<ViewName>(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso']);

/** Camera described in world space (all Z-up). */
interface Camera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** Orthographic half-extents; if null, derive from scene bounds. */
  ortho: number | null;
}

/** Build an orthographic camera for a named view at a given scene radius. */
function cameraForView(view: ViewName, center: Vec3, radius: number): Camera {
  const d = radius * 2.5;
  const [cx, cy, cz] = center;
  const target: [number, number, number] = [cx, cy, cz];

  switch (view) {
    case 'top':
      return { position: [cx, cy, cz + d], target, up: [0, 1, 0], ortho: radius };
    case 'bottom':
      return { position: [cx, cy, cz - d], target, up: [0, 1, 0], ortho: radius };
    case 'front':
      return { position: [cx, cy - d, cz], target, up: [0, 0, 1], ortho: radius };
    case 'back':
      return { position: [cx, cy + d, cz], target, up: [0, 0, 1], ortho: radius };
    case 'left':
      return { position: [cx - d, cy, cz], target, up: [0, 0, 1], ortho: radius };
    case 'right':
      return { position: [cx + d, cy, cz], target, up: [0, 0, 1], ortho: radius };
    case 'iso': {
      // Fixed isometric direction: roughly from (+1, -1.4, +1) relative to center.
      const iso = normalize3([1, -1.4, 1]);
      const pos: [number, number, number] = [cx + iso[0] * d, cy + iso[1] * d, cz + iso[2] * d];
      return { position: pos, target, up: [0, 0, 1], ortho: radius };
    }
  }
}

// ---------------------------------------------------------------------------
// Projection (orthographic)
// ---------------------------------------------------------------------------

/** Build a right-hand orthographic camera basis (forward, right, up vectors). */
function cameraBasis(cam: Camera): { fwd: Vec3; right: Vec3; up: Vec3 } {
  const fwd = normalize3(sub3(cam.target, cam.position));
  const right = normalize3(cross3(fwd, cam.up));
  const up = normalize3(cross3(right, fwd));
  return { fwd, right, up };
}

/** Project a world-space point to camera space [u, v, depth]. */
function projectPoint(
  p: Vec3,
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
): [number, number, number] {
  const d = sub3(p, cam.position);
  const u = dot3(d, basis.right);
  const v = dot3(d, basis.up);
  const depth = dot3(d, basis.fwd);
  return [u, v, depth];
}

/** Map camera [u,v] to SVG pixel coords with scaling to fit width×height. */
function toScreenCoords(
  u: number,
  v: number,
  orthoHalf: number,
  width: number,
  height: number,
): [number, number] {
  const margin = 0.9; // 90 % of canvas used
  const scaleX = (width / 2) * margin / orthoHalf;
  const scaleY = (height / 2) * margin / orthoHalf;
  const scale = Math.min(scaleX, scaleY);
  const sx = width / 2 + u * scale;
  const sy = height / 2 - v * scale; // flip Y (SVG Y grows down)
  return [sx, sy];
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

/** Fixed directional light direction in world space (Z-up). */
const LIGHT_DIR: Vec3 = normalize3([0.6, -0.8, 1.0]);
const AMBIENT = 0.35;

function shade(normal: Vec3, baseColor: string): string {
  const diff = Math.max(0, dot3(normal, LIGHT_DIR));
  const factor = AMBIENT + (1 - AMBIENT) * diff;
  return tintHex(baseColor, factor);
}

/** Shade a back-face (face pointing away from light) darker. */
function tintHex(hex: string, factor: number): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const ri = Math.min(255, Math.round(r * factor));
  const gi = Math.min(255, Math.round(g * factor));
  const bi = Math.min(255, Math.round(b * factor));
  return `rgb(${ri},${gi},${bi})`;
}

// ---------------------------------------------------------------------------
// Tessellation helpers
// ---------------------------------------------------------------------------

const SEG_CIRCLE = 24; // segments for circles/cylinders/cones/torus
const SEG_SPHERE_LAT = 12;
const SEG_SPHERE_LON = 16;
const SEG_TORUS_TUBE = 12;

/** Points on a circle in the XY plane at height `cz` (Z-up). */
function circlePoints(cx: number, cy: number, cz: number, r: number, segments: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), cz]);
  }
  return pts;
}

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

// ---------------------------------------------------------------------------
// Per-kind tessellation (Z-up document space)
// ---------------------------------------------------------------------------

function tessellateBox(e: { position: Vec3; size: Vec3; color: string }): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const x0 = px - w / 2, x1 = px + w / 2;
  const y0 = py - h / 2, y1 = py + h / 2;
  const z0 = pz - d / 2, z1 = pz + d / 2;
  const c = e.color;
  // 6 quads (CCW when viewed from outside, Z-up)
  return [
    // bottom (-Z)
    makePolygon([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], c),
    // top (+Z)
    makePolygon([[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]], c),
    // front (-Y)
    makePolygon([[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]], c),
    // back (+Y)
    makePolygon([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], c),
    // left (-X)
    makePolygon([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], c),
    // right (+X)
    makePolygon([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], c),
  ];
}

/** Z-up cylinder: axis along Z, centered at position. */
function tessellateCylinder(e: { position: Vec3; radius: number; height: number; color: string }): PreDepthPolygon[] {
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

function tessellateSphere(e: { position: Vec3; radius: number; color: string }): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const { radius, color } = e;
  const polys: PreDepthPolygon[] = [];

  for (let lat = 0; lat < SEG_SPHERE_LAT; lat++) {
    const a0 = (Math.PI * lat) / SEG_SPHERE_LAT - Math.PI / 2;
    const a1 = (Math.PI * (lat + 1)) / SEG_SPHERE_LAT - Math.PI / 2;
    for (let lon = 0; lon < SEG_SPHERE_LON; lon++) {
      const b0 = (2 * Math.PI * lon) / SEG_SPHERE_LON;
      const b1 = (2 * Math.PI * (lon + 1)) / SEG_SPHERE_LON;
      const v00: Vec3 = [px + radius * Math.cos(a0) * Math.cos(b0), py + radius * Math.cos(a0) * Math.sin(b0), pz + radius * Math.sin(a0)];
      const v01: Vec3 = [px + radius * Math.cos(a0) * Math.cos(b1), py + radius * Math.cos(a0) * Math.sin(b1), pz + radius * Math.sin(a0)];
      const v10: Vec3 = [px + radius * Math.cos(a1) * Math.cos(b0), py + radius * Math.cos(a1) * Math.sin(b0), pz + radius * Math.sin(a1)];
      const v11: Vec3 = [px + radius * Math.cos(a1) * Math.cos(b1), py + radius * Math.cos(a1) * Math.sin(b1), pz + radius * Math.sin(a1)];
      polys.push(makePolygon([v00, v01, v11, v10], color));
    }
  }
  return polys;
}

/** Z-up cone: base circle in XY at position, apex at position+[0,0,height]. */
function tessellateCone(e: { position: Vec3; radius: number; height: number; color: string }): PreDepthPolygon[] {
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
function tessellateTorus(e: { position: Vec3; ringRadius: number; tubeRadius: number; color: string }): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const { ringRadius, tubeRadius, color } = e;
  const RING_SEGS = SEG_CIRCLE;
  const TUBE_SEGS = SEG_TORUS_TUBE;
  const polys: PreDepthPolygon[] = [];

  for (let i = 0; i < RING_SEGS; i++) {
    const a0 = (2 * Math.PI * i) / RING_SEGS;
    const a1 = (2 * Math.PI * (i + 1)) / RING_SEGS;
    const ca0 = Math.cos(a0), sa0 = Math.sin(a0);
    const ca1 = Math.cos(a1), sa1 = Math.sin(a1);
    for (let j = 0; j < TUBE_SEGS; j++) {
      const b0 = (2 * Math.PI * j) / TUBE_SEGS;
      const b1 = (2 * Math.PI * (j + 1)) / TUBE_SEGS;
      // tube cross-section: radial direction in XY + Z
      const cb0 = Math.cos(b0), sb0 = Math.sin(b0);
      const cb1 = Math.cos(b1), sb1 = Math.sin(b1);

      const v00: Vec3 = [px + (ringRadius + tubeRadius * cb0) * ca0, py + (ringRadius + tubeRadius * cb0) * sa0, pz + tubeRadius * sb0];
      const v01: Vec3 = [px + (ringRadius + tubeRadius * cb1) * ca0, py + (ringRadius + tubeRadius * cb1) * sa0, pz + tubeRadius * sb1];
      const v10: Vec3 = [px + (ringRadius + tubeRadius * cb0) * ca1, py + (ringRadius + tubeRadius * cb0) * sa1, pz + tubeRadius * sb0];
      const v11: Vec3 = [px + (ringRadius + tubeRadius * cb1) * ca1, py + (ringRadius + tubeRadius * cb1) * sa1, pz + tubeRadius * sb1];
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
function tessellateWedge(e: { position: Vec3; size: Vec3; color: string }): PreDepthPolygon[] {
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
function tessellatePyramid(e: { position: Vec3; baseWidth: number; baseDepth: number; height: number; color: string }): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const hw = e.baseWidth / 2, hd = e.baseDepth / 2;
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

/** Extrusion: closed XY profile at position, extruded +Z by depth. */
function tessellateExtrusion(e: { position: Vec3; profile: ReadonlyArray<readonly [number, number]>; depth: number; color: string }): PreDepthPolygon[] {
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

/** Mesh solid: world-space triangle soup. Groups every 3 vertices as one triangle. */
function tessellateMesh(e: { position: Vec3; mesh: { positions: readonly number[] }; color: string }): PreDepthPolygon[] {
  const p = e.mesh.positions;
  const polys: PreDepthPolygon[] = [];
  for (let i = 0; i + 8 < p.length; i += 9) {
    const v0: Vec3 = [p[i] as number, p[i + 1] as number, p[i + 2] as number];
    const v1: Vec3 = [p[i + 3] as number, p[i + 4] as number, p[i + 5] as number];
    const v2: Vec3 = [p[i + 6] as number, p[i + 7] as number, p[i + 8] as number];
    polys.push(makePolygon([v0, v1, v2], e.color));
  }
  return polys;
}

// ---------------------------------------------------------------------------
// 2D shape tessellation — produces stroke polylines in local XY → world XY (Z=pos.z)
// ---------------------------------------------------------------------------

function place2D(localPt: Vec2, position: Vec3): Vec3 {
  return [position[0] + localPt[0], position[1] + localPt[1], position[2]];
}

function tessellate2DLine(e: { position: Vec3; start: Vec2; end: Vec2; color: string }): PreDepthPolygon[] {
  const verts: Vec3[] = [place2D(e.start, e.position), place2D(e.end, e.position)];
  return [{ verts, color: e.color, normal: [0, 0, 1], stroke: true }];
}

function tessellate2DPolyline(e: { position: Vec3; points: ReadonlyArray<Vec2>; closed: boolean; color: string }): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const verts: Vec3[] = e.points.map((pt) => place2D(pt, e.position));
  if (e.closed) verts.push(verts[0]!);
  return [{ verts, color: e.color, normal: [0, 0, 1], stroke: true }];
}

function tessellate2DArc(e: { position: Vec3; center: Vec2; radius: number; startAngle: number; endAngle: number; color: string }): PreDepthPolygon[] {
  const segs = SEG_CIRCLE;
  const { startAngle, endAngle, radius, color } = e;
  let span = endAngle - startAngle;
  if (span <= 0) span += 2 * Math.PI;
  const verts: Vec3[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = startAngle + (span * i) / segs;
    const local: Vec2 = [e.center[0] + radius * Math.cos(a), e.center[1] + radius * Math.sin(a)];
    verts.push(place2D(local, e.position));
  }
  return [{ verts, color, normal: [0, 0, 1], stroke: true }];
}

function tessellate2DCircle(e: { position: Vec3; center: Vec2; radius: number; color: string }): PreDepthPolygon[] {
  const { radius, color } = e;
  const verts: Vec3[] = [];
  for (let i = 0; i <= SEG_CIRCLE; i++) {
    const a = (2 * Math.PI * i) / SEG_CIRCLE;
    const local: Vec2 = [e.center[0] + radius * Math.cos(a), e.center[1] + radius * Math.sin(a)];
    verts.push(place2D(local, e.position));
  }
  return [{ verts, color, normal: [0, 0, 1], stroke: true }];
}

function tessellate2DRectangle(e: { position: Vec3; width: number; height: number; color: string }): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const verts: Vec3[] = [
    [px, py, pz],
    [px + e.width, py, pz],
    [px + e.width, py + e.height, pz],
    [px, py + e.height, pz],
    [px, py, pz], // close
  ];
  return [{ verts, color: e.color, normal: [0, 0, 1], stroke: true }];
}

function tessellate2DEllipse(e: { position: Vec3; center: Vec2; radiusX: number; radiusY: number; color: string }): PreDepthPolygon[] {
  const verts: Vec3[] = [];
  for (let i = 0; i <= SEG_CIRCLE; i++) {
    const a = (2 * Math.PI * i) / SEG_CIRCLE;
    const local: Vec2 = [e.center[0] + e.radiusX * Math.cos(a), e.center[1] + e.radiusY * Math.sin(a)];
    verts.push(place2D(local, e.position));
  }
  return [{ verts, color: e.color, normal: [0, 0, 1], stroke: true }];
}

/**
 * Catmull-Rom spline tessellation with centripetal parameterization.
 * The through-points ARE the control points.
 */
function tessellate2DSpline(e: { position: Vec3; points: ReadonlyArray<Vec2>; closed: boolean; color: string }): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const pts = [...e.points];
  if (e.closed) pts.push(pts[0]!); // close loop

  const STEPS = 8; // subdivisions per segment
  const verts: Vec3[] = [];

  // Catmull-Rom: for each interior segment use 4-point stencil
  const extended = [pts[0]!, ...pts, pts[pts.length - 1]!];
  for (let i = 1; i < extended.length - 2; i++) {
    const p0 = extended[i - 1]!;
    const p1 = extended[i]!;
    const p2 = extended[i + 1]!;
    const p3 = extended[i + 2]!;
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      if (s === 0 && verts.length > 0) continue; // avoid duplicating junction
      verts.push(place2D([x, y], e.position));
    }
  }
  return [{ verts, color: e.color, normal: [0, 0, 1], stroke: true }];
}

function tessellate2DPoint(e: { position: Vec3; color: string }): PreDepthPolygon[] {
  // Render as a tiny cross (4 short line segments)
  const [px, py, pz] = e.position;
  const s = 0.1; // small cross arm
  return [
    { verts: [[px - s, py, pz], [px + s, py, pz]], color: e.color, normal: [0, 0, 1], stroke: true },
    { verts: [[px, py - s, pz], [px, py + s, pz]], color: e.color, normal: [0, 0, 1], stroke: true },
  ];
}

// ---------------------------------------------------------------------------
// Dispatch tessellation by entity kind
// ---------------------------------------------------------------------------

function tessellateEntity(e: Entity): PreDepthPolygon[] {
  switch (e.kind) {
    case 'box':      return tessellateBox(e);
    case 'cylinder': return tessellateCylinder(e);
    case 'sphere':   return tessellateSphere(e);
    case 'cone':     return tessellateCone(e);
    case 'torus':    return tessellateTorus(e);
    case 'wedge':    return tessellateWedge(e);
    case 'pyramid':  return tessellatePyramid(e);
    case 'extrusion':return tessellateExtrusion(e);
    case 'mesh':     return tessellateMesh(e);
    case 'line':     return tessellate2DLine(e);
    case 'polyline': return tessellate2DPolyline(e);
    case 'arc':      return tessellate2DArc(e);
    case 'circle':   return tessellate2DCircle(e);
    case 'rectangle':return tessellate2DRectangle(e);
    case 'point':    return tessellate2DPoint(e);
    case 'ellipse':  return tessellate2DEllipse(e);
    case 'spline':   return tessellate2DSpline(e);
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// SVG composition
// ---------------------------------------------------------------------------

const MAX_POLYGONS = 4000;

/** Build the complete SVG string. */
function buildSvg(
  polygons: Polygon3D[],
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
  orthoHalf: number,
  width: number,
  height: number,
  viewName: string,
  entityCount: number,
): string {
  // Sort back-to-front (painter's algorithm): farthest first so nearer faces paint
  // on top. `depth` is the centroid's distance along the camera forward axis, so
  // larger depth = farther — sort DESCENDING. Strokes (2D) always draw on top.
  const filled = polygons.filter((p) => !p.stroke).sort((a, b) => b.depth - a.depth);
  const stroked = polygons.filter((p) => p.stroke);
  const sorted = [...filled, ...stroked];

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);

  // Background
  lines.push(`  <rect width="${width}" height="${height}" fill="#1a1a2e"/>`);

  // Faint ground grid (projected XY plane, Z=0)
  const gridLines = buildGroundGrid(cam, basis, orthoHalf, width, height);
  if (gridLines) lines.push(gridLines);

  // Filled polygons (3D solids)
  for (const poly of sorted) {
    const pts = poly.verts.map((v) => {
      const [u, v2] = projectPoint(v, cam, basis);
      const [sx, sy] = toScreenCoords(u, v2, orthoHalf, width, height);
      return `${r2(sx)},${r2(sy)}`;
    });

    if (poly.stroke) {
      lines.push(
        `  <polyline points="${pts.join(' ')}" fill="none" stroke="${poly.color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    } else {
      const shadedColor = shade(poly.normal, poly.color);
      lines.push(
        `  <polygon points="${pts.join(' ')}" fill="${shadedColor}" stroke="rgba(0,0,0,0.25)" stroke-width="0.5"/>`,
      );
    }
  }

  // Axis triad (bottom-left corner)
  const triadSvg = buildAxisTriad(cam, basis, width, height, orthoHalf);
  lines.push(triadSvg);

  // Overlay: view label + entity count
  lines.push(`  <text x="8" y="20" font-family="monospace" font-size="13" fill="#aaaacc">${viewName.toUpperCase()} | ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}</text>`);

  lines.push('</svg>');
  return lines.join('\n');
}

/** A faint 5-line ground grid in the XY plane (Z=0). */
function buildGroundGrid(
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
  orthoHalf: number,
  width: number,
  height: number,
): string {
  // Project a ±orthoHalf grid (5×5) at Z=0
  const GRID_LINES = 5;
  const step = (orthoHalf * 2) / GRID_LINES;
  const start = -orthoHalf;
  const end = orthoHalf;
  // Grid center at world origin
  const cx = cam.target[0], cy = cam.target[1];
  const parts: string[] = [];
  for (let i = 0; i <= GRID_LINES; i++) {
    const offset = start + step * i;
    // Horizontal lines (constant Y, vary X)
    const p0 = projectPoint([cx + start, cy + offset, 0], cam, basis);
    const p1 = projectPoint([cx + end, cy + offset, 0], cam, basis);
    const s0 = toScreenCoords(p0[0], p0[1], orthoHalf, width, height);
    const s1 = toScreenCoords(p1[0], p1[1], orthoHalf, width, height);
    parts.push(`<line x1="${r2(s0[0])}" y1="${r2(s0[1])}" x2="${r2(s1[0])}" y2="${r2(s1[1])}" stroke="#333355" stroke-width="0.5"/>`);
    // Vertical lines (constant X, vary Y)
    const q0 = projectPoint([cx + offset, cy + start, 0], cam, basis);
    const q1 = projectPoint([cx + offset, cy + end, 0], cam, basis);
    const sq0 = toScreenCoords(q0[0], q0[1], orthoHalf, width, height);
    const sq1 = toScreenCoords(q1[0], q1[1], orthoHalf, width, height);
    parts.push(`<line x1="${r2(sq0[0])}" y1="${r2(sq0[1])}" x2="${r2(sq1[0])}" y2="${r2(sq1[1])}" stroke="#333355" stroke-width="0.5"/>`);
  }
  return `  <g id="grid">${parts.join('')}</g>`;
}

/** Small RGB axis triad at the bottom-left corner. */
function buildAxisTriad(
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
  width: number,
  height: number,
  orthoHalf: number,
): string {
  const origin: Vec3 = cam.target;
  const armLen = orthoHalf * 0.15;
  const axes: [Vec3, string, string][] = [
    [add3(origin, scale3([1, 0, 0], armLen)), '#ff4444', 'X'],
    [add3(origin, scale3([0, 1, 0], armLen)), '#44ff44', 'Y'],
    [add3(origin, scale3([0, 0, 1], armLen)), '#4488ff', 'Z'],
  ];

  const [ou, ov] = projectPoint(origin, cam, basis);
  const [osx, osy] = toScreenCoords(ou, ov, orthoHalf, width, height);

  // Render triad in bottom-left corner by offsetting screen coords
  const triadX = 40;
  const triadY = height - 40;
  const triadScale = 30;

  const parts: string[] = [];
  for (const [tip, color, label] of axes) {
    const [tu, tv] = projectPoint(tip, cam, basis);
    const [tsx, tsy] = toScreenCoords(tu, tv, orthoHalf, width, height);
    const dx = (tsx - osx) / (width / 2) * triadScale;
    const dy = (tsy - osy) / (height / 2) * triadScale;
    const tx = r2(triadX + dx);
    const ty = r2(triadY + dy);
    parts.push(`<line x1="${triadX}" y1="${triadY}" x2="${tx}" y2="${ty}" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<text x="${tx}" y="${ty}" font-family="monospace" font-size="10" fill="${color}">${label}</text>`);
  }
  return `  <g id="axis-triad">${parts.join('')}</g>`;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

function renderDocument(doc: CadDocument, view: ViewName, width: number, height: number): RenderViewData {
  const snapshot = computeSceneSnapshot(doc);
  const bounds = snapshot.bounds;

  // Compute scene radius and center
  let center: Vec3 = [0, 0, 0];
  let radius = 5; // default for empty scene

  if (bounds) {
    center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    radius = Math.max(dx, dy, dz) / 2 + 1e-3;
    if (radius < 0.1) radius = 1;
  }

  const cam = cameraForView(view, center, radius);
  const basis = cameraBasis(cam);
  const orthoHalf = (cam.ortho ?? radius) * 1.2;

  // Collect and tessellate all entities (stable order = doc.order)
  const rawPolys: PreDepthPolygon[] = [];
  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    const tess = tessellateEntity(e);
    for (const p of tess) {
      rawPolys.push(p);
    }
  }

  // Cap polygon count
  const capped = rawPolys.length > MAX_POLYGONS ? rawPolys.slice(0, MAX_POLYGONS) : rawPolys;

  // Project depth and shade
  const polygons: Polygon3D[] = capped.map((p) => {
    const c = centroid3(p.verts);
    const [, , depth] = projectPoint(c, cam, basis);
    return { ...p, depth };
  });

  const svg = buildSvg(polygons, cam, basis, orthoHalf, width, height, view, snapshot.entityCount);

  return {
    view,
    width,
    height,
    entityCount: snapshot.entityCount,
    bounds,
    camera: {
      position: [...cam.position] as [number, number, number],
      target: [...cam.target] as [number, number, number],
      up: [...cam.up] as [number, number, number],
    },
    svg,
  };
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

interface RenderViewParams {
  view?: string;
  width?: number;
  height?: number;
}

/**
 * @command render_view
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a self-contained <svg> string; document === input doc (referential equality)
 * @failure unknown view name -> fallback to 'iso'; width/height clamped to [64, 2000]
 */
export const renderView: CommandDefinition<RenderViewParams> = {
  name: 'render_view',
  description:
    'Render the document to a self-contained SVG image string so an AI agent can SEE the scene and self-correct. ' +
    'Returns the unchanged document plus a `data` object containing: `svg` (complete SVG string), ' +
    '`view` (resolved view name), `width`, `height`, `entityCount`, `bounds` (world AABB or null), ' +
    'and `camera` ({position, target, up}). ' +
    'Choose `view` to orient the render: "iso" (default isometric), "top", "bottom", "front", "back", ' +
    '"left", or "right" (all orthographic). ' +
    'Adjust `width`/`height` (pixels, clamped to [64, 2000], default 800×600) for resolution. ' +
    'The SVG uses flat Lambertian shading on 3D solids and stroked paths for 2D shapes. ' +
    'Does NOT modify the document; `affected` is always [].',
  paramsSchema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        description:
          'Camera direction. One of: "iso" (isometric — default, good for orienting in 3D), ' +
          '"top" (looking down the +Z axis), "bottom" (looking up the -Z axis), ' +
          '"front" (looking along the +Y axis), "back" (looking along the -Y axis), ' +
          '"left" (looking along the +X axis), "right" (looking along the -X axis). ' +
          'Omit for the default "iso" view.',
        enum: ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'],
      },
      width: {
        type: 'number',
        description: 'Output image width in pixels. Clamped to [64, 2000]. Default: 800.',
      },
      height: {
        type: 'number',
        description: 'Output image height in pixels. Clamped to [64, 2000]. Default: 600.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const rawParams = params as RenderViewParams;

    // Resolve view
    const rawView = rawParams.view ?? 'iso';
    const view: ViewName = VALID_VIEWS.has(rawView) ? (rawView as ViewName) : 'iso';

    // Clamp dimensions
    const width = Math.max(64, Math.min(2000, Math.round(rawParams.width ?? 800)));
    const height = Math.max(64, Math.min(2000, Math.round(rawParams.height ?? 600)));

    const data = renderDocument(doc, view, width, height);

    return {
      document: doc,
      summary: `Rendered ${view} view: ${data.entityCount} entit${data.entityCount === 1 ? 'y' : 'ies'}, ${width}×${height}.`,
      affected: [],
      data,
    };
  },
};
