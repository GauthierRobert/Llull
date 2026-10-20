// Closed-form volume / surface area / centroid / bbox of the oracle shapes. No llull code is imported: these are textbook formulas.
export const PI = Math.PI;

/** A solid description: v volume, a surface area (null = not checked), c centroid, min/max bbox corners. */
export const part = (v, a, c, min, max) => ({ v, a, c, min, max });

/** Axis-aligned box of size s centred on c. */
export const box = (s, c = [0, 0, 0]) =>
  part(
    s[0] * s[1] * s[2],
    2 * (s[0] * s[1] + s[1] * s[2] + s[0] * s[2]),
    c,
    c.map((x, i) => x - s[i] / 2),
    c.map((x, i) => x + s[i] / 2),
  );

/** Cylinder, axis along Z, centred on c. */
export const cylinder = (r, h, c = [0, 0, 0]) =>
  part(PI * r * r * h, 2 * PI * r * (r + h), c, [c[0] - r, c[1] - r, c[2] - h / 2], [c[0] + r, c[1] + r, c[2] + h / 2]);

/** Right circular cone, axis along Z, base centre b. */
export const cone = (r, h, b = [0, 0, 0]) =>
  part(
    (PI * r * r * h) / 3,
    PI * r * (r + Math.hypot(r, h)),
    [b[0], b[1], b[2] + h / 4],
    [b[0] - r, b[1] - r, b[2]],
    [b[0] + r, b[1] + r, b[2] + h],
  );

/** Frustum (axis Z, bottom radius r1 at base centre b, top radius r2). */
export const frustum = (r1, r2, h, b = [0, 0, 0]) => {
  const v = (PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
  const slant = Math.hypot(r1 - r2, h);
  const zbar = (h * (r1 * r1 + 2 * r1 * r2 + 3 * r2 * r2)) / (4 * (r1 * r1 + r1 * r2 + r2 * r2));
  return part(
    v,
    PI * (r1 * r1 + r2 * r2 + (r1 + r2) * slant),
    [b[0], b[1], b[2] + zbar],
    [b[0] - r1, b[1] - r1, b[2]],
    [b[0] + r1, b[1] + r1, b[2] + h],
  );
};

export const sphere = (r, c = [0, 0, 0]) =>
  part(
    (4 / 3) * PI * r ** 3,
    4 * PI * r * r,
    c,
    c.map((x) => x - r),
    c.map((x) => x + r),
  );

/** Torus (ring radius R, tube radius r), axis Z, centred on c. */
export const torus = (R, r, c = [0, 0, 0]) =>
  part(2 * PI * PI * R * r * r, 4 * PI * PI * R * r, c, [c[0] - R - r, c[1] - R - r, c[2] - r], [c[0] + R + r, c[1] + R + r, c[2] + r]);

/** Wedge of size [w,h,d] with min corner m: right triangle (legs h along Y and d along Z) extruded w along X, tall at z = 0. */
export const wedge = (s, m = [0, 0, 0]) =>
  part(
    (s[0] * s[1] * s[2]) / 2,
    s[1] * s[2] + s[0] * s[1] + s[0] * s[2] + s[0] * Math.hypot(s[1], s[2]),
    [m[0] + s[0] / 2, m[1] + s[1] / 3, m[2] + s[2] / 3],
    m,
    [m[0] + s[0], m[1] + s[1], m[2] + s[2]],
  );

/** Rectangular pyramid, base centre b, apex at b + [0,0,h]. */
export const pyramid = (w, d, h, b = [0, 0, 0]) =>
  part(
    (w * d * h) / 3,
    w * d + w * Math.hypot(h, d / 2) + d * Math.hypot(h, w / 2),
    [b[0], b[1], b[2] + h / 4],
    [b[0] - w / 2, b[1] - d / 2, b[2]],
    [b[0] + w / 2, b[1] + d / 2, b[2] + h],
  );

/** Shoelace area and centroid of a simple polygon. */
export function polygon(points) {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const sign = Math.sign(a2);
  const area = Math.abs(a2) / 2;
  const perimeter = points.reduce(
    (p, q, i) => p + Math.hypot(points[(i + 1) % points.length][0] - q[0], points[(i + 1) % points.length][1] - q[1]),
    0,
  );
  return { area, perimeter, cx: (sign * cx) / (3 * Math.abs(a2)), cy: (sign * cy) / (3 * Math.abs(a2)) };
}

/** Prism: polygon extruded along +Z by depth from z0, polygon placed at offset o. */
export function prism(points, depth, o = [0, 0, 0]) {
  const p = polygon(points);
  const xs = points.map((q) => q[0]);
  const ys = points.map((q) => q[1]);
  return part(
    p.area * depth,
    2 * p.area + p.perimeter * depth,
    [o[0] + p.cx, o[1] + p.cy, o[2] + depth / 2],
    [o[0] + Math.min(...xs), o[1] + Math.min(...ys), o[2]],
    [o[0] + Math.max(...xs), o[1] + Math.max(...ys), o[2] + depth],
  );
}

/** Sum of disjoint parts (bodies). */
export function union(parts) {
  const v = parts.reduce((s, p) => s + p.v, 0);
  const a = parts.every((p) => p.a !== null) ? parts.reduce((s, p) => s + p.a, 0) : null;
  const c = [0, 1, 2].map((i) => parts.reduce((s, p) => s + p.v * p.c[i], 0) / v);
  const min = [0, 1, 2].map((i) => Math.min(...parts.map((p) => p.min[i])));
  const max = [0, 1, 2].map((i) => Math.max(...parts.map((p) => p.max[i])));
  return part(v, a, c, min, max);
}

/** The part with a sub-part's volume removed (centroid by moments); bbox kept from the outer part. */
export function minus(outer, inner, area = null) {
  const v = outer.v - inner.v;
  const c = [0, 1, 2].map((i) => (outer.v * outer.c[i] - inner.v * inner.c[i]) / v);
  return part(v, area, c, outer.min, outer.max);
}

/** Translate a part. */
export const shift = (p, d) =>
  part(
    p.v,
    p.a,
    p.c.map((x, i) => x + d[i]),
    p.min.map((x, i) => x + d[i]),
    p.max.map((x, i) => x + d[i]),
  );

/** Spherical cap of height h on a sphere of radius r. */
export const capVolume = (r, h) => (PI * h * h * (3 * r - h)) / 3;

/** Lens (intersection) of two spheres of radius r at centre distance d (d < 2r). */
export const lensVolume = (r, d) => (PI * (4 * r + d) * (2 * r - d) ** 2) / 12;
