// Mass properties by knot span (01 DEF §17.16). BRepGProp integrates a B-spline face from a coarse sampling of its WHOLE parameter box and refines until two orders agree: a feature much
// narrower than the face (a push of radius 2 on a 1000 mm face: 1.57 mm^3 of 3e6) lies between the first samples, the two orders agree on a flat surface, and the face reads as flat (area
// and volume unchanged to 1e-9 although the surface carries the bump). The cure is to hand the integrator pieces of the face: one per run of FINE spans (the slivers of a local refinement,
// as wide as the feature that caused them) and one per run of COARSE spans, each a patch whose parameter box is the run.
#pragma once

#include <BRepAdaptor_Curve2d.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Precision.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TopExp_Explorer.hxx>
#include <TopAbs.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec2d.hxx>

#include <algorithm>
#include <cmath>
#include <vector>

namespace llull {
namespace query {

// Most sub-faces one face is cut into: beyond it the face is dense everywhere (a uniform fit), where the whole-face rule sees every feature and cutting it would cost seconds.
constexpr size_t kMaxSpanFaces = 1024;
// A direction with this many spans or fewer stays whole (the profile direction of a blend face has three): a feature there is a fraction of the direction, not a sliver between samples,
// and cutting it multiplies the pieces (and the time) for nothing. A direction whose spans are all within this ratio of one another stays whole too: it is a uniform fit (a global law
// refined everywhere, or a blend face's stations), whose features are as wide as its spans; only a LOCAL refinement (a push, a lattice cell) puts slivers beside long spans.
constexpr size_t kWholeDirectionSpans = 4;
constexpr double kUniformSpanRatio = 4.0;

// Whether the face is the whole rectangle [u0, u1] x [v0, v1] of its surface: one wire of axis-aligned straight pcurves on all four sides (a fitted face of a warp of a box face, say).
inline bool is_full_patch(const TopoDS_Face &face, double u0, double u1, double v0, double v1) {
  int wires = 0;
  for (TopoDS_Iterator it(face); it.More(); it.Next())
    if (it.Value().ShapeType() == TopAbs_WIRE) ++wires;
  if (wires != 1) return false;
  const double tolerance = 1e-9 * std::max({1.0, std::fabs(u1 - u0), std::fabs(v1 - v0)});
  bool sides[4] = {false, false, false, false};  // u = u0, u = u1, v = v0, v = v1
  for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(edges.Current());
    if (BRep_Tool::Degenerated(edge)) continue;
    const BRepAdaptor_Curve2d curve(edge, face);
    if (curve.GetType() != GeomAbs_Line) return false;
    const gp_Pnt2d a = curve.Value(curve.FirstParameter()), b = curve.Value(curve.LastParameter());
    if (std::fabs(a.X() - b.X()) <= tolerance) {
      if (std::fabs(a.X() - u0) <= tolerance) sides[0] = true;
      else if (std::fabs(a.X() - u1) <= tolerance) sides[1] = true;
      else return false;
    } else if (std::fabs(a.Y() - b.Y()) <= tolerance) {
      if (std::fabs(a.Y() - v0) <= tolerance) sides[2] = true;
      else if (std::fabs(a.Y() - v1) <= tolerance) sides[3] = true;
      else return false;
    } else {
      return false;
    }
  }
  return sides[0] && sides[1] && sides[2] && sides[3];
}

// Whether the longest span is more than kUniformSpanRatio times the shortest.
inline bool is_graded(const std::vector<double> &borders) {
  double shortest = 1e300, longest = 0;
  for (size_t i = 0; i + 1 < borders.size(); ++i) {
    shortest = std::min(shortest, borders[i + 1] - borders[i]);
    longest = std::max(longest, borders[i + 1] - borders[i]);
  }
  return longest > kUniformSpanRatio * shortest;
}

// The borders of the pieces of one graded direction: consecutive FINE spans (at most kFineRatio times the shortest: the slivers of a local refinement, as wide as the feature that caused them) form
// one piece, consecutive COARSE spans another (they are wider than any feature the fit holds, so the whole-face rule reads them right). A push on a 1000 mm face is then 3 pieces per direction (coarse, fine
// run around the support, coarse), 9 per face, not one per span (a piece per span cost about 450 microseconds each and a dense 197 x 197 fit took 20 s per mass call).
constexpr double kFineRatio = 8.0;
inline std::vector<double> class_borders(const std::vector<double> &borders) {
  double shortest = 1e300;
  for (size_t i = 0; i + 1 < borders.size(); ++i) shortest = std::min(shortest, borders[i + 1] - borders[i]);
  std::vector<double> out{borders.front()};
  bool previous_fine = false;
  for (size_t i = 0; i + 1 < borders.size(); ++i) {
    const bool fine = borders[i + 1] - borders[i] <= kFineRatio * shortest * (1 + 1e-9);
    if (i > 0 && fine != previous_fine) out.push_back(borders[i]);
    previous_fine = fine;
  }
  out.push_back(borders.back());
  return out;
}

// The distinct knots of one direction clipped to [low, high], as the borders of the spans.
inline std::vector<double> span_borders(const TColStd_Array1OfReal &knots, double low, double high) {
  std::vector<double> borders{low};
  for (int k = knots.Lower(); k <= knots.Upper(); ++k)
    if (knots(k) > low + 1e-12 * (high - low) && knots(k) < high - 1e-12 * (high - low)) borders.push_back(knots(k));
  borders.push_back(high);
  return borders;
}

// Whether every face of `shape` belongs to a closed shell: only then do the open-cone volumes of its faces add up to a volume (an open shell integrated from an arbitrary apex
// depends on where the apex is).
inline bool all_shells_closed(const TopoDS_Shape &shape) {
  if (TopExp_Explorer(shape, TopAbs_FACE, TopAbs_SHELL).More()) return false;
  bool any = false;
  for (TopExp_Explorer shells(shape, TopAbs_SHELL); shells.More(); shells.Next()) {
    any = true;
    if (!BRep_Tool::IsClosed(shells.Current())) return false;
  }
  return any;
}

// A compound of the faces of `shape` in which every full-patch B-spline face is cut into one face per run of fine spans and per run of coarse spans (same surface, same orientation,
// the location of the face applied to the surface). The faces that are not B-spline patches, are trimmed, or would need more than kMaxSpanFaces pieces stay as they are; so does a face
// one of whose pieces cannot be made (it is not counted). `cut` counts the faces that were replaced. With `need_closed` (a volume) a shape that has a face outside a closed shell is
// returned as it is, with cut 0.
inline TopoDS_Compound span_faces(const TopoDS_Shape &shape, int &cut, bool need_closed) {
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  cut = 0;
  const bool whole = need_closed && !all_shells_closed(shape);
  for (TopExp_Explorer faces(shape, TopAbs_FACE); faces.More(); faces.Next()) {
    const TopoDS_Face face = TopoDS::Face(faces.Current());
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);  // the location applied: the pieces lie where the face lies
    const Handle(Geom_BSplineSurface) spline = surface.IsNull() ? Handle(Geom_BSplineSurface)() : Handle(Geom_BSplineSurface)::DownCast(surface);
    double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
    if (!whole && !spline.IsNull()) BRepTools::UVBounds(face, u0, u1, v0, v1);
    if (whole || spline.IsNull() || !is_full_patch(face, u0, u1, v0, v1)) {
      builder.Add(compound, face);
      continue;
    }
    std::vector<double> us = span_borders(spline->UKnots(), u0, u1), vs = span_borders(spline->VKnots(), v0, v1);
    if (us.size() - 1 <= kWholeDirectionSpans || !is_graded(us)) us = {u0, u1};
    else us = class_borders(us);
    if (vs.size() - 1 <= kWholeDirectionSpans || !is_graded(vs)) vs = {v0, v1};
    else vs = class_borders(vs);
    if ((us.size() - 1) * (vs.size() - 1) > kMaxSpanFaces || (us.size() - 1) * (vs.size() - 1) < 2) {
      builder.Add(compound, face);
      continue;
    }
    std::vector<TopoDS_Face> pieces;
    bool complete = true;
    for (size_t i = 0; i + 1 < us.size() && complete; ++i)
      for (size_t j = 0; j + 1 < vs.size() && complete; ++j) {
        BRepBuilderAPI_MakeFace maker(spline, us[i], us[i + 1], vs[j], vs[j + 1], Precision::Confusion());
        if (!maker.IsDone()) {
          complete = false;
          break;
        }
        TopoDS_Face piece = maker.Face();
        piece.Orientation(face.Orientation());
        pieces.push_back(piece);
      }
    if (!complete) {
      builder.Add(compound, face);
      continue;
    }
    ++cut;
    for (const TopoDS_Face &piece : pieces) builder.Add(compound, piece);
  }
  return compound;
}

}  // namespace query
}  // namespace llull
