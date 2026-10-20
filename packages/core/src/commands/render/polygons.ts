/**
 * Entity → painter's-algorithm polygons for render_view: filled faces for 3D solids (rotated about their position, three.js intrinsic XYZ
 * order) and stroked paths for 2D shapes (Z-up throughout).
 */

import type { Entity, SplineEntity, Vec2, Vec3 } from '../../model/types';
import { applyEulerXYZ, isZeroRotation } from '../../lib/eulerRotation';
import { ORIGIN, add3 } from '../../lib/vec3';
import { curveDisplayPoints } from '../../geometry/nurbsCurve';
import { surfaceTriangles } from '../../geometry/nurbsSurface';
import { revolutionPolygons } from '../../geometry/revolution';
import { sweepTriangles } from '../../geometry/sweep';
import { loftTriangles } from '../../geometry/loft';
import { subdivisionTriangles } from '../../geometry/subdivision';
import {
  SEG_CIRCLE,
  boxFaces,
  extrusionRings,
  facetNormal,
  meshTriangles,
  coneSurface,
  cylinderRings,
  pyramidFaces,
  sideQuads,
  sphereQuads,
  torusQuads,
  wedgeFaces,
} from '../../geometry/tessellation';
import type { PreDepthPolygon } from './types';
import { positiveSweep } from '../../lib/angle';
import { arcPolyline } from '../../lib/arc';
import { catmullRomBeziers, segmentPoint } from '../../geometry/curveSegments';
import { planeToWorld } from '../../geometry/workPlane';

// 3D solids

/** Filled polygon whose normal comes from its first 3 vertices (degenerate faces face up). */
function makePolygon(verts: Vec3[], color: string): PreDepthPolygon {
  const [a, b, c] = verts;
  const normal: Vec3 = a && b && c ? facetNormal(a, b, c) : [0, 0, 1];
  return { verts, color, normal, stroke: false };
}

const makePolygons = (faces: Vec3[][], color: string): PreDepthPolygon[] => faces.map((verts) => makePolygon(verts, color));

/** Closed prism between two vertex rings: bottom cap (reversed, faces down), top cap, side quads. */
function prism(bottom: Vec3[], top: Vec3[], color: string): PreDepthPolygon[] {
  return makePolygons([[...bottom].reverse(), [...top], ...sideQuads(bottom, top)], color);
}

/** Rotate polygons about `position` by `rotation`; normals rotate without translation. */
function applyRotation(polys: PreDepthPolygon[], position: Vec3, rotation: Vec3): PreDepthPolygon[] {
  if (isZeroRotation(rotation)) return polys;
  return polys.map((poly) => ({
    ...poly,
    verts: poly.verts.map((v) => applyEulerXYZ(v, position, rotation)),
    normal: applyEulerXYZ(poly.normal, ORIGIN, rotation),
  }));
}

// 2D shapes: one stroked path each, lifted from the local plane to world space

function place2D(localPt: Vec2, entity: { position: Vec3; rotation: Vec3 }): Vec3 {
  return planeToWorld(entity.position, entity.rotation, localPt);
}

const stroke = (verts: Vec3[], color: string): PreDepthPolygon => ({ verts, color, normal: [0, 0, 1], stroke: true });

/** SEG_CIRCLE+1 samples of an ellipse arc from `startAngle` sweeping `span` radians. */
function strokeEllipseArc(
  e: { position: Vec3; rotation: Vec3; center: Vec2; color: string },
  radiusX: number,
  radiusY: number,
  startAngle: number,
  span: number,
): PreDepthPolygon[] {
  const verts = arcPolyline(e.center, radiusX, startAngle, span, SEG_CIRCLE, radiusY).map((point) => place2D(point, e));
  return [stroke(verts, e.color)];
}

/** The spline's centripetal Catmull-Rom curve (the same one the viewport and bounds use), 8 samples per segment. */
function tessellate2DSpline(e: SplineEntity): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const STEPS = 8;
  const verts: Vec3[] = [];
  for (const segment of catmullRomBeziers(e.points, e.closed)) {
    // Each segment starts where the previous one ended: skip the duplicate first sample.
    for (let s = verts.length > 0 ? 1 : 0; s <= STEPS; s++) {
      const [x, y] = segmentPoint(segment, s / STEPS);
      verts.push(place2D([x, y], e));
    }
  }
  return [stroke(verts, e.color)];
}

