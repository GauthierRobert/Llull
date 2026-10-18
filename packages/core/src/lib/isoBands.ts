/** Iso-band contouring of a linearly interpolated scalar on a triangle, and the blue → red result colour scale of FE post-processors. */

import type { Vec3 } from '../model/vectors';

interface ValuedPoint {
  readonly point: Vec3;
  readonly value: number;
}

const lerpPoint = (a: ValuedPoint, b: ValuedPoint, level: number): ValuedPoint => {
  const t = b.value === a.value ? 0 : (level - a.value) / (b.value - a.value);
  return {
    point: [
      a.point[0] + t * (b.point[0] - a.point[0]),
      a.point[1] + t * (b.point[1] - a.point[1]),
      a.point[2] + t * (b.point[2] - a.point[2]),
    ],
    value: level,
  };
};

/** Sutherland–Hodgman clip of a valued polygon to `value >= level` (`keepAbove`) or `value <= level`. */
function clipToLevel(polygon: readonly ValuedPoint[], level: number, keepAbove: boolean): ValuedPoint[] {
  const inside = (p: ValuedPoint): boolean => (keepAbove ? p.value >= level : p.value <= level);
  const out: ValuedPoint[] = [];
  polygon.forEach((current, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    if (previous === undefined) return;
    if (inside(current)) {
      if (!inside(previous)) out.push(lerpPoint(previous, current, level));
      out.push(current);
    } else if (inside(previous)) out.push(lerpPoint(previous, current, level));
  });
  return out;
}

export interface BandPiece {
  /** Band index: band i spans [levels[i], levels[i + 1]]. */
  readonly band: number;
  readonly polygon: readonly Vec3[];
}

/**
 * Splits a triangle with nodal values into the pieces lying in each band of `levels` (ascending, ≥ 2 entries). Values outside
 * [levels[0], levels.at(-1)] are clamped into the end bands, so the pieces always tile the whole triangle. @pure
 */
export function triangleBands(
  points: readonly [Vec3, Vec3, Vec3],
  values: readonly [number, number, number],
  levels: readonly number[],
): BandPiece[] {
  const low = levels[0];
  const high = levels.at(-1);
  if (low === undefined || high === undefined || levels.length < 2) return [];
  const clamp = (value: number): number => Math.min(high, Math.max(low, value));
  const triangle: ValuedPoint[] = points.map((point, index) => ({ point, value: clamp(values[index] ?? low) }));
  const least = Math.min(...triangle.map((p) => p.value));
  const most = Math.max(...triangle.map((p) => p.value));
  const pieces: BandPiece[] = [];
  for (let band = 0; band < levels.length - 1; band += 1) {
    const from = levels[band] ?? low;
    const to = levels[band + 1] ?? high;
    if (to < least || from > most) continue;
    if (from <= least && to >= most) {
      pieces.push({ band, polygon: points });
      continue;
    }
    const clipped = clipToLevel(clipToLevel(triangle, from, true), to, false);
    if (clipped.length >= 3) pieces.push({ band, polygon: clipped.map((p) => p.point) });
  }
  return pieces;
}

/** `count + 1` evenly spaced levels from `min` to `max` (a zero range is widened so every band has a width). @pure */
export function bandLevels(min: number, max: number, count: number): number[] {
  const span = max - min;
  const width = span > 0 ? span : Math.max(Math.abs(min) * 1e-6, 1e-12);
  const start = span > 0 ? min : min - width / 2;
  return Array.from({ length: count + 1 }, (_, index) => start + (width * index) / count);
}

/** Colour of `t` ∈ [0, 1] on the blue (low) → cyan → green → yellow → red (high) scale, as `#rrggbb`. @pure */
export function resultColor(t: number): string {
  const hue = 240 * (1 - Math.min(1, Math.max(0, t)));
  const channel = (n: number): number => {
    const k = (n + hue / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return `#${[channel(5), channel(3), channel(1)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
