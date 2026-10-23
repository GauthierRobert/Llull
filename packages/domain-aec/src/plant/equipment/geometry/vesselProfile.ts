/**
 * Revolve profiles of a vessel (plant 03 EQP §5.1): the meridian of each formed head and the closed wall-section band of shell + heads.
 * Head profiles come from ONE function, `headProfileCurves`; its ellipsoidal branch is where the exact `ellipse` curve segment (decision Q3)
 * replaces the cubic Bézier approximation. Volumes and weights never read these curves (closed forms, M1).
 */

import type { CurveSegment } from '@core/model/curve';
import type { Vec2 } from '@core/model/vectors';
import { reverseChain, sampleProfile } from '@core/geometry/curveSegments';
import type { HeadShape } from './heads';
import type { VesselGeometry } from './vesselFrame';

type Curves = CurveSegment<Vec2>[];

const TOLERANCE = 1e-9;
const OFFSET_PIECES = 12;
const DERIVATIVE_STEP = 1e-6;

const line = (from: Vec2, to: Vec2): Curves =>
  Math.hypot(to[0] - from[0], to[1] - from[1]) < TOLERANCE ? [] : [{ type: 'line', points: [from, to] }];

/** Point of the ellipse (semi-axes a, b) offset outward by t along the normal, at parameter u (0 = rim, pi/2 = apex). */
function ellipseOffsetPoint(a: number, b: number, t: number, u: number): Vec2 {
  const norm = Math.hypot(a * Math.sin(u), b * Math.cos(u));
  return [a * Math.cos(u) + (t * b * Math.cos(u)) / norm, b * Math.sin(u) + (t * a * Math.sin(u)) / norm];
}

/** The ellipse (offset 0) or its offset curve as 12 cubic Hermite pieces (Bézier form), exact end points, central-difference tangents: error far below 1e-5 R. */
function ellipseOffsetBeziers(a: number, b: number, t: number): Curves {
  const step = Math.PI / 2 / OFFSET_PIECES;
  const slope = (u: number): Vec2 => {
    const [before, after] = [ellipseOffsetPoint(a, b, t, u - DERIVATIVE_STEP), ellipseOffsetPoint(a, b, t, u + DERIVATIVE_STEP)];
    return [(after[0] - before[0]) / (2 * DERIVATIVE_STEP), (after[1] - before[1]) / (2 * DERIVATIVE_STEP)];
  };
  return Array.from({ length: OFFSET_PIECES }, (_unused, index): CurveSegment<Vec2> => {
    const [u0, u1] = [index * step, (index + 1) * step];
    const [p0, p3, d0, d1] = [ellipseOffsetPoint(a, b, t, u0), ellipseOffsetPoint(a, b, t, u1), slope(u0), slope(u1)];
    return {
      type: 'bezier',
      points: [p0, [p0[0] + (step / 3) * d0[0], p0[1] + (step / 3) * d0[1]], [p3[0] - (step / 3) * d1[0], p3[1] - (step / 3) * d1[1]], p3],
    };
  });
}

/** Circular arc centre `c`, radius `rho`, from direction angle `from` to `to` (angle measured from the +h axis toward +r). */
function circleArc(centre: Vec2, rho: number, from: number, to: number): CurveSegment<Vec2> {
  const at = (phi: number): Vec2 => [centre[0] + rho * Math.sin(phi), centre[1] + rho * Math.cos(phi)];
  return { type: 'arc', points: [at(from), at((from + to) / 2), at(to)] };
}

/**
 * Meridian of a head's surface offset outward by `offset` (0 = inside surface), from the rim to the apex, in (r, h): r from the axis, h from
 * the tangent line along the axis away from the shell. Torispherical / spherical offsets keep their centres (exact arcs); the ellipsoidal
 * curve (the offset is not an ellipse) is 12 Hermite Bézier pieces through exact points and tangents (error far below 1e-5 R); a conical offset is
 * the offset cone; a flat head's offset is a plate of thickness `offset`.
 */
export function headProfileCurves(shape: HeadShape, radius: number, offset: number): Curves {
  switch (shape.kind) {
    case 'flat':
      return offset < TOLERANCE
        ? line([radius, 0], [0, 0])
        : [...line([radius + offset, 0], [radius + offset, offset]), ...line([radius + offset, offset], [0, offset])];
    case 'ellipsoidal':
      return ellipseOffsetBeziers(radius, shape.depth, offset);
    case 'spherical': {
      const sphere = (radius * radius + shape.depth * shape.depth) / (2 * shape.depth);
      const centreHeight = shape.depth - sphere;
      const rho = sphere + offset;
      const rim = Math.sqrt(Math.max(0, rho * rho - centreHeight * centreHeight));
      return [circleArc([0, centreHeight], rho, Math.atan2(rim, -centreHeight), 0)];
    }
    case 'conical': {
      const cosine = shape.depth / Math.hypot(radius, shape.depth);
      const outerRadius = radius + offset / cosine;
      return line([outerRadius, 0], [0, (shape.depth * outerRadius) / radius]);
    }
    case 'torispherical': {
      const knuckleCentre: Vec2 = [radius - shape.knuckleRadius, 0];
      const crownCentre: Vec2 = [0, shape.depth - shape.crownRadius];
      return [
        circleArc(knuckleCentre, shape.knuckleRadius + offset, Math.PI / 2, shape.alpha),
        circleArc(crownCentre, shape.crownRadius + offset, shape.alpha, 0),
      ];
    }
  }
}

