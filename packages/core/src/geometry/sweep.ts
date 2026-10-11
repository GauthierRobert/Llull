/**
 * @layer core/geometry
 * Sweep tessellation shared by export, kernels' mesh path and the viewport: the section is carried
 * along the sampled path by a rotation-minimizing frame (double reflection, Wang et al. 2008).
 * Start frame: binormal (section +y) is world +Z projected off the tangent (+Y when the path starts
 * vertical), normal (section +x) = binormal × tangent.
 */

import type { CurveSegment } from '../model/curve';
import type { SweepSection, Vec2, Vec3 } from '../model/types';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';
import { signedArea } from '../lib/polygon';
import { triangulatePolygon } from '../lib/triangulate';
import { segmentPoint, segmentSteps, segmentTangent } from './curveSegments';

/** Vertices around a circular sweep section. */
export const SWEEP_CIRCLE_SEGMENTS = 24;

type Triangle = readonly [Vec3, Vec3, Vec3];

/** One path sample with its section axes. */
export interface SweepFrame {
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  /** Index of the path segment the sample ends (0 for the start sample). */
  readonly segment: number;
}

/** Section axes at the path start (see the module doc). */
export function sweepStartAxes(tangent: Vec3): { normal: Vec3; binormal: Vec3 } {
  const reference: Vec3 = Math.abs(tangent[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0];
  const binormal = normalize3(sub3(reference, scale3(tangent, dot3(reference, tangent))));
  return { normal: cross3(binormal, tangent), binormal };
}

function reflect(v: Vec3, axis: Vec3, axisSq: number): Vec3 {
  return sub3(v, scale3(axis, (2 / axisSq) * dot3(axis, v)));
}

/** Rotation-minimizing frames at every path sample (joints not repeated). */
export function sweepFrames(path: ReadonlyArray<CurveSegment<Vec3>>): SweepFrame[] {
  const samples: Array<{ point: Vec3; tangent: Vec3; segment: number }> = [];
  path.forEach((segment, index) => {
    const steps = segmentSteps(segment);
    for (let s = index === 0 ? 0 : 1; s <= steps; s++) {
      samples.push({
        point: segmentPoint(segment, s / steps),
        tangent: segmentTangent(segment, s / steps),
        segment: index,
      });
    }
  });
  const first = samples[0];
  if (first === undefined) return [];
  const frames: SweepFrame[] = [{ ...first, ...sweepStartAxes(first.tangent) }];
  for (let i = 1; i < samples.length; i++) {
    const previous = frames[i - 1] as SweepFrame;
    const { point, tangent, segment } = samples[i] as (typeof samples)[number];
    const v1 = sub3(point, previous.point);
    const c1 = dot3(v1, v1);
    let normal = previous.normal;
    if (c1 > 1e-24) {
      const reflectedNormal = reflect(previous.normal, v1, c1);
      const v2 = sub3(tangent, reflect(previous.tangent, v1, c1));
      const c2 = dot3(v2, v2);
      normal = c2 > 1e-24 ? reflect(reflectedNormal, v2, c2) : reflectedNormal;
    }
    normal = normalize3(sub3(normal, scale3(tangent, dot3(normal, tangent))));
    frames.push({ point, tangent, normal, binormal: cross3(tangent, normal), segment });
  }
  return frames;
}

/** Section loops in section coordinates: CCW outer boundary and optional CCW bore (same count). */
export function sectionLoops(section: SweepSection): { outer: Vec2[]; inner: Vec2[] | null } {
  if (section.shape === 'profile') {
    const outer =
      signedArea(section.profile) < 0 ? [...section.profile].reverse() : [...section.profile];
    return { outer, inner: null };
  }
  const ring = (radius: number): Vec2[] =>
    Array.from({ length: SWEEP_CIRCLE_SEGMENTS }, (_, k): Vec2 => {
      const angle = (2 * Math.PI * k) / SWEEP_CIRCLE_SEGMENTS;
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    });
  const bore = section.innerRadius;
  return {
    outer: ring(section.radius),
    inner: bore !== undefined && bore > 0 && bore < section.radius ? ring(bore) : null,
  };
}

/**
 * Outer section rings grouped per path segment (each group includes the joint ring it starts
 * from), carried by the same continuous frames as `sweepTriangles`.
 */
export function sweepSegmentRings(
  path: ReadonlyArray<CurveSegment<Vec3>>,
  section: SweepSection,
): Vec3[][] {
  const frames = sweepFrames(path);
  const { outer } = sectionLoops(section);
  return path.map((_, index) =>
    frames
      .filter((frame, i) => frame.segment === index || frames[i + 1]?.segment === index)
      .flatMap((frame) =>
        outer.map(([x, y]) =>
          add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y))),
        ),
      ),
  );
}

const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Triangle[] => [
  [a, b, c],
  [a, c, d],
];

/** Wall quads between two rings, outward for a CCW section (flip for a bore). */
function walls(lower: readonly Vec3[], upper: readonly Vec3[], flip: boolean): Triangle[] {
  return lower.flatMap((_, j) => {
    const k = (j + 1) % lower.length;
    const [a, b, c, d] = [lower[j], lower[k], upper[k], upper[j]] as [Vec3, Vec3, Vec3, Vec3];
    return flip ? quad(d, c, b, a) : quad(a, b, c, d);
  });
}

/**
 * Closed, outward-wound triangles of a sweep; `origin` is added to every vertex.
 * @invariant shared ring vertices are the same Vec3 values, so the soup welds watertight
 */
export function sweepTriangles(
  path: ReadonlyArray<CurveSegment<Vec3>>,
  section: SweepSection,
  origin: Vec3 = [0, 0, 0],
): Triangle[] {
  const frames = sweepFrames(path);
  const { outer, inner } = sectionLoops(section);
  if (frames.length < 2 || outer.length < 3) return [];
  const ringAt = (frame: SweepFrame, loop: readonly Vec2[]): Vec3[] =>
    loop.map(([x, y]) =>
      add3(origin, add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y)))),
    );
  const outerRings = frames.map((frame) => ringAt(frame, outer));
  const innerRings = inner === null ? null : frames.map((frame) => ringAt(frame, inner));
  const triangles: Triangle[] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    triangles.push(...walls(outerRings[i] as Vec3[], outerRings[i + 1] as Vec3[], false));
    if (innerRings !== null)
      triangles.push(...walls(innerRings[i] as Vec3[], innerRings[i + 1] as Vec3[], true));
  }
  const [startOuter, endOuter] = [outerRings[0] as Vec3[], outerRings[frames.length - 1] as Vec3[]];
  if (innerRings !== null) {
    const [startInner, endInner] = [
      innerRings[0] as Vec3[],
      innerRings[frames.length - 1] as Vec3[],
    ];
    outer.forEach((_, j) => {
      const k = (j + 1) % outer.length;
      const at = (ring: Vec3[], index: number): Vec3 => ring[index] as Vec3;
      triangles.push(...quad(at(endOuter, j), at(endOuter, k), at(endInner, k), at(endInner, j)));
      triangles.push(
        ...quad(at(startInner, j), at(startInner, k), at(startOuter, k), at(startOuter, j)),
      );
    });
    return triangles;
  }
  for (const [a, b, c] of triangulatePolygon(outer).triangles) {
    const pick = (ring: Vec3[], index: number): Vec3 => ring[index] as Vec3;
    triangles.push([pick(endOuter, a), pick(endOuter, b), pick(endOuter, c)]);
    triangles.push([pick(startOuter, a), pick(startOuter, c), pick(startOuter, b)]);
  }
  return triangles;
}
