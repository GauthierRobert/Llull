/**
 * Text on a curve (03 WRP M5): a map from text coordinates (x along the baseline, y above it) to the plane, bending the text along a polyline of a curve. A glyph point (x, y) goes to
 * the curve point at arc length s = anchor offset + x, moved y along the left normal there. The text keeps its baseline length; glyph shapes bend (a straight edge becomes a chain of
 * edges), so the outline of text on a curve is polygonal.
 * @invariant the baseline keeps its length (s runs at unit speed); the normal is the left normal of the segment containing s
 * @failure a point whose arc length falls outside the curve -> null
 */

import type { Vec2 } from '../model/vectors';

export type PointMapper = (point: Vec2) => Vec2 | null;

const ARC_SLACK = 1e-9;

/**
 * @param curve polyline of the curve in plane coordinates (at least two distinct points)
 * @param anchor how the text is aligned on the curve: its left end at the offset, its centre at the middle of the curve plus the offset, its right end at the end plus the offset
 * @param shift plane coordinates of the text origin; the result is expressed relative to it (text-local), like an unbent outline
 */
export function curveMapper(
  curve: readonly Vec2[],
  anchor: 'left' | 'center' | 'right',
  offset: number,
  reverse: boolean,
  shift: Vec2,
): { readonly map: PointMapper; readonly length: number } | null {
  const ordered = reverse ? [...curve].reverse() : [...curve];
  const points = ordered.filter(
    (p, k) => k === 0 || Math.hypot(p[0] - (ordered[k - 1] as Vec2)[0], p[1] - (ordered[k - 1] as Vec2)[1]) > 1e-12,
  );
  const cumulative = [0];
  for (let k = 1; k < points.length; k++) {
    const [a, b] = [points[k - 1] as Vec2, points[k] as Vec2];
    cumulative.push((cumulative[k - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cumulative[cumulative.length - 1] as number;
  if (!(length > 0)) return null;
  const origin = anchor === 'left' ? 0 : anchor === 'center' ? length / 2 : length;
  const map: PointMapper = ([x, y]) => {
    const s = origin + offset + x;
    if (s < -ARC_SLACK || s > length + ARC_SLACK) return null;
    let low = 0;
    let high = cumulative.length - 2;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((cumulative[mid] as number) <= s) low = mid;
      else high = mid - 1;
    }
    const [a, b] = [points[low] as Vec2, points[low + 1] as Vec2];
    const span = (cumulative[low + 1] as number) - (cumulative[low] as number);
    if (!(span > 0)) return null;
    const t = Math.min(1, Math.max(0, (s - (cumulative[low] as number)) / span));
    const tangent: Vec2 = [(b[0] - a[0]) / span, (b[1] - a[1]) / span];
    return [a[0] + t * (b[0] - a[0]) - tangent[1] * y - shift[0], a[1] + t * (b[1] - a[1]) + tangent[0] * y - shift[1]];
  };
  return { map, length };
}
