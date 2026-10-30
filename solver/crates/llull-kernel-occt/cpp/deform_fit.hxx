// B-spline fits of a deformed surface F(S) and a deformed curve F(C) within a tolerance (01 DEF §5.6 steps 4a, 4c). A fit is the cubic C2
// interpolation (not-a-knot, BSplCLib::Interpolate) of F on a tensor grid of parameter nodes, refined per direction INTERVAL by interval (an interval whose
// deviation at its middle and quarter points exceeds the tolerance is halved, the others keep their nodes: a localised map is resolved where it acts and a
// law that deviates everywhere refines everywhere, as the uniform doubling did) until every cell middle and quarter point deviates by less than the tolerance. The fitted geometry keeps the (u, v) / t parameterisation of the source, which is what keeps every
// curve on surface of the face valid. (GeomConvert_ApproxSurface over an Adaptor3d_Surface was tried first: its own error estimate accepted fits
// that were 0.1 mm off on a tapered cylinder, so it is no guarantee; GeomAPI_PointsToBSplineSurface::Interpolate returned garbage above 128 nodes.)
#pragma once

#include <algorithm>
#include <cmath>
#include <sstream>
#include <string>
#include <vector>

#include <BSplCLib.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_Curve.hxx>
#include <Geom_Surface.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_HArray1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/deform_laws.hxx"

