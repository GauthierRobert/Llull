// Tight bounding boxes of many-span B-spline faces by Bezier patch (CHK1, 06 BLD TECHNICAL_SPEC 13.22.6). BRepBndLib::AddOptimal costs about 30 ms per blend face (a B-spline surface of 12 to 41 stations
// and 3 spans across), 1.6 s of the 2.3 s of `mass_properties` on a 64-gon rim; the box that function returns is the exact one, which a branch and bound reaches in a fraction of the time:
// the surface lies in the convex hull of the poles of each Bezier patch (weights are positive), so a patch whose pole box is inside the box of the points found so far (within the tolerance) cannot
// widen it, and only the patches that can are split (de Casteljau, by `Segment`) and their new corner points added. The found box may fall short of the exact extreme by at most the tolerance
// `kBoundsRelativeTolerance` x the diagonal of the face's box (a patch is skipped when its pole box leaves the found box by no more), so the returned box is padded by that tolerance on every side and
// ENCLOSES the exact one; it overshoots it by at most twice the tolerance. The guarantee is relative (1e-9 of the diagonal), outward. A trimmed face (at least kMinFill of its rectangle) is accepted only when every side of the found box was reached at a point of the face (13.46). `false` when the face is not a B-spline that is a full patch or such a face, the search does
// not finish, or a patch reaches kBoundsMaxDepth without being inside the found box (the caller uses AddOptimal).
#pragma once

#include <BRepClass_FaceClassifier.hxx>
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

// Where in the surface (u, v) each side of the found box was reached: the proof that a trimmed face has the box of its rectangle.
struct Witness {
  double value[2][3] = {{1e300, 1e300, 1e300}, {-1e300, -1e300, -1e300}};
  gp_Pnt2d at[2][3];
};

// The patch covers [ua, ub] x [va, vb] of the surface.
inline void add_samples(Bnd_Box &box, const Handle(Geom_BezierSurface) &patch, double ua, double ub, double va, double vb, Witness &witness) {
  constexpr int kGrid = 4;
  for (int i = 0; i <= kGrid; ++i)
    for (int j = 0; j <= kGrid; ++j) {
      const double s = static_cast<double>(i) / kGrid, t = static_cast<double>(j) / kGrid;
      const gp_Pnt point = patch->Value(s, t);
      box.Add(point);
      const double xyz[3] = {point.X(), point.Y(), point.Z()};
      for (int axis = 0; axis < 3; ++axis) {
        if (xyz[axis] < witness.value[0][axis]) {
          witness.value[0][axis] = xyz[axis];
          witness.at[0][axis] = gp_Pnt2d(ua + (ub - ua) * s, va + (vb - va) * t);
        }
        if (xyz[axis] > witness.value[1][axis]) {
          witness.value[1][axis] = xyz[axis];
          witness.at[1][axis] = gp_Pnt2d(ua + (ub - ua) * s, va + (vb - va) * t);
        }
      }
    }
}

// A face with one wire that fills at least this share of the rectangle [u0, u1] x [v0, v1] of its surface (a sewn sub-patch, or one with its corners cut off by a straight line) is a candidate for the
// box of the whole rectangle, accepted only when `rectangle_box_is_exact` proves it equal to the face's own (BLD 13.46).
constexpr double kMinFill = 0.85;

// The share of the rectangle the face fills (0 when it has not one wire).
inline double fill_of_rectangle(const TopoDS_Face &face, double u0, double u1, double v0, double v1) {
  int wires = 0;
  for (TopoDS_Iterator it(face); it.More(); it.Next())
    if (it.Value().ShapeType() == TopAbs_WIRE) ++wires;
  if (wires != 1 || !(u1 > u0) || !(v1 > v0)) return 0.0;
  constexpr int kSegments = 16;
  double twice_area = 0;
  for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(edges.Current());
    const BRepAdaptor_Curve2d curve(edge, face);
    const double sign = edge.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
    gp_Pnt2d previous = curve.Value(curve.FirstParameter());
    for (int k = 1; k <= kSegments; ++k) {
      const gp_Pnt2d next = curve.Value(curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * k / kSegments);
      twice_area += sign * (previous.X() * next.Y() - next.X() * previous.Y());
      previous = next;
    }
  }
  return std::fabs(twice_area) / (2 * (u1 - u0) * (v1 - v0));
}

