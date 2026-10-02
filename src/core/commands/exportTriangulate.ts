import type { CadDocument, Entity, InstanceEntity, Vec3 } from '../model/types';
import { applyEulerXYZ } from './render';
import { expandInstance } from './assemblies';
import { revolutionTriangles } from '../geometry/revolution';
import {
  SEG_CIRCLE,
  SEG_SPHERE_LAT,
  SEG_SPHERE_LON,
  SEG_TORUS_TUBE,
  circlePoints,
  meshTriangles,
} from './tessellation';
import { type Triangle, fanTriangulate, earClipTriangulateVerts } from './exportMath';

// ---------------------------------------------------------------------------
// Per-kind world-space triangle tessellation
// ---------------------------------------------------------------------------

export function triangulateBox(e: { position: Vec3; size: Vec3; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const x0 = px - w / 2,
    x1 = px + w / 2;
  const y0 = py - h / 2,
    y1 = py + h / 2;
  const z0 = pz - d / 2,
    z1 = pz + d / 2;

  // Counter-clockwise seen from outside (outward normals).
  const quads: Vec3[][] = [
    // bottom (-Z)
    [
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y0, z0],
    ],
    // top (+Z)
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    // front (-Y)
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
    // back (+Y)
    [
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
    ],
    // left (-X)
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    // right (+X)
    [
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ],
  ];

  const tris = quads.flatMap(fanTriangulate);
  return applyRotationToTriangles(tris, e.position, e.rotation);
}

export function triangulateCylinder(e: {
  position: Vec3;
  radius: number;
  height: number;
  rotation: Vec3;
}): Triangle[] {
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

export function triangulateSphere(e: {
  position: Vec3;
  radius: number;
  rotation: Vec3;
}): Triangle[] {
  const [px, py, pz] = e.position;
  const { radius } = e;
  const tris: Triangle[] = [];

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
      tris.push([v00, v01, v11]);
      tris.push([v00, v11, v10]);
    }
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

export function triangulateCone(e: {
  position: Vec3;
  radius: number;
  height: number;
  rotation: Vec3;
}): Triangle[] {
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

export function triangulateTorus(e: {
  position: Vec3;
  ringRadius: number;
  tubeRadius: number;
  rotation: Vec3;
}): Triangle[] {
  const [px, py, pz] = e.position;
  const { ringRadius, tubeRadius } = e;
  const RING_SEGS = SEG_CIRCLE;
  const TUBE_SEGS = SEG_TORUS_TUBE;
  const tris: Triangle[] = [];

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
      tris.push([v00, v10, v11]);
      tris.push([v00, v11, v01]);
    }
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

export function tessellateWedge(e: { position: Vec3; size: Vec3; rotation: Vec3 }): Triangle[] {
  const [px, py, pz] = e.position;
  const [w, h, d] = e.size;
  const p = (dx: number, dy: number, dz: number): Vec3 => [px + dx, py + dy, pz + dz];
  const f00 = p(0, 0, 0);
  const f10 = p(w, 0, 0);
  const f11 = p(w, h, 0);
  const f01 = p(0, h, 0);
  const b00 = p(0, 0, d);
  const b10 = p(w, 0, d);

  // Counter-clockwise seen from outside (outward normals).
  const quads: Vec3[][] = [
    // front face (-Z)
    [f00, f01, f11, f10],
    // bottom face (-Y)
    [f00, f10, b10, b00],
    // top slope (ramp)
    [f01, b00, b10, f11],
  ];
  const triPairs: Triangle[] = [
    ...quads.flatMap(fanTriangulate),
    // left triangle (-X)
    [f00, b00, f01],
    // right triangle (+X)
    [f10, f11, b10],
  ];

  return applyRotationToTriangles(triPairs, e.position, e.rotation);
}

export function triangulatePyramid(e: {
  position: Vec3;
  baseWidth: number;
  baseDepth: number;
  height: number;
  rotation: Vec3;
}): Triangle[] {
  const [px, py, pz] = e.position;
  const hw = e.baseWidth / 2,
    hd = e.baseDepth / 2;
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

export function triangulateExtrusion(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
  rotation: Vec3;
}): Triangle[] {
  if (e.profile.length < 3) return [];
  const [px, py, pz] = e.position;
  const n = e.profile.length;
  const bottom: Vec3[] = e.profile.map(([x, y]) => [px + x, py + y, pz]);
  const top: Vec3[] = e.profile.map(([x, y]) => [px + x, py + y, pz + e.depth]);

  const tris: Triangle[] = [];

  // Bottom cap (reversed = face down) — ear-clip handles non-convex profiles correctly.
  tris.push(...earClipTriangulateVerts([...bottom].reverse()));
  // Top cap
  tris.push(...earClipTriangulateVerts([...top]));
  // Side quads → 2 tris each
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([bottom[i]!, bottom[j]!, top[j]!]);
    tris.push([bottom[i]!, top[j]!, top[i]!]);
  }

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

export function triangulateMesh(e: {
  position: Vec3;
  mesh: { positions: readonly number[]; indices: readonly number[] };
  rotation: Vec3;
}): Triangle[] {
  const tris: Triangle[] = meshTriangles(e.mesh);
  return applyRotationToTriangles(tris, e.position, e.rotation);
}

// ---------------------------------------------------------------------------
// Rotation application (mirrors render.ts applyEulerXYZ)
// ---------------------------------------------------------------------------

export function applyRotationToTriangles(
  tris: Triangle[],
  position: Vec3,
  rotation: Vec3,
): Triangle[] {
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

export function triangulateRevolution(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  axis: Vec3;
  angle: number;
  segments: number;
  rotation: Vec3;
}): Triangle[] {
  const tris = revolutionTriangles(e.profile, e.axis, e.angle, e.segments, e.position);
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
    case 'box':
      return triangulateBox(e);
    case 'cylinder':
      return triangulateCylinder(e);
    case 'sphere':
      return triangulateSphere(e);
    case 'cone':
      return triangulateCone(e);
    case 'torus':
      return triangulateTorus(e);
    case 'wedge':
      return tessellateWedge(e);
    case 'pyramid':
      return triangulatePyramid(e);
    case 'extrusion':
      return triangulateExtrusion(e);
    case 'mesh':
      return triangulateMesh(e);
    case 'revolution':
      return triangulateRevolution(e);
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
    default:
      return []; // 2D shapes → nothing
  }
}

// ---------------------------------------------------------------------------
// STL ASCII serialisation
// ---------------------------------------------------------------------------
