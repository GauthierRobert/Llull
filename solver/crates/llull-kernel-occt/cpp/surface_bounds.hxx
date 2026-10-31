// Tight bounding boxes of many-span B-spline faces by Bezier patch (CHK1, 06 BLD TECHNICAL_SPEC 13.22.6). BRepBndLib::AddOptimal costs about 30 ms per blend face (a B-spline surface of 12 to 41 stations
// and 3 spans across), 1.6 s of the 2.3 s of `mass_properties` on a 64-gon rim; the box that function returns is the exact one, which a branch and bound reaches in a fraction of the time:
// the surface lies in the convex hull of the poles of each Bezier patch (weights are positive), so a patch whose pole box is inside the box of the points found so far (within the tolerance) cannot
// widen it, and only the patches that can are split (de Casteljau, by `Segment`) and their new corner points added. The result is the exact box to `kBoundsRelativeTolerance` x the
// diagonal of the face's box (it can only be smaller than the exact one, by at most that), or `false` when the face is not a plain full-patch B-spline or the search does not finish (the caller uses AddOptimal).
#pragma once

#include <Bnd_Box.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GeomConvert_BSplineSurfaceToBezierSurface.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_BezierSurface.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt.hxx>

#include <algorithm>
#include <cmath>
#include <vector>

#include "llull-kernel-occt/cpp/mass_spans.hxx"

namespace llull {
namespace query {

// A face with fewer patches than this keeps AddOptimal: the saving is for the many-span faces (the blend faces of a long chain, a fine fit).
constexpr int kBoundsMinPatches = 8;
// Tolerance of the box (x the diagonal of the face's box) and the most patches the search visits.
constexpr double kBoundsRelativeTolerance = 1e-9;
constexpr int kBoundsMaxVisits = 4000, kBoundsMaxDepth = 24;

inline void add_samples(Bnd_Box &box, const Handle(Geom_BezierSurface) &patch) {
  constexpr int kGrid = 4;
  for (int i = 0; i <= kGrid; ++i)
    for (int j = 0; j <= kGrid; ++j) box.Add(patch->Value(static_cast<double>(i) / kGrid, static_cast<double>(j) / kGrid));
}

// Adds the box of `face` (a plain full-patch B-spline face with many patches) to `box`; false (box untouched) when the face does not qualify or the search is too long.
inline bool add_spline_bounds(const TopoDS_Face &face, Bnd_Box &box) {
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  const Handle(Geom_BSplineSurface) spline = surface.IsNull() ? Handle(Geom_BSplineSurface)() : Handle(Geom_BSplineSurface)::DownCast(surface);
  if (spline.IsNull() || spline->IsUPeriodic() || spline->IsVPeriodic()) return false;
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  double s0 = 0, s1 = 0, t0 = 0, t1 = 0;
  spline->Bounds(s0, s1, t0, t1);
  const double slack = 1e-9 * std::max({1.0, std::fabs(s1 - s0), std::fabs(t1 - t0)});
  if (std::fabs(u0 - s0) > slack || std::fabs(u1 - s1) > slack || std::fabs(v0 - t0) > slack || std::fabs(v1 - t1) > slack) return false;
  if (!is_full_patch(face, u0, u1, v0, v1)) return false;
  GeomConvert_BSplineSurfaceToBezierSurface converter(spline);
  const int nu = converter.NbUPatches(), nv = converter.NbVPatches();
  if (nu * nv < kBoundsMinPatches) return false;
  struct Node {
    Handle(Geom_BezierSurface) patch;
    int depth;
  };
  Bnd_Box found;
  std::vector<Node> pending;
  for (int i = 1; i <= nu; ++i)
    for (int j = 1; j <= nv; ++j) {
      const Handle(Geom_BezierSurface) patch = converter.Patch(i, j);
      add_samples(found, patch);
      pending.push_back({patch, 0});
    }
  if (found.IsVoid()) return false;
  double x0, y0, z0, x1, y1, z1;
  found.Get(x0, y0, z0, x1, y1, z1);
  const double tolerance = kBoundsRelativeTolerance * std::max(std::sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + (z1 - z0) * (z1 - z0)), 1e-12);
  int visits = 0;
  while (!pending.empty()) {
    const Node node = pending.back();
    pending.pop_back();
    const TColgp_Array2OfPnt &poles = node.patch->Poles();
    double lo[3] = {1e300, 1e300, 1e300}, hi[3] = {-1e300, -1e300, -1e300};
    for (int i = poles.LowerRow(); i <= poles.UpperRow(); ++i)
      for (int j = poles.LowerCol(); j <= poles.UpperCol(); ++j) {
        const gp_Pnt &pole = poles(i, j);
        const double xyz[3] = {pole.X(), pole.Y(), pole.Z()};
        for (int axis = 0; axis < 3; ++axis) {
          lo[axis] = std::min(lo[axis], xyz[axis]);
          hi[axis] = std::max(hi[axis], xyz[axis]);
        }
      }
    found.Get(x0, y0, z0, x1, y1, z1);
    const double inner_lo[3] = {x0, y0, z0}, inner_hi[3] = {x1, y1, z1};
    bool inside = true;
    for (int axis = 0; axis < 3; ++axis) inside = inside && lo[axis] >= inner_lo[axis] - tolerance && hi[axis] <= inner_hi[axis] + tolerance;
    if (inside || node.depth >= kBoundsMaxDepth) continue;
    if (++visits > kBoundsMaxVisits) return false;
    for (int quarter = 0; quarter < 4; ++quarter) {
      const double ua = quarter % 2 == 0 ? 0.0 : 0.5, va = quarter < 2 ? 0.0 : 0.5;
      const Handle(Geom_BezierSurface) child = Handle(Geom_BezierSurface)::DownCast(node.patch->Copy());
      child->Segment(ua, ua + 0.5, va, va + 0.5);
      add_samples(found, child);
      pending.push_back({child, node.depth + 1});
    }
  }
  found.Get(x0, y0, z0, x1, y1, z1);
  box.Add(gp_Pnt(x0, y0, z0));
  box.Add(gp_Pnt(x1, y1, z1));
  return true;
}

}  // namespace query
}  // namespace llull
