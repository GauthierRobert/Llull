// Deformation laws of the exact warp (01 DEF §5.2), the C++ mirror of packages/core/src/geometry/deform/laws.ts. Every law is written once over
// `Jet` (a value and its derivative along a curve parameter), so one evaluation of F(C(t)) gives the point and the tangent that the curve fit
// needs at the ends of an edge, exact by the chain rule. Parity with the TypeScript laws is tested on validation/data/point_vectors.json.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace llull {
namespace deform {

struct Jet {
  double v = 0;  // value
  double a = 0;  // derivative along the curve parameter
  Jet() = default;
  Jet(double value) : v(value) {}  // NOLINT: constants convert implicitly
};

inline Jet operator+(const Jet &f, const Jet &g) {
  Jet r;
  r.v = f.v + g.v;
  r.a = f.a + g.a;
  return r;
}
inline Jet operator-(const Jet &f, const Jet &g) {
  Jet r;
  r.v = f.v - g.v;
  r.a = f.a - g.a;
  return r;
}
inline Jet operator-(const Jet &f) { return Jet(0) - f; }
inline Jet operator*(const Jet &f, const Jet &g) {
  Jet r;
  r.v = f.v * g.v;
  r.a = f.a * g.v + f.v * g.a;
  return r;
}

// h(f) for a scalar function with value h0 and first derivative h1 at f.v.
inline Jet chain(const Jet &f, double h0, double h1) {
  Jet r;
  r.v = h0;
  r.a = h1 * f.a;
  return r;
}
inline Jet reciprocal(const Jet &f) { return chain(f, 1 / f.v, -1 / (f.v * f.v)); }
inline Jet operator/(const Jet &f, const Jet &g) { return f * reciprocal(g); }
inline Jet sin(const Jet &f) { return chain(f, std::sin(f.v), std::cos(f.v)); }
inline Jet cos(const Jet &f) { return chain(f, std::cos(f.v), -std::sin(f.v)); }
// sqrt for f.v > 0 (callers handle the point where the argument vanishes).
inline Jet sqrt(const Jet &f) {
  const double root = std::sqrt(f.v);
  return chain(f, root, 0.5 / root);
}

using Vec3J = std::array<Jet, 3>;

enum class LawKind : int { Affine = 0, Twist = 1, Taper = 2, Stretch = 3, Bend = 4, Lattice = 5, Point = 6, Flow = 7, FlowSurface = 8, Rbf = 9 };

// Region ramp codes of DeformRegion.falloff.
enum class Falloff : int { None = 0, Linear = 1, Smooth = 2 };

struct Frame {
  double origin[3] = {0, 0, 0};
  double x[3] = {1, 0, 0};
  double y[3] = {0, 1, 0};
  double z[3] = {0, 0, 1};
};

// z = axis, x = reference projected perpendicular to the axis, y = z cross x (frame.ts); false for a degenerate frame.
inline bool resolve_frame(const double *origin, const double *axis, const double *reference, Frame &frame) {
  const double axis_length = std::sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  const double reference_length = std::sqrt(reference[0] * reference[0] + reference[1] * reference[1] + reference[2] * reference[2]);
  if (!(axis_length > 0) || !(reference_length > 0)) return false;
  double z[3], across[3];
  for (int k = 0; k < 3; ++k) z[k] = axis[k] / axis_length;
  const double along = reference[0] * z[0] + reference[1] * z[1] + reference[2] * z[2];
  for (int k = 0; k < 3; ++k) across[k] = reference[k] - along * z[k];
  const double across_length = std::sqrt(across[0] * across[0] + across[1] * across[1] + across[2] * across[2]);
  if (across_length / reference_length < 1e-9) return false;
  for (int k = 0; k < 3; ++k) {
    frame.origin[k] = origin[k];
    frame.z[k] = z[k];
    frame.x[k] = across[k] / across_length;
  }
  frame.y[0] = frame.z[1] * frame.x[2] - frame.z[2] * frame.x[1];
  frame.y[1] = frame.z[2] * frame.x[0] - frame.z[0] * frame.x[2];
  frame.y[2] = frame.z[0] * frame.x[1] - frame.z[1] * frame.x[0];
  return true;
}

struct Region {
  double start = 0, end = 1;
  Falloff falloff = Falloff::Smooth;
  // `infinite`: start and end only fix the rate; the law holds on the whole axis (linear ramp not clamped, no rigid continuation, no kink to split at).
  bool infinite = false;
};

// A trivariate Bernstein lattice (deform_lattice): normalised coordinates inside `min`..`max` (frame coordinates), control points displaced by
// `offsets` (triples laid out i-major, then j, then k).
struct Lattice {
  double min[3] = {0, 0, 0}, max[3] = {1, 1, 1};
  int degree[3] = {1, 1, 1};
  std::vector<double> offsets;
};

// Flow along a curve (flow.ts): stations of 12 numbers (P, T, N, B) at uniform arc length `step`; the point (x, y, z) goes to P(s) + x N(s) + y B(s),
// s = ratio (z - z0), cubic Hermite on P and a normalised linear blend of the frames, straight beyond both ends.
// With a base curve (flow_along_curve baseCurve) the same 12-number stations describe the base at uniform arc length `base_step`: a point is taken in the base
// frame at the arc length s where (q - P(s)).T(s) = 0, with offsets (q - P).N and (q - P).B, and goes to the target at ratio (s - z0) with the same offsets.
struct Flow {
  double z0 = 0, ratio = 1, step = 1;
  std::vector<double> stations;
  double base_step = 0;
  std::vector<double> base;  // empty: the base is the frame axis
};

// Flow of a base plane onto a surface (flowSurface.ts): P and N tabulated on a regular (x, y) grid, six numbers per node (i-major); bicubic Catmull-Rom,
// the coordinates clamped to the table.
struct FlowSurface {
  double x0 = 0, y0 = 0, hx = 1, hy = 1;
  int nx = 2, ny = 2;
  std::vector<double> nodes;
};

// Displacement field fitted to curve pairs (rbf.ts): p + a0 + A p + sum w_i |p - c_i|^3; affine = a0 (3) then the rows of A.
struct Rbf {
  std::vector<double> centres, weights;
  double affine[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
};

struct Law {
  LawKind kind = LawKind::Twist;
  double matrix[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};  // affine rows
  double translation[3] = {0, 0, 0};
  double angle = 0;        // twist
  double scale_end = 1;    // taper
  bool flat = false;       // taper
  double factor = 1;       // stretch
  double radius = 1;       // bend
  bool symmetric = false;  // bend
  Lattice lattice;         // lattice
  double center[3] = {0, 0, 0};     // point (frame coordinates)
  double direction[3] = {0, 0, 1};  // point
  double distance = 0;              // point
  double support = 1;               // point support radius
  bool cubic = false;               // point: cubic falloff, else smooth_c2
  Flow flow;                        // flow along a curve
  FlowSurface surface;              // flow onto a surface
  Rbf rbf;                          // fitted displacement field
};

inline Jet ramp(const Region &region, const Jet &z) {
  const Jet t = (z - Jet(region.start)) * Jet(1 / (region.end - region.start));
  if (region.infinite) return t;
  if (t.v <= 0) return Jet(0);
  if (t.v >= 1 || region.falloff == Falloff::None) return Jet(1);
  if (region.falloff == Falloff::Linear) return t;
  return t * t * (Jet(3) - Jet(2) * t);
}

// Bend of the region about the axis parallel to local x through (y = R, z = start), rigid past the end (laws.ts bendMap).
inline Vec3J bend_map(const Law &law, const Region &region, const Vec3J &q) {
  const double start = region.start, end = region.end;
  const Jet &z = q[2];
  Jet clamped = z, over(0);
  if (region.infinite) {
    // theta = (z - start) / R on the whole axis: nothing is clamped, nothing continues rigidly
  } else if (z.v < start) {
    clamped = Jet(start);
    over = z - Jet(start);
  } else if (z.v > end) {
    clamped = Jet(end);
    over = z - Jet(end);
  }
  const Jet theta = (clamped - Jet(start)) * Jet(1 / law.radius);
  const Jet s = sin(theta), c = cos(theta);
  const Jet arm = q[1] - Jet(law.radius);
  const Jet dy = c * arm + s * over;
  const Jet dz = -s * arm + c * over;
  if (!law.symmetric) return {q[0], Jet(law.radius) + dy, Jet(start) + dz};
  const double half = (end - start) / (2 * law.radius);
  const double hs = std::sin(half), hc = std::cos(half);
  return {q[0], Jet(law.radius) + Jet(hc) * dy - Jet(hs) * dz, Jet(start) + Jet(hs) * dy + Jet(hc) * dz + Jet((end - start) / 2)};
}

inline double binomial(int n, int k) {
  double r = 1;
  for (int i = 1; i <= k; ++i) r = r * (n - k + i) / i;
  return r;
}

// Bernstein basis B_i^n(t) as a jet.
inline Jet bernstein(int n, int i, const Jet &t) {
  Jet r(binomial(n, i));
  for (int k = 0; k < i; ++k) r = r * t;
  const Jet rest = Jet(1) - t;
  for (int k = 0; k < n - i; ++k) r = r * rest;
  return r;
}

inline Vec3J lattice_map(const Lattice &lattice, const Vec3J &q) {
  // Points outside the box are not moved (the lattice must enclose the deformed part, 01 DEF §5.3).
  Jet s[3];
  for (int a = 0; a < 3; ++a) {
    const double size = lattice.max[a] - lattice.min[a];
    if (!(q[a].v >= lattice.min[a] && q[a].v <= lattice.max[a]) || !(size > 0)) return q;
    s[a] = (q[a] - Jet(lattice.min[a])) * Jet(1 / size);
  }
  const int l = lattice.degree[0], m = lattice.degree[1], n = lattice.degree[2];
  std::vector<Jet> bi(static_cast<size_t>(l) + 1), bj(static_cast<size_t>(m) + 1), bk(static_cast<size_t>(n) + 1);
  for (int i = 0; i <= l; ++i) bi[static_cast<size_t>(i)] = bernstein(l, i, s[0]);
  for (int j = 0; j <= m; ++j) bj[static_cast<size_t>(j)] = bernstein(m, j, s[1]);
  for (int k = 0; k <= n; ++k) bk[static_cast<size_t>(k)] = bernstein(n, k, s[2]);
  Vec3J out = q;
  for (int i = 0; i <= l; ++i)
    for (int j = 0; j <= m; ++j)
      for (int k = 0; k <= n; ++k) {
        const size_t at = (static_cast<size_t>(i) * (static_cast<size_t>(m) + 1) + static_cast<size_t>(j)) * (static_cast<size_t>(n) + 1) +
                          static_cast<size_t>(k);
        if (3 * at + 2 >= lattice.offsets.size()) continue;
        const Jet weight = bi[static_cast<size_t>(i)] * bj[static_cast<size_t>(j)] * bk[static_cast<size_t>(k)];
        for (int a = 0; a < 3; ++a) out[static_cast<size_t>(a)] = out[static_cast<size_t>(a)] + weight * Jet(lattice.offsets[3 * at + static_cast<size_t>(a)]);
      }
  return out;
}

// p + distance dir phi(|p - c| / r) with phi = (1 - s^2)^3 (smooth_c2) or 1 - 3 s^2 + 2 s^3 (cubic), zero from s = 1 on.
inline Vec3J point_map(const Law &law, const Vec3J &q) {
  Jet d2(0);
  for (int a = 0; a < 3; ++a) {
    const Jet d = q[static_cast<size_t>(a)] - Jet(law.center[a]);
    d2 = d2 + d * d;
  }
  const Jet s2 = d2 * Jet(1 / (law.support * law.support));
  if (!(s2.v < 1)) return q;
  Jet phi;
  if (!law.cubic) {
    const Jet w = Jet(1) - s2;
    phi = w * w * w;
  } else if (s2.v <= 0) {
    phi = Jet(1);
  } else {
    const Jet s = sqrt(s2);
    phi = Jet(1) - Jet(3) * s2 + Jet(2) * s2 * s;
  }
  Vec3J out = q;
  for (int a = 0; a < 3; ++a) out[static_cast<size_t>(a)] = out[static_cast<size_t>(a)] + Jet(law.distance * law.direction[a]) * phi;
  return out;
}

inline Vec3J operator+(const Vec3J &a, const Vec3J &b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
inline Vec3J operator-(const Vec3J &a, const Vec3J &b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline Vec3J operator*(const Vec3J &a, const Jet &s) { return {a[0] * s, a[1] * s, a[2] * s}; }
inline Jet dot(const Vec3J &a, const Vec3J &b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline Vec3J cross(const Vec3J &a, const Vec3J &b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline Vec3J normalized(const Vec3J &a) { return a * reciprocal(sqrt(dot(a, a))); }
inline Vec3J constant(const double *p) { return {Jet(p[0]), Jet(p[1]), Jet(p[2])}; }

// P, T, N, B of a station table at arc length s (cubic Hermite on P, normalised linear blend of the frames, straight beyond both ends; flow.ts sampleAt).
struct FlowSample {
  Vec3J point, tangent, normal, binormal;
};

inline FlowSample flow_sample(const std::vector<double> &stations, double step, const Jet &s) {
  const size_t count = stations.size() / 12;
  const double length = static_cast<double>(count - 1) * step;
  const double clamped = std::min(std::max(s.v, 0.0), length);
  const size_t k = std::min(static_cast<size_t>(std::floor(clamped / step)), count - 2);
  const Jet inside = s.v < 0 ? Jet(0) : (s.v > length ? Jet(length) : s);
  const Jet u = (inside - Jet(static_cast<double>(k) * step)) * Jet(1 / step);
  const double *row0 = &stations[k * 12];
  const double *row1 = &stations[(k + 1) * 12];
  const Jet u2 = u * u, u3 = u2 * u;
  const Jet h00 = Jet(2) * u3 - Jet(3) * u2 + Jet(1), h10 = u3 - Jet(2) * u2 + u, h01 = Jet(-2) * u3 + Jet(3) * u2, h11 = u3 - u2;
  const Jet d00 = Jet(6) * u2 - Jet(6) * u, d10 = Jet(3) * u2 - Jet(4) * u + Jet(1), d01 = Jet(-6) * u2 + Jet(6) * u, d11 = Jet(3) * u2 - Jet(2) * u;
  const double h = step;
  Vec3J point = constant(row0) * h00 + constant(row0 + 3) * (h10 * Jet(h)) + constant(row1) * h01 + constant(row1 + 3) * (h11 * Jet(h));
  const Vec3J slope = constant(row0) * (d00 * Jet(1 / h)) + constant(row0 + 3) * d10 + constant(row1) * (d01 * Jet(1 / h)) + constant(row1 + 3) * d11;
  const Vec3J tangent = normalized(slope);
  const Vec3J blended = constant(row0 + 6) * (Jet(1) - u) + constant(row1 + 6) * u;
  const Vec3J normal = normalized(blended - tangent * dot(blended, tangent));
  const Vec3J binormal = cross(tangent, normal);
  if (s.v < 0) point = point + tangent * s;
  else if (s.v > length) point = point + tangent * (s - Jet(length));
  return {point, tangent, normal, binormal};
}

// The arc length s of the base table where q lies in the normal plane of the base (flow.ts projectOnBase: Newton from the nearest station).
inline double project_on_base(const std::vector<double> &stations, double step, const double q[3], double *derivative_out = nullptr) {
  const size_t count = stations.size() / 12;
  const double length = static_cast<double>(count - 1) * step;
  // seed: the nearest station, on a coarse grid of every stride-th station and then within one stride of the coarse winner (flow.ts projectOnBase)
  const size_t stride = std::max<size_t>(1, static_cast<size_t>(std::ceil(std::sqrt(static_cast<double>(count)))));
  size_t best = 0;
  double nearest = 1e300;
  const auto consider = [&](size_t k) {
    double distance = 0;
    for (int a = 0; a < 3; ++a) {
      const double gap = q[a] - stations[k * 12 + static_cast<size_t>(a)];
      distance += gap * gap;
    }
    if (distance < nearest) {
      nearest = distance;
      best = k;
    }
  };
  for (size_t k = 0; k < count; k += stride) consider(k);
  const size_t coarse = best;
  for (size_t k = coarse > stride ? coarse - stride : 0; k <= std::min(count - 1, coarse + stride); ++k) consider(k);
  double s = static_cast<double>(best) * step;
  const double h = 1e-4 * step;
  double derivative = -1;
  for (int iteration = 0; iteration < 40; ++iteration) {
    const FlowSample here = flow_sample(stations, step, Jet(s));
    const FlowSample ahead = flow_sample(stations, step, Jet(s + h));
    const FlowSample behind = flow_sample(stations, step, Jet(s - h));
    double along = 0, bend = 0;
    for (size_t a = 0; a < 3; ++a) {
      const double gap = q[a] - here.point[a].v;
      along += gap * here.tangent[a].v;
      bend += gap * ((ahead.tangent[a].v - behind.tangent[a].v) * (1 / (2 * h)));
    }
    derivative = -1 + bend;
    if (std::fabs(derivative) < 1e-12) break;
    const double move = along / derivative;
    s -= move;
    if (std::fabs(move) < 1e-13 * (1 + length)) break;
  }
  if (derivative_out != nullptr) *derivative_out = derivative;
  return s;
}

inline Vec3J flow_map(const Flow &flow, const Vec3J &q) {
  if (flow.base.empty()) {
    const FlowSample at = flow_sample(flow.stations, flow.step, Jet(flow.ratio) * (q[2] - Jet(flow.z0)));
    return at.point + at.normal * q[0] + at.binormal * q[1];
  }
  const double point[3] = {q[0].v, q[1].v, q[2].v};
  double derivative = -1;
  Jet arc(project_on_base(flow.base, flow.base_step, point, &derivative));
  // implicit derivative of the projection: ds = T.dq / (1 - gap.T'), the same Jet direction as q
  const FlowSample own = flow_sample(flow.base, flow.base_step, arc);
  for (size_t a = 0; a < 3; ++a) arc.a += own.tangent[a].v * q[a].a / -derivative;
  const FlowSample base = flow_sample(flow.base, flow.base_step, arc);
  const Vec3J gap = q - base.point;
  const FlowSample at = flow_sample(flow.stations, flow.step, Jet(flow.ratio) * (arc - Jet(flow.z0)));
  return at.point + at.normal * dot(gap, base.normal) + at.binormal * dot(gap, base.binormal);
}

inline void catmull_rom(const Jet &t, Jet out[4]) {
  const Jet t2 = t * t, t3 = t2 * t;
  out[0] = Jet(-0.5) * t3 + t2 - Jet(0.5) * t;
  out[1] = Jet(1.5) * t3 - Jet(2.5) * t2 + Jet(1);
  out[2] = Jet(-1.5) * t3 + Jet(2) * t2 + Jet(0.5) * t;
  out[3] = Jet(0.5) * t3 - Jet(0.5) * t2;
}

inline Vec3J flow_surface_map(const FlowSurface &table, const Vec3J &q) {
  const auto cell = [](const Jet &x, double origin, double step, int count, int &index) {
    const Jet raw = (x - Jet(origin)) * Jet(1 / step);
    const double hi = static_cast<double>(count - 1);
    const Jet f = raw.v < 0 ? Jet(0) : (raw.v > hi ? Jet(hi) : raw);
    index = std::min(static_cast<int>(std::floor(f.v)), count - 2);
    return f - Jet(static_cast<double>(index));
  };
  int i = 0, j = 0;
  const Jet tx = cell(q[0], table.x0, table.hx, table.nx, i);
  const Jet ty = cell(q[1], table.y0, table.hy, table.ny, j);
  Jet wx[4], wy[4];
  catmull_rom(tx, wx);
  catmull_rom(ty, wy);
  Jet sum[6];
  for (int a = 0; a < 4; ++a) {
    const int row = std::min(std::max(i - 1 + a, 0), table.nx - 1);
    for (int b = 0; b < 4; ++b) {
      const int column = std::min(std::max(j - 1 + b, 0), table.ny - 1);
      const Jet weight = wx[a] * wy[b];
      const double *node = &table.nodes[(static_cast<size_t>(row) * static_cast<size_t>(table.ny) + static_cast<size_t>(column)) * 6];
      for (int c = 0; c < 6; ++c) sum[c] = sum[c] + weight * Jet(node[c]);
    }
  }
  const Vec3J normal = normalized({sum[3], sum[4], sum[5]});
  return {sum[0] + q[2] * normal[0], sum[1] + q[2] * normal[1], sum[2] + q[2] * normal[2]};
}

inline Vec3J rbf_map(const Rbf &field, const Vec3J &q) {
  const double *m = field.affine;
  Vec3J out = {q[0] + Jet(m[0]) + Jet(m[3]) * q[0] + Jet(m[4]) * q[1] + Jet(m[5]) * q[2], q[1] + Jet(m[1]) + Jet(m[6]) * q[0] + Jet(m[7]) * q[1] + Jet(m[8]) * q[2],
               q[2] + Jet(m[2]) + Jet(m[9]) * q[0] + Jet(m[10]) * q[1] + Jet(m[11]) * q[2]};
  for (size_t i = 0; i < field.centres.size() / 3; ++i) {
    const Jet dx = q[0] - Jet(field.centres[3 * i]), dy = q[1] - Jet(field.centres[3 * i + 1]), dz = q[2] - Jet(field.centres[3 * i + 2]);
    const Jet squared = dx * dx + dy * dy + dz * dz;
    if (!(squared.v > 0)) continue;
    const Jet r = sqrt(squared);
    const Jet cube = r * r * r;
    for (size_t a = 0; a < 3; ++a) out[a] = out[a] + Jet(field.weights[3 * i + a]) * cube;
  }
  return out;
}

// The law applied to local coordinates (laws.ts mapLocal).
inline Vec3J map_local(const Law &law, const Region &region, const Vec3J &q) {
  switch (law.kind) {
    case LawKind::Affine: {
      Vec3J out;
      for (size_t r = 0; r < 3; ++r)
        out[r] = Jet(law.matrix[3 * r]) * q[0] + Jet(law.matrix[3 * r + 1]) * q[1] + Jet(law.matrix[3 * r + 2]) * q[2] + Jet(law.translation[r]);
      return out;
    }
    case LawKind::Twist: {
      const Jet theta = Jet(law.angle) * ramp(region, q[2]);
      const Jet s = sin(theta), c = cos(theta);
      return {q[0] * c - q[1] * s, q[0] * s + q[1] * c, q[2]};
    }
    case LawKind::Taper: {
      const Jet s = Jet(1) + Jet(law.scale_end - 1) * ramp(region, q[2]);
      return {s * q[0], law.flat ? q[1] : s * q[1], q[2]};
    }
    case LawKind::Stretch: {
      if (region.infinite) return {q[0], q[1], Jet(region.start) + Jet(law.factor) * (q[2] - Jet(region.start))};
      if (q[2].v <= region.start) return q;
      if (q[2].v <= region.end) return {q[0], q[1], Jet(region.start) + Jet(law.factor) * (q[2] - Jet(region.start))};
      return {q[0], q[1], q[2] + Jet((law.factor - 1) * (region.end - region.start))};
    }
    case LawKind::Bend:
      return bend_map(law, region, q);
    case LawKind::Lattice:
      return lattice_map(law.lattice, q);
    case LawKind::Point:
      return point_map(law, q);
    case LawKind::Flow:
      return flow_map(law.flow, q);
    case LawKind::FlowSurface:
      return flow_surface_map(law.surface, q);
    case LawKind::Rbf:
      return rbf_map(law.rbf, q);
  }
  return q;
}

// World-space map of a deform node: world jets in, world jets out.
struct Warp {
  Frame frame;
  Region region;
  Law law;

  Vec3J apply(const Vec3J &p) const {
    Vec3J local;
    for (size_t r = 0; r < 3; ++r) {
      const double *axis = r == 0 ? frame.x : r == 1 ? frame.y : frame.z;
      local[r] = (p[0] - Jet(frame.origin[0])) * Jet(axis[0]) + (p[1] - Jet(frame.origin[1])) * Jet(axis[1]) +
                 (p[2] - Jet(frame.origin[2])) * Jet(axis[2]);
    }
    const Vec3J image = map_local(law, region, local);
    Vec3J out;
    for (size_t k = 0; k < 3; ++k)
      out[k] = Jet(frame.origin[k]) + image[0] * Jet(frame.x[k]) + image[1] * Jet(frame.y[k]) + image[2] * Jet(frame.z[k]);
    return out;
  }

  void point(const double in[3], double out[3]) const {
    const Vec3J image = apply({Jet(in[0]), Jet(in[1]), Jet(in[2])});
    for (size_t k = 0; k < 3; ++k) out[k] = image[k].v;
  }
};

}  // namespace deform
}  // namespace llull
