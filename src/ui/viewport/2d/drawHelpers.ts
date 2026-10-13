// Pure click → draw-command param helpers of the 2D draw tools.

import type { Vec2, Vec3 } from '@core/model/types';

interface RectParams {
  width: number;
  height: number;
  position: Vec3;
}

/** Lower-left corner becomes `position`; positive width/height. @failure zero area -> null */
export function rectParamsFromCorners(a: Vec2, b: Vec2): RectParams | null {
  const minX = Math.min(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const width = Math.abs(b[0] - a[0]);
  const height = Math.abs(b[1] - a[1]);

  if (width === 0 || height === 0) return null;

  return { width, height, position: [minX, minY, 0] };
}

/** @failure center == rim -> null */
export function circleRadiusFromPoints(center: Vec2, rim: Vec2): number | null {
  const dx = rim[0] - center[0];
  const dy = rim[1] - center[1];
  const r = Math.sqrt(dx * dx + dy * dy);
  return r > 0 ? r : null;
}

/** Drop consecutive near-duplicates (within `chainTolerance`): a double-click finish records its last point twice. */
export function dropRepeatedPoints(points: ReadonlyArray<Vec2>): Vec2[] {
  const tolerance = chainTolerance(points);
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return previous === undefined || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > tolerance;
  });
}

/** 0.1% of the chain's bounding diagonal (never below 1e-9). */
export function chainTolerance(points: ReadonlyArray<Vec2>): number {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return Math.max(diagonal * 1e-3, 1e-9);
}

interface EllipseParams {
  center: Vec2;
  radiusX: number;
  radiusY: number;
}

/** radiusX/Y = |corner − center| per axis. @failure zero on either axis -> null */
export function ellipseParamsFromCenterCorner(center: Vec2, corner: Vec2): EllipseParams | null {
  const radiusX = Math.abs(corner[0] - center[0]);
  const radiusY = Math.abs(corner[1] - center[1]);
  if (radiusX === 0 || radiusY === 0) return null;
  return { center, radiusX, radiusY };
}