/** Polygons of one entity; 3D solids carry their rotation, 2D shapes ignore it (plane orientation is out of scope). */
export function tessellateEntity(e: Entity): PreDepthPolygon[] {
  const rotated = (faces: Vec3[][]): PreDepthPolygon[] => applyRotation(makePolygons(faces, e.color), e.position, e.rotation);
  const rotatedPrism = ({ bottom, top }: { bottom: Vec3[]; top: Vec3[] }): PreDepthPolygon[] =>
    applyRotation(prism(bottom, top, e.color), e.position, e.rotation);
  const strokePoints = (points: readonly Vec2[]): PreDepthPolygon[] => [
    stroke(
      points.map((point) => place2D(point, e)),
      e.color,
    ),
  ];
  switch (e.kind) {
    case 'box':
      return rotated(boxFaces(e.position, e.size));
    case 'cylinder':
      return rotatedPrism(cylinderRings(e));
    case 'sphere':
      return rotated(sphereQuads(e.position, e.radius));
    case 'cone': {
      const { base, sides } = coneSurface(e);
      return rotated([[...base].reverse(), ...sides]);
    }
    case 'torus':
      return rotated(torusQuads(e.position, e.ringRadius, e.tubeRadius));
    case 'wedge':
      return rotated(wedgeFaces(e.position, e.size));
    case 'pyramid':
      return rotated(pyramidFaces(e));
    case 'extrusion':
      return e.profile.length < 3 ? [] : rotatedPrism(extrusionRings(e));
    case 'revolution':
      return rotated(revolutionPolygons(e.profile, e.axis, e.angle, e.segments, e.position));
    case 'mesh':
      return rotated(meshTriangles(e.mesh, e.position));
    case 'loft':
      return rotated(loftTriangles(e, e.position).map((triangle) => [...triangle]));
    case 'subdivision':
      return rotated(subdivisionTriangles(e, e.position).map((triangle) => [...triangle]));
    case 'sweep':
      return rotated(sweepTriangles(e, e.position).map((triangle) => [...triangle]));
    case 'line':
      return strokePoints([e.start, e.end]);
    case 'polyline':
      return e.points.length < 2 ? [] : strokePoints(e.closed ? [...e.points, e.points[0] as Vec2] : e.points);
    case 'arc':
      return strokeEllipseArc(e, e.radius, e.radius, e.startAngle, positiveSweep(e.endAngle - e.startAngle));
    case 'circle':
      return strokeEllipseArc(e, e.radius, e.radius, 0, 2 * Math.PI);
    case 'rectangle':
      return strokePoints([
        [0, 0],
        [e.width, 0],
        [e.width, e.height],
        [0, e.height],
        [0, 0],
      ]);
    case 'point': {
      // A tiny cross: two short segments.
      const s = 0.1;
      return [
        ...strokePoints([
          [-s, 0],
          [s, 0],
        ]),
        ...strokePoints([
          [0, -s],
          [0, s],
        ]),
      ];
    }
    case 'ellipse':
      return strokeEllipseArc(e, e.radiusX, e.radiusY, 0, 2 * Math.PI);
    case 'spline':
      return tessellate2DSpline(e);
    case 'nurbs_surface':
      return rotated(surfaceTriangles(e.surface, e.position));
    case 'nurbs_curve':
      return [
        stroke(
          curveDisplayPoints(e.curve).map((point) => applyEulerXYZ(add3(e.position, point), e.position, e.rotation)),
          e.color,
        ),
      ];
    case 'text':
    case 'dimension':
      return []; // drawn by renderScene (annotations.ts): dimension strokes + SVG text on top
    case 'image':
      return []; // drawn by renderScene as an <image> underlay behind every polygon
    case 'instance':
      return []; // drawn by renderScene, which bakes the instance into its component's entities first
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return [];
    }
  }
}
