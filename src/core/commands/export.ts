/**
 * Export commands — read-only serialisation of the document to external formats.
 *
 * Each command returns the SAME document reference, affected:[], and a `data`
 * field containing the serialised output. They are safe to call at any time
 * without side effects.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, InstanceEntity, Vec3 } from '../model/types';
import { is3D } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { applyEulerXYZ } from './render';
import { expandInstance } from './assemblies';

// ---------------------------------------------------------------------------
// Internal math helpers (pure)
// ---------------------------------------------------------------------------

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function len3(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-10 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/** Compute the outward facet normal from 3 vertices (right-hand rule). */
function facetNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  return normalize3(cross3(sub3(v1, v0), sub3(v2, v0)));
}

// ---------------------------------------------------------------------------
// Triangle soup: a list of [v0, v1, v2] world-space triangles
// ---------------------------------------------------------------------------

export type Triangle = readonly [Vec3, Vec3, Vec3];

// ---------------------------------------------------------------------------
// Shared tessellation constants (mirror render.ts values for consistency)
// ---------------------------------------------------------------------------

const SEG_CIRCLE = 24;
const SEG_SPHERE_LAT = 12;
const SEG_SPHERE_LON = 16;
const SEG_TORUS_TUBE = 12;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Points on a circle in the XY plane at height cz (Z-up). */
function circlePoints(cx: number, cy: number, cz: number, r: number, segs: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), cz]);
  }
  return pts;
}

/**
 * Triangulate a convex/simple polygon fan from first vertex.
 * Polygon assumed CCW when viewed from outside.
 */
function fanTriangulate(verts: Vec3[]): Triangle[] {
  const tris: Triangle[] = [];
  for (let i = 1; i + 1 < verts.length; i++) {
    tris.push([verts[0]!, verts[i]!, verts[i + 1]!]);
  }
  return tris;
}

// ---------------------------------------------------------------------------
// Per-kind world-space triangle tessellation
// ---------------------------------------------------------------------------

