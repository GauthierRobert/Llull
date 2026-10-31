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
constexpr int kPoleCounts[] = {8, 11, 14, 24, 36};
// The corner of the outline of the hole at a vertex must open between these angles (radians) for a spoke to leave between its edges.
constexpr double kMinWedge = 0.1;
// Two supports meeting at a vertex must have normals within this cosine.
constexpr double kNormalCosine = 1 - 1e-9;
// Two edges of the hole that turn by less than this at a vertex continue each other (a joint of a chain, no spoke); a hole with fewer than 3 corners gets spokes from the middles of its edges.
constexpr double kCornerAngle = 0.02;
constexpr size_t kSmoothSpokes = 6;

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
struct EdgeSide {
  BRepAdaptor_Curve curve;
  double first = 0, last = 0;
  bool reversed = false;
  Handle(Geom2d_Curve) pcurve;
  BRepAdaptor_Surface surface;
  size_t source = 0;     // the index of the edge in the loop given to build()
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

// The length of a loop edge (Simpson over 32 steps of the speed).
double edge_length(const EdgeSide &edge) {
  constexpr int kSteps = 32;
  double sum = 0;
  for (int step = 0; step <= kSteps; ++step) sum += (step == 0 || step == kSteps ? 1.0 : (step % 2 == 1 ? 4.0 : 2.0)) * edge.tangent(static_cast<double>(step) / kSteps).Magnitude();
  return sum / (3.0 * kSteps);
}

// A part [a, b] of loop edge `edge` (in the s of that edge) that covers [s0, s1] of the chain.
struct Piece {
  size_t edge = 0;
  double a = 0, b = 1, s0 = 0, s1 = 1;
  // The map sigma -> s of the piece when its edge is not traversed at a steady speed (a B-spline intersection curve of OCCT): the nodes (sigma, s, ds/dsigma) of a cubic Hermite inverse of the
  // arc length, so that the chain is traversed at a steady speed whatever the parametrization of its edges.
  std::vector<double> node_sigma, node_s, node_slope;
};

// A stretch of the loop between two spoke vertices: one or several loop edges (or parts of them) joined where their supports are tangent. Parametrized by sigma in [0,1]; with several
// pieces the parameter is the length of the chain up to the speed at the ends of each piece (a cubic Hermite map per piece), so the tangent vector is continuous at the joints.
struct Side {
  const std::vector<EdgeSide> *raw = nullptr;
  std::vector<Piece> pieces;
  double length = 0;
  size_t source = 0;  // the edge of the loop given to build() the chain starts on
  size_t part = 0;    // 1 when it starts inside that edge
  bool hermite = false;

  // The chain parameters where one piece ends and the next starts.
  std::vector<double> joints() const {
    std::vector<double> found;
    for (size_t p = 0; p + 1 < pieces.size(); ++p) found.push_back(pieces[p].s1);
    return found;
  }

