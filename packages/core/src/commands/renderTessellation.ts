/**
 * Entity → painter's-algorithm polygons for render_view: filled faces for 3D solids (rotated about
 * their position, three.js intrinsic XYZ order) and stroked paths for 2D shapes (Z-up throughout).
 *
 * @layer core/commands
 * @pure
 */

import type {
  ArcEntity,
  BoxEntity,
  CircleEntity,
  ConeEntity,
  CylinderEntity,
  EllipseEntity,
  Entity,
  ExtrusionEntity,
  LineEntity,
  MeshSolidEntity,
  PointEntity,
  PolylineEntity,
  PyramidEntity,
  RectangleEntity,
  RevolutionEntity,
  SphereEntity,
  SplineEntity,
  TorusEntity,
  Vec2,
  Vec3,
  WedgeEntity,
} from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { ORIGIN } from '../lib/vec3';
import { revolutionPolygons } from '../geometry/revolution';
import {
  SEG_CIRCLE,
  boxExtents,
  circlePoints,
  extrusionRings,
  facetNormal,
  meshTriangles,
  pyramidCorners,
  ringEdges,
  sideQuads,
  sphereQuads,
  torusQuads,
  wedgeCorners,
} from './tessellation';
import type { PreDepthPolygon } from './renderTypes';

// ---------------------------------------------------------------------------
// 3D solids
// ---------------------------------------------------------------------------

/** Filled polygon whose normal comes from its first 3 vertices (degenerate faces face up). */
function makePolygon(verts: Vec3[], color: string): PreDepthPolygon {
  const [a, b, c] = verts;
  const normal: Vec3 = a && b && c ? facetNormal(a, b, c) : [0, 0, 1];
  return { verts, color, normal, stroke: false };
}

const makePolygons = (faces: Vec3[][], color: string): PreDepthPolygon[] =>
  faces.map((verts) => makePolygon(verts, color));

/** Closed prism between two vertex rings: bottom cap (reversed, faces down), top cap, side quads. */
function prism(bottom: Vec3[], top: Vec3[], color: string): PreDepthPolygon[] {
  return makePolygons([[...bottom].reverse(), [...top], ...sideQuads(bottom, top)], color);
}

function tessellateBox(e: BoxEntity): PreDepthPolygon[] {
  const { x0, x1, y0, y1, z0, z1 } = boxExtents(e.position, e.size);
  // 6 quads (CCW when viewed from outside, Z-up): bottom, top, front, back, left, right.
  return makePolygons(
    [
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      [
        [x0, y0, z1],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y0, z0],
      ],
      [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x0, y1, z1],
        [x0, y0, z1],
      ],
      [
        [x1, y0, z0],
        [x1, y0, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
    ],
    e.color,
  );
}

/** Z-up cylinder: axis along Z, centered at position. */
function tessellateCylinder(e: CylinderEntity): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const bottom = circlePoints(px, py, pz - e.height / 2, e.radius, SEG_CIRCLE);
  const top = circlePoints(px, py, pz + e.height / 2, e.radius, SEG_CIRCLE);
  return prism(bottom, top, e.color);
}

function tessellateSphere(e: SphereEntity): PreDepthPolygon[] {
  return makePolygons(sphereQuads(e.position, e.radius), e.color);
}

/** Z-up cone: base circle in XY at position, apex at position+[0,0,height]. */
function tessellateCone(e: ConeEntity): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const base = circlePoints(px, py, pz, e.radius, SEG_CIRCLE);
  const apex: Vec3 = [px, py, pz + e.height];
  // Base cap (reversed winding = face down), then one side triangle per base edge.
  return makePolygons(
    [[...base].reverse(), ...ringEdges(base).map(([from, to]): Vec3[] => [from, to, apex])],
    e.color,
  );
}

/** Torus: ring in XY plane, tube extends ±tubeRadius in Z. */
function tessellateTorus(e: TorusEntity): PreDepthPolygon[] {
  return makePolygons(torusQuads(e.position, e.ringRadius, e.tubeRadius), e.color);
}

