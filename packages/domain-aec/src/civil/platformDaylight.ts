/**
 * Daylight line of a graded pad: where the cut / fill batter from the pad edge meets the ground.
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';
import { polygonPerimeter } from '@lib/polygon';
import { daylightReach } from './earthworksMath';
import { elevationAt, type Tin } from './tin';

/** Pad-edge points generated around the outline (vertices included). */
const RING_POINTS = 160;
const MARCH_STEPS = 200;
const BISECTIONS = 30;

export type BatterMode = 'cut' | 'fill' | 'none';

export interface DaylightPoint {
  /** Point on the pad outline. */
  readonly edge: Vec2;
  /** Where the batter meets the ground. */
  readonly daylight: Vec2;
  /** Plan distance edge -> daylight. */
  readonly distance: number;
  /** Elevation of the batter at the daylight point. */
  readonly elevation: number;
  readonly mode: BatterMode;
  /** True when the batter left the TIN or exceeded its reach before meeting the ground. */
  readonly clipped: boolean;
}

interface RingPoint {
  readonly at: Vec2;
  readonly normal: Vec2;
}

function unit(x: number, y: number): Vec2 {
  const length = Math.hypot(x, y);
  return length === 0 ? [0, 0] : [x / length, y / length];
}

/** Pad outline (CCW) as points with outward normals; vertices get the corner bisector. */
export function outlineRing(boundary: ReadonlyArray<Vec2>): RingPoint[] {
  const count = boundary.length;
  const edgeNormals = boundary.map((a, i): Vec2 => {
    const b = boundary[(i + 1) % count] as Vec2;
    return unit(b[1] - a[1], -(b[0] - a[0]));
  });
  const step = polygonPerimeter(boundary) / RING_POINTS;
  const ring: RingPoint[] = [];
  boundary.forEach((a, i) => {
    const b = boundary[(i + 1) % count] as Vec2;
    const previous = edgeNormals[(i + count - 1) % count] as Vec2;
    const normal = edgeNormals[i] as Vec2;
    const corner = unit(previous[0] + normal[0], previous[1] + normal[1]);
    ring.push({ at: a, normal: corner[0] === 0 && corner[1] === 0 ? normal : corner });
    const pieces = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k < pieces; k++) {
      const t = k / pieces;
      ring.push({ at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], normal });
    }
  });
  return ring;
}

function march(
  tin: Tin,
  ring: RingPoint,
  elevation: number,
  cutSlope: number,
  fillSlope: number,
  reach: number,
): DaylightPoint {
  const { at, normal } = ring;
  const base = { edge: at, daylight: at, distance: 0, elevation, mode: 'none' as BatterMode };
  const ground = elevationAt(tin, at);
  if (ground === null) return { ...base, clipped: true };
  if (ground === elevation) return { ...base, clipped: false };
  const mode: BatterMode = ground > elevation ? 'cut' : 'fill';
  const designAt = (t: number): number =>
    mode === 'cut' ? elevation + t / cutSlope : elevation - t / fillSlope;
  const pointAt = (t: number): Vec2 => [at[0] + normal[0] * t, at[1] + normal[1] * t];
  const gapAt = (t: number): number | null => {
    const z = elevationAt(tin, pointAt(t));
    if (z === null) return null;
    return mode === 'cut' ? z - designAt(t) : designAt(t) - z;
  };
  const result = (t: number, clipped: boolean): DaylightPoint => ({
    edge: at,
    daylight: pointAt(t),
    distance: t,
    elevation: designAt(t),
    mode,
    clipped,
  });
  const dt = reach / MARCH_STEPS;
  let previous = 0;
  for (let k = 1; k <= MARCH_STEPS; k++) {
    const t = k * dt;
    const gap = gapAt(t);
    if (gap === null) return result(previous, true);
    if (gap <= 0) {
      let [low, high] = [previous, t];
      for (let i = 0; i < BISECTIONS; i++) {
        const mid = (low + high) / 2;
        if ((gapAt(mid) ?? -1) > 0) low = mid;
        else high = mid;
      }
      return result((low + high) / 2, false);
    }
    previous = t;
  }
  return result(reach, true);
}

/** Daylight points around the pad outline, in outline order. */
export function daylightPoints(
  tin: Tin,
  boundary: ReadonlyArray<Vec2>,
  elevation: number,
  cutSlope: number,
  fillSlope: number,
): DaylightPoint[] {
  const reach = daylightReach(tin, elevation, cutSlope, fillSlope);
  return outlineRing(boundary).map((ring) =>
    march(tin, ring, elevation, cutSlope, fillSlope, reach),
  );
}
