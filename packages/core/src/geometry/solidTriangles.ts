/**
 * World-space triangles of single solids (no instance resolution: see ./instanceExpansion and
 * ./exportTriangulate `entityToTriangles`). Counter-clockwise from outside (outward normals).
 */

import { type Entity, type Vec3, is2D } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { revolutionTriangles } from './revolution';
import { sweepTriangles } from './sweep';
import { loftTriangles } from './loft';
import { subdivisionTriangles } from './subdivision';
import {
  boxFaces,
  extrusionRings,
  meshTriangles,
  coneSurface,
  cylinderRings,
  pyramidFaces,
  ringEdges,
  sideQuads,
  sphereQuads,
  torusQuads,
  wedgeFaces,
} from './tessellation';
import { type Triangle, fanTriangulate, earClipTriangulateVerts } from './triangles';

type Kind<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

function triangulateBox(e: Kind<'box'>): Triangle[] {
  return boxFaces(e.position, e.size).flatMap(fanTriangulate);
}

function triangulateCylinder(e: Kind<'cylinder'>): Triangle[] {
  const [px, py, pz] = e.position;
  const zb = pz - e.height / 2;
  const zt = pz + e.height / 2;
  const { bottom: bot, top } = cylinderRings(e);
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
  const { center, base, sides } = coneSurface(e);
  return [...ringEdges(base).map(([from, to]): Triangle => [center, to, from]), ...sides];
}

function triangulateTorus(e: Kind<'torus'>): Triangle[] {
  return torusQuads(e.position, e.ringRadius, e.tubeRadius).flatMap(fanTriangulate);
}

function triangulateWedge(e: Kind<'wedge'>): Triangle[] {
  return wedgeFaces(e.position, e.size).flatMap(fanTriangulate);
}

function triangulatePyramid(e: Kind<'pyramid'>): Triangle[] {
  return pyramidFaces(e).flatMap(fanTriangulate);
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
  if (is2D(e)) return [];
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
    case 'sweep':
      return sweepTriangles(e, e.position);
    case 'loft':
      return loftTriangles(e, e.position);
    case 'subdivision':
      return subdivisionTriangles(e, e.position);
    case 'instance':
      return [];
  }
}

/** World-space triangles of one entity without resolving instances (instances and 2D shapes return []). */
export function solidTriangles(e: Entity): Triangle[] {
  return applyRotationToTriangles(unrotatedTriangles(e), e.position, e.rotation);
}

/** Triangles of `e` in its own frame (before its rotation and position): decals and texture UVs. */
export function localTriangles(e: Entity): Triangle[] {
  return solidTriangles({ ...e, position: [0, 0, 0], rotation: [0, 0, 0] } as Entity);
}