/** Wedge: lower-front-left corner at position; the back edge is degenerate, so there is no back face. */
function tessellateWedge(e: WedgeEntity): PreDepthPolygon[] {
  const { f00, f10, f11, f01, b00, b10 } = wedgeCorners(e.position, e.size);
  return makePolygons(
    [
      [f00, f10, f11, f01], // front
      [f00, b00, b10, f10], // bottom
      [f00, f01, b00], // left triangle
      [f10, b10, f11], // right triangle
      [f01, f11, b10, b00], // top slope
    ],
    e.color,
  );
}

/** Pyramid: rectangular base centered at position in XY, apex at position+[0,0,height]. */
function tessellatePyramid(e: PyramidEntity): PreDepthPolygon[] {
  const { b00, b10, b11, b01, apex } = pyramidCorners(e);
  return makePolygons(
    [
      [b00, b01, b11, b10], // base, facing down
      [b00, b10, apex],
      [b10, b11, apex],
      [b11, b01, apex],
      [b01, b00, apex],
    ],
    e.color,
  );
}

/** Revolution: closed profile swept about an axis (frames and caps: geometry/revolution.ts). */
function tessellateRevolution(e: RevolutionEntity): PreDepthPolygon[] {
  return makePolygons(
    revolutionPolygons(e.profile, e.axis, e.angle, e.segments, e.position),
    e.color,
  );
}

/** Extrusion: closed XY profile at position, extruded +Z by depth. */
function tessellateExtrusion(e: ExtrusionEntity): PreDepthPolygon[] {
  if (e.profile.length < 3) return [];
  const { bottom, top } = extrusionRings(e);
  return prism(bottom, top, e.color);
}

/** Mesh solid: world-space triangles — indexed (kernel output) or a soup when indices is empty. */
function tessellateMesh(e: MeshSolidEntity): PreDepthPolygon[] {
  return makePolygons(meshTriangles(e.mesh), e.color);
}

/** Rotate polygons about `position` by `rotation`; normals rotate without translation. */
function applyRotation(
  polys: PreDepthPolygon[],
  position: Vec3,
  rotation: Vec3,
): PreDepthPolygon[] {
  if (isZeroRotation(rotation)) return polys;
  return polys.map((poly) => ({
    ...poly,
    verts: poly.verts.map((v) => applyEulerXYZ(v, position, rotation)),
    normal: applyEulerXYZ(poly.normal, ORIGIN, rotation),
  }));
}

// ---------------------------------------------------------------------------
// 2D shapes: one stroked path each, lifted from the local plane to world space
// ---------------------------------------------------------------------------

function place2D(localPt: Vec2, position: Vec3): Vec3 {
  return [position[0] + localPt[0], position[1] + localPt[1], position[2]];
}

const stroke = (verts: Vec3[], color: string): PreDepthPolygon => ({
  verts,
  color,
  normal: [0, 0, 1],
  stroke: true,
});

/** SEG_CIRCLE+1 samples of an ellipse arc from `startAngle` sweeping `span` radians. */
function strokeEllipseArc(
  e: { position: Vec3; center: Vec2; color: string },
  radiusX: number,
  radiusY: number,
  startAngle: number,
  span: number,
): PreDepthPolygon[] {
  const verts: Vec3[] = [];
  for (let i = 0; i <= SEG_CIRCLE; i++) {
    const a = startAngle + (span * i) / SEG_CIRCLE;
    verts.push(
      place2D(
        [e.center[0] + radiusX * Math.cos(a), e.center[1] + radiusY * Math.sin(a)],
        e.position,
      ),
    );
  }
  return [stroke(verts, e.color)];
}

function tessellate2DLine(e: LineEntity): PreDepthPolygon[] {
  return [stroke([place2D(e.start, e.position), place2D(e.end, e.position)], e.color)];
}

function tessellate2DPolyline(e: PolylineEntity): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const verts = e.points.map((pt) => place2D(pt, e.position));
  if (e.closed) verts.push(verts[0] as Vec3);
  return [stroke(verts, e.color)];
}

function tessellate2DArc(e: ArcEntity): PreDepthPolygon[] {
  let span = e.endAngle - e.startAngle;
  if (span <= 0) span += 2 * Math.PI;
  return strokeEllipseArc(e, e.radius, e.radius, e.startAngle, span);
}