  // The piece at sigma, the s of its edge there and ds/dsigma.
  void local(double sigma, const Piece *&piece, double &s, double &rate) const {
    size_t at = 0;
    while (at + 1 < pieces.size() && sigma > pieces[at].s1) ++at;
    piece = &pieces[at];
    const double width = piece->s1 - piece->s0;
    const double x = std::min(1.0, std::max(0.0, (sigma - piece->s0) / width));
    if (piece->node_s.empty()) {
      s = piece->a + (piece->b - piece->a) * x;
      rate = (piece->b - piece->a) / width;
      return;
    }
    const std::vector<double> &nodes = piece->node_sigma;
    const size_t upper = static_cast<size_t>(std::min<std::ptrdiff_t>(std::max<std::ptrdiff_t>(std::upper_bound(nodes.begin(), nodes.end(), sigma) - nodes.begin(), 1), static_cast<std::ptrdiff_t>(nodes.size()) - 1));
    const size_t lower = upper - 1;
    const double step = nodes[upper] - nodes[lower];
    const double t = std::min(1.0, std::max(0.0, (sigma - nodes[lower]) / step));
    const Hermite3 h = cubic(t);
    s = h.p0 * piece->node_s[lower] + h.d0 * step * piece->node_slope[lower] + h.p1 * piece->node_s[upper] + h.d1 * step * piece->node_slope[upper];
    const double t2 = t * t;
    const double dp0 = 6 * t2 - 6 * t, dd0 = 3 * t2 - 4 * t + 1, dp1 = -6 * t2 + 6 * t, dd1 = 3 * t2 - 2 * t;
    rate = (dp0 * piece->node_s[lower] + dd0 * step * piece->node_slope[lower] + dp1 * piece->node_s[upper] + dd1 * step * piece->node_slope[upper]) / step;
  }
  gp_Pnt point(double sigma) const {
    const Piece *piece = nullptr;
    double s = 0, rate = 0;
    local(sigma, piece, s, rate);
    return (*raw)[piece->edge].point(s);
  }
  Vec tangent(double sigma) const {
    const Piece *piece = nullptr;
    double s = 0, rate = 0;
    local(sigma, piece, s, rate);
    return (*raw)[piece->edge].tangent(s) * rate;
  }
  bool normal(double sigma, Vec &n) const {
    const Piece *piece = nullptr;
    double s = 0, rate = 0;
    local(sigma, piece, s, rate);
    return (*raw)[piece->edge].normal(s, n);
  }
  // d(normal)/dsigma at an end of the chain (a second-order difference inside the end piece).
  bool normal_rate(double sigma, Vec &rate_out) const {
    constexpr double h = 1e-4;
    Vec a, b, c;
    if (sigma < 0.5) {
      if (!normal(sigma, a) || !normal(sigma + h, b) || !normal(sigma + 2 * h, c)) return false;
      rate_out = (a * -3.0 + b * 4.0 - c) / (2 * h);
    } else {
      if (!normal(sigma, a) || !normal(sigma - h, b) || !normal(sigma - 2 * h, c)) return false;
      rate_out = (a * 3.0 - b * 4.0 + c) / (2 * h);
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
  std::vector<EdgeSide> raw;  // the loop edges, oriented along the loop
  std::vector<Side> sides;    // the chains between the spoke vertices
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

bool solve_vertex(Vertex &vertex, std::string &why) {
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
  mutable bool broken = false;  // a support or spoke had no normal where one was needed

  Vec cross_bottom(double u) const {
    const Vertex &a = star.vertices[k], &b = star.vertices[j];
    Vec n;
    if (!star.sides[k].normal(u, n)) broken = true;
    return project(cubic_vec(u, a.spoke_tangent, suv00, b.spoke_tangent, suv10), n);
  }
  Vec cross_left(double v) const {
    Vec n;
    if (!star.spoke_normal(k, v, n)) broken = true;
    return project(cubic_vec(v, star.vertices[k].leaving, suv00, Vec(0, 0, 0), theta), n);
  }
  Vec cross_right(double v) const {
    Vec n;
    if (!star.spoke_normal(j, v, n)) broken = true;
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
  explicit Basis(std::vector<double> flat) : poles(static_cast<int>(flat.size()) - kDegree - 1), knots(std::move(flat)) {}
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

// The clamped knot vector of about `poles` poles: uniform, with a knot of `multiplicity` (kDegree - 1: C1, kDegree: C0) at each joint of the bottom chain (where the supports change and the
// curvature of the boundary jumps), the uniform knots next to a joint dropped.
std::vector<double> flat_knots(int poles, const std::vector<double> &joints, int multiplicity) {
  const int spans = poles - kDegree;
  std::vector<double> interior;
  for (int k = 1; k < spans; ++k) {
    const double t = static_cast<double>(k) / spans;
    if (std::none_of(joints.begin(), joints.end(), [&](double joint) { return std::fabs(t - joint) < 0.5 / spans; })) interior.push_back(t);
  }
  for (const double joint : joints)
    for (int k = 0; k < multiplicity; ++k) interior.push_back(joint);
  std::sort(interior.begin(), interior.end());
  std::vector<double> flat(static_cast<size_t>(kDegree) + 1, 0.0);
  flat.insert(flat.end(), interior.begin(), interior.end());
  flat.insert(flat.end(), static_cast<size_t>(kDegree) + 1, 1.0);
  return flat;
}

Handle(Geom_BSplineSurface) interpolate(const Patch &patch, int poles, int multiplicity) {
  const Basis basis_u(flat_knots(poles, patch.star.sides[patch.k].joints(), multiplicity)), basis_v(flat_knots(poles, {}, kDegree - 1));
  std::vector<std::vector<double>> inverse_u, inverse_v;
  if (!inverse_of(basis_u, inverse_u) || !inverse_of(basis_v, inverse_v)) return nullptr;
  const size_t nu = static_cast<size_t>(basis_u.poles), nv = static_cast<size_t>(basis_v.poles);
  std::vector<std::vector<gp_Pnt>> samples(nu, std::vector<gp_Pnt>(nv));
  for (size_t i = 0; i < nu; ++i)
    for (size_t j = 0; j < nv; ++j) samples[i][j] = patch.at(basis_u.greville(static_cast<int>(i)), basis_v.greville(static_cast<int>(j)));
  // along u, then along v
  std::vector<std::vector<gp_XYZ>> mid(nu, std::vector<gp_XYZ>(nv, gp_XYZ(0, 0, 0)));
  for (size_t i = 0; i < nu; ++i)
    for (size_t j = 0; j < nv; ++j)
      for (size_t a = 0; a < nu; ++a) mid[i][j] += samples[a][j].XYZ() * inverse_u[i][a];
  TColgp_Array2OfPnt grid(1, static_cast<int>(nu), 1, static_cast<int>(nv));
  for (size_t i = 0; i < nu; ++i)
    for (size_t j = 0; j < nv; ++j) {
      gp_XYZ sum(0, 0, 0);
      for (size_t b = 0; b < nv; ++b) sum += mid[i][b] * inverse_v[j][b];
      grid.SetValue(static_cast<int>(i) + 1, static_cast<int>(j) + 1, gp_Pnt(sum));
    }
  // the collapsed side is one point exactly (the interpolation leaves it 1e-9 apart: its derivative along u would be noise, not zero)
  for (int i = 1; i <= static_cast<int>(nu); ++i) grid.SetValue(i, static_cast<int>(nv), patch.star.centre);
  const auto distinct = [](const Basis &basis) {
    std::vector<double> values;
    std::vector<int> counts;
    for (const double knot : basis.knots) {
      if (!values.empty() && knot == values.back()) ++counts.back();
      else {
        values.push_back(knot);
        counts.push_back(1);
      }
    }
    std::pair<TColStd_Array1OfReal, TColStd_Array1OfInteger> result{TColStd_Array1OfReal(1, static_cast<int>(values.size())), TColStd_Array1OfInteger(1, static_cast<int>(values.size()))};
    for (size_t k = 0; k < values.size(); ++k) {
      result.first.SetValue(static_cast<int>(k) + 1, values[k]);
      result.second.SetValue(static_cast<int>(k) + 1, counts[k]);
    }
    return result;
  };
  const auto along_u = distinct(basis_u), along_v = distinct(basis_v);
  return new Geom_BSplineSurface(grid, along_u.first, along_v.first, along_u.second, along_v.second, kDegree, kDegree);
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

// The crease of a sub-patch along its joint iso-lines: the largest angle between the normals on the two sides of a joint knot (u = joint -+ 1e-5), at v from the bottom to near the centre.
// About zero for a C1 knot; the jump of the u derivative for a C0 knot, which the boundary measures never see (it is in the interior of the face).
double joint_crease(const Handle(Geom_BSplineSurface) &surface, const std::vector<double> &joints) {
  constexpr double kStep = 1e-5;
  constexpr int kCreaseSamples = 20;
  double worst = 0;
  for (const double joint : joints) {
    if (!(joint > 2 * kStep && joint < 1 - 2 * kStep)) continue;
    for (int s = 0; s < kCreaseSamples; ++s) {
      const double v = static_cast<double>(s) / kCreaseSamples;
      Vec before, after;
      if (!normal_of(surface, joint - kStep, v, before) || !normal_of(surface, joint + kStep, v, after)) {
        worst = std::max(worst, kPi / 2);
        continue;
      }
      worst = std::max(worst, before * after < 0 ? kPi : line_angle(before, after));
    }
  }
  return worst;
}

}  // namespace

bool build(const std::vector<TopoDS_Edge> &loop, const std::vector<TopoDS_Face> &supports, double max_gap, double max_angle, Patches &out, std::string &why,
           const CentreHint &hint, bool spokes_at_every_vertex, bool gate_crease, bool c0_knots_only) {
  const size_t raw_count = loop.size();
  if (raw_count < 3 || supports.size() != raw_count) {
    why = "the hole has fewer than 3 edges";
    return false;
  }
  Star star;
  star.raw.resize(raw_count);
  for (size_t k = 0; k < raw_count; ++k) {
    EdgeSide &side = star.raw[k];
    side.source = k;
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
    a = star.raw[k].curve.Value(star.raw[k].first);
    b = star.raw[k].curve.Value(star.raw[k].last);
  };
  gp_Pnt a0, b0, a1, b1;
  ends(0, a0, b0);
  ends(1, a1, b1);
  star.raw[0].reversed = std::min(a0.Distance(a1), a0.Distance(b1)) < std::min(b0.Distance(a1), b0.Distance(b1));
  gp_Pnt cursor = star.raw[0].point(1);
  double scale = 0;
  for (size_t k = 1; k < raw_count; ++k) {
    gp_Pnt a, b;
    ends(k, a, b);
    star.raw[k].reversed = b.Distance(cursor) < a.Distance(cursor);
    cursor = star.raw[k].point(1);
  }
  for (size_t k = 0; k < raw_count; ++k) {
    scale = std::max(scale, star.raw[k].point(0).Distance(star.raw[k].point(1)));
    if (star.raw[k].point(1).Distance(star.raw[(k + 1) % raw_count].point(0)) > 1e-5 * std::max(scale, 1e-9)) {
      why = "the edges of the hole do not chain";
      return false;
    }
  }
  // The loop runs counter-clockwise seen from outside (the patch on the left): reverse it otherwise.
  Vec mean(0, 0, 0), newell(0, 0, 0);
  for (size_t k = 0; k < raw_count; ++k) {
    Vec n;
    if (!star.raw[k].normal(0.0, n)) {
      why = "a support has no normal at a vertex";
      return false;
    }
    mean += n;
    const gp_Pnt p = star.raw[k].point(0), q = star.raw[(k + 1) % raw_count].point(0);
    newell += Vec(p.XYZ()) ^ Vec(q.XYZ());
  }
  if (newell * mean < 0) {
    std::reverse(star.raw.begin(), star.raw.end());
    for (EdgeSide &side : star.raw) side.reversed = !side.reversed;
  }
  // The supports must be tangent at every vertex of the loop. The spokes leave from the CORNERS (where the two edges turn); a vertex where the edges continue each other (the contact
  // of a blend with its support) is only a joint of a chain: at such a vertex the twist condition of the spoke would have two parallel equations with different right-hand sides.
  std::vector<double> cuts;  // positions e + s along the loop where a spoke leaves
  for (size_t k = 0; k < raw_count; ++k) {
    const size_t before = (k + raw_count - 1) % raw_count;
    Vec n_leaving, n_arriving;
    if (!star.raw[k].normal(0, n_leaving) || !star.raw[before].normal(1, n_arriving)) {
      why = "a support has no normal at a vertex";
      return false;
    }
    if (n_leaving * n_arriving < kNormalCosine) {
      why = "the supports of the hole are not tangent at a vertex (normals differ by " + std::to_string(std::acos(std::min(1.0, n_leaving * n_arriving))) + " rad)";
      return false;
    }
    Vec leaving = star.raw[k].tangent(0), arriving = star.raw[before].tangent(1);
    if (!unit(leaving) || !unit(arriving)) {
      why = "an edge of the hole has no tangent at a vertex";
      return false;
    }
    if (spokes_at_every_vertex || leaving * arriving < std::cos(kCornerAngle)) cuts.push_back(static_cast<double>(k));
  }
  // Fewer than 3 corners (a hole bounded by smooth curves): spokes also leave from the middles of the longest edges, where one support is smooth.
  const size_t wanted = std::max<size_t>(3, std::min<size_t>(raw_count, kSmoothSpokes));
  if (cuts.size() < wanted) {
    std::vector<std::pair<double, size_t>> by_length;
    for (size_t k = 0; k < raw_count; ++k) by_length.emplace_back(-edge_length(star.raw[k]), k);
    std::sort(by_length.begin(), by_length.end());
    for (size_t at = 0; at < by_length.size() && cuts.size() < wanted; ++at) cuts.push_back(static_cast<double>(by_length[at].second) + 0.5);
    std::sort(cuts.begin(), cuts.end());
  }
  // The chains.
  const size_t chain_count = cuts.size();
  star.sides.resize(chain_count);
  for (size_t c = 0; c < chain_count; ++c) {
    Side &chain = star.sides[c];
    chain.raw = &star.raw;
    const double from = cuts[c];
    double to = cuts[(c + 1) % chain_count];
    if (to <= from) to += static_cast<double>(raw_count);
    for (size_t e = static_cast<size_t>(std::floor(from)); static_cast<double>(e) < to - 1e-12; ++e) {
      Piece piece;
      piece.edge = e % raw_count;
      piece.a = std::max(from - static_cast<double>(e), 0.0);
      piece.b = std::min(to - static_cast<double>(e), 1.0);
      if (piece.b - piece.a < 1e-9) continue;
      chain.pieces.push_back(piece);
    }
    chain.source = star.raw[chain.pieces.front().edge].source;
    chain.part = chain.pieces.front().a > 1e-9 ? 1 : 0;
    chain.hermite = chain.pieces.size() > 1;
    // the length of each piece (Simpson over 64 steps of the speed) and its share of the chain
    std::vector<double> lengths;
    for (const Piece &piece : chain.pieces) {
      double sum = 0;
      constexpr int kSteps = 64;
      for (int step = 0; step <= kSteps; ++step) {
        const double weight = step == 0 || step == kSteps ? 1.0 : (step % 2 == 1 ? 4.0 : 2.0);
        sum += weight * star.raw[piece.edge].tangent(piece.a + (piece.b - piece.a) * step / kSteps).Magnitude();
      }
      lengths.push_back(sum * (piece.b - piece.a) / (3.0 * kSteps));
      chain.length += lengths.back();
    }
    double covered = 0;
    for (size_t p = 0; p < chain.pieces.size(); ++p) {
      chain.pieces[p].s0 = covered / chain.length;
      covered += lengths[p];
      chain.pieces[p].s1 = p + 1 == chain.pieces.size() ? 1.0 : covered / chain.length;
    }
    // the steady-speed map of the pieces of a chain of several edges
    for (Piece &piece : chain.pieces) {
      constexpr int kNodes = 128;
      std::vector<double> speed(kNodes + 1), cumulative(kNodes + 1, 0.0);
      for (int i = 0; i <= kNodes; ++i) {
        speed[i] = star.raw[piece.edge].tangent(piece.a + (piece.b - piece.a) * i / kNodes).Magnitude();
      }
      if (!chain.hermite) continue;  // one edge: its own parameter (a map would make the pcurve of the sewn edge differ from its curve by more than the sewing tolerance)
      for (int i = 1; i <= kNodes; ++i) cumulative[i] = cumulative[i - 1] + 0.5 * (speed[i - 1] + speed[i]) / kNodes;
      const double width = piece.s1 - piece.s0;
      for (int i = 0; i <= kNodes; ++i) {
        piece.node_sigma.push_back(piece.s0 + width * cumulative[i] / cumulative[kNodes]);
        piece.node_s.push_back(piece.a + (piece.b - piece.a) * i / kNodes);
        piece.node_slope.push_back(cumulative[kNodes] / (width * speed[i]) * (piece.b - piece.a));
      }
      piece.node_sigma.front() = piece.s0;
      piece.node_sigma.back() = piece.s1;
    }
    if (chain.hermite)
      for (int step = 0; step <= 8 * static_cast<int>(chain.pieces.size()); ++step) {
        const Piece *piece = nullptr;
        double local_s = 0, rate = 0;
        chain.local(static_cast<double>(step) / (8.0 * static_cast<double>(chain.pieces.size())), piece, local_s, rate);
        if (!(rate > 0)) {
          why = "a chain of the hole boundary is not monotone in the length parametrization";
          return false;
        }
      }
  }
  const size_t m = chain_count;
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
    vertex.normal = n_leaving + n_arriving;
    unit(vertex.normal);
    vertex.at = star.sides[k].point(0);
    vertex.leaving = star.sides[k].tangent(0);
    vertex.arriving = star.sides[before].tangent(1);
    if (!star.sides[k].normal_rate(0, vertex.rate_leaving) || !star.sides[before].normal_rate(1, vertex.rate_arriving)) {
      why = "a support has no normal rate at a vertex";
      return false;
    }
    if (!solve_vertex(vertex, why)) return false;
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
  double centre_height = 0.375 * height / static_cast<double>(m);
  bool from_hint = false;
  if (hint) {
    double known = 0;
    if (hint(gp_Pnt(centroid), gp_Dir(centre_normal), known)) {
      centre_height = known;
      from_hint = true;
    }
  }
  if (!place(star, centroid, centre_height, scale, why)) return false;
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
  // The attempts, in order (at most 12 interpolate-and-measure passes, 7 when no chain has a joint; 0.17 s on the cylinder block with 1.2 / 1.2 / 1.6 at 36 poles, about 0.45 s when the 48 and 64
  // pole attempts are reached, 13.22.6): C1 knots at the joints of the chains (the pole is steadier); C0 knots, which hold the kink of the cross tangent of a support whose curvature jumps there
  // (0.0056 rad at 36 poles with C1 on the cylinder block) but leave a crease in the interior of the sub-patch along the joint, refused by `joint_crease` when it passes the angle limit (0.37 rad
  // there); then C1 at 48 and 64 poles, where the error of the kink (decaying like h) falls under the limit. The sewn solid is measured again with the pole included and reads the star about 1.7
  // times larger than the star's own measure (0.0056 -> 0.0097 on the cylinder block), so the C1 attempts through 48 poles keep half the limit and the 64-pole one takes it all; a failure of the
  // sewn solid then falls back to the plate.
  struct Attempt {
    int multiplicity, poles;
    double share;
  };
  constexpr int kFinest = kPoleCounts[std::size(kPoleCounts) - 1];
  std::vector<Attempt> attempts;
  const bool has_joints = std::any_of(star.sides.begin(), star.sides.end(), [](const auto &side) { return !side.joints().empty(); });
  for (const int multiplicity : {kDegree - 1, kDegree})
    for (const int poles : kPoleCounts)
      if ((multiplicity == kDegree - 1 && (!c0_knots_only || !has_joints)) || (multiplicity == kDegree && has_joints)) attempts.push_back({multiplicity, poles, poles == kFinest ? (multiplicity == kDegree ? 1.0 : 0.5) : 0.25});
  if ((!c0_knots_only || !has_joints)) {
    attempts.push_back({kDegree - 1, 48, 0.5});
    attempts.push_back({kDegree - 1, 64, 1.0});
  }
  for (const Attempt &attempt : attempts) {
    const int poles = attempt.poles;
    // the coarse interpolations must leave a margin under the angle limit; the finest may use all of it
    const double angle_limit = attempt.share * max_angle;
    out = Patches();
    out.centre = star.centre;
    out.centre_from_hint = from_hint;
    std::vector<Handle(Geom_BSplineSurface)> surfaces;
    for (const Patch &patch : patches) {
      Handle(Geom_BSplineSurface) surface = interpolate(patch, poles, attempt.multiplicity);
      if (patch.broken) {
        why = "a support or a spoke of the hole has no normal along an edge";
        return false;
      }
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
            out.angle = kPi;  // a finer interpolation may still be right: the measure below rejects this one
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
              out.angle = kPi;
            }
          }
          out.gap = std::max(out.gap, surfaces[k]->Value(0, t).Distance(surfaces[previous]->Value(1, t)));
        }
      }
    }
    // The interior crease along the joint iso-lines of each sub-patch, gated at the full angle limit for C1 and C0 knots alike.
    for (size_t k = 0; k < m; ++k) out.crease = std::max(out.crease, joint_crease(surfaces[k], star.sides[k].joints()));
    if (gate_crease && out.crease > max_angle) {
      why = "the sub-patches (" + std::to_string(poles) + " x " + std::to_string(poles) + " poles, " + (attempt.multiplicity == kDegree ? "C0" : "C1") + " joint knots) crease by " +
            std::to_string(out.crease) + " rad along a joint of their bottom chain (limit " + std::to_string(max_angle) + ")";
      continue;
    }
    if (out.gap <= max_gap && out.angle <= angle_limit) {
      for (const Handle(Geom_BSplineSurface) &surface : surfaces) {
        BRepBuilderAPI_MakeFace maker(surface, 0.0, 1.0, 0.0, 1.0, 1e-7);
        if (!maker.IsDone()) {
          why = "a sub-patch could not be made into a face";
          return false;
        }
        out.faces.push_back(maker.Face());
        out.loop_index.push_back(star.sides[out.faces.size() - 1].source);
        out.part.push_back(star.sides[out.faces.size() - 1].part);
      }
      return true;
    }
    why = "the sub-patches (" + std::to_string(poles) + " x " + std::to_string(poles) + " poles) leave the edges by " + std::to_string(out.gap) + " and the supports by " +
          std::to_string(out.angle) + " rad";
  }
  return false;
}

}  // namespace llull::corner_exact
