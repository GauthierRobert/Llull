/**
 * @layer core/geometry
 * Sweep tessellation shared by export, kernels' mesh path and the viewport: the section is carried
 * along the sampled path by a rotation-minimizing frame (double reflection, Wang et al. 2008).
 * Start frame: binormal (section +y) is world +Z projected off the tangent (+Y when the path starts
 * vertical), normal (section +x) = binormal × tangent. Variable sections (`stations`) blend
 * section rings (./sectionRing) along the arc length and are skinned by ./skin.
 */

import type { CurveSegment } from '../model/curve';
import type { SweepEntity, SweepSection, SweepStation, Vec2, Vec3 } from '../model/types';
import { add3, cross3, dot3, lerp3, normalize3, scale3, sub3 } from '../lib/vec3';
import { segmentLengths } from '../lib/polyline';
import { toCounterClockwise } from '../lib/polygon';
import { triangulatePolygon } from '../lib/triangulate';
import { isClosedChain, segmentPoint, segmentSteps, segmentTangent } from './curveSegments';
import { sampleRing } from './sectionRing';
import { quad, ringWalls as walls, skinTriangles } from './skin';
import type { Triangle } from './triangles';
import { clamp01 } from '../lib/clamp';

/** Vertices around a circular sweep section. */
const SWEEP_CIRCLE_SEGMENTS = 24;

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
  return isClosedChain(path) && frames.length > 2 ? closeFrames(frames) : frames;
}

/**
 * Frames of a closed path: the duplicated end sample is dropped and the rotation-minimizing
 * frame's holonomy (the twist it gains going once round) is spread linearly along the arc length,
 * so the last frame meets the first without a jump.
 */
function closeFrames(frames: SweepFrame[]): SweepFrame[] {
  const open = frames.slice(0, -1);
  const first = open[0] as SweepFrame;
  const last = frames[frames.length - 1] as SweepFrame;
  const twist = Math.atan2(dot3(cross3(first.normal, last.normal), first.tangent), dot3(first.normal, last.normal));
  const fractions = frameFractions(frames);
  return open.map((frame, i) => {
    const angle = -twist * (fractions[i] as number);
    const normal = add3(scale3(frame.normal, Math.cos(angle)), scale3(cross3(frame.tangent, frame.normal), Math.sin(angle)));
    return { ...frame, normal, binormal: cross3(frame.tangent, normal) };
  });
}

/** Section loops in section coordinates: CCW outer boundary and optional CCW bore (same count). */
function sectionLoops(section: SweepSection): { outer: Vec2[]; inner: Vec2[] | null } {
  if (section.shape === 'profile') {
    const outer = toCounterClockwise(section.profile);
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
export function sweepSegmentRings(sweep: SweepShape): Vec3[][] {
  const { path, section, stations } = sweep;
  const frames = sweepFrames(path);
  const fractions = frameFractions(frames);
  const { outer } = sectionLoops(section);
  const loopAt = (i: number): Vec2[] =>
    stations !== undefined && stations.length >= 2 ? stationLoopAt(stations, fractions[i] as number) : outer;
  return path.map((_, index) =>
    frames
      .filter((frame, i) => frame.segment === index || frames[i + 1]?.segment === index)
      .flatMap((frame) =>
        loopAt(frames.indexOf(frame)).map(([x, y]) => add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y)))),
      ),
  );
}

/** What a sweep's geometry depends on (a SweepEntity satisfies it). */
export type SweepShape = Pick<SweepEntity, 'path' | 'section'> & {
  readonly stations?: SweepEntity['stations'];
};

/** Arc-length fraction (0..1) of every frame along the path. */
function frameFractions(frames: readonly SweepFrame[]): number[] {
  const distances = [0];
  for (const length of segmentLengths(frames.map((frame) => frame.point)))
    distances.push((distances[distances.length - 1] as number) + length);
  const total = distances[distances.length - 1] as number;
  return distances.map((d) => (total > 0 ? d / total : 0));
}

/** Point and section axes at path fraction `t` (0..1), interpolated between sampled frames. */
export function frameAtFraction(path: ReadonlyArray<CurveSegment<Vec3>>, t: number): Pick<SweepFrame, 'point' | 'normal' | 'binormal'> {
  const open = sweepFrames(path);
  // A loop's last span runs back to the first frame (the twist correction makes them meet).
  const frames = isClosedChain(path) && open[0] !== undefined ? [...open, open[0]] : open;
  const fractions = frameFractions(frames);
  let i = 0;
  while (i < frames.length - 2 && t > (fractions[i + 1] as number)) i++;
  const a = frames[i] as SweepFrame;
  const b = (frames[i + 1] ?? a) as SweepFrame;
  const span = (fractions[i + 1] ?? 1) - (fractions[i] ?? 0);
  const u = span > 0 ? clamp01((t - (fractions[i] as number)) / span) : 0;
  const lerp = (p: Vec3, q: Vec3): Vec3 => lerp3(p, q, u);
  const normal = normalize3(lerp(a.normal, b.normal));
  const tangent = normalize3(lerp(a.tangent, b.tangent));
  return { point: lerp(a.point, b.point), normal, binormal: cross3(tangent, normal) };
}

