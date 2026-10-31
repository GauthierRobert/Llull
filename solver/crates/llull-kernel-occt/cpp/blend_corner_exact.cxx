// The exact-boundary corner patch (BLD 13.21). The hole of a setback corner is a closed loop of m edges, each lying on a support face (a blend end, a flat face). The patch is a star
// of m sub-patches around one centre C: sub-patch k has the loop edge k as its bottom side and two spokes (quintic Hermite curves from the vertices k and k+1 of the loop to C) as its
// left and right sides; its top side is the point C. Each is a Hermite-Coons patch (Boolean sum of two Hermite lofts less the bicubic corner patch) whose cross-boundary tangents are
// projected onto the tangent planes of the support (along the loop edges) and onto a shared normal field (along the spokes): the loop edges are its boundary exactly and the tangent
// planes agree with the supports, and with the neighbouring sub-patch along a spoke, by construction. The curvature of the supports jumps at the vertices of the loop (a cylinder
// against a plane), so the mixed derivative of a cross tangent cannot be the same from both sides there: the derivative of the spoke's normal field at each vertex is solved so
// that it is, which is why every vertex of the loop gets a spoke. Each sub-patch is sampled and interpolated by a degree-5 B-spline (the boundary data are smooth: the interpolation
// error is of the order of h^6), the shared spokes being the same quintic polynomial from both sides.
#include "llull-kernel-occt/cpp/blend_corner_exact.hxx"

#include <algorithm>
#include <cmath>
#include <functional>
#include <iterator>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

namespace llull::corner_exact {

namespace {

using Vec = gp_Vec;

constexpr double kPi = 3.14159265358979323846;
constexpr int kDegree = 5;
constexpr int kCheckSamples = 100;
// The poles per direction of the interpolation, tried in turn.
constexpr int kPoleCounts[] = {8, 11, 14, 24};
// The corner of the outline of the hole at a vertex must open between these angles (radians) for a spoke to leave between its edges.
constexpr double kMinWedge = 0.1;
// Two supports meeting at a vertex must have normals within this cosine.
constexpr double kNormalCosine = 0.999;

struct Hermite3 {
  double p0, d0, p1, d1;
};

Hermite3 cubic(double t) {
  const double t2 = t * t, t3 = t2 * t;
  return {2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2};
}

Vec cubic_vec(double t, const Vec &p0, const Vec &d0, const Vec &p1, const Vec &d1) {
  const Hermite3 h = cubic(t);
  return p0 * h.p0 + d0 * h.d0 + p1 * h.p1 + d1 * h.d1;
}

// Quintic Hermite basis (value, first and second derivative at 0, then at 1) as coefficients of t^0..t^5.
constexpr double kQuintic[6][6] = {{1, 0, 0, -10, 15, -6}, {0, 1, 0, -6, 8, -3}, {0, 0, 0.5, -1.5, 1.5, -0.5}, {0, 0, 0, 0.5, -1, 0.5}, {0, 0, 0, -4, 7, -3}, {0, 0, 0, 10, -15, 6}};

double poly(const double *c, double t, int derivative) {
  double sum = 0;
  for (int k = derivative; k < 6; ++k) {
    double factor = 1;
    for (int j = 0; j < derivative; ++j) factor *= (k - j);
    sum += c[k] * factor * std::pow(t, k - derivative);
  }
  return sum;
}

// A quintic curve on [0,1] from p0 (first derivative d0, second q0) to p1 (d1, q1).
struct Quintic {
  Vec p0, d0, q0, q1, d1, p1;
  Vec at(double t, int derivative) const {
    const Vec *data[6] = {&p0, &d0, &q0, &q1, &d1, &p1};
    Vec sum(0, 0, 0);
    for (int k = 0; k < 6; ++k) sum += *data[k] * poly(kQuintic[k], t, derivative);
    return sum;
  }
};

bool unit(Vec &v) {
  const double length = v.Magnitude();
  if (!(length > 1e-300)) return false;
  v /= length;
  return true;
}

Vec project(const Vec &v, const Vec &normal) { return v - normal * (v * normal); }

// One loop edge with the support it lies on, parametrized by s in [0,1] along the direction of the loop.
struct Side {
  BRepAdaptor_Curve curve;
  double first = 0, last = 0;
  bool reversed = false;
  Handle(Geom2d_Curve) pcurve;
  BRepAdaptor_Surface surface;
  bool flipped = false;  // the support face is reversed in its solid: its outward normal is the opposite of du ^ dv

