/** Section loops of a sweep in section coordinates: constant sections and the station blend of variable ones. */

import type { Vec2 } from '../../model/types';
import type { SweepSection, SweepStation } from '../../model/sweepOrientation';
import { toCounterClockwise } from '../../lib/polygon';
import { clamp01 } from '../../lib/clamp';
import { sampleRing } from '../sectionRing';

/** Vertices around a circular sweep section. */
const SWEEP_CIRCLE_SEGMENTS = 24;

/** Section loops in section coordinates: CCW outer boundary and optional CCW bore (same count). */
export function sectionLoops(section: SweepSection): { outer: Vec2[]; inner: Vec2[] | null } {
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
  return { outer: ring(section.radius), inner: bore !== undefined && bore > 0 && bore < section.radius ? ring(bore) : null };
}

/**
 * Section ring (SECTION_RING_POINTS points, section coordinates) at path fraction `t`: the two neighbouring station rings blended with a
 * smoothstep weight (tangent-continuous at stations; the default) or linearly.
 */
export function stationRingAt(stations: ReadonlyArray<SweepStation>, t: number, blend: 'smooth' | 'linear' = 'smooth'): Vec2[] {
  let span = 0;
  while (span < stations.length - 2 && t > (stations[span + 1] as SweepStation).at) span++;
  const a = stations[span] as SweepStation;
  const b = stations[span + 1] as SweepStation;
  const u = clamp01((t - a.at) / Math.max(1e-12, b.at - a.at));
  const w = blend === 'linear' ? u : u * u * (3 - 2 * u);
  return a.ring.map((p, i): Vec2 => {
    const q = b.ring[i] as Vec2;
    return [p[0] + w * (q[0] - p[0]), p[1] + w * (q[1] - p[1])];
  });
}

/** Dense section loop at path fraction `t` (the sampled curve of `stationRingAt`). */
export function stationLoopAt(stations: ReadonlyArray<SweepStation>, t: number, blend: 'smooth' | 'linear' = 'smooth'): Vec2[] {
  return sampleRing(stationRingAt(stations, t, blend)).map(([x, y]): Vec2 => [x, y]);
}
