// Reference implementation of the DEF deformation laws (pure functions, no npm deps).
// Shared by generate_analytic_refs.mjs and make_plans.mjs. Frame convention (TECHNICAL_SPEC §5.1):
// local coordinates (x, y, z) with z along the deformation axis, measured from the frame origin;
// the region is z in [z0, z1]; "w" is the ramp (blend) of the region: 0 below, 1 above.

export const ramp = {
  linear: (t) => Math.min(1, Math.max(0, t)),
  smooth: (t) => {
    const c = Math.min(1, Math.max(0, t));
    return c * c * (3 - 2 * c);
  },
};

// infinite: z0 and z1 only fix the rate, the linear ramp is not clamped (TECHNICAL_SPEC §17.1)
const rampOf = (z, z0, z1, falloff, infinite = false) => (infinite ? (z - z0) / (z1 - z0) : ramp[falloff]((z - z0) / (z1 - z0)));

/** Barr twist: rotation about +z by theta(z) = angle * w(z). Jacobian determinant = 1 everywhere. */
export function twist([x, y, z], { angleRad, z0, z1, falloff = 'linear', infinite = false }) {
  const th = angleRad * rampOf(z, z0, z1, falloff, infinite);
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [c * x - s * y, s * x + c * y, z];
}

/** Barr taper: lateral scale s(z) = 1 + (scaleEnd - 1) w(z); flat = only x scales. det = s^2 (s when flat). */
export function taper([x, y, z], { scaleEnd, z0, z1, falloff = 'linear', flat = false, infinite = false }) {
  const s = 1 + (scaleEnd - 1) * rampOf(z, z0, z1, falloff, infinite);
  return [s * x, flat ? y : s * y, z];
}

/**
 * Bend of the region z in [z0, z1] about an axis parallel to +x through (y = R, z = z0); fibre y = 0 is the neutral
 * fibre (length preserved). Beyond z1 the body follows rigidly (Barr). Below z0 unchanged. det = (R - y) / R in the region.
 */
export function bend([x, y, z], { radius: R, z0, z1, infinite = false, symmetric = false }) {
  if (infinite) {
    // theta = (z - z0) / R at every z, no clamp, nothing rigid; symmetric: the same arc turned back by the half angle about its centre
    // (y = R, z = z0) and moved up by half the region length, so the point of the neutral fibre at the region middle stays where it was
    const th = (z - z0) / R;
    const [ya, za] = [R - (R - y) * Math.cos(th), z0 + (R - y) * Math.sin(th)];
    if (!symmetric) return [x, ya, za];
    const h = (z1 - z0) / (2 * R);
    const [dy, dz] = [ya - R, za - z0];
    return [x, R + Math.cos(h) * dy - Math.sin(h) * dz, z0 + (z1 - z0) / 2 + Math.sin(h) * dy + Math.cos(h) * dz];
  }
  if (z <= z0) return [x, y, z];
  const zc = Math.min(z, z1);
  const th = (zc - z0) / R;
  const yb = R - (R - y) * Math.cos(th);
  const zb = z0 + (R - y) * Math.sin(th);
  const over = z - zc; // rigid continuation along the end tangent
  return [x, yb + over * Math.sin(th), zb + over * Math.cos(th)];
}

/** Piecewise stretch along z: factor f inside [z0, z1], translation beyond. det = f inside, 1 outside. */
export function stretch([x, y, z], { factor: f, z0, z1, infinite = false }) {
  if (infinite) return [x, y, z0 + f * (z - z0)];
  if (z <= z0) return [x, y, z];
  if (z <= z1) return [x, y, z0 + f * (z - z0)];
  return [x, y, z + (f - 1) * (z1 - z0)];
}

/**
 * Flow along a curve with a base curve (flow_along_curve baseCurve, TECHNICAL_SPEC §17.2), closed form for a base arc of radius `baseRadius` in the xz plane
 * (centre (R, 0, 0), start at the origin, tangent +z, normal toward the centre) onto a target line along +z (`targetRadius` 0) or a target arc of
 * `targetRadius` bending the same way. A point q lies at polar angle theta about the base centre and offset x = R - |q - centre| toward it; it goes to the
 * target at arc length ratio R theta with the same offsets (x along the target normal, y along the binormal).
 */
export function flowBaseArc([x, y, z], { baseRadius: R, targetRadius: Rt = 0, ratio = 1 }) {
  const dx = R - x;
  const theta = Math.atan2(z, dx);
  const offset = R - Math.hypot(dx, z);
  const s = ratio * R * theta;
  if (Rt === 0) return [offset, y, s];
  const phi = s / Rt;
  return [Rt * (1 - Math.cos(phi)) + offset * Math.cos(phi), y, Rt * Math.sin(phi) - offset * Math.sin(phi)];
}

/** Non-uniform scale about the frame origin. det = sx sy sz. */
export const scaleNonUniform = ([x, y, z], { factors: [sx, sy, sz] }) => [sx * x, sy * y, sz * z];