// A trimmed face lies inside its rectangle, so its box is inside the box R of the rectangle. When every side of R is reached by the face (to kReachSlack = 1e-8 of the diagonal; membership of a point in the face is tested to 1e-9 of the larger (u, v) span), R is the exact box
// of the face. A side counts as reached when the witness of the search lies in the face, or else when a point of a kReachGrid x kReachGrid grid of the rectangle that lies in the face is as far out
// (a flat side is touched all along an edge: the witness may be in a cut-off corner while the rest of the edge is in the face). A spike in a cut-off corner is reached by no point of the face:
// refused, and the caller keeps AddOptimal on the face.
constexpr double kReachSlack = 1e-8;
constexpr int kReachGrid = 40;

inline bool in_face(const TopoDS_Face &face, const gp_Pnt2d &at, double span) {
  BRepClass_FaceClassifier classifier(face, at, 1e-9 * span);
  return classifier.State() == TopAbs_IN || classifier.State() == TopAbs_ON;
}

inline bool rectangle_box_is_exact(const TopoDS_Face &face, const Handle(Geom_BSplineSurface) &spline, const Witness &witness, double u0, double u1, double v0, double v1, double diagonal) {
  const double slack = kReachSlack * diagonal;
  const double span = std::max({u1 - u0, v1 - v0, 1e-300});
  bool open_sides[2][3];
  bool any_open = false;
  for (int side = 0; side < 2; ++side)
    for (int axis = 0; axis < 3; ++axis) {
      open_sides[side][axis] = !in_face(face, witness.at[side][axis], span);
      any_open = any_open || open_sides[side][axis];
    }
  if (!any_open) return true;
  for (int i = 0; i <= kReachGrid; ++i)
    for (int j = 0; j <= kReachGrid; ++j) {
      const gp_Pnt2d at(u0 + (u1 - u0) * i / kReachGrid, v0 + (v1 - v0) * j / kReachGrid);
      const gp_Pnt point = spline->Value(at.X(), at.Y());
      const double xyz[3] = {point.X(), point.Y(), point.Z()};
      bool near_open = false;
      for (int side = 0; side < 2; ++side)
        for (int axis = 0; axis < 3; ++axis)
          if (open_sides[side][axis] && std::fabs(xyz[axis] - witness.value[side][axis]) <= slack) near_open = true;
      if (!near_open || !in_face(face, at, span)) continue;
      for (int side = 0; side < 2; ++side)
        for (int axis = 0; axis < 3; ++axis)
          if (open_sides[side][axis] && std::fabs(xyz[axis] - witness.value[side][axis]) <= slack) open_sides[side][axis] = false;
    }
  for (int side = 0; side < 2; ++side)
    for (int axis = 0; axis < 3; ++axis)
      if (open_sides[side][axis]) return false;
  return true;
}

