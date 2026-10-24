// B-spline fits of a deformed surface F(S) and a deformed curve F(C) within a tolerance (01 DEF §5.6 steps 4a, 4c). A fit is the cubic C2
// interpolation (not-a-knot, BSplCLib::Interpolate) of F on a uniform parameter grid, refined per direction until the deviation at the cell middles
// and quarter points is within the tolerance. The fitted geometry keeps the (u, v) / t parameterisation of the source, which is what keeps every
// curve on surface of the face valid. (GeomConvert_ApproxSurface over an Adaptor3d_Surface was tried first: its own error estimate accepted fits
// that were 0.1 mm off on a tapered cylinder, so it is no guarantee; GeomAPI_PointsToBSplineSurface::Interpolate returned garbage above 128 nodes.)
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include <BSplCLib.hxx>
#include <GeomAPI_Interpolate.hxx>
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
  double error = 0;
  // Smallest det J of the map found on the face (central differences on a coarse grid of the box): <= 0 means the map folds the body there.
  double min_determinant = 1;
  bool ok = false;
};

struct CurveFit {
  Handle(Geom_BSplineCurve) curve;
  double error = 0;
  bool ok = false;
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
// The fit is refined to this share of the tolerance: the interpolation error is not zero-mean, and the integrals (volume, area) of the result stay closer to the closed form.
constexpr double kOverFit = 0.125;

// Not-a-knot cubic B-spline basis through n + 1 uniform nodes of [low, high]: the parameters, the flat and the distinct knots (n >= 4).
struct CubicBasis {
  TColStd_Array1OfReal parameters, flat, knots;
  TColStd_Array1OfInteger multiplicities, contact;
  CubicBasis(int n, double low, double high)
      : parameters(1, n + 1), flat(1, n + 5), knots(1, n - 1), multiplicities(1, n - 1), contact(1, n + 1) {
    for (int i = 0; i <= n; ++i) {
      parameters.SetValue(i + 1, low + (high - low) * i / n);
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
inline Handle(Geom_BSplineSurface) interpolate_grid(const std::vector<gp_Pnt> &nodes, int nu, int nv, double u0, double u1, double v0, double v1) {
  const CubicBasis ub(nu, u0, u1), vb(nv, v0, v1);
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

// The surface through F(S) at the nodes of an nu x nv grid of the box, and its worst deviation at the cell middles / quarter points; the
// deviation per direction decides which one to refine.
inline SurfaceFit fit_surface(const Warp &warp, const Handle(Geom_Surface) & base, double u0, double u1, double v0, double v1,
                              double allowed) {
  SurfaceFit best;
  const double tolerance = allowed * kOverFit;
  int nu = kStartSegments, nv = kStartSegments;
  while (true) {
    std::vector<gp_Pnt> nodes;
    nodes.reserve(static_cast<size_t>(nu + 1) * static_cast<size_t>(nv + 1));
    for (int i = 0; i <= nu; ++i)
      for (int j = 0; j <= nv; ++j) nodes.push_back(warped_point(warp, base->Value(u0 + (u1 - u0) * i / nu, v0 + (v1 - v0) * j / nv)));
    best.surface = interpolate_grid(nodes, nu, nv, u0, u1, v0, v1);
    if (best.surface.IsNull()) return best;
    // error at the cell middles: along u (between nodes, on node lines in v), along v, and in the cell centres
    double error_u = 0, error_v = 0, error_c = 0;
    const auto deviation = [&](double fu, double fv) {
      const double u = u0 + (u1 - u0) * fu, v = v0 + (v1 - v0) * fv;
      return best.surface->Value(u, v).Distance(warped_point(warp, base->Value(u, v)));
    };
    for (int i = 0; i < nu; ++i)
      for (int j = 0; j < nv; ++j) {
        for (const double a : {0.25, 0.5, 0.75}) {
          error_u = std::max(error_u, deviation((i + a) / nu, static_cast<double>(j) / nv));
          error_v = std::max(error_v, deviation(static_cast<double>(i) / nu, (j + a) / nv));
        }
        error_c = std::max({error_c, deviation((i + 0.5) / nu, (j + 0.5) / nv), deviation((i + 0.25) / nu, (j + 0.75) / nv)});
      }
    // the last node lines
    for (int j = 0; j < nv; ++j)
      for (const double a : {0.25, 0.5, 0.75}) error_v = std::max(error_v, deviation(1.0, (j + a) / nv));
    for (int i = 0; i < nu; ++i)
      for (const double a : {0.25, 0.5, 0.75}) error_u = std::max(error_u, deviation((i + a) / nu, 1.0));
    best.error = std::max({error_u, error_v, error_c});
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
    const bool more_u = error_u > tolerance;
    const bool more_v = error_v > tolerance;
    if (more_u || !more_v) nu *= 2;
    if (more_v || !more_u) nv *= 2;
    if (nu > kMaxSegmentsPerDirection || nv > kMaxSegmentsPerDirection || static_cast<long>(nu + 1) * (nv + 1) > kMaxFitPoints) {
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
  int n = kStartSegments;
  while (true) {
    Handle(TColgp_HArray1OfPnt) nodes = new TColgp_HArray1OfPnt(1, n + 1);
    Handle(TColStd_HArray1OfReal) parameters = new TColStd_HArray1OfReal(1, n + 1);
    for (int i = 0; i <= n; ++i) {
      const double t = first + (last - first) * i / n;
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
        const double t = first + (last - first) * (i + a) / n;
        error = std::max(error, best.curve->Value(t).Distance(warped_point(warp, base->Value(t))));
      }
    best.error = error;
    if (error <= tolerance) {
      best.ok = true;
      return best;
    }
    n *= 2;
    if (n > 4 * kMaxSegmentsPerDirection) {
      best.ok = best.error <= allowed;
      return best;
    }
  }
}

}  // namespace deform
}  // namespace llull
