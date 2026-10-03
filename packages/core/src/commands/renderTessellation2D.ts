import type { Vec3, Vec2 } from '../model/types';
import { SEG_CIRCLE } from './tessellation';
import { type PreDepthPolygon } from './renderTypes';

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

export function tessellate2DLine(e: {
  position: Vec3;
  start: Vec2;
  end: Vec2;
  color: string;
}): PreDepthPolygon[] {
  return [stroke([place2D(e.start, e.position), place2D(e.end, e.position)], e.color)];
}

export function tessellate2DPolyline(e: {
  position: Vec3;
  points: ReadonlyArray<Vec2>;
  closed: boolean;
  color: string;
}): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const verts = e.points.map((pt) => place2D(pt, e.position));
  if (e.closed) verts.push(verts[0]!);
  return [stroke(verts, e.color)];
}

export function tessellate2DArc(e: {
  position: Vec3;
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
  color: string;
}): PreDepthPolygon[] {
  let span = e.endAngle - e.startAngle;
  if (span <= 0) span += 2 * Math.PI;
  return strokeEllipseArc(e, e.radius, e.radius, e.startAngle, span);
}

export function tessellate2DCircle(e: {
  position: Vec3;
  center: Vec2;
  radius: number;
  color: string;
}): PreDepthPolygon[] {
  return strokeEllipseArc(e, e.radius, e.radius, 0, 2 * Math.PI);
}

export function tessellate2DRectangle(e: {
  position: Vec3;
  width: number;
  height: number;
  color: string;
}): PreDepthPolygon[] {
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

export function tessellate2DEllipse(e: {
  position: Vec3;
  center: Vec2;
  radiusX: number;
  radiusY: number;
  color: string;
}): PreDepthPolygon[] {
  return strokeEllipseArc(e, e.radiusX, e.radiusY, 0, 2 * Math.PI);
}

/**
 * Catmull-Rom spline tessellation with centripetal parameterization.
 * The through-points ARE the control points.
 */
export function tessellate2DSpline(e: {
  position: Vec3;
  points: ReadonlyArray<Vec2>;
  closed: boolean;
  color: string;
}): PreDepthPolygon[] {
  if (e.points.length < 2) return [];
  const pts = [...e.points];
  if (e.closed) pts.push(pts[0]!);

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
      const t2 = t * t,
        t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      if (s === 0 && verts.length > 0) continue; // avoid duplicating junction
      verts.push(place2D([x, y], e.position));
    }
  }
  return [stroke(verts, e.color)];
}

export function tessellate2DPoint(e: { position: Vec3; color: string }): PreDepthPolygon[] {
  // A tiny cross: two short segments.
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