// Adds the box of `face` (a plain full-patch B-spline face with many patches) to `box`; false (box untouched) when the face does not qualify or the search is too long.
// `outer` (may be null): for a trimmed face whose rectangle box is not proved exact, receives that box (it contains the face's own) and the function returns false: the caller may skip the face when
// the box it has gathered from the other faces already contains `outer`, else it asks AddOptimal for the face.
inline bool add_spline_bounds(const TopoDS_Face &face, Bnd_Box &box, int max_depth = kBoundsMaxDepth, Bnd_Box *outer = nullptr) {
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  const Handle(Geom_BSplineSurface) spline = surface.IsNull() ? Handle(Geom_BSplineSurface)() : Handle(Geom_BSplineSurface)::DownCast(surface);
  if (spline.IsNull() || spline->IsUPeriodic() || spline->IsVPeriodic()) return false;
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  double s0 = 0, s1 = 0, t0 = 0, t1 = 0;
  spline->Bounds(s0, s1, t0, t1);
  const double slack = 1e-9 * std::max({1.0, std::fabs(s1 - s0), std::fabs(t1 - t0)});
  if (std::fabs(u0 - s0) > slack || std::fabs(u1 - s1) > slack || std::fabs(v0 - t0) > slack || std::fabs(v1 - t1) > slack) return false;
  // a face that IS its rectangle (pcurves of any kind, fill 1 to the area of the polyline) needs no proof; a trimmed one is accepted only when the search reached every side of the box inside the face (below)
  bool trimmed = false;
  if (!is_full_patch(face, u0, u1, v0, v1)) {
    const double fill = fill_of_rectangle(face, u0, u1, v0, v1);
    if (fill < kMinFill) return false;
    trimmed = true;  // every face that is not a full patch goes through the proof (a 16-segment polyline misses a narrow notch)
  }
  GeomConvert_BSplineSurfaceToBezierSurface converter(spline);
  const int nu = converter.NbUPatches(), nv = converter.NbVPatches();
  if (nu * nv < kBoundsMinPatches) return false;
  struct Node {
    Handle(Geom_BezierSurface) patch;
    int depth;
    double ua, ub, va, vb;
  };
  TColStd_Array1OfReal u_knots(1, nu + 1), v_knots(1, nv + 1);
  converter.UKnots(u_knots);
  converter.VKnots(v_knots);
  Witness witness;
  Bnd_Box found;
  std::vector<Node> pending;
  for (int i = 1; i <= nu; ++i)
    for (int j = 1; j <= nv; ++j) {
      const Handle(Geom_BezierSurface) patch = converter.Patch(i, j);
      add_samples(found, patch, u_knots(i), u_knots(i + 1), v_knots(j), v_knots(j + 1), witness);
      pending.push_back({patch, 0, u_knots(i), u_knots(i + 1), v_knots(j), v_knots(j + 1)});
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
    if (inside) continue;
    if (node.depth >= max_depth) return false;
    if (++visits > kBoundsMaxVisits) return false;
    for (int quarter = 0; quarter < 4; ++quarter) {
      const double ua = quarter % 2 == 0 ? 0.0 : 0.5, va = quarter < 2 ? 0.0 : 0.5;
      const Handle(Geom_BezierSurface) child = Handle(Geom_BezierSurface)::DownCast(node.patch->Copy());
      child->Segment(ua, ua + 0.5, va, va + 0.5);
      const double u_mid = 0.5 * (node.ua + node.ub), v_mid = 0.5 * (node.va + node.vb);
      const double child_ua = quarter % 2 == 0 ? node.ua : u_mid, child_ub = quarter % 2 == 0 ? u_mid : node.ub;
      const double child_va = quarter < 2 ? node.va : v_mid, child_vb = quarter < 2 ? v_mid : node.vb;
      add_samples(found, child, child_ua, child_ub, child_va, child_vb, witness);
      pending.push_back({child, node.depth + 1, child_ua, child_ub, child_va, child_vb});
    }
  }
  found.Get(x0, y0, z0, x1, y1, z1);
  if (trimmed && !rectangle_box_is_exact(face, spline, witness, u0, u1, v0, v1, std::sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + (z1 - z0) * (z1 - z0)))) {
    if (outer != nullptr) {
      outer->Add(gp_Pnt(x0 - tolerance, y0 - tolerance, z0 - tolerance));
      outer->Add(gp_Pnt(x1 + tolerance, y1 + tolerance, z1 + tolerance));
    }
    return false;
  }
  box.Add(gp_Pnt(x0 - tolerance, y0 - tolerance, z0 - tolerance));
  box.Add(gp_Pnt(x1 + tolerance, y1 + tolerance, z1 + tolerance));
  return true;
}

}  // namespace query
}  // namespace llull
