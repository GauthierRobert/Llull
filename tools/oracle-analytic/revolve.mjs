// Pappus-Guldin solids of revolution about the Z axis.
import { PI, part, polygon } from './formulas.mjs';

/**
 * Polygon (x = radial, y = axial) revolved by `angle` (default a full turn) about the Z axis through o.
 * V = angle * xbar * A; lateral area = sum of angle * r_mid * L over the edges (+ the two planar end sections of a partial turn).
 * Centroid and bbox are only given for a full turn (null otherwise).
 */
export function revolvePolygon(points, o = [0, 0, 0], angle = 2 * PI) {
  const n = points.length;
  let a2 = 0;
  let ixy = 0;
  let lateral = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    ixy += cross * (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0);
    lateral += angle * ((x0 + x1) / 2) * Math.hypot(x1 - x0, y1 - y0);
  }
  const sign = Math.sign(a2);
  const A = Math.abs(a2) / 2;
  const xbar = polygon(points).cx;
  const zbar = (sign * ixy) / 24 / (A * xbar);
  const rmax = Math.max(...points.map((q) => q[0]));
  const ys = points.map((q) => q[1]);
  const full = Math.abs(angle - 2 * PI) < 1e-12;
  return part(
    angle * xbar * A,
    lateral + (full ? 0 : 2 * A),
    full ? [o[0], o[1], o[2] + zbar] : null,
    full ? [o[0] - rmax, o[1] - rmax, o[2] + Math.min(...ys)] : null,
    full ? [o[0] + rmax, o[1] + rmax, o[2] + Math.max(...ys)] : null,
  );
}