const mapCurve = (segment: CurveSegment<Vec2>, f: (point: Vec2) => Vec2): CurveSegment<Vec2> =>
  segment.type === 'line'
    ? { type: 'line', points: [f(segment.points[0]), f(segment.points[1])] }
    : segment.type === 'arc'
      ? { type: 'arc', points: [f(segment.points[0]), f(segment.points[1]), f(segment.points[2])] }
      : { type: 'bezier', points: [f(segment.points[0]), f(segment.points[1]), f(segment.points[2]), f(segment.points[3])] };

const mapCurves = (segments: Curves, f: (point: Vec2) => Vec2): Curves => segments.map((segment) => mapCurve(segment, f));

const startOf = (segments: Curves): Vec2 => (segments[0] as CurveSegment<Vec2>).points[0];
const endOf = (segments: Curves): Vec2 => (segments[segments.length - 1] as CurveSegment<Vec2>).points.at(-1) as Vec2;

/** Arc sampling leaves axis points a few 1e-14 off the axis; a revolve profile must stay on the positive side (Pappus volume). */
const onAxis = ([radial, axial]: Vec2): Vec2 => [radial < TOLERANCE ? 0 : radial, axial];

/** Height of the head apex above its tangent line for the surface offset by `offset` (conical offsets move the apex by t / sin(half-angle)). */
export const headApexHeight = (shape: HeadShape, radius: number, offset: number): number =>
  endOf(headProfileCurves(shape, radius, offset))[1];

export interface ProfileBand {
  /** Exact closed boundary (lines, arcs, Béziers). */
  readonly curves: Curves;
  /** Its tessellation. */
  readonly profile: Vec2[];
}

/**
 * Closed (radial, axial) wall section of shell + both heads, axial position measured from the first tangent line: the first head bulges
 * toward negative axial, the second toward positive. Outer boundary up, along the axis, inner boundary down; thickness steps between shell
 * and head are closed by short radial lines.
 */
export function vesselBand(geometry: VesselGeometry, firstTangent: number): ProfileBand {
  const { radius, shellThickness: ts, headThickness: th } = geometry;
  const secondTangent = firstTangent + geometry.length;
  const atFirst = ([r, h]: Vec2): Vec2 => [r, firstTangent - h];
  const atSecond = ([r, h]: Vec2): Vec2 => [r, secondTangent + h];
  const outerFirst = headProfileCurves(geometry.first, radius, th);
  const outerSecond = headProfileCurves(geometry.second, radius, th);
  const innerFirst = headProfileCurves(geometry.first, radius, 0);
  const innerSecond = headProfileCurves(geometry.second, radius, 0);
  const rimFirst = startOf(outerFirst)[0];
  const rimSecond = startOf(outerSecond)[0];
  const outerShell = radius + ts;
  const apexOuterFirst = atFirst(startOf(reverseChain(outerFirst)));
  const curves: Curves = [
    ...mapCurves(reverseChain(outerFirst), atFirst),
    ...line([rimFirst, firstTangent], [outerShell, firstTangent]),
    ...line([outerShell, firstTangent], [outerShell, secondTangent]),
    ...line([outerShell, secondTangent], [rimSecond, secondTangent]),
    ...mapCurves(outerSecond, atSecond),
  ];
  const apexOuterSecond = atSecond(endOf(outerSecond));
  const apexInnerSecond = atSecond(endOf(innerSecond));
  const apexInnerFirst = atFirst(endOf(innerFirst));
  curves.push(
    ...line(apexOuterSecond, apexInnerSecond),
    ...mapCurves(reverseChain(innerSecond), atSecond),
    ...line([radius, secondTangent], [radius, firstTangent]),
    ...mapCurves(innerFirst, atFirst),
    ...line(apexInnerFirst, apexOuterFirst),
  );
  return { curves, profile: sampleProfile(curves).map(onAxis) };
}

/** Closed rectangle section (r0..r1 radial, a0..a1 axial) for rings, skirts and base plates. */
export function ringSection(innerRadius: number, outerRadius: number, from: number, to: number): ProfileBand {
  const profile: Vec2[] = [
    [innerRadius, from],
    [outerRadius, from],
    [outerRadius, to],
    [innerRadius, to],
  ];
  const curves: Curves = profile.flatMap((point, index) => line(point, profile[(index + 1) % profile.length] as Vec2));
  return { curves, profile };
}