  double param(double s) const { return reversed ? last - s * (last - first) : first + s * (last - first); }
  gp_Pnt point(double s) const { return curve.Value(param(s)); }
  Vec tangent(double s) const {
    gp_Pnt p;
    Vec d;
    curve.D1(param(s), p, d);
    return d * ((reversed ? -1.0 : 1.0) * (last - first));
  }
  bool normal(double s, Vec &n) const {
    const gp_Pnt2d uv = pcurve->Value(param(s));
    gp_Pnt p;
    Vec du, dv;
    surface.D1(uv.X(), uv.Y(), p, du, dv);
    n = du ^ dv;
    if (!unit(n)) return false;
    if (flipped) n.Reverse();
    return true;
  }
  // d(normal)/ds, by a second-order difference of the normal of the support.
  bool normal_rate(double s, Vec &rate) const {
    constexpr double h = 1e-4;
    Vec a, b, c;
    if (s < 0.5) {
      if (!normal(s, a) || !normal(s + h, b) || !normal(s + 2 * h, c)) return false;
      rate = (a * -3.0 + b * 4.0 - c) / (2 * h);
    } else {
      if (!normal(s, a) || !normal(s - h, b) || !normal(s - 2 * h, c)) return false;
      rate = (a * 3.0 - b * 4.0 + c) / (2 * h);
    }
    return true;
  }
};

// Everything of the star at one vertex of the loop.
struct Vertex {
  gp_Pnt at;
  Vec normal, toward;  // support normal, spoke direction (unit, in the tangent plane)
  Vec leaving, arriving;  // tangent of the loop edge that starts here, tangent of the one that ends here (both d/ds)
  Vec rate_leaving, rate_arriving;  // d(normal)/ds of the supports along them
  Vec rate;  // d(normal)/dv of the spoke at the vertex
  Vec spoke_tangent;
};

struct Star {
  std::vector<Side> sides;
  std::vector<Vertex> vertices;
  std::vector<Quintic> spokes;
  std::vector<Vec> spoke_rate_start;  // as vertices[k].rate
  gp_Pnt centre;
  Vec centre_normal;
  double curvature_at_centre = 0;
  std::vector<Vec> arrival;  // spoke tangent at the centre
  Vec rate_at_centre(size_t k) const { return arrival[k] * curvature_at_centre; }

  // The normal of the shared tangent plane along spoke k at v.
  bool spoke_normal(size_t k, double v, Vec &n) const {
    Vec g = cubic_vec(v, vertices[k].normal, vertices[k].rate, centre_normal, rate_at_centre(k));
    Vec t = spokes[k].at(v, 1);
    if (!unit(t)) return false;
    n = project(g, t);
    return unit(n);
  }
};

bool solve_vertex(Vertex &vertex, double scale, std::string &why) {
  Vec a = project(vertex.leaving, vertex.normal), b = project(vertex.arriving * -1.0, vertex.normal);
  if (!unit(a) || !unit(b)) {
    why = "an edge of the hole has no tangent at a vertex";
    return false;
  }
  const Vec across = vertex.normal ^ a;
  const double wedge_sin = vertex.normal * (a ^ b), wedge_cos = a * b;
  double wedge = std::atan2(wedge_sin, wedge_cos);
  if (wedge < 0) wedge += 2 * kPi;
  if (wedge < kMinWedge || wedge > 2 * kPi - kMinWedge) {
    why = "the hole has a vertex that closes to " + std::to_string(wedge) + " rad (a spike)";
    return false;
  }
  vertex.toward = a * std::cos(wedge / 2) + across * std::sin(wedge / 2);
  (void)scale;
  return true;
}

// Dn (in the tangent plane) with Dn . leaving = rate_leaving . D0 and Dn . arriving = rate_arriving . D0, least squares with a small damping when the two tangents are parallel.
Vec spoke_rate(const Vertex &vertex, const Vec &d0) {
  const Vec b1 = project(vertex.leaving, vertex.normal).Normalized(), b2 = vertex.normal ^ b1;
  const double m[2][2] = {{vertex.leaving * b1, vertex.leaving * b2}, {vertex.arriving * b1, vertex.arriving * b2}};
  const double r[2] = {vertex.rate_leaving * d0, vertex.rate_arriving * d0};
  const double eps = 1e-8 * (vertex.leaving.SquareMagnitude() + vertex.arriving.SquareMagnitude());
  const double a00 = m[0][0] * m[0][0] + m[1][0] * m[1][0] + eps, a01 = m[0][0] * m[0][1] + m[1][0] * m[1][1], a11 = m[0][1] * m[0][1] + m[1][1] * m[1][1] + eps;
  const double y0 = m[0][0] * r[0] + m[1][0] * r[1], y1 = m[0][1] * r[0] + m[1][1] * r[1];
  const double det = a00 * a11 - a01 * a01;
  const double x = (y0 * a11 - y1 * a01) / det, y = (a00 * y1 - a01 * y0) / det;
  return b1 * x + b2 * y;
}

// The patch k of the star at (u, v).
struct Patch {
  const Star &star;
  size_t k, j;
  Vec suv00, suv10, theta;