function triangulateBox(e: { position: Vec3; size: Vec3; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const x0 = px - w / 2, x1 = px + w / 2;
  const y0 = py - h / 2, y1 = py + h / 2;
  const z0 = pz - d / 2, z1 = pz + d / 2;

  const quads: Vec3[][] = [
    // bottom (-Z)  reversed = face down
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    // top (+Z)
    [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]],
    // front (-Y)
    [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]],
    // back (+Y)
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
    // left (-X)
    [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
    // right (+X)
    [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]],
  ];

  const tris = quads.flatMap(fanTriangulate);
  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateCylinder(e: { position: Vec3; radius: number; height: number; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const { radius, height } = e;
  const zb = pz - height / 2;
  const zt = pz + height / 2;
  const bot = circlePoints(px, py, zb, radius, SEG_CIRCLE);
  const top = circlePoints(px, py, zt, radius, SEG_CIRCLE);

  const tris: Triangle[] = [];

  // Bottom cap (reversed = face down)
  const botCenter: Vec3 = [px, py, zb];
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    tris.push([botCenter, bot[j]!, bot[i]!]);
  }

  // Top cap
  const topCenter: Vec3 = [px, py, zt];
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    tris.push([topCenter, top[i]!, top[j]!]);
  }

  // Side quads → 2 tris each
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    tris.push([bot[i]!, bot[j]!, top[j]!]);
    tris.push([bot[i]!, top[j]!, top[i]!]);
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateSphere(e: { position: Vec3; radius: number; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const { radius } = e;
  const tris: Triangle[] = [];

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
      tris.push([v00, v01, v11]);
      tris.push([v00, v11, v10]);
    }
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateCone(e: { position: Vec3; radius: number; height: number; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const { radius, height } = e;
  const base = circlePoints(px, py, pz, radius, SEG_CIRCLE);
  const apex: Vec3 = [px, py, pz + height];

  const tris: Triangle[] = [];

  // Base cap (face down)
  const baseCenter: Vec3 = [px, py, pz];
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    tris.push([baseCenter, base[j]!, base[i]!]);
  }

  // Side triangles
  for (let i = 0; i < SEG_CIRCLE; i++) {
    const j = (i + 1) % SEG_CIRCLE;
    tris.push([base[i]!, base[j]!, apex]);
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateTorus(e: { position: Vec3; ringRadius: number; tubeRadius: number; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const { ringRadius, tubeRadius } = e;
  const RING_SEGS = SEG_CIRCLE;
  const TUBE_SEGS = SEG_TORUS_TUBE;
  const tris: Triangle[] = [];

  for (let i = 0; i < RING_SEGS; i++) {
    const a0 = (2 * Math.PI * i) / RING_SEGS;
    const a1 = (2 * Math.PI * (i + 1)) / RING_SEGS;
    const ca0 = Math.cos(a0), sa0 = Math.sin(a0);
    const ca1 = Math.cos(a1), sa1 = Math.sin(a1);
    for (let j = 0; j < TUBE_SEGS; j++) {
      const b0 = (2 * Math.PI * j) / TUBE_SEGS;
      const b1 = (2 * Math.PI * (j + 1)) / TUBE_SEGS;
      const cb0 = Math.cos(b0), sb0 = Math.sin(b0);
      const cb1 = Math.cos(b1), sb1 = Math.sin(b1);
      const v00: Vec3 = [px + (ringRadius + tubeRadius * cb0) * ca0, py + (ringRadius + tubeRadius * cb0) * sa0, pz + tubeRadius * sb0];
      const v01: Vec3 = [px + (ringRadius + tubeRadius * cb1) * ca0, py + (ringRadius + tubeRadius * cb1) * sa0, pz + tubeRadius * sb1];
      const v10: Vec3 = [px + (ringRadius + tubeRadius * cb0) * ca1, py + (ringRadius + tubeRadius * cb0) * sa1, pz + tubeRadius * sb0];
      const v11: Vec3 = [px + (ringRadius + tubeRadius * cb1) * ca1, py + (ringRadius + tubeRadius * cb1) * sa1, pz + tubeRadius * sb1];
      tris.push([v00, v10, v11]);
      tris.push([v00, v11, v01]);
    }
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function tessellateWedge(e: { position: Vec3; size: Vec3; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const p = (dx: number, dy: number, dz: number): Vec3 => [px + dx, py + dy, pz + dz];
  const f00 = p(0, 0, 0);
  const f10 = p(w, 0, 0);
  const f11 = p(w, h, 0);
  const f01 = p(0, h, 0);
  const b00 = p(0, 0, d);
  const b10 = p(w, 0, d);

  const quads: Vec3[][] = [
    // front face
    [f00, f10, f11, f01],
    // bottom face
    [f00, b00, b10, f10],
    // top slope (ramp)
    [f01, f11, b10, b00],
  ];
  const triPairs: Triangle[] = [
    ...quads.flatMap(fanTriangulate),
    // left triangle
    [f00, f01, b00],
    // right triangle
    [f10, b10, f11],
  ];

  return applyRotationToTriangles(triPairs, e.position, e.rotation);
}

function triangulatePyramid(e: { position: Vec3; baseWidth: number; baseDepth: number; height: number; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const hw = e.baseWidth / 2, hd = e.baseDepth / 2;
  const b00: Vec3 = [px - hw, py - hd, pz];
  const b10: Vec3 = [px + hw, py - hd, pz];
  const b11: Vec3 = [px + hw, py + hd, pz];
  const b01: Vec3 = [px - hw, py + hd, pz];
  const apex: Vec3 = [px, py, pz + e.height];

  const tris: Triangle[] = [
    // base (reversed = face down)
    ...fanTriangulate([b00, b01, b11, b10]),
    // 4 side triangles
    [b00, b10, apex],
    [b10, b11, apex],
    [b11, b01, apex],
    [b01, b00, apex],
  ];

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateExtrusion(e: { position: Vec3; profile: ReadonlyArray<readonly [number, number]>; depth: number; rotation: Vec3 }): Triangle[] {
  if (e.profile.length < 3) return [];
  const [px, py, pz] = e.position;
  const n = e.profile.length;
  const bottom: Vec3[] = e.profile.map(([x, y]) => [px + x, py + y, pz]);
  const top: Vec3[] = e.profile.map(([x, y]) => [px + x, py + y, pz + e.depth]);

  const tris: Triangle[] = [];

  // Bottom cap (reversed = face down)
  tris.push(...fanTriangulate([...bottom].reverse()));
  // Top cap
  tris.push(...fanTriangulate([...top]));
  // Side quads → 2 tris each
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([bottom[i]!, bottom[j]!, top[j]!]);
    tris.push([bottom[i]!, top[j]!, top[i]!]);
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateMesh(e: { position: Vec3; mesh: { positions: readonly number[] }; rotation: Vec3 }): Triangle[] {
  const p = e.mesh.positions;
  const tris: Triangle[] = [];
  for (let i = 0; i + 8 < p.length; i += 9) {
    const v0: Vec3 = [p[i] as number, p[i + 1] as number, p[i + 2] as number];
    const v1: Vec3 = [p[i + 3] as number, p[i + 4] as number, p[i + 5] as number];
    const v2: Vec3 = [p[i + 6] as number, p[i + 7] as number, p[i + 8] as number];
    tris.push([v0, v1, v2]);
  }
  return applyRotationToTriangles(tris, e.position, e.rotation);
}

// ---------------------------------------------------------------------------
// Rotation application (mirrors render.ts applyEulerXYZ)
// ---------------------------------------------------------------------------

function applyRotationToTriangles(tris: Triangle[], position: Vec3, rotation: Vec3): Triangle[] {
  const [rx, ry, rz] = rotation;
  if (rx === 0 && ry === 0 && rz === 0) return tris;
  return tris.map(
    ([v0, v1, v2]) =>
      [
        applyEulerXYZ(v0, position, rotation),
        applyEulerXYZ(v1, position, rotation),
        applyEulerXYZ(v2, position, rotation),
      ] as const,
  );
}

/**
 * Triangulate a surface of revolution (mirrors tessellateRevolution in render.ts,
 * outputting Triangle[] instead of PreDepthPolygon[]).
 *
 * Coordinate conventions match render.ts:
 *   Z-axis revolution: radial→X, axial→Z (default/Z-up)
 *   Y-axis revolution: radial→X, axial→Y
 *   X-axis revolution: radial→Y, axial→X
 */
function triangulateRevolution(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  axis: Vec3;
  angle: number;
  segments: number;
  rotation: Vec3;
}): Triangle[] {
  if (e.profile.length < 3) return [];
  const { profile, angle, segments } = e;
  const [px, py, pz] = e.position;
  const [ax, ay, az] = e.axis;
  const absX = Math.abs(ax), absY = Math.abs(ay), absZ = Math.abs(az);

  function profileToWorld(r: number, a: number, theta: number): Vec3 {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    if (absZ >= absX && absZ >= absY) {
      return [px + r * cosT, py + r * sinT, pz + a];
    } else if (absY >= absX) {
      return [px + r * cosT, py + a, pz + r * sinT];
    } else {
      return [px + a, py + r * cosT, pz + r * sinT];
    }
  }

  const n = profile.length;
  const isFull = angle >= 2 * Math.PI - 1e-6;
  const ringCount = isFull ? segments : segments + 1;
  const rings: Vec3[][] = [];
  for (let s = 0; s < ringCount; s++) {
    const theta = (angle * s) / segments;
    const ring: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const [r, a] = profile[i]!;
      ring.push(profileToWorld(r, a, theta));
    }
    rings.push(ring);
  }

  const tris: Triangle[] = [];
  const numRings = rings.length;

  // Stitch side quads between consecutive rings → 2 triangles each
  for (let s = 0; s < segments; s++) {
    const ringA = rings[s]!;
    const ringB = rings[(s + 1) % numRings]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tris.push([ringA[i]!, ringA[j]!, ringB[j]!]);
      tris.push([ringA[i]!, ringB[j]!, ringB[i]!]);
    }
  }

  // End caps for partial revolutions
  if (!isFull) {
    tris.push(...fanTriangulate([...rings[0]!].reverse()));
    tris.push(...fanTriangulate([...rings[segments]!]));
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

// ---------------------------------------------------------------------------
// Entity → triangles dispatch
// ---------------------------------------------------------------------------

/**
 * Convert a single entity to a world-space triangle list.
 * Accepts `doc` for instance expansion (looks up components).
 * 2D shapes and unknown kinds return [].
 */
export function entityToTriangles(e: Entity, doc: CadDocument): Triangle[] {
  switch (e.kind) {
    case 'box':        return triangulateBox(e);
    case 'cylinder':   return triangulateCylinder(e);
    case 'sphere':     return triangulateSphere(e);
    case 'cone':       return triangulateCone(e);
    case 'torus':      return triangulateTorus(e);
    case 'wedge':      return tessellateWedge(e);
    case 'pyramid':    return triangulatePyramid(e);
    case 'extrusion':  return triangulateExtrusion(e);
    case 'mesh':       return triangulateMesh(e);
    case 'revolution': return triangulateRevolution(e);
    case 'instance': {
      const inst = e as InstanceEntity;
      const component = doc.components[inst.componentId];
      if (!component) return [];
      const children = expandInstance(inst, component);
      const result: Triangle[] = [];
      for (const child of children) {
        const childTris = entityToTriangles(child, doc);
        for (const t of childTris) result.push(t);
      }
      return result;
    }
    default:           return [];   // 2D shapes → nothing
  }
}

// ---------------------------------------------------------------------------
// STL ASCII serialisation
// ---------------------------------------------------------------------------

function formatVec3(v: Vec3): string {
  return `${v[0]} ${v[1]} ${v[2]}`;
}

function buildAsciiStl(tris: Triangle[], solidName: string): string {
  const lines: string[] = [`solid ${solidName}`];
  for (const [v0, v1, v2] of tris) {
    const n = facetNormal(v0, v1, v2);
    lines.push(`  facet normal ${formatVec3(n)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${formatVec3(v0)}`);
    lines.push(`      vertex ${formatVec3(v1)}`);
    lines.push(`      vertex ${formatVec3(v2)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${solidName}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pure base64 encoder — no Node Buffer, no DOM (browser-safe for core/)
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;
    out.push(B64_CHARS[b0 >> 2]!);
    out.push(B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]!);
    out.push(i + 1 < len ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '=');
    out.push(i + 2 < len ? B64_CHARS[b2 & 0x3f]! : '=');
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// STL binary serialisation
// ---------------------------------------------------------------------------

function buildBinaryStl(tris: Triangle[], headerText: string): Uint8Array {
  const count = tris.length;
  // 80-byte header + 4-byte count + count × 50-byte triangles
  const buf = new Uint8Array(84 + count * 50);
  const view = new DataView(buf.buffer);

  // Header: ASCII solid name in the first 80 bytes (truncated; remainder stays zero).
  // STL binary headers conventionally carry a label/comment (never "solid ...", which
  // would trip ASCII-vs-binary sniffers — callers pass a plain name).
  for (let i = 0; i < headerText.length && i < 80; i += 1) {
    buf[i] = headerText.charCodeAt(i) & 0x7f;
  }
  // Triangle count at offset 80
  view.setUint32(80, count, true); // little-endian

  let offset = 84;
  for (const [v0, v1, v2] of tris) {
    const n = facetNormal(v0, v1, v2);
    // normal (3 × float32)
    view.setFloat32(offset, n[0], true);   offset += 4;
    view.setFloat32(offset, n[1], true);   offset += 4;
    view.setFloat32(offset, n[2], true);   offset += 4;
    // v0 (3 × float32)
    view.setFloat32(offset, v0[0], true);  offset += 4;
    view.setFloat32(offset, v0[1], true);  offset += 4;
    view.setFloat32(offset, v0[2], true);  offset += 4;
    // v1 (3 × float32)
    view.setFloat32(offset, v1[0], true);  offset += 4;
    view.setFloat32(offset, v1[1], true);  offset += 4;
    view.setFloat32(offset, v1[2], true);  offset += 4;
    // v2 (3 × float32)
    view.setFloat32(offset, v2[0], true);  offset += 4;
    view.setFloat32(offset, v2[1], true);  offset += 4;
    view.setFloat32(offset, v2[2], true);  offset += 4;
    // attribute byte count (2 bytes, always 0)
    view.setUint16(offset, 0, true);       offset += 2;
  }

  return buf;
}

// ---------------------------------------------------------------------------
// ExportStl data shape (exported so tests can type-narrow)
// ---------------------------------------------------------------------------

export interface ExportStlData {
  /** Resolved format used ('ascii' | 'binary'). */
  format: 'ascii' | 'binary';
  /** Total number of triangles exported. */
  triangleCount: number;
  /** Present for format='ascii': the full ASCII STL text. */
  stl?: string;
  /** Present for format='binary': base64-encoded binary STL bytes. */
  stlBase64?: string;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

interface ExportStlParams {
  /**
   * Output format. 'ascii' (default) produces a text STL string in data.stl.
   * 'binary' produces a base64-encoded binary STL in data.stlBase64.
   */
  format?: 'ascii' | 'binary';
  /**
   * Ids of entities to export. Omit (or pass an empty array) to export ALL
   * exportable (3D solid) entities in the document.
   */
  entityIds?: string[];
  /**
   * Solid name embedded in the STL header. Defaults to 'llull'.
   * For ASCII STL: appears in the 'solid <name>' … 'endsolid <name>' wrapper.
   * For binary STL: embedded in the 80-byte ASCII header.
   */
  name?: string;
}

/**
 * @command export_stl
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.triangleCount >= 0; data.format matches the requested format;
 *            ASCII STL wraps content in 'solid <name>'…'endsolid <name>';
 *            binary STL is 84 + triangleCount*50 bytes, base64-encoded in stlBase64
 * @failure 2D-only entities or unknown ids are silently skipped;
 *          empty selection or all-2D document → valid empty solid, triangleCount:0;
 *          never throws for user error
 */
export const exportStl: CommandDefinition<ExportStlParams> = {
  name: 'export_stl',
  annotations: { readOnly: true },
  description:
    'Export the document (or a subset of entities) to STL format — the standard triangle-mesh ' +
    'interchange format accepted by slicers, mesh editors, and 3D printers. ' +
    'Produces a triangle tessellation in world space for every exportable 3D solid entity. ' +
    '2D shape entities (line, polyline, arc, circle, rectangle, text, dimension, etc.) are ' +
    'silently skipped — STL is a solid/mesh format. ' +
    'Returns the UNCHANGED document, affected:[], and a data object with: ' +
    '  format ("ascii"|"binary"), triangleCount (number of exported triangles), ' +
    '  stl (ASCII STL string — when format="ascii"), ' +
    '  stlBase64 (base64-encoded binary STL bytes — when format="binary"). ' +
    'Supported entity kinds: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, mesh. ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'format: "ascii" (default, human-readable) or "binary" (more compact, required by some importers). ' +
    'name: optional solid name embedded in the STL header (default "llull"). ' +
    'Does NOT modify the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        description:
          'STL output format. "ascii" (default): returns data.stl as a human-readable ASCII STL string. ' +
          '"binary": returns data.stlBase64 as a base64-encoded binary STL blob ' +
          '(84-byte header + 50 bytes per triangle). Most slicers accept both; ' +
          'binary is more compact for large meshes.',
        enum: ['ascii', 'binary'],
      },
      entityIds: {
        type: 'array',
        description:
          'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
          '3D solid entities in the document. 2D-only entities in the list are silently skipped. ' +
          'Unknown ids are also silently skipped with a note in summary.',
        items: { type: 'string' },
      },
      name: {
        type: 'string',
        description:
          'Solid name to embed in the STL header (ASCII: "solid <name>"…"endsolid <name>"; ' +
          'binary: first bytes of the 80-byte header). Default: "llull". ' +
          'Use a meaningful name to help downstream tools identify the mesh.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const fmt: 'ascii' | 'binary' =
      (params as ExportStlParams).format === 'binary' ? 'binary' : 'ascii';
    const solidName = (params as ExportStlParams).name ?? 'llull';
    const requestedIds = (params as ExportStlParams).entityIds;

    // Determine which entity ids to process
    let idsToProcess: string[];
    const unknownIds: string[] = [];
    if (requestedIds && requestedIds.length > 0) {
      idsToProcess = [];
      for (const id of requestedIds) {
        if (doc.entities[id]) {
          idsToProcess.push(id);
        } else {
          unknownIds.push(id);
        }
      }
    } else {
      idsToProcess = doc.order;
    }

    // Collect triangles from 3D entities only
    const allTris: Triangle[] = [];
    let skipped2D = 0;
    for (const id of idsToProcess) {
      const e = doc.entities[id];
      if (!e) continue;
      if (!is3D(e)) {
        skipped2D++;
        continue;
      }
      const tris = entityToTriangles(e, doc);
      for (const t of tris) {
        allTris.push(t);
      }
    }

    const triangleCount = allTris.length;

    // Build summary
    const parts: string[] = [`export_stl: ${triangleCount} triangle${triangleCount !== 1 ? 's' : ''} exported (format=${fmt}).`];
    if (skipped2D > 0) parts.push(`${skipped2D} 2D entit${skipped2D !== 1 ? 'ies' : 'y'} skipped.`);
    if (unknownIds.length > 0) parts.push(`Unknown ids skipped: ${unknownIds.join(', ')}.`);
    const summary = parts.join(' ');

    if (fmt === 'ascii') {
      const stl = buildAsciiStl(allTris, solidName);
      const data: ExportStlData = { format: 'ascii', triangleCount, stl };
      return { document: doc, summary, affected: [], data };
    } else {
      const bytes = buildBinaryStl(allTris, solidName);
      const stlBase64 = uint8ArrayToBase64(bytes);
      const data: ExportStlData = { format: 'binary', triangleCount, stlBase64 };
      return { document: doc, summary, affected: [], data };
    }
  },
};
