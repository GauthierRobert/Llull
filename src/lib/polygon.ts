/** Pure planar polygon / segment helpers. @layer lib */

export type Point2 = readonly [number, number];

/** Signed shoelace area; > 0 when counter-clockwise. */
export function signedArea(points: ReadonlyArray<Point2>): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i] as Point2;
    const [x2, y2] = points[(i + 1) % points.length] as Point2;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

export function polygonArea(points: ReadonlyArray<Point2>): number {
  return Math.abs(signedArea(points));
}

/** Perimeter of the closed polygon. */
export function polygonPerimeter(points: ReadonlyArray<Point2>): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distance(points[i] as Point2, points[(i + 1) % points.length] as Point2);
  }
  return total;
}

/** Area centroid; falls back to the vertex average for degenerate (zero-area) input. */
export function polygonCentroid(points: ReadonlyArray<Point2>): Point2 {
  const area = signedArea(points);
  if (Math.abs(area) < 1e-12) {
    const sum = points.reduce<[number, number]>((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / Math.max(points.length, 1), sum[1] / Math.max(points.length, 1)];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i] as Point2;
    const [x2, y2] = points[(i + 1) % points.length] as Point2;
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Returns the polygon in counter-clockwise order. */
export function toCounterClockwise(points: ReadonlyArray<Point2>): Point2[] {
  return signedArea(points) < 0 ? [...points].reverse() : [...points];
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Distance from `p` to segment `a`→`b` and the clamped parameter t ∈ [0,1] of the foot point. */
export function projectOntoSegment(
  p: Point2,
  a: Point2,
  b: Point2,
): { distance: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const rawT = lengthSquared === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
  const t = Math.min(1, Math.max(0, rawT));
  return { distance: distance(p, [a[0] + t * dx, a[1] + t * dy]), t };
}

/** True when the polygon has ≥ 3 finite vertices and a non-zero area. */
export function isValidPolygon(points: ReadonlyArray<Point2>): boolean {
  return (
    points.length >= 3 &&
    points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) &&
    polygonArea(points) > 1e-12
  );
}

/**
 * Offsets every edge of a closed polygon by `delta` along its outward normal (CCW input assumed;
 * the result is computed on the CCW copy) and joins consecutive edges with mitred corners.
 * Parallel consecutive edges keep the shifted vertex.
 */
export function offsetPolygon(points: ReadonlyArray<Point2>, delta: number): Point2[] {
  const ccw = toCounterClockwise(points);
  const count = ccw.length;
  const shifted = ccw.map((point, index) => {
    const next = ccw[(index + 1) % count] as Point2;
    const length = distance(point, next) || 1;
    const normal: Point2 = [(next[1] - point[1]) / length, -(next[0] - point[0]) / length];
    return {
      a: [point[0] + normal[0] * delta, point[1] + normal[1] * delta] as Point2,
      b: [next[0] + normal[0] * delta, next[1] + normal[1] * delta] as Point2,
    };
  });
  return shifted.map((edge, index) => {
    const previous = shifted[(index - 1 + count) % count] as { a: Point2; b: Point2 };
    return lineIntersection(previous.a, previous.b, edge.a, edge.b) ?? edge.a;
  });
}

/** Intersection of the infinite lines a1→a2 and b1→b2, or null when parallel. */
export function lineIntersection(a1: Point2, a2: Point2, b1: Point2, b2: Point2): Point2 | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denominator;
  return [a1[0] + t * d1x, a1[1] + t * d1y];
}
