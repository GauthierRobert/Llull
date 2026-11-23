// The vertex fans of a G2 corner star (BLD 13.45). The two sub-patches that meet at a vertex V of the loop differ in the third-order jet at V (13.44): a surface that is C3 there
// cannot be curvature-continuous across the spoke next to V. Each sub-patch corner (u, v) in [0, a] x [0, b] around V is cut off along the straight line from (a, 0) to (0, b) of its
// parameter square and replaced by a fan: a B-spline surface in polar coordinates (r, tau) about V, r = 0 collapsed to V, that is the sub-patch itself, P(r a (1 - tau), r b tau), plus a
// displacement along the normal of the spoke, delta(r) psi(tau) N(r), psi = tau^3 (1 - tau)^2 / 2 (psi'' = 1, psi' = psi = 0 at the spoke, tau = 1; third order flat at the bottom edge, tau = 0,
// so the contact with the support keeps its data), delta(r) = lambda^2 (kappa_mean - kappa_side): the normal curvature across the spoke of both fans is the mean of the two at every
// r > 0. In (r, tau) the displacement is O(r^3) times a smooth function: the surface is smooth in the parameters and the singular jet at V is the collapsed edge, not a defect of a
// B-spline approximation.
#include "llull-kernel-occt/cpp/blend_corner_fan.hxx"

#include <algorithm>
#include <cmath>
#include <array>
#include <stdexcept>
#include <string>

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepLib.hxx>
#include <BRep_Builder.hxx>
#include <Geom2d_Line.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Dir2d.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>