/**
 * Section ring (SECTION_RING_POINTS points, section coordinates) at path fraction `t`: the two
 * neighbouring station rings blended with a smoothstep weight (tangent-continuous at stations).
 */
export function stationRingAt(stations: ReadonlyArray<SweepStation>, t: number): Vec2[] {
  let span = 0;
  while (span < stations.length - 2 && t > (stations[span + 1] as SweepStation).at) span++;
  const a = stations[span] as SweepStation;
  const b = stations[span + 1] as SweepStation;
  const u = clamp01((t - a.at) / Math.max(1e-12, b.at - a.at));
  const w = u * u * (3 - 2 * u);
  return a.ring.map((p, i): Vec2 => {
    const q = b.ring[i] as Vec2;
    return [p[0] + w * (q[0] - p[0]), p[1] + w * (q[1] - p[1])];
  });
}

/** Dense section loop at path fraction `t` (the sampled curve of `stationRingAt`). */
function stationLoopAt(stations: ReadonlyArray<SweepStation>, t: number): Vec2[] {
  return sampleRing(stationRingAt(stations, t)).map(([x, y]): Vec2 => [x, y]);
}

/** Walls of a sweep round a closed path: consecutive rings joined, the last back to the first. */
function closedWalls(outerRings: Vec3[][], innerRings: Vec3[][] | null): Triangle[] {
  const triangles: Triangle[] = [];
  for (let i = 0; i < outerRings.length; i++) {
    const next = (i + 1) % outerRings.length;
    triangles.push(...walls(outerRings[i] as Vec3[], outerRings[next] as Vec3[], false));
    if (innerRings !== null) triangles.push(...walls(innerRings[i] as Vec3[], innerRings[next] as Vec3[], true));
  }
  return triangles;
}

/**
 * Closed, outward-wound triangles of a sweep; `origin` is added to every vertex.
 * @invariant shared ring vertices are the same Vec3 values, so the soup welds watertight
 */
export function sweepTriangles(sweep: SweepShape, origin: Vec3 = [0, 0, 0]): Triangle[] {
  const { path, section, stations } = sweep;
  if (stations !== undefined && stations.length >= 2) {
    const frames = sweepFrames(path);
    const fractions = frameFractions(frames);
    return skinTriangles(
      frames.map((frame, i) =>
        stationLoopAt(stations, fractions[i] as number).map(([x, y]) =>
          add3(origin, add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y)))),
        ),
      ),
    );
  }
  const frames = sweepFrames(path);
  const { outer, inner } = sectionLoops(section);
  if (frames.length < 2 || outer.length < 3) return [];
  const ringAt = (frame: SweepFrame, loop: readonly Vec2[]): Vec3[] =>
    loop.map(([x, y]) => add3(origin, add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y)))));
  const outerRings = frames.map((frame) => ringAt(frame, outer));
  const innerRings = inner === null ? null : frames.map((frame) => ringAt(frame, inner));
  if (isClosedChain(path)) return closedWalls(outerRings, innerRings);
  const triangles: Triangle[] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    triangles.push(...walls(outerRings[i] as Vec3[], outerRings[i + 1] as Vec3[], false));
    if (innerRings !== null) triangles.push(...walls(innerRings[i] as Vec3[], innerRings[i + 1] as Vec3[], true));
  }
  const [startOuter, endOuter] = [outerRings[0] as Vec3[], outerRings[frames.length - 1] as Vec3[]];
  if (innerRings !== null) {
    const [startInner, endInner] = [innerRings[0] as Vec3[], innerRings[frames.length - 1] as Vec3[]];
    outer.forEach((_, j) => {
      const k = (j + 1) % outer.length;
      const at = (ring: Vec3[], index: number): Vec3 => ring[index] as Vec3;
      triangles.push(...quad(at(endOuter, j), at(endOuter, k), at(endInner, k), at(endInner, j)));
      triangles.push(...quad(at(startInner, j), at(startInner, k), at(startOuter, k), at(startOuter, j)));
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