  Vec cross_bottom(double u) const {
    const Vertex &a = star.vertices[k], &b = star.vertices[j];
    Vec n;
    star.sides[k].normal(u, n);
    return project(cubic_vec(u, a.spoke_tangent, suv00, b.spoke_tangent, suv10), n);
  }
  Vec cross_left(double v) const {
    Vec n;
    star.spoke_normal(k, v, n);
    return project(cubic_vec(v, star.vertices[k].leaving, suv00, Vec(0, 0, 0), theta), n);
  }
  Vec cross_right(double v) const {
    Vec n;
    star.spoke_normal(j, v, n);
    return project(cubic_vec(v, star.sides[k].tangent(1), suv10, Vec(0, 0, 0), theta), n);
  }
  Vec cross_top(double u) const { return star.arrival[k] * (1 - u) + star.arrival[j] * u; }

  gp_Pnt at(double u, double v) const {
    const Vertex &a = star.vertices[k], &b = star.vertices[j];
    const Vec origin(0, 0, 0);
    const Vec centre(star.centre.XYZ());
    const Vec bottom(star.sides[k].point(u).XYZ());
    const Vec left(star.spokes[k].at(v, 0)), right(star.spokes[j].at(v, 0));
    const Hermite3 hu = cubic(u), hv = cubic(v);
    const Vec p_v = bottom * hv.p0 + centre * hv.p1 + cross_bottom(u) * hv.d0 + cross_top(u) * hv.d1;
    const Vec p_u = left * hu.p0 + right * hu.p1 + cross_left(v) * hu.d0 + cross_right(v) * hu.d1;
    // the bicubic corner patch
    const Vec corner_s[2][2] = {{Vec(gp_XYZ(a.at.XYZ())), centre}, {Vec(gp_XYZ(b.at.XYZ())), centre}};
    const Vec corner_su[2][2] = {{a.leaving, origin}, {star.sides[k].tangent(1), origin}};
    const Vec corner_sv[2][2] = {{a.spoke_tangent, star.arrival[k]}, {b.spoke_tangent, star.arrival[j]}};
    const Vec corner_suv[2][2] = {{suv00, theta}, {suv10, theta}};
    const double fu[2] = {hu.p0, hu.p1}, du[2] = {hu.d0, hu.d1}, fv[2] = {hv.p0, hv.p1}, dv[2] = {hv.d0, hv.d1};
    Vec p_uv = origin;
    for (int s = 0; s < 2; ++s)
      for (int t = 0; t < 2; ++t) p_uv += corner_s[s][t] * (fu[s] * fv[t]) + corner_su[s][t] * (du[s] * fv[t]) + corner_sv[s][t] * (fu[s] * dv[t]) + corner_suv[s][t] * (du[s] * dv[t]);
    const Vec sum = p_u + p_v - p_uv;
    return gp_Pnt(sum.X(), sum.Y(), sum.Z());
  }
};

// B-spline basis functions (Cox - de Boor) of the clamped uniform knot vector of `poles` poles.
struct Basis {
  int poles;
  std::vector<double> knots;  // flat
  explicit Basis(int count) : poles(count) {
    const int spans = count - kDegree;
    for (int k = 0; k <= kDegree; ++k) knots.push_back(0);
    for (int k = 1; k < spans; ++k) knots.push_back(static_cast<double>(k) / spans);
    for (int k = 0; k <= kDegree; ++k) knots.push_back(1);
  }
  std::vector<double> at(double t) const {
    std::vector<double> values(static_cast<size_t>(poles), 0.0);
    int span = kDegree;
    while (span < poles - 1 && t >= knots[static_cast<size_t>(span + 1)]) ++span;
    std::vector<double> n(static_cast<size_t>(kDegree + 1), 0.0), left(kDegree + 1), right(kDegree + 1);
    n[0] = 1;
    for (int j = 1; j <= kDegree; ++j) {
      left[static_cast<size_t>(j)] = t - knots[static_cast<size_t>(span + 1 - j)];
      right[static_cast<size_t>(j)] = knots[static_cast<size_t>(span + j)] - t;
      double saved = 0;
      for (int r = 0; r < j; ++r) {
        const double denominator = right[static_cast<size_t>(r + 1)] + left[static_cast<size_t>(j - r)];
        const double temp = n[static_cast<size_t>(r)] / denominator;
        n[static_cast<size_t>(r)] = saved + right[static_cast<size_t>(r + 1)] * temp;
        saved = left[static_cast<size_t>(j - r)] * temp;
      }
      n[static_cast<size_t>(j)] = saved;
    }
    for (int r = 0; r <= kDegree; ++r) values[static_cast<size_t>(span - kDegree + r)] = n[static_cast<size_t>(r)];
    return values;
  }
  double greville(int index) const {
    double sum = 0;
    for (int k = 1; k <= kDegree; ++k) sum += knots[static_cast<size_t>(index + k)];
    return sum / kDegree;
  }
};

// The inverse of the collocation matrix (Gauss - Jordan with partial pivoting); false when singular.
bool inverse_of(const Basis &basis, std::vector<std::vector<double>> &inverse) {
  const size_t n = static_cast<size_t>(basis.poles);
  std::vector<std::vector<double>> a(n, std::vector<double>(2 * n, 0.0));
  for (size_t i = 0; i < n; ++i) {
    const std::vector<double> row = basis.at(basis.greville(static_cast<int>(i)));
    for (size_t j = 0; j < n; ++j) a[i][j] = row[j];
    a[i][n + i] = 1;
  }
  for (size_t c = 0; c < n; ++c) {
    size_t pivot = c;
    for (size_t r = c + 1; r < n; ++r)
      if (std::fabs(a[r][c]) > std::fabs(a[pivot][c])) pivot = r;
    if (std::fabs(a[pivot][c]) < 1e-14) return false;
    std::swap(a[c], a[pivot]);
    const double scale = a[c][c];
    for (double &value : a[c]) value /= scale;
    for (size_t r = 0; r < n; ++r) {
      if (r == c) continue;
      const double factor = a[r][c];
      if (factor == 0) continue;
      for (size_t k = 0; k < 2 * n; ++k) a[r][k] -= factor * a[c][k];
    }
  }
  inverse.assign(n, std::vector<double>(n, 0.0));
  for (size_t i = 0; i < n; ++i)
    for (size_t j = 0; j < n; ++j) inverse[i][j] = a[i][n + j];
  return true;
}

Handle(Geom_BSplineSurface) interpolate(const Patch &patch, int poles) {
  const Basis basis(poles);
  std::vector<std::vector<double>> inverse;
  if (!inverse_of(basis, inverse)) return nullptr;
  const size_t n = static_cast<size_t>(poles);
  std::vector<std::vector<gp_Pnt>> samples(n, std::vector<gp_Pnt>(n));
  for (size_t i = 0; i < n; ++i)
    for (size_t j = 0; j < n; ++j) samples[i][j] = patch.at(basis.greville(static_cast<int>(i)), basis.greville(static_cast<int>(j)));
  // along u, then along v
  std::vector<std::vector<gp_XYZ>> mid(n, std::vector<gp_XYZ>(n, gp_XYZ(0, 0, 0)));
  for (size_t i = 0; i < n; ++i)
    for (size_t j = 0; j < n; ++j)
      for (size_t a = 0; a < n; ++a) mid[i][j] += samples[a][j].XYZ() * inverse[i][a];
  TColgp_Array2OfPnt grid(1, poles, 1, poles);
  for (size_t i = 0; i < n; ++i)
    for (size_t j = 0; j < n; ++j) {
      gp_XYZ sum(0, 0, 0);
      for (size_t b = 0; b < n; ++b) sum += mid[i][b] * inverse[j][b];
      grid.SetValue(static_cast<int>(i) + 1, static_cast<int>(j) + 1, gp_Pnt(sum));
    }
  // the collapsed side is one point exactly (the interpolation leaves it 1e-9 apart: its derivative along u would be noise, not zero)
  for (int i = 1; i <= poles; ++i) grid.SetValue(i, poles, patch.star.centre);
  const int spans = poles - kDegree;
  TColStd_Array1OfReal knots(1, spans + 1);
  TColStd_Array1OfInteger mults(1, spans + 1);
  for (int k = 0; k <= spans; ++k) {
    knots.SetValue(k + 1, static_cast<double>(k) / spans);
    mults.SetValue(k + 1, k == 0 || k == spans ? kDegree + 1 : 1);
  }
  return new Geom_BSplineSurface(grid, knots, knots, mults, mults, kDegree, kDegree);
}

// Puts the centre at `height` above the centroid along the mean normal and builds the spokes from it; false (with `why`) when the star is degenerate.
bool place(Star &star, const gp_XYZ &centroid, double height, double scale, std::string &why) {
  const size_t m = star.vertices.size();
  const Vec centre_normal = star.centre_normal;
  star.centre = gp_Pnt(centroid.X() + centre_normal.X() * height, centroid.Y() + centre_normal.Y() * height, centroid.Z() + centre_normal.Z() * height);
  // The spokes.
  star.spokes.resize(m);
  star.arrival.resize(m);
  double curvature = 0;
  for (size_t k = 0; k < m; ++k) {
    Vertex &vertex = star.vertices[k];
    const Vec chord(vertex.at, star.centre);
    const double length = chord.Magnitude();
    if (!(length > 1e-9 * std::max(scale, 1e-9))) {
      why = "a vertex of the hole is at its centre";
      return false;
    }
    vertex.spoke_tangent = vertex.toward * length;
    vertex.rate = spoke_rate(vertex, vertex.spoke_tangent);
    curvature += (vertex.rate * vertex.spoke_tangent) / vertex.spoke_tangent.SquareMagnitude();
    Vec outward = project(Vec(star.centre, vertex.at), centre_normal);
    if (!unit(outward)) outward = vertex.toward * -1.0;
    star.arrival[k] = outward * (-length);
  }
  star.curvature_at_centre = curvature / static_cast<double>(m);
  // The spokes must turn the same way around the centre, each wedge less than a half turn (the hole is star-shaped about the centre), or a sub-patch folds.
  double turn = 0;
  for (size_t k = 0; k < m; ++k) {
    const Vec a = star.arrival[k], b = star.arrival[(k + 1) % m];
    const double wedge = std::atan2(centre_normal * (a ^ b), a * b);
    if (!(wedge > 0.05 && wedge < kPi - 0.05)) {
      why = "the hole is not star-shaped about its centre (the spokes " + std::to_string(k) + " and " + std::to_string((k + 1) % m) + " close to " + std::to_string(wedge) + " rad)";
      return false;
    }
    turn += wedge;
  }
  if (std::fabs(turn - 2 * kPi) > 1e-6) {
    why = "the spokes do not turn once around the centre of the hole (" + std::to_string(turn) + " rad)";
    return false;
  }
  for (size_t k = 0; k < m; ++k) {
    const Vertex &vertex = star.vertices[k];
    Quintic &spoke = star.spokes[k];
    spoke.p0 = Vec(vertex.at.XYZ());
    spoke.d0 = vertex.spoke_tangent;
    spoke.q0 = vertex.normal * -(vertex.rate * vertex.spoke_tangent);
    spoke.p1 = Vec(star.centre.XYZ());
    spoke.d1 = star.arrival[k];
    spoke.q1 = centre_normal * -(star.curvature_at_centre * star.arrival[k].SquareMagnitude());
  }
  return true;
}

double line_angle(const Vec &a, const Vec &b) {
  const double dot = std::fabs(a * b) / std::max(a.Magnitude() * b.Magnitude(), 1e-300);
  return std::acos(std::min(1.0, dot));
}

bool normal_of(const Handle(Geom_BSplineSurface) &surface, double u, double v, Vec &n) {
  gp_Pnt p;
  Vec du, dv;
  surface->D1(u, v, p, du, dv);
  n = du ^ dv;
  return unit(n);
}

}  // namespace

bool build(const std::vector<TopoDS_Edge> &loop, const std::vector<TopoDS_Face> &supports, double max_gap, double max_angle, Patches &out, std::string &why) {
  const size_t m = loop.size();
  if (m < 3 || supports.size() != m) {
    why = "the hole has fewer than 3 edges";
    return false;
  }
  Star star;
  star.sides.resize(m);
  for (size_t k = 0; k < m; ++k) {
    Side &side = star.sides[k];
    side.curve.Initialize(loop[k]);
    BRep_Tool::Range(loop[k], side.first, side.last);
    double pf = 0, pl = 0;
    side.pcurve = BRep_Tool::CurveOnSurface(loop[k], supports[k], pf, pl);
    if (side.pcurve.IsNull() || !BRep_Tool::SameParameter(loop[k])) {
      why = "an edge of the hole has no curve on its support";
      return false;
    }
    side.surface.Initialize(supports[k], Standard_False);
    side.flipped = supports[k].Orientation() == TopAbs_REVERSED;
  }
  // The direction of each edge along the loop.
  const auto ends = [&](size_t k, gp_Pnt &a, gp_Pnt &b) {
    a = star.sides[k].curve.Value(star.sides[k].first);
    b = star.sides[k].curve.Value(star.sides[k].last);
  };
  gp_Pnt a0, b0, a1, b1;
  ends(0, a0, b0);
  ends(1, a1, b1);
  star.sides[0].reversed = std::min(a0.Distance(a1), a0.Distance(b1)) < std::min(b0.Distance(a1), b0.Distance(b1));
  gp_Pnt cursor = star.sides[0].point(1);
  double scale = 0;
  for (size_t k = 1; k < m; ++k) {
    gp_Pnt a, b;
    ends(k, a, b);
    star.sides[k].reversed = b.Distance(cursor) < a.Distance(cursor);
    cursor = star.sides[k].point(1);
  }
  for (size_t k = 0; k < m; ++k) {
    scale = std::max(scale, star.sides[k].point(0).Distance(star.sides[k].point(1)));
    if (star.sides[k].point(1).Distance(star.sides[(k + 1) % m].point(0)) > 1e-5 * std::max(scale, 1e-9)) {
      why = "the edges of the hole do not chain";
      return false;
    }
  }
  // The loop runs counter-clockwise seen from outside (the patch on the left): reverse it otherwise.
  const auto side_normal = [&](size_t k, double s, Vec &n) { return star.sides[k].normal(s, n); };
  Vec mean(0, 0, 0), newell(0, 0, 0);
  for (size_t k = 0; k < m; ++k) {
    Vec n;
    if (!side_normal(k, 0.0, n)) {
      why = "a support has no normal at a vertex";
      return false;
    }
    mean += n;
    const gp_Pnt p = star.sides[k].point(0), q = star.sides[(k + 1) % m].point(0);
    newell += Vec(p.XYZ()) ^ Vec(q.XYZ());
  }
  if (newell * mean < 0) {
    std::reverse(star.sides.begin(), star.sides.end());
    for (Side &side : star.sides) side.reversed = !side.reversed;
  }
  // The vertices.
  star.vertices.resize(m);
  Vec centre_normal(0, 0, 0);
  gp_XYZ centroid(0, 0, 0);
  for (size_t k = 0; k < m; ++k) {
    const size_t before = (k + m - 1) % m;
    Vertex &vertex = star.vertices[k];
    Vec n_leaving, n_arriving;
    if (!star.sides[k].normal(0, n_leaving) || !star.sides[before].normal(1, n_arriving)) {
      why = "a support has no normal at a vertex";
      return false;
    }
    if (n_leaving * n_arriving < kNormalCosine) {
      why = "the supports of the hole are not tangent at a vertex (normals differ by " + std::to_string(std::acos(std::min(1.0, n_leaving * n_arriving))) + " rad)";
      return false;
    }
    vertex.normal = n_leaving + n_arriving;
    unit(vertex.normal);
    vertex.at = star.sides[k].point(0);
    vertex.leaving = star.sides[k].tangent(0);
    vertex.arriving = star.sides[before].tangent(1);
    if (!star.sides[k].normal_rate(0, vertex.rate_leaving) || !star.sides[before].normal_rate(1, vertex.rate_arriving)) {
      why = "a support has no normal rate at a vertex";
      return false;
    }
    if (!solve_vertex(vertex, scale, why)) return false;
    centre_normal += vertex.normal;
    centroid += vertex.at.XYZ();
  }
  if (!unit(centre_normal)) {
    why = "the hole closes on itself (the normals at its vertices cancel)";
    return false;
  }
  star.centre_normal = centre_normal;
  centroid /= static_cast<double>(m);
  double height = 0;
  for (const Vertex &vertex : star.vertices) {
    const double along = vertex.normal * centre_normal;
    if (along < 0.2) {
      why = "the normals of the hole turn by more than 78 degrees from its mean";
      return false;
    }
    height += (vertex.normal * (Vec(vertex.at.XYZ()) - Vec(centroid))) / along;
  }
  // The centre: 3/8 of the mean height of the tangent planes of the vertices above the centroid. For a hole bounded by a cylinder arc and a plane chord the exact (thin plate) surface
  // passes there to 4e-6 of the volume of the corner (13.21.4).
  if (!place(star, centroid, 0.375 * height / static_cast<double>(m), scale, why)) return false;
  // The patches.
  std::vector<Patch> patches;
  for (size_t k = 0; k < m; ++k) {
    const size_t j = (k + 1) % m;
    Patch patch{star, k, j, Vec(), Vec(), Vec()};
    patch.suv00 = star.vertices[k].normal * -(star.vertices[k].rate_leaving * star.vertices[k].spoke_tangent);
    patch.suv10 = star.vertices[j].normal * -(star.vertices[j].rate_arriving * star.vertices[j].spoke_tangent);
    patch.theta = star.arrival[j] - star.arrival[k];
    patches.push_back(patch);
  }
  for (const int poles : kPoleCounts) {
    // the coarse interpolations must leave a margin under the angle limit; the finest may use all of it
    const double angle_limit = poles == kPoleCounts[std::size(kPoleCounts) - 1] ? max_angle : 0.25 * max_angle;
    out = Patches();
    out.centre = star.centre;
    std::vector<Handle(Geom_BSplineSurface)> surfaces;
    for (const Patch &patch : patches) {
      Handle(Geom_BSplineSurface) surface = interpolate(patch, poles);
      if (surface.IsNull()) {
        why = "the interpolation matrix is singular";
        return false;
      }
      surfaces.push_back(surface);
    }
    // The measures: the loop edges against the bottom of the patch, the normals against the supports, the neighbours along the spokes.
    for (size_t k = 0; k < m; ++k) {
      for (int s = 0; s <= kCheckSamples; ++s) {
        const double t = static_cast<double>(s) / kCheckSamples;
        out.gap = std::max(out.gap, surfaces[k]->Value(t, 0).Distance(star.sides[k].point(t)));
        Vec support, mine;
        if (star.sides[k].normal(t, support) && normal_of(surfaces[k], t, 0, mine)) {
          out.angle = std::max(out.angle, line_angle(support, mine));
          if (support * mine < 0) {
            why = "sub-patch " + std::to_string(k) + " faces away from its support at " + std::to_string(t);
            return false;
          }
        }
        else
          out.angle = std::max(out.angle, kPi / 2);
        if (t < 0.97) {
          const size_t previous = (k + m - 1) % m;
          Vec left, right;
          if (normal_of(surfaces[k], 0, t, left) && normal_of(surfaces[previous], 1, t, right)) {
            out.angle = std::max(out.angle, line_angle(left, right));
            if (left * right < 0) {
              why = "sub-patches " + std::to_string(previous) + " and " + std::to_string(k) + " face opposite ways along their spoke at " + std::to_string(t);
              return false;
            }
          }
          out.gap = std::max(out.gap, surfaces[k]->Value(0, t).Distance(surfaces[previous]->Value(1, t)));
        }
      }
    }
    if (out.gap <= max_gap && out.angle <= angle_limit) {
      for (const Handle(Geom_BSplineSurface) &surface : surfaces) {
        BRepBuilderAPI_MakeFace maker(surface, 0.0, 1.0, 0.0, 1.0, 1e-7);
        if (!maker.IsDone()) {
          why = "a sub-patch could not be made into a face";
          return false;
        }
        out.faces.push_back(maker.Face());
      }
      return true;
    }
    why = "the sub-patches (" + std::to_string(poles) + " x " + std::to_string(poles) + " poles) leave the edges by " + std::to_string(out.gap) + " and the supports by " +
          std::to_string(out.angle) + " rad";
  }
  return false;
}

}  // namespace llull::corner_exact