function tessellate2DCircle(e: CircleEntity): PreDepthPolygon[] {
  return strokeEllipseArc(e, e.radius, e.radius, 0, 2 * Math.PI);
}

function tessellate2DRectangle(e: RectangleEntity): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const verts: Vec3[] = [
    [px, py, pz],
    [px + e.width, py, pz],
    [px + e.width, py + e.height, pz],
    [px, py + e.height, pz],
    [px, py, pz],
  ];
  return [stroke(verts, e.color)];
}

function tessellate2DEllipse(e: EllipseEntity): PreDepthPolygon[] {
  return strokeEllipseArc(e, e.radiusX, e.radiusY, 0, 2 * Math.PI);
}

/** Uniform Catmull-Rom interpolation of one coordinate between `p1` and `p2` at `t` in [0, 1]. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Uniform Catmull-Rom spline through the points (they ARE the control points), 8 samples per segment. */
function tessellate2DSpline(e: SplineEntity): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const STEPS = 8;
  const pts = e.closed ? [...e.points, e.points[0] as Vec2] : [...e.points];
  // Duplicated end points act as the missing neighbours of the first and last segments.
  const extended = [pts[0] as Vec2, ...pts, pts[pts.length - 1] as Vec2];
  const verts: Vec3[] = [];
  for (let i = 1; i < extended.length - 2; i++) {
    const [p0, p1, p2, p3] = extended.slice(i - 1, i + 3) as [Vec2, Vec2, Vec2, Vec2];
    // Each segment starts where the previous one ended: skip the duplicate first sample.
    for (let s = verts.length > 0 ? 1 : 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const x = catmullRom(p0[0], p1[0], p2[0], p3[0], t);
      const y = catmullRom(p0[1], p1[1], p2[1], p3[1], t);
      verts.push(place2D([x, y], e.position));
    }
  }
  return [stroke(verts, e.color)];
}

/** A tiny cross: two short segments. */
function tessellate2DPoint(e: PointEntity): PreDepthPolygon[] {
  const [px, py, pz] = e.position;
  const s = 0.1;
  return [
    stroke(
      [
        [px - s, py, pz],
        [px + s, py, pz],
      ],
      e.color,
    ),
    stroke(
      [
        [px, py - s, pz],
        [px, py + s, pz],
      ],
      e.color,
    ),
  ];
}

/** Polygons of one entity; 3D solids carry their rotation, 2D shapes ignore it (plane orientation is out of scope). */
export function tessellateEntity(e: Entity): PreDepthPolygon[] {
  const rotated = (polys: PreDepthPolygon[]): PreDepthPolygon[] =>
    applyRotation(polys, e.position, e.rotation);
  switch (e.kind) {
    case 'box':
      return rotated(tessellateBox(e));
    case 'cylinder':
      return rotated(tessellateCylinder(e));
    case 'sphere':
      return rotated(tessellateSphere(e));
    case 'cone':
      return rotated(tessellateCone(e));
    case 'torus':
      return rotated(tessellateTorus(e));
    case 'wedge':
      return rotated(tessellateWedge(e));
    case 'pyramid':
      return rotated(tessellatePyramid(e));
    case 'extrusion':
      return rotated(tessellateExtrusion(e));
    case 'revolution':
      return rotated(tessellateRevolution(e));
    case 'mesh':
      return rotated(tessellateMesh(e));
    case 'line':
      return tessellate2DLine(e);
    case 'polyline':
      return tessellate2DPolyline(e);
    case 'arc':
      return tessellate2DArc(e);
    case 'circle':
      return tessellate2DCircle(e);
    case 'rectangle':
      return tessellate2DRectangle(e);
    case 'point':
      return tessellate2DPoint(e);
    case 'ellipse':
      return tessellate2DEllipse(e);
    case 'spline':
      return tessellate2DSpline(e);
    case 'text':
      return []; // not drawn in render_view SVG; the viewport renders text
    case 'dimension':
      return []; // not drawn in render_view SVG; the viewport renders dimensions
    case 'instance':
      return []; // drawn by renderScene, which bakes the instance into its component's entities first
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return [];
    }
  }
}
