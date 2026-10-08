/**
 * World-space triangles of single solids (no instance resolution: see ./instanceExpansion and
 * ./exportTriangulate `entityToTriangles`). Counter-clockwise from outside (outward normals).
 *
 * @layer core/commands
 */

import type { Entity, Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { revolutionTriangles } from '../geometry/revolution';
import {
  SEG_CIRCLE,
  boxExtents,
  circlePoints,
  extrusionRings,
  meshTriangles,
  pyramidCorners,
  ringEdges,
  sideQuads,
  sphereQuads,
  torusQuads,
  wedgeCorners,
} from './tessellation';
import { type Triangle, fanTriangulate, earClipTriangulateVerts } from './exportMath';

type Kind<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

function triangulateBox(e: Kind<'box'>): Triangle[] {
  const { x0, x1, y0, y1, z0, z1 } = boxExtents(e.position, e.size);
  // Counter-clockwise seen from outside (outward normals): -Z, +Z, -Y, +Y, -X, +X.
  const quads: Vec3[][] = [
    [
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y0, z0],
    ],
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
    [
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    [
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ],
  ];
  return quads.flatMap(fanTriangulate);
}

function triangulateCylinder(e: Kind<'cylinder'>): Triangle[] {
  const [px, py, pz] = e.position;
  const zb = pz - e.height / 2;
  const zt = pz + e.height / 2;
  const bot = circlePoints(px, py, zb, e.radius, SEG_CIRCLE);
  const top = circlePoints(px, py, zt, e.radius, SEG_CIRCLE);
  return [
    ...ringEdges(bot).map(([from, to]): Triangle => [[px, py, zb], to, from]),
    ...ringEdges(top).map(([from, to]): Triangle => [[px, py, zt], from, to]),
    ...sideQuads(bot, top).flatMap(fanTriangulate),
  ];
}

function triangulateSphere(e: Kind<'sphere'>): Triangle[] {
  return sphereQuads(e.position, e.radius).flatMap(fanTriangulate);
}

function triangulateCone(e: Kind<'cone'>): Triangle[] {
  const [px, py, pz] = e.position;
  const base = circlePoints(px, py, pz, e.radius, SEG_CIRCLE);
  const apex: Vec3 = [px, py, pz + e.height];
  const edges = ringEdges(base);
  return [
    ...edges.map(([from, to]): Triangle => [[px, py, pz], to, from]),
    ...edges.map(([from, to]): Triangle => [from, to, apex]),
  ];
}

function triangulateTorus(e: Kind<'torus'>): Triangle[] {
  return torusQuads(e.position, e.ringRadius, e.tubeRadius).flatMap(fanTriangulate);
}

function triangulateWedge(e: Kind<'wedge'>): Triangle[] {
  const { f00, f10, f11, f01, b00, b10 } = wedgeCorners(e.position, e.size);
  // Counter-clockwise seen from outside: front (-Z), bottom (-Y), top ramp, then the -X / +X triangles.
  const quads: Vec3[][] = [
    [f00, f01, f11, f10],
    [f00, f10, b10, b00],
    [f01, b00, b10, f11],
  ];
  return [...quads.flatMap(fanTriangulate), [f00, b00, f01], [f10, f11, b10]];
}

function triangulatePyramid(e: Kind<'pyramid'>): Triangle[] {
  const { b00, b10, b11, b01, apex } = pyramidCorners(e);
  return [
    ...fanTriangulate([b00, b01, b11, b10]), // base, face down
    [b00, b10, apex],
    [b10, b11, apex],
    [b11, b01, apex],
    [b01, b00, apex],
  ];
}

function triangulateExtrusion(e: Kind<'extrusion'>): Triangle[] {
  if (e.profile.length < 3) return [];
  const { bottom, top } = extrusionRings(e);
  return [
    // Ear clipping handles non-convex profiles; its triangles face +Z, so the bottom cap is flipped.
    ...earClipTriangulateVerts([...bottom]).map(([a, b, c]): Triangle => [a, c, b]),
    ...earClipTriangulateVerts([...top]),
    ...sideQuads(bottom, top).flatMap(fanTriangulate),
  ];
}

function applyRotationToTriangles(tris: Triangle[], position: Vec3, rotation: Vec3): Triangle[] {
  if (isZeroRotation(rotation)) return tris;
  const rotate = (v: Vec3): Vec3 => applyEulerXYZ(v, position, rotation);
  return tris.map(([a, b, c]): Triangle => [rotate(a), rotate(b), rotate(c)]);
}

/** Triangles of a non-instance entity before its own `rotation` is applied (world position baked in). */
function unrotatedTriangles(e: Entity): Triangle[] {
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
      return triangulateWedge(e);
    case 'pyramid':
      return triangulatePyramid(e);
    case 'extrusion':
      return triangulateExtrusion(e);
    case 'mesh':
      return meshTriangles(e.mesh);
    case 'revolution':
      return revolutionTriangles(e.profile, e.axis, e.angle, e.segments, e.position);
    default:
      return []; // 2D shapes and instances
  }
}

/** World-space triangles of one entity without resolving instances (instances and 2D shapes return []). */
export function solidTriangles(e: Entity): Triangle[] {
  return applyRotationToTriangles(unrotatedTriangles(e), e.position, e.rotation);
}