namespace llull {
namespace deform {

struct SurfaceFit {
  Handle(Geom_BSplineSurface) surface;
  long points = 0;  // nodes of the grid the surface interpolates
  double error = 0;
  // Smallest det J of the map found on the face (central differences on a coarse grid of the box): <= 0 means the map folds the body there.
  double min_determinant = 1;
  bool ok = false;
  // A point push whose support the grid cannot resolve (see resolve_support): the fit stops and says why, the warp is refused by name.
  bool unresolved = false;
  std::string note;
};

struct CurveFit {
  Handle(Geom_BSplineCurve) curve;
  double error = 0;
  bool ok = false;
  bool unresolved = false;
  std::string note;
};

// The deformed point of a source point.
inline gp_Pnt warped_point(const Warp &warp, const gp_Pnt &p) {
  const double in[3] = {p.X(), p.Y(), p.Z()};
  double out[3];
  warp.point(in, out);
  return gp_Pnt(out[0], out[1], out[2]);
}

// det J of the map at `p` from the first derivative of the law along each source axis (forward-mode jets: exact, one-sided at a kink).
inline double determinant_at(const Warp &warp, const gp_Pnt &p) {
  gp_Vec columns[3];
  for (int axis = 0; axis < 3; ++axis) {
    Vec3J seeded = {Jet(p.X()), Jet(p.Y()), Jet(p.Z())};
    seeded[static_cast<size_t>(axis)].a = 1;
    const Vec3J out = warp.apply(seeded);
    columns[axis] = gp_Vec(out[0].a, out[1].a, out[2].a);
  }
  return columns[0].Dot(columns[1].Crossed(columns[2]));
}

// Fewest and most segments per direction; the fit gives up (refused by the caller) beyond the point budget.
constexpr int kStartSegments = 4;
constexpr int kMaxSegmentsPerDirection = 512;
constexpr long kMaxFitPoints = 400000;
// The finest grid a direction may use is 1 / kMaxDenominator of its range (the node indices are integers of that denominator; a push narrower than that is below what a double resolves on the face).
// The 512 above counts the NODES of a direction, not the finest level: a local feature is resolved by a few dozen nodes however fine its level.
constexpr long kMaxDenominator = 1L << 28;  // long is 32 bits on Windows: den * 2 must stay below 2^31
// The fit is refined to this share of the tolerance: the interpolation error is not zero-mean, and the integrals (volume, area) of the result stay closer to the closed form.
constexpr double kOverFit = 0.125;

// The nodes of one direction of a fit: the parameters index / den of [low, high] (den doubles when an interval is halved, so a fully refined direction is the uniform
// grid with the same parameters, bit for bit, as the uniform doubling produced).
struct Axis {
  std::vector<long> index{0, 1, 2, 3, 4};
  long den = kStartSegments;
  int intervals() const { return static_cast<int>(index.size()) - 1; }
  double at(double low, double high, long k) const { return low + (high - low) * static_cast<double>(k) / static_cast<double>(den); }
  // fraction of [low, high] of the point a (0..1) inside interval i
  double inside(int i, double a) const {
    const long first = index[static_cast<size_t>(i)], last = index[static_cast<size_t>(i) + 1];
    return (static_cast<double>(first) + a * static_cast<double>(last - first)) / static_cast<double>(den);
  }
  double node(int i) const { return static_cast<double>(index[static_cast<size_t>(i)]) / static_cast<double>(den); }
  // Halve the intervals flagged in `split` (all indices double first, so the midpoints stay integers).
  void refine(const std::vector<char> &split) {
    den *= 2;
    std::vector<long> next;
    for (size_t i = 0; i < index.size(); ++i) {
      next.push_back(2 * index[i]);
      if (i < split.size() && split[i] != 0) next.push_back(index[i] + index[i + 1]);
    }
    index = next;
    grade();
  }
  // 2:1 grading: an interval more than twice as long as a neighbour is halved (until none is), so that a second local feature between the samples of a coarse interval
  // is met by a gradual change of the node spacing and found by the next check instead of falling between two far nodes.
  void grade() {
    for (bool changed = true; changed;) {
      changed = false;
      std::vector<long> next;
      for (size_t i = 0; i + 1 < index.size(); ++i) {
        next.push_back(index[i]);
        const long size = index[i + 1] - index[i];
        const long before = i == 0 ? size : index[i] - index[i - 1];
        const long after = i + 2 < index.size() ? index[i + 2] - index[i + 1] : size;
        if (size % 2 == 0 && (size > 2 * before || size > 2 * after)) {
          next.push_back(index[i] + size / 2);
          changed = true;
        }
      }
      next.push_back(index.back());
      index = next;
    }
  }
};

// Not-a-knot cubic B-spline basis through the nodes of `axis` over [low, high]: the parameters, the flat and the distinct knots (n >= 4 intervals).
struct CubicBasis {
  TColStd_Array1OfReal parameters, flat, knots;
  TColStd_Array1OfInteger multiplicities, contact;
  CubicBasis(const Axis &axis, double low, double high)
      : parameters(1, axis.intervals() + 1),
        flat(1, axis.intervals() + 5),
        knots(1, axis.intervals() - 1),
        multiplicities(1, axis.intervals() - 1),
        contact(1, axis.intervals() + 1) {
    const int n = axis.intervals();
    for (int i = 0; i <= n; ++i) {
      parameters.SetValue(i + 1, axis.at(low, high, axis.index[static_cast<size_t>(i)]));
      contact.SetValue(i + 1, 0);
    }
    // distinct knots: both ends and the nodes 2 .. n - 2
    int k = 1;
    knots.SetValue(k, low);
    multiplicities.SetValue(k++, 4);
    for (int i = 2; i <= n - 2; ++i) {
      knots.SetValue(k, parameters.Value(i + 1));
      multiplicities.SetValue(k++, 1);
    }
    knots.SetValue(k, high);
    multiplicities.SetValue(k, 4);
    int f = 1;
    for (int i = 1; i <= knots.Length(); ++i)
      for (int m = 0; m < multiplicities.Value(i); ++m) flat.SetValue(f++, knots.Value(i));
  }
};

// The cubic tensor-product surface through the (nu + 1) x (nv + 1) points `nodes` (row-major, u first): interpolation along v for each row, then
// along u for every pole column (BSplCLib::Interpolate; the nodes are uniform on the box). Null on a solver failure.
inline Handle(Geom_BSplineSurface) interpolate_grid(const std::vector<gp_Pnt> &nodes, const Axis &uaxis, const Axis &vaxis, double u0, double u1, double v0, double v1) {
  const CubicBasis ub(uaxis, u0, u1), vb(vaxis, v0, v1);
  const int nu = uaxis.intervals(), nv = vaxis.intervals();
  const size_t rows = static_cast<size_t>(nu) + 1, cols = static_cast<size_t>(nv) + 1, width = cols * 3;
  std::vector<double> poles(rows * width);
  for (size_t i = 0; i < rows; ++i) {
    double *row = &poles[i * width];
    for (size_t j = 0; j < cols; ++j) {
      const gp_Pnt &p = nodes[i * cols + j];
      row[3 * j] = p.X();
      row[3 * j + 1] = p.Y();
      row[3 * j + 2] = p.Z();
    }
    Standard_Integer problem = 0;
    BSplCLib::Interpolate(3, vb.flat, vb.parameters, vb.contact, 3, *row, problem);
    if (problem != 0) return Handle(Geom_BSplineSurface)();
  }
  Standard_Integer problem = 0;
  BSplCLib::Interpolate(3, ub.flat, ub.parameters, ub.contact, static_cast<Standard_Integer>(width), poles[0], problem);
  if (problem != 0) return Handle(Geom_BSplineSurface)();
  TColgp_Array2OfPnt net(1, nu + 1, 1, nv + 1);
  for (int i = 0; i <= nu; ++i)
    for (int j = 0; j <= nv; ++j) {
      const double *p = &poles[static_cast<size_t>(i) * width + 3 * static_cast<size_t>(j)];
      net.SetValue(i + 1, j + 1, gp_Pnt(p[0], p[1], p[2]));
    }
  return new Geom_BSplineSurface(net, ub.knots, vb.knots, ub.multiplicities, vb.multiplicities, 3, 3);
}

// The centre of a point push in world coordinates, and its support radius (0 for any other law).
inline gp_Pnt push_centre(const Warp &warp) {
  const Law &law = warp.law;
  const Frame &f = warp.frame;
  return gp_Pnt(f.origin[0] + law.center[0] * f.x[0] + law.center[1] * f.y[0] + law.center[2] * f.z[0],
                f.origin[1] + law.center[0] * f.x[1] + law.center[1] * f.y[1] + law.center[2] * f.z[1],
                f.origin[2] + law.center[0] * f.x[2] + law.center[1] * f.y[2] + law.center[2] * f.z[2]);
}

// The words of a refusal: a push whose support is narrower than the finest grid the fit may use cannot be seen by it.
inline std::string unresolvable(double support, double length, double finest) {
  const auto shown = [](double value) {
    std::ostringstream text;
    text.precision(6);
    text << value;
    return text.str();
  };
  return "the push radius " + shown(support) + " is below what the fit can resolve on a face or edge of length " + shown(length) +
         " (it needs intervals of 1/" + std::to_string(static_cast<long long>(std::ceil(finest))) + " of its length across the support, the finest grid is 1/" +
         std::to_string(kMaxDenominator) + ", with at most " + std::to_string(kMaxSegmentsPerDirection) + " nodes per direction): the bump would be lost, so the deformation is refused; use a larger radius or split the body";
}

// Refine `axis` (nodes at fractions of the parameter range) until every interval overlapping [low, high] is at most (high - low) / 6 long. False when that would
// a grid finer than 1 / kMaxDenominator or more than kMaxSegmentsPerDirection nodes (a local refinement needs a few dozen).
inline bool refine_across(Axis &axis, double low, double high) {
  const double target = (high - low) / 6.0;
  while (true) {
    std::vector<char> split(static_cast<size_t>(axis.intervals()), 0);
    bool any = false;
    for (int i = 0; i < axis.intervals(); ++i)
      if (axis.node(i + 1) >= low && axis.node(i) <= high && axis.node(i + 1) - axis.node(i) > target * (1 + 1e-9)) {
        split[static_cast<size_t>(i)] = 1;
        any = true;
      }
    if (!any) return true;
    if (axis.den > kMaxDenominator / 2 || axis.intervals() >= kMaxSegmentsPerDirection) return false;
    axis.refine(split);
  }
}

// A point push is a feature of a known size (its support radius): a grid whose cells are wider than the support can hold it between its samples and never see it
// (the error checks below only look at node lines, cell middles and quarter points). The centre of the push is projected on the base surface (the nearest point of
// the parameter box); when the support reaches the face, the parameter box of the support is that point grown by support / |S_u|, support / |S_v|, and both axes are
// refined until six intervals span it. False, with the reason in `note`, when the axes cannot get there: the bump would be lost, and a lost bump is refused, not returned.
inline bool resolve_support(const Warp &warp, const Handle(Geom_Surface) & base, double u0, double u1, double v0, double v1, Axis &uaxis, Axis &vaxis,
                            std::string &note) {
  const Law &law = warp.law;
  if (law.kind != LawKind::Point || !(law.support > 0)) return true;
  const GeomAPI_ProjectPointOnSurf projection(push_centre(warp), base, u0, u1, v0, v1);
  if (projection.NbPoints() < 1 || projection.LowerDistance() > 1.1 * law.support) return true;
  double uc = 0, vc = 0;
  projection.LowerDistanceParameters(uc, vc);
  gp_Pnt at;
  gp_Vec du, dv;
  base->D1(uc, vc, at, du, dv);
  const double reach = 1.1 * law.support;
  const double half_u = reach / std::max(du.Magnitude(), 1e-300) / (u1 - u0), half_v = reach / std::max(dv.Magnitude(), 1e-300) / (v1 - v0);
  const double fu = (uc - u0) / (u1 - u0), fv = (vc - v0) / (v1 - v0);
  const double length_u = du.Magnitude() * (u1 - u0), length_v = dv.Magnitude() * (v1 - v0);
  if (!refine_across(uaxis, std::max(0.0, fu - half_u), std::min(1.0, fu + half_u))) {
    note = unresolvable(law.support, length_u, 6.0 / (2 * half_u));
    return false;
  }
  if (!refine_across(vaxis, std::max(0.0, fv - half_v), std::min(1.0, fv + half_v))) {
    note = unresolvable(law.support, length_v, 6.0 / (2 * half_v));
    return false;
  }
  return true;
}

// The surface through F(S) at the nodes of the tensor grid of the box, and its worst deviation at the middles / quarter points of the cells; the deviation of
// each interval decides which intervals to halve.
inline SurfaceFit fit_surface(const Warp &warp, const Handle(Geom_Surface) & base, double u0, double u1, double v0, double v1,
                              double allowed) {
  SurfaceFit best;
  const double tolerance = allowed * kOverFit;
  Axis uaxis, vaxis;
  if (!resolve_support(warp, base, u0, u1, v0, v1, uaxis, vaxis, best.note)) {
    best.unresolved = true;
    return best;
  }
  while (true) {
    const int nu = uaxis.intervals(), nv = vaxis.intervals();
    std::vector<gp_Pnt> nodes;
    nodes.reserve(static_cast<size_t>(nu + 1) * static_cast<size_t>(nv + 1));
    for (int i = 0; i <= nu; ++i)
      for (int j = 0; j <= nv; ++j) nodes.push_back(warped_point(warp, base->Value(u0 + (u1 - u0) * uaxis.index[static_cast<size_t>(i)] / uaxis.den, v0 + (v1 - v0) * vaxis.index[static_cast<size_t>(j)] / vaxis.den)));
    best.surface = interpolate_grid(nodes, uaxis, vaxis, u0, u1, v0, v1);
    best.points = static_cast<long>(nodes.size());
    if (best.surface.IsNull()) return best;
    // error of every u interval (between nodes, on node lines in v), v interval, and cell (middle and a quarter point)
    std::vector<double> error_u(static_cast<size_t>(nu), 0.0), error_v(static_cast<size_t>(nv), 0.0), error_c(static_cast<size_t>(nu) * static_cast<size_t>(nv), 0.0);
    const auto deviation = [&](double fu, double fv) {
      const double u = u0 + (u1 - u0) * fu, v = v0 + (v1 - v0) * fv;
      return best.surface->Value(u, v).Distance(warped_point(warp, base->Value(u, v)));
    };
    for (int i = 0; i < nu; ++i)
      for (int j = 0; j < nv; ++j) {
        for (const double a : {0.25, 0.5, 0.75}) {
          error_u[static_cast<size_t>(i)] = std::max(error_u[static_cast<size_t>(i)], deviation(uaxis.inside(i, a), vaxis.node(j)));
          error_v[static_cast<size_t>(j)] = std::max(error_v[static_cast<size_t>(j)], deviation(uaxis.node(i), vaxis.inside(j, a)));
        }
        error_c[static_cast<size_t>(i) * static_cast<size_t>(nv) + static_cast<size_t>(j)] =
            std::max(deviation(uaxis.inside(i, 0.5), vaxis.inside(j, 0.5)), deviation(uaxis.inside(i, 0.25), vaxis.inside(j, 0.75)));
      }
    // the last node lines
    for (int j = 0; j < nv; ++j)
      for (const double a : {0.25, 0.5, 0.75}) error_v[static_cast<size_t>(j)] = std::max(error_v[static_cast<size_t>(j)], deviation(1.0, vaxis.inside(j, a)));
    for (int i = 0; i < nu; ++i)
      for (const double a : {0.25, 0.5, 0.75}) error_u[static_cast<size_t>(i)] = std::max(error_u[static_cast<size_t>(i)], deviation(uaxis.inside(i, a), 1.0));
    const double worst_u = *std::max_element(error_u.begin(), error_u.end());
    const double worst_v = *std::max_element(error_v.begin(), error_v.end());
    const double worst_c = *std::max_element(error_c.begin(), error_c.end());
    best.error = std::max({worst_u, worst_v, worst_c});
    const auto finish = [&]() {
      // within the allowed error (the loop aims lower; at the budget limit the allowed error is what counts)
      best.ok = best.error <= allowed;
      if (!best.ok) return;
      const int steps = 16;
      for (int i = 0; i <= steps; ++i)
        for (int j = 0; j <= steps; ++j) {
          const gp_Pnt at = base->Value(u0 + (u1 - u0) * i / steps, v0 + (v1 - v0) * j / steps);
          best.min_determinant = std::min(best.min_determinant, determinant_at(warp, at));
        }
    };
    if (best.error <= tolerance) {
      finish();
      return best;
    }
    // halve the intervals that deviate: in u where the u error is high, in v where the v error is high
    std::vector<char> split_u(static_cast<size_t>(nu), 0), split_v(static_cast<size_t>(nv), 0);
    const bool more_u = worst_u > tolerance, more_v = worst_v > tolerance;
    for (int i = 0; i < nu; ++i) split_u[static_cast<size_t>(i)] = more_u && error_u[static_cast<size_t>(i)] > tolerance;
    for (int j = 0; j < nv; ++j) split_v[static_cast<size_t>(j)] = more_v && error_v[static_cast<size_t>(j)] > tolerance;
    // only the cell middles deviate (the law bulges inside a cell between nodes that all agree): both intervals of each such cell; when an axis error explains the deviation the cells add nothing (a global law would refine the other direction too)
    if (!more_u && !more_v)
      for (int i = 0; i < nu; ++i)
        for (int j = 0; j < nv; ++j)
          if (error_c[static_cast<size_t>(i) * static_cast<size_t>(nv) + static_cast<size_t>(j)] > tolerance) split_u[static_cast<size_t>(i)] = split_v[static_cast<size_t>(j)] = 1;
    // a law that deviates over much of the face (a quarter of the intervals or more) is refined everywhere, as the uniform doubling did: the integrals of the result
    // (volume, area) then stay as close to the closed form as before; a localised one (a push, a lattice cell) only where it acts
    const auto widen = [](std::vector<char> &split) {
      const long flagged = std::count_if(split.begin(), split.end(), [](char f) { return f != 0; });
      if (4 * flagged >= static_cast<long>(split.size())) std::fill(split.begin(), split.end(), static_cast<char>(1));
      return flagged > 0;
    };
    bool any_u = widen(split_u);
    bool any_v = widen(split_v);
    // structural progress: an error above the tolerance that no flag explained refines both directions everywhere (the loop can never stand still)
    if (!any_u && !any_v) {
      std::fill(split_u.begin(), split_u.end(), static_cast<char>(1));
      std::fill(split_v.begin(), split_v.end(), static_cast<char>(1));
      any_u = any_v = true;
    }
    if (any_u) uaxis.refine(split_u);
    if (any_v) vaxis.refine(split_v);
    if (uaxis.intervals() > kMaxSegmentsPerDirection || vaxis.intervals() > kMaxSegmentsPerDirection || uaxis.den >= kMaxDenominator || vaxis.den >= kMaxDenominator ||
        static_cast<long>(uaxis.intervals() + 1) * (vaxis.intervals() + 1) > kMaxFitPoints) {
      finish();
      return best;
    }
  }
}

// The curve through F(C) at n + 1 uniform nodes of [first, last] with the exact end tangents, refined until the deviation at the quarter points
// of every span is within the tolerance.
inline CurveFit fit_curve(const Warp &warp, const Handle(Geom_Curve) & base, double first, double last, double allowed) {
  CurveFit best;
  const double tolerance = allowed * kOverFit;
  // Derivative of F(C) at t. A law with a kink at a region end has two one-sided derivatives there, so the end tangents are taken from inside
  // the edge (two points at 1e-6 of its length, extrapolated to the end: error O(1e-12)).
  const auto tangent_at = [&](double t) {
    gp_Pnt p;
    gp_Vec d1;
    base->D1(t, p, d1);
    Vec3J seeded = {Jet(p.X()), Jet(p.Y()), Jet(p.Z())};
    seeded[0].a = d1.X();
    seeded[1].a = d1.Y();
    seeded[2].a = d1.Z();
    const Vec3J out = warp.apply(seeded);
    return gp_Vec(out[0].a, out[1].a, out[2].a);
  };
  const auto end_tangent = [&](double t, double inward) {
    const double step = inward * 1e-6 * (last - first);
    return tangent_at(t + step) * 2.0 - tangent_at(t + 2 * step);
  };
  // Node parameters as fractions of [first, last]: uniform, with a point push's support resolved the same way as on a face (the centre projected on the curve, grown by
  // support / |C'|, six intervals across it); an error above the tolerance then halves every interval.
  std::vector<double> fractions;
  for (int i = 0; i <= kStartSegments; ++i) fractions.push_back(static_cast<double>(i) / kStartSegments);
  const Law &law = warp.law;
  if (law.kind == LawKind::Point && law.support > 0) {
    const GeomAPI_ProjectPointOnCurve projection(push_centre(warp), base, first, last);
    if (projection.NbPoints() >= 1 && projection.LowerDistance() <= 1.1 * law.support) {
      gp_Pnt at;
      gp_Vec d1;
      const double tc = projection.LowerDistanceParameter();
      base->D1(tc, at, d1);
      const double half = 1.1 * law.support / std::max(d1.Magnitude(), 1e-300) / (last - first);
      const double centre = (tc - first) / (last - first);
      const double low = std::max(0.0, centre - half), high = std::min(1.0, centre + half), target = (high - low) / 6.0;
      while (true) {
        if (target < 1e-12) {
          best.unresolved = true;
          best.note = unresolvable(law.support, d1.Magnitude() * (last - first), 6.0 / (2 * half));
          return best;
        }
        std::vector<double> next;
        bool any = false;
        for (size_t i = 0; i + 1 < fractions.size(); ++i) {
          next.push_back(fractions[i]);
          if (fractions[i + 1] >= low && fractions[i] <= high && fractions[i + 1] - fractions[i] > target * (1 + 1e-9)) {
            next.push_back(0.5 * (fractions[i] + fractions[i + 1]));
            any = true;
          }
        }
        next.push_back(fractions.back());
        if (!any) break;
        fractions = next;
        if (fractions.size() > static_cast<size_t>(4 * kMaxSegmentsPerDirection)) {
          best.unresolved = true;
          best.note = unresolvable(law.support, d1.Magnitude() * (last - first), 6.0 / (2 * half));
          return best;
        }
      }
    }
  }
  while (true) {
    const int n = static_cast<int>(fractions.size()) - 1;
    Handle(TColgp_HArray1OfPnt) nodes = new TColgp_HArray1OfPnt(1, n + 1);
    Handle(TColStd_HArray1OfReal) parameters = new TColStd_HArray1OfReal(1, n + 1);
    for (int i = 0; i <= n; ++i) {
      const double t = first + (last - first) * fractions[static_cast<size_t>(i)];
      nodes->SetValue(i + 1, warped_point(warp, base->Value(t)));
      parameters->SetValue(i + 1, t);
    }
    GeomAPI_Interpolate interpolation(nodes, parameters, Standard_False, 1e-12);
    interpolation.Load(end_tangent(first, 1.0), end_tangent(last, -1.0), Standard_False);
    interpolation.Perform();
    if (!interpolation.IsDone()) return best;
    best.curve = interpolation.Curve();
    double error = 0;
    for (int i = 0; i < n; ++i)
      for (const double a : {0.25, 0.5, 0.75}) {
        const double t = first + (last - first) * (fractions[static_cast<size_t>(i)] + a * (fractions[static_cast<size_t>(i) + 1] - fractions[static_cast<size_t>(i)]));
        error = std::max(error, best.curve->Value(t).Distance(warped_point(warp, base->Value(t))));
      }
    best.error = error;
    if (error <= tolerance) {
      best.ok = true;
      return best;
    }
    std::vector<double> next;
    for (size_t i = 0; i + 1 < fractions.size(); ++i) {
      next.push_back(fractions[i]);
      next.push_back(0.5 * (fractions[i] + fractions[i + 1]));
    }
    next.push_back(fractions.back());
    fractions = next;
    if (static_cast<int>(fractions.size()) - 1 > 4 * kMaxSegmentsPerDirection) {
      best.ok = best.error <= allowed;
      return best;
    }
  }
}

}  // namespace deform
}  // namespace llull
