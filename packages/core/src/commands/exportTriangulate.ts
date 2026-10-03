import type { CadDocument, Entity, InstanceEntity, Vec3 } from '../model/types';
import { is3D } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { expandInstance } from './assemblies';
import { revolutionTriangles } from '../geometry/revolution';
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
import { type Triangle, fanTriangulate, earClipTriangulateVerts } from './exportMath';

function triangulateBox(e: { position: Vec3; size: Vec3; rotation: Vec3 }): Triangle[] {
  const { x0, x1, y0, y1, z0, z1 } = boxExtents(e.position, e.size);

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

function triangulateCylinder(e: {
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

function triangulateSphere(e: { position: Vec3; radius: number; rotation: Vec3 }): Triangle[] {
  const tris: Triangle[] = sphereQuads(e.position, e.radius).flatMap(
    ([v00, v01, v11, v10]): Triangle[] => [
      [v00, v01, v11],
      [v00, v11, v10],
    ],
  );

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function triangulateCone(e: {
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

function triangulateTorus(e: {
  position: Vec3;
  ringRadius: number;
  tubeRadius: number;
  rotation: Vec3;
}): Triangle[] {
  const tris: Triangle[] = torusQuads(e.position, e.ringRadius, e.tubeRadius).flatMap(
    ([v00, v10, v11, v01]): Triangle[] => [
      [v00, v10, v11],
      [v00, v11, v01],
    ],
  );

  return applyRotationToTriangles(tris, e.position, e.rotation);
}

function tessellateWedge(e: { position: Vec3; size: Vec3; rotation: Vec3 }): Triangle[] {
  const { f00, f10, f11, f01, b00, b10 } = wedgeCorners(e.position, e.size);

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

function triangulatePyramid(e: {
  position: Vec3;
  baseWidth: number;
  baseDepth: number;
  height: number;
  rotation: Vec3;
}): Triangle[] {
  const { b00, b10, b11, b01, apex } = pyramidCorners(e);

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

function triangulateExtrusion(e: {
  position: Vec3;
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
  rotation: Vec3;
}): Triangle[] {
  if (e.profile.length < 3) return [];
  const n = e.profile.length;
  const { bottom, top } = extrusionRings(e);

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

function triangulateMesh(e: {
  position: Vec3;
  mesh: { positions: readonly number[]; indices: readonly number[] };
  rotation: Vec3;
}): Triangle[] {
  const tris: Triangle[] = meshTriangles(e.mesh);
  return applyRotationToTriangles(tris, e.position, e.rotation);
}

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

function triangulateRevolution(e: {
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

/**
 * World-space triangles of the entities named by `requestedIds` (all of `doc.order` when
 * undefined/empty). Unknown ids are reported, 2D entities are counted and skipped.
 */
export function collectExportTriangles(
  doc: CadDocument,
  requestedIds: readonly string[] | undefined,
): { tris: Triangle[]; skipped2D: number; unknownIds: string[] } {
  const unknownIds: string[] = [];
  let idsToProcess: readonly string[] = doc.order;
  if (requestedIds && requestedIds.length > 0) {
    idsToProcess = requestedIds.filter((id) => {
      const known = doc.entities[id] !== undefined;
      if (!known) unknownIds.push(id);
      return known;
    });
  }
  const tris: Triangle[] = [];
  let skipped2D = 0;
  for (const id of idsToProcess) {
    const entity = doc.entities[id];
    if (!entity) continue;
    if (!is3D(entity)) {
      skipped2D++;
      continue;
    }
    for (const t of entityToTriangles(entity, doc)) tris.push(t);
  }
  return { tris, skipped2D, unknownIds };
}