const binom = (n, k) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};
export const bernstein = (n, i, t) => binom(n, i) * t ** i * (1 - t) ** (n - i);

/**
 * Sederberg-Parry FFD on the lattice box [min, max] with degrees [l, m, n] and control points P[i][j][k] (world).
 * (s, t, u) = normalised coordinates in the box (an axis-aligned parallelepiped: equation (1) of the paper reduces to this).
 */
export function ffd(p, { min, max, degrees: [l, m, n], points }) {
  const st = [0, 1, 2].map((a) => (p[a] - min[a]) / (max[a] - min[a]));
  const out = [0, 0, 0];
  for (let i = 0; i <= l; i++)
    for (let j = 0; j <= m; j++)
      for (let k = 0; k <= n; k++) {
        const b = bernstein(l, i, st[0]) * bernstein(m, j, st[1]) * bernstein(n, k, st[2]);
        const q = points[i][j][k];
        out[0] += b * q[0];
        out[1] += b * q[1];
        out[2] += b * q[2];
      }
  return out;
}

/**
 * Uniform clamped knot vector of `count` control points and degree `p` (p + 1 zeros, count - p - 1 interior knots, p + 1 ones) and the textbook Cox-de Boor
 * recursion N_{i,p}(u) on it (0/0 = 0; u = 1 belongs to the last span), independent of the span-based algorithm of the production code.
 */
export function clampedKnots(count, p) {
  return Array.from({ length: count + p + 1 }, (_, j) => (j <= p ? 0 : j >= count ? 1 : (j - p) / (count - p)));
}
export function splineN(i, p, u, knots) {
  if (p === 0) return (knots[i] <= u && u < knots[i + 1]) || (u === 1 && knots[i] < 1 && knots[i + 1] === 1) ? 1 : 0;
  const left = knots[i + p] - knots[i];
  const right = knots[i + p + 1] - knots[i + 1];
  return (
    (left > 0 ? ((u - knots[i]) / left) * splineN(i, p - 1, u, knots) : 0) +
    (right > 0 ? ((knots[i + p + 1] - u) / right) * splineN(i + 1, p - 1, u, knots) : 0)
  );
}

/**
 * FFD on a B-spline lattice and/or an oriented box (TECHNICAL_SPEC §17.4). Net degrees [l, m, n] (control points l + 1, m + 1, n + 1), spline degrees
 * `splineDegrees` (omitted: Bernstein), box [min, max] in box coordinates c = A p (`axes` rows; omitted: the frame), control points at rest on the Greville
 * abscissae and displaced by `moved` (frame coordinates). Points outside the box do not move.
 */
export function ffdGeneral(p, { min, max, degrees, splineDegrees, axes, moved }) {
  const c = axes ? axes.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]) : p;
  const s = [0, 1, 2].map((a) => (c[a] - min[a]) / (max[a] - min[a]));
  if (s.some((t) => !(t >= 0 && t <= 1))) return p;
  const basis = (a, i) => {
    const net = degrees[a];
    if (!splineDegrees) return bernstein(net, i, s[a]);
    return splineN(i, splineDegrees[a], s[a], clampedKnots(net + 1, splineDegrees[a]));
  };
  const rest = (a, i) => {
    const net = degrees[a];
    if (!splineDegrees) return i / net;
    const knots = clampedKnots(net + 1, splineDegrees[a]);
    let sum = 0;
    for (let j = 1; j <= splineDegrees[a]; j++) sum += knots[i + j];
    return sum / splineDegrees[a];
  };
  const delta = new Map(moved.map(({ index, delta: d }) => [index.join(','), d]));
  const out = [0, 0, 0];
  for (let i = 0; i <= degrees[0]; i++)
    for (let j = 0; j <= degrees[1]; j++)
      for (let k = 0; k <= degrees[2]; k++) {
        const w = basis(0, i) * basis(1, j) * basis(2, k);
        const box = [
          min[0] + rest(0, i) * (max[0] - min[0]),
          min[1] + rest(1, j) * (max[1] - min[1]),
          min[2] + rest(2, k) * (max[2] - min[2]),
        ];
        const frame = axes ? [0, 1, 2].map((a) => axes[0][a] * box[0] + axes[1][a] * box[1] + axes[2][a] * box[2]) : box;
        const d = delta.get([i, j, k].join(',')) ?? [0, 0, 0];
        for (let a = 0; a < 3; a++) out[a] += w * (frame[a] + d[a]);
      }
  return out;
}

/** Undisplaced lattice points of the box. */
export function latticeOf(min, max, [l, m, n]) {
  const pts = [];
  for (let i = 0; i <= l; i++) {
    const row = [];
    for (let j = 0; j <= m; j++) {
      const col = [];
      for (let k = 0; k <= n; k++)
        col.push([min[0] + ((max[0] - min[0]) * i) / l, min[1] + ((max[1] - min[1]) * j) / m, min[2] + ((max[2] - min[2]) * k) / n]);
      row.push(col);
    }
    pts.push(row);
  }
  return pts;
}