namespace llull::corner_exact {

namespace {

using Vec = gp_Vec;

constexpr int kDegree = 7;
constexpr double kSpan = kFanSpan;
// The corner triangle of a sub-patch reaches at most this share of its bottom edge (two of them, one at each end, must not meet).
constexpr double kMaxLeg = 0.4;
constexpr double kG2Relative = 0.02, kG2Floor = 2e-4;
constexpr double kMarks[] = {0.0025, 0.005, 0.01, 0.02, 0.04, 0.08, 0.16, 0.24};
constexpr int kSamples = 100;
constexpr double kAngle = 5e-5;

bool unit(Vec &v) {
  const double length = v.Magnitude();
  if (!(length > 1e-300)) return false;
  v /= length;
  return true;
}

bool second_form(const Vec &su, const Vec &sv, const Vec &suu, const Vec &svv, const Vec &suv, const Vec &w, const Vec &n, double &value) {
  const double e = su * su, f = su * sv, g = sv * sv, det = e * g - f * f;
  if (!(det > 1e-24 * e * g)) return false;
  const double rhs_u = w * su, rhs_v = w * sv;
  const double a = (rhs_u * g - rhs_v * f) / det, b = (e * rhs_v - f * rhs_u) / det;
  value = n * (suu * (a * a) + suv * (2 * a * b) + svv * (b * b));
  return true;
}

struct Basis {
  std::vector<double> knots;  // flat
  int poles;
  // `count` poles of uniform interior knots, with a knot of multiplicity `mult` at each of `extra` (the uniform knots within half a span of it dropped).
  explicit Basis(int count, const std::vector<double> &extra = {}, int mult = 0) {
    const int spans = count - kDegree;
    std::vector<double> interior;
    for (int k = 1; k < spans; ++k) {
      const double t = static_cast<double>(k) / spans;
      if (std::none_of(extra.begin(), extra.end(), [&](double x) { return std::fabs(t - x) < 0.5 / spans; })) interior.push_back(t);
    }
    for (const double x : extra)
      for (int k = 0; k < mult; ++k) interior.push_back(x);
    std::sort(interior.begin(), interior.end());
    knots.assign(kDegree + 1, 0.0);
    knots.insert(knots.end(), interior.begin(), interior.end());
    knots.insert(knots.end(), kDegree + 1, 1.0);
    poles = static_cast<int>(knots.size()) - kDegree - 1;
  }
  std::vector<double> at(double t) const {
    std::vector<double> values(static_cast<size_t>(poles), 0.0);
    int span = kDegree;
    while (span < poles - 1 && t >= knots[static_cast<size_t>(span + 1)]) ++span;
    std::vector<double> n(kDegree + 1, 0.0), left(kDegree + 1), right(kDegree + 1);
    n[0] = 1;
    for (int j = 1; j <= kDegree; ++j) {
      left[static_cast<size_t>(j)] = t - knots[static_cast<size_t>(span + 1 - j)];
      right[static_cast<size_t>(j)] = knots[static_cast<size_t>(span + j)] - t;
      double saved = 0;
      for (int r = 0; r < j; ++r) {
        const double temp = n[static_cast<size_t>(r)] / (right[static_cast<size_t>(r + 1)] + left[static_cast<size_t>(j - r)]);
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
  bool inverse(std::vector<std::vector<double>> &out) const {
    const size_t n = static_cast<size_t>(poles);
    std::vector<std::vector<double>> a(n, std::vector<double>(2 * n, 0.0));
    for (size_t i = 0; i < n; ++i) {
      const std::vector<double> row = at(greville(static_cast<int>(i)));
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
        if (r == c || a[r][c] == 0) continue;
        const double factor = a[r][c];
        for (size_t k = 0; k < 2 * n; ++k) a[r][k] -= factor * a[c][k];
      }
    }
    out.assign(n, std::vector<double>(n, 0.0));
    for (size_t i = 0; i < n; ++i)
      for (size_t j = 0; j < n; ++j) out[i][j] = a[i][n + j];
    return true;
  }
  std::pair<TColStd_Array1OfReal, TColStd_Array1OfInteger> distinct() const {
    std::vector<double> values;
    std::vector<int> counts;
    for (const double knot : knots) {
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
  }
};

// One corner of a sub-patch: the parameter point of the polar coordinates (r, tau): tau = 0 on the bottom edge, 1 on the spoke.
struct Corner {
  Handle(Geom_BSplineSurface) surface;
  Handle(Geom_BSplineSurface) local;  // the same surface with its poles taken about V: positions read from it are offsets from V without the rounding of absolute coordinates
  bool right = false;  // the corner (1, 0) rather than (0, 0)
  double a = 0, b = kSpan;
  gp_Pnt2d uv(double r, double tau) const {
    const double u = a * r * (1 - tau);
    return gp_Pnt2d(right ? 1 - u : u, b * r * tau);
  }
  // The parameter of the fan surface along tau: tau itself at a left corner, its complement at a right one (so the fan has the orientation of the sub-patch).
  double s_of(double tau) const { return right ? 1 - tau : tau; }
  double tau_of(double s) const { return right ? 1 - s : s; }
};

double psi(double tau) { return 0.5 * tau * tau * tau * (1 - tau) * (1 - tau); }

// The data of a corner on the spoke at r: the oriented normal, the curvature across the spoke, the speed lambda of tau across it.
struct SeamData {
  Vec normal;
  double kappa = 0, lambda = 0;
};

bool seam_data(const Corner &corner, double r, const Vec *reference, SeamData &out) {
  const gp_Pnt2d at = corner.uv(r, 1.0);
  gp_Pnt p;
  Vec su, sv, suu, svv, suv;
  corner.surface->D2(at.X(), at.Y(), p, su, sv, suu, svv, suv);
  Vec n = su ^ sv, tangent = sv;
  if (!unit(n) || !unit(tangent)) return false;
  if (reference && n * *reference < 0) n.Reverse();
  Vec w = n ^ tangent;
  if (!unit(w)) return false;
  if (!second_form(su, sv, suu, svv, suv, w, n, out.kappa)) return false;
  const Vec s_tau = su * (corner.right ? corner.a * r : -corner.a * r) + sv * (corner.b * r);
  out.normal = n;
  out.lambda = s_tau * w;
  return true;
}

Handle(Geom_BSplineSurface) interpolate(const std::vector<std::vector<gp_XYZ>> &samples, const Basis &basis_r, const Basis &basis_s, const std::vector<std::vector<double>> &inverse_r,
                                        const std::vector<std::vector<double>> &inverse_s, const gp_Pnt &vertex) {
  const size_t nr = static_cast<size_t>(basis_r.poles), ns = static_cast<size_t>(basis_s.poles);
  std::vector<std::vector<gp_XYZ>> mid(nr, std::vector<gp_XYZ>(ns, gp_XYZ(0, 0, 0)));
  for (size_t i = 0; i < nr; ++i)
    for (size_t j = 0; j < ns; ++j)
      for (size_t a = 0; a < nr; ++a) mid[i][j] += samples[a][j] * inverse_r[i][a];
  TColgp_Array2OfPnt grid(1, static_cast<int>(nr), 1, static_cast<int>(ns));
  for (size_t i = 0; i < nr; ++i)
    for (size_t j = 0; j < ns; ++j) {
      gp_XYZ sum(0, 0, 0);
      for (size_t c = 0; c < ns; ++c) sum += mid[i][c] * inverse_s[j][c];
      grid.SetValue(static_cast<int>(i) + 1, static_cast<int>(j) + 1, gp_Pnt(sum + vertex.XYZ()));
    }
  for (int j = 1; j <= static_cast<int>(ns); ++j) grid.SetValue(1, j, vertex);  // the collapsed edge is one point exactly
  const auto along_r = basis_r.distinct(), along_s = basis_s.distinct();
  return new Geom_BSplineSurface(grid, along_r.first, along_s.first, along_r.second, along_s.second, kDegree, kDegree);
}

// The sub-patch less its two corner triangles, a face of the same surface bounded by pcurves in (u, v); a null face when OCCT could not make it.
TopoDS_Face trimmed_face(const Handle(Geom_BSplineSurface) &surface, double a_left, double a_right, double b) {
  const gp_Pnt2d corners[6] = {gp_Pnt2d(a_left, 0), gp_Pnt2d(1 - a_right, 0), gp_Pnt2d(1, b), gp_Pnt2d(1, 1), gp_Pnt2d(0, 1), gp_Pnt2d(0, b)};
  const double tolerance = 1e-7;
  TopoDS_Vertex vertices[6];
  for (int k = 0; k < 6; ++k) vertices[k] = BRepBuilderAPI_MakeVertex(surface->Value(corners[k].X(), corners[k].Y()));
  vertices[4] = vertices[3];  // the top edge is collapsed to the centre: one vertex
  BRep_Builder builder;
  BRepBuilderAPI_MakeWire wire;
  for (int k = 0; k < 6; ++k) {
    const gp_Pnt2d from = corners[k], to = corners[(k + 1) % 6];
    if (k == 3) {
      TopoDS_Edge collapsed;
      builder.MakeEdge(collapsed);
      builder.Degenerated(collapsed, true);
      builder.UpdateEdge(collapsed, new Geom2d_Line(from, gp_Dir2d(to.X() - from.X(), to.Y() - from.Y())), surface, TopLoc_Location(), tolerance);
      builder.Add(collapsed, vertices[3].Oriented(TopAbs_FORWARD));
      builder.Add(collapsed, vertices[3].Oriented(TopAbs_REVERSED));
      builder.Range(collapsed, surface, TopLoc_Location(), 0.0, from.Distance(to));
      wire.Add(collapsed);
      continue;
    }
    const gp_Dir2d direction(to.X() - from.X(), to.Y() - from.Y());
    BRepBuilderAPI_MakeEdge maker(new Geom2d_Line(from, direction), surface, vertices[k], vertices[(k + 1) % 6], 0.0, from.Distance(to));
    if (!maker.IsDone()) return TopoDS_Face();
    wire.Add(maker.Edge());
  }
  if (!wire.IsDone()) return TopoDS_Face();
  BRepBuilderAPI_MakeFace maker(surface, wire.Wire(), true);
  if (!maker.IsDone()) return TopoDS_Face();
  TopoDS_Face face = maker.Face();
  BRepLib::BuildCurves3d(face, 1e-9);
  return face;
}

bool build_fans(const std::vector<Handle(Geom_BSplineSurface)> &surfaces, double max_gap, double mean_length, int inject, Fans &out, std::string &why) {
  if (inject == 1) throw Standard_Failure("fault injected by the test hook");
  if (inject == 2) throw std::runtime_error("fault injected by the test hook");
  const size_t m = surfaces.size();
  std::vector<double> a_left(m), a_right(m);
  // the extent along the bottom edge: the corner triangle has about the same size along both its legs
  for (size_t k = 0; k < m; ++k) {
    for (const bool right : {false, true}) {
      gp_Pnt p;
      Vec du, dv;
      const double u = right ? 1.0 : 0.0;
      surfaces[k]->D1(u, 0.0, p, du, dv);
      const double length = du.Magnitude();
      const gp_Pnt reach = surfaces[k]->Value(u, kSpan);
      if (!(length > 1e-12)) {
        why = "a sub-patch has no bottom edge tangent at a vertex";
        return false;
      }
      (right ? a_right : a_left)[k] = std::min(reach.Distance(p) / length, kMaxLeg);
    }
    if (!(a_left[k] + a_right[k] < 0.9)) {
      why = "the corner triangles of a sub-patch overlap";
      return false;
    }
  }
  out = Fans();
  for (size_t k = 0; k < m; ++k) {
    out.trimmed.push_back(trimmed_face(surfaces[k], a_left[k], a_right[k], kSpan));
    if (out.trimmed.back().IsNull()) {
      why = "a trimmed sub-patch could not be made into a face";
      return false;
    }
  }
  out.marks.assign(std::size(kMarks), 0.0);
  std::array<double, 6> worst{0, 0, 0, 0, 0, 0};
  bool gates_reached = false;  // a rung built all its fans and was judged against the gates
  std::string face_why;  // a rung whose fan cannot be made into a face (OCCT) is skipped; kept for the message when every rung fails
  int rung = 0;
  // cheapest first (each face costs an integral in every analysis of the shell, 13.46): the cube passes at 22 x 26, the box and the other bodies climb the ladder; 20 x 26 meets the gates too but
  // reads 0.10 relative at the 0.25 % mark of the spoke (0.076 at 22 x 26, 0.056 at 24 x 28), which is why the ladder starts at 22
  int pole_counts[][2] = {{22, 26}, {24, 26}, {22, 28}, {24, 28}, {30, 32}, {36, 40}};
  for (const auto &counts : pole_counts) {
    const bool rung_faults = inject == 3 && rung++ == 0;  // test hook: the first rung's faces cannot be made
    bool face_failed = false;
    // a knot of multiplicity 4 where the correction of 13.38 has finished fading in (its weight is C3 there)
    const Basis basis_r(counts[0], {0.2 / kSpan}, 4), basis_s(counts[1]);
    std::vector<std::vector<double>> inverse_r, inverse_s;
    if (!basis_r.inverse(inverse_r) || !basis_s.inverse(inverse_s)) {
      why = "the interpolation matrix of a fan is singular";
      return false;
    }
    out.fans.clear();
    out.seam_relative = out.seam_jump = out.arc_gap = out.arc_angle = out.arc_g2 = 0;
    out.marks.assign(std::size(kMarks), 0.0);
    double seam_excess = 0, arc_excess = 0, tau_gap = 0, tau_angle = 0;
    for (size_t k = 0; k < m; ++k) {
      const size_t previous = (k + m - 1) % m;
      Corner corners[2];
      const gp_Pnt vertex = surfaces[k]->Value(0.0, 0.0);
      const auto about_vertex = [&](const Handle(Geom_BSplineSurface) &surface) {
        Handle(Geom_BSplineSurface) copy = Handle(Geom_BSplineSurface)::DownCast(surface->Copy());
        copy->Translate(gp_Vec(-vertex.X(), -vertex.Y(), -vertex.Z()));
        return copy;
      };
      corners[0] = Corner{surfaces[k], about_vertex(surfaces[k]), false, a_left[k], kSpan};
      corners[1] = Corner{surfaces[previous], about_vertex(surfaces[previous]), true, a_right[previous], kSpan};
      // the displacement along the spoke at the r of the interpolation points
      std::vector<std::array<double, 2>> delta(static_cast<size_t>(basis_r.poles), {0.0, 0.0});
      std::vector<Vec> normal(static_cast<size_t>(basis_r.poles), Vec(0, 0, 0));
      for (int i = 1; i < basis_r.poles; ++i) {
        const double r = basis_r.greville(i);
        SeamData data[2];
        if (!seam_data(corners[0], r, nullptr, data[0]) || !seam_data(corners[1], r, &data[0].normal, data[1])) {
          why = "a spoke has no normal or no direction across it at a vertex fan";
          return false;
        }
        const double mean = 0.5 * (data[0].kappa + data[1].kappa);
        normal[static_cast<size_t>(i)] = data[0].normal;
        for (int side = 0; side < 2; ++side) delta[static_cast<size_t>(i)][static_cast<size_t>(side)] = data[side].lambda * data[side].lambda * (mean - data[side].kappa);
      }
      Handle(Geom_BSplineSurface) fan[2];
      for (int side = 0; side < 2; ++side) {
        std::vector<std::vector<gp_XYZ>> samples(static_cast<size_t>(basis_r.poles), std::vector<gp_XYZ>(static_cast<size_t>(basis_s.poles), gp_XYZ(0, 0, 0)));
        for (int i = 0; i < basis_r.poles; ++i) {
          const double r = basis_r.greville(i);
          for (int j = 0; j < basis_s.poles; ++j) {
            const double tau = corners[side].tau_of(basis_s.greville(j));
            const gp_Pnt2d at = corners[side].uv(r, tau);
            gp_XYZ sum = i == 0 ? gp_XYZ(0, 0, 0) : corners[side].local->Value(at.X(), at.Y()).XYZ();
            if (i > 0) sum += normal[static_cast<size_t>(i)].XYZ() * (delta[static_cast<size_t>(i)][static_cast<size_t>(side)] * psi(tau));
            samples[static_cast<size_t>(i)][static_cast<size_t>(j)] = sum;
          }
        }
        fan[side] = interpolate(samples, basis_r, basis_s, inverse_r, inverse_s, vertex);
      }
      // the seam: both fans at their spoke (fan 0: s = 1, fan 1: s = 0)
      const auto seam = [&](double r, double &jump, double &scale) {
        gp_Pnt p;
        Vec su, sv, suu, svv, suv;
        fan[0]->D2(r, 1.0, p, su, sv, suu, svv, suv);
        Vec n0 = su ^ sv, tangent = su;
        double kappa[2] = {0, 0};
        if (!unit(n0) || !unit(tangent)) return false;
        Vec w = n0 ^ tangent;
        if (!unit(w) || !second_form(su, sv, suu, svv, suv, w, n0, kappa[0])) return false;
        fan[1]->D2(r, 0.0, p, su, sv, suu, svv, suv);
        Vec n1 = su ^ sv;
        if (!unit(n1)) return false;
        if (n1 * n0 < 0) n1.Reverse();
        if (!second_form(su, sv, suu, svv, suv, w, n1, kappa[1])) return false;
        jump = std::fabs(kappa[0] - kappa[1]);
        scale = std::max(std::fabs(kappa[0]), std::fabs(kappa[1]));
        return true;
      };
      for (int s = 1; s <= kSamples; ++s) {
        double jump = 0, scale = 0;
        if (!seam(static_cast<double>(s) / kSamples, jump, scale)) {
          seam_excess = 1e300;  // a sample that cannot be evaluated refuses
          continue;
        }
        out.seam_jump = std::max(out.seam_jump, jump);
        seam_excess = std::max(seam_excess, jump - (kG2Relative * scale + kG2Floor / mean_length));
        if (scale > kG2Floor / mean_length) out.seam_relative = std::max(out.seam_relative, jump / scale);
      }
      for (size_t q = 0; q < std::size(kMarks); ++q) {
        double jump = 0, scale = 0;
        if (!seam(kMarks[q] / kSpan, jump, scale)) {
          seam_excess = 1e300;
          continue;
        }
        seam_excess = std::max(seam_excess, jump - (kG2Relative * scale + kG2Floor / mean_length));
        if (scale > 1e-300) out.marks[q] = std::max(out.marks[q], jump / scale);
      }
      // the fans against the sub-patch they replace: along the arc (r = 1) and the bottom edge (tau = 0)
      for (int side = 0; side < 2; ++side) {
        for (int pass = 0; pass < 2; ++pass)
          for (int s = 0; s <= kSamples; ++s) {
            const double x = static_cast<double>(s) / kSamples;
            const double r = pass == 0 ? 1.0 : std::max(x, 0.02), param_s = pass == 0 ? x : corners[side].s_of(0.0);
            gp_Pnt p, q;
            Vec su, sv, suu, svv, suv, pu, pv, puu, pvv, puv;
            fan[side]->D2(r, param_s, p, su, sv, suu, svv, suv);
            Vec n = su ^ sv, tangent = pass == 0 ? sv : su;
            if (!unit(n) || !unit(tangent)) {
              arc_excess = 1e300;
              continue;
            }
            const gp_Pnt2d at = corners[side].uv(r, corners[side].tau_of(param_s));
            corners[side].surface->D2(at.X(), at.Y(), q, pu, pv, puu, pvv, puv);
            Vec nq = pu ^ pv;
            if (!unit(nq)) {
              arc_excess = 1e300;
              continue;
            }
            if (nq * n < 0) nq.Reverse();
            Vec w = n ^ tangent;
            double kappa_fan = 0, kappa_patch = 0;
            if (!unit(w) || !second_form(su, sv, suu, svv, suv, w, n, kappa_fan) || !second_form(pu, pv, puu, pvv, puv, w, nq, kappa_patch)) {
              arc_excess = 1e300;
              continue;
            }
            out.arc_gap = std::max(out.arc_gap, p.Distance(q));
            out.arc_angle = std::max(out.arc_angle, std::acos(std::min(1.0, n * nq)));
            out.arc_g2 = std::max(out.arc_g2, std::fabs(kappa_fan - kappa_patch));
            arc_excess = std::max(arc_excess, std::fabs(kappa_fan - kappa_patch) - (kG2Relative * std::max(std::fabs(kappa_fan), std::fabs(kappa_patch)) + kG2Floor / mean_length));
          }
      }
      // the seam of the two fans at a vertex (tau = 1): position and normal
      for (int s = 1; s <= kSamples; ++s) {
        const double r = static_cast<double>(s) / kSamples;
        gp_Pnt p0, p1;
        Vec su, sv, suu, svv, suv;
        fan[0]->D1(r, 1.0, p0, su, sv);
        Vec n0 = su ^ sv;
        fan[1]->D1(r, 0.0, p1, su, sv);
        Vec n1 = su ^ sv;
        if (!unit(n0) || !unit(n1)) {
          tau_gap = 1e300;
          continue;
        }
        if (n1 * n0 < 0) n1.Reverse();
        tau_gap = std::max(tau_gap, p0.Distance(p1));
        tau_angle = std::max(tau_angle, std::acos(std::min(1.0, n0 * n1)));
      }
      for (int side = 0; side < 2 && !face_failed; ++side) {
        const BRepBuilderAPI_MakeFace maker(fan[side], 0.0, 1.0, 0.0, 1.0, 1e-7);
        if (rung_faults || !maker.IsDone()) {
          face_why = "a vertex fan could not be made into a face at " + std::to_string(counts[0]) + " x " + std::to_string(counts[1]) + " poles";
          face_failed = true;
        } else out.fans.push_back(maker.Face());
      }
      if (face_failed) break;
    }
    if (face_failed) continue;
    gates_reached = true;
    if (out.arc_gap <= 0.5 * max_gap && out.arc_angle <= kAngle && arc_excess <= 0 && seam_excess <= 0 && tau_gap <= 0.5 * max_gap && tau_angle <= kAngle) return true;
    worst = {out.arc_gap, out.arc_angle, arc_excess, seam_excess, tau_gap, tau_angle};
  }
  if (!gates_reached && !face_why.empty()) {
    why = face_why;
    return false;
  }
  why = "the vertex fans leave the sub-patches by " + std::to_string(worst[0]) + " (" + std::to_string(worst[1]) + " rad, curvature over the gate by " + std::to_string(worst[2]) + "), their seams are over the curvature gate by " + std::to_string(worst[3]) + " and the two fans at a vertex meet with a gap of " + std::to_string(worst[4]) + " and an angle of " + std::to_string(worst[5]) + " rad (gates: curvature, G0, G1)";
  return false;
}

}  // namespace

bool make_fans(const std::vector<Handle(Geom_BSplineSurface)> &surfaces, double max_gap, double mean_length, int inject, Fans &out, std::string &why) {
  try {
    return build_fans(surfaces, max_gap, mean_length, inject, out, why);
  } catch (const Standard_Failure &failure) {
    why = std::string("an OCCT exception inside the vertex fans: ") + failure.DynamicType()->Name() + " " + (failure.GetMessageString() ? failure.GetMessageString() : "");
    out = Fans();
    return false;
  } catch (const std::exception &failure) {
    why = std::string("an exception inside the vertex fans: ") + failure.what();
    out = Fans();
    return false;
  }
}

}  // namespace llull::corner_exact