/** Point push: p + d * dir * phi(|p - c| / r), phi(s) = (1 - s^2)^3 for s < 1 (C2 at the support boundary). */
export function pointPush(p, { center, direction, distance: d, radius: r }) {
  const s2 = ((p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2) / (r * r);
  const phi = s2 < 1 ? (1 - s2) ** 3 : 0;
  return [p[0] + d * direction[0] * phi, p[1] + d * direction[1] * phi, p[2] + d * direction[2] * phi];
}

/**
 * Flow of base-plane coordinates (x along the base, y across, w along the base normal) onto a cylinder of radius R whose axis
 * is parallel to +y through (0, *, -R): arc length x is preserved at w = 0. det = (R + w) / R.
 */
export function flowOnCylinder([x, y, w], { radius: R }) {
  const a = x / R;
  return [(R + w) * Math.sin(a), y, (R + w) * Math.cos(a) - R];
}

/** Flow along a circular arc target (neutral = base line z axis, bending toward +y) is the bend law with z0 = 0, z1 = length. */
export const flowAlongArc = (p, { radius, length }) => bend(p, { radius, z0: 0, z1: length });

// ---------- numerics ----------

/** Central-difference Jacobian determinant of map f at p. */
export function jacobianDet(f, p, h = 1e-5) {
  const col = (a) => {
    const pp = [...p];
    const pm = [...p];
    pp[a] += h;
    pm[a] -= h;
    const fp = f(pp);
    const fm = f(pm);
    return [0, 1, 2].map((c) => (fp[c] - fm[c]) / (2 * h));
  };
  const [a, b, c] = [col(0), col(1), col(2)];
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

/** Gauss-Legendre nodes/weights on [-1, 1] (Newton on P_n). */
export function gaussLegendre(n) {
  const x = [];
  const w = [];
  for (let i = 1; i <= n; i++) {
    let t = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1;
      let p1 = t;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * t * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      dp = (n * (t * p1 - p0)) / (t * t - 1);
      const dt = p1 / dp;
      t -= dt;
      if (Math.abs(dt) < 1e-16) break;
    }
    x.push(t);
    w.push(2 / ((1 - t * t) * dp * dp));
  }
  return { x, w };
}

/** Integral of g over the box [lo, hi]^3 with an n-point Gauss rule per axis, split into `pieces` per axis. */
export function integrateBox(g, lo, hi, n = 8, pieces = [1, 1, 1]) {
  const { x, w } = gaussLegendre(n);
  let sum = 0;
  const ranges = [0, 1, 2].map((a) => {
    const list = [];
    const len = (hi[a] - lo[a]) / pieces[a];
    for (let q = 0; q < pieces[a]; q++) {
      const a0 = lo[a] + q * len;
      for (let i = 0; i < n; i++) list.push([a0 + ((x[i] + 1) * len) / 2, (w[i] * len) / 2]);
    }
    return list;
  });
  for (const [px, wx] of ranges[0])
    for (const [py, wy] of ranges[1]) for (const [pz, wz] of ranges[2]) sum += wx * wy * wz * g([px, py, pz]);
  return sum;
}

/** Area of the image of a planar rectangle (param (u, v) -> point) under f, by Gauss quadrature of |dF/du x dF/dv|. */
export function mappedArea(param, f, [u0, u1], [v0, v1], n = 12, pieces = [8, 8], h = 1e-6) {
  const { x, w } = gaussLegendre(n);
  let sum = 0;
  const du = (u1 - u0) / pieces[0];
  const dv = (v1 - v0) / pieces[1];
  for (let a = 0; a < pieces[0]; a++)
    for (let b = 0; b < pieces[1]; b++)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const u = u0 + a * du + ((x[i] + 1) * du) / 2;
          const v = v0 + b * dv + ((x[j] + 1) * dv) / 2;
          const F = (uu, vv) => f(param(uu, vv));
          const fu = F(u + h, v).map((c, k) => (c - F(u - h, v)[k]) / (2 * h));
          const fv = F(u, v + h).map((c, k) => (c - F(u, v - h)[k]) / (2 * h));
          const cx = fu[1] * fv[2] - fu[2] * fv[1];
          const cy = fu[2] * fv[0] - fu[0] * fv[2];
          const cz = fu[0] * fv[1] - fu[1] * fv[0];
          sum += ((w[i] * w[j] * du * dv) / 4) * Math.hypot(cx, cy, cz);
        }
  return sum;
}

/** Deterministic PRNG (mulberry32) so generated data never changes between runs. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (v, digits = 12) => (Array.isArray(v) ? v.map((c) => round(c, digits)) : Number(v.toPrecision(digits)));
