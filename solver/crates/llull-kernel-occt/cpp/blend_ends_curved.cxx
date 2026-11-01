// Oblique ends on a CURVED end face (BLD M2, TECHNICAL_SPEC §13.37): the skin runs past the end of the circular blend and is cut back by the surface of the end
// face itself (BRepAlgoAPI_Splitter), keeping the piece on the solid's side. The new end curve is the intersection of the skin with that surface.
#include <algorithm>
#include <cmath>
#include <string>

#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"

namespace llull {
namespace blend {
namespace rails {

namespace {

// The parameter box of the cutting face is the end face's own, grown by this fraction of its size on each side.
constexpr double kBoxGrowth = 0.1;
// A piece of the split whose centre lies within this fraction of the diagonal of the surface is a piece of the cutting face, not of the skin.
constexpr double kOnSurface = 1e-6;

// [lo - pad, hi + pad] within the bounds of the surface, or one period of a periodic direction.
void widen(double lo, double hi, double least, double most, bool periodic, double &from, double &to) {
  const double pad = kBoxGrowth * (hi - lo);
  if (periodic) {
    from = lo - pad;
    to = std::min(hi + pad, from + (most - least));
  } else {
    from = std::max(lo - pad, least);
    to = std::min(hi + pad, most);
  }
}

}  // namespace

bool end_height(const Blend &blend, int side, const gp_Pnt &point, double &height) {
  if (!blend.curved[side]) {
    height = gp_Vec(blend.end_point[side], point).Dot(blend.end_normal[side].Normalized());
    return true;
  }
  TopLoc_Location location;
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(blend.end_face[side], location);
  if (surface.IsNull()) return false;
  const gp_Trsf placement = location.Transformation();
  GeomAPI_ProjectPointOnSurf projection(point.Transformed(placement.Inverted()), surface);
  if (projection.NbPoints() < 1) return false;
  double u = 0, v = 0;
  projection.LowerDistanceParameters(u, v);
  gp_Pnt on;
  gp_Vec du, dv;
  surface->D1(u, v, on, du, dv);
  gp_Vec normal = du.Crossed(dv);
  if (normal.Magnitude() < 1e-14) return false;
  normal = normal.Normalized().Transformed(placement) * blend.end_sign[side];
  height = gp_Vec(on.Transformed(placement), point).Dot(normal);
  return true;
}

bool split_by_end_surface(TopoDS_Face &face, const Blend &blend, int side, double diagonal, std::string &why) {
  TopLoc_Location location;
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(blend.end_face[side], location);
  if (surface.IsNull()) {
    why = "internal error: the curved end face has no surface";
    return false;
  }
  double u0, u1, v0, v1, s0, s1, t0, t1;
  BRepTools::UVBounds(blend.end_face[side], u0, u1, v0, v1);
  surface->Bounds(s0, s1, t0, t1);
  double ua, ub, va, vb;
  widen(u0, u1, s0, s1, surface->IsUPeriodic() == Standard_True, ua, ub);
  widen(v0, v1, t0, t1, surface->IsVPeriodic() == Standard_True, va, vb);
  BRepBuilderAPI_MakeFace made(surface, ua, ub, va, vb, 1e-9 * diagonal);
  if (!made.IsDone()) {
    why = "internal error: the surface of the curved end face could not be made a face to cut with";
    return false;
  }
  TopTools_ListOfShape arguments, tools;
  arguments.Append(face);
  tools.Append(made.Face().Moved(location));
  BRepAlgoAPI_Splitter split;
  split.SetArguments(arguments);
  split.SetTools(tools);
  split.Build();
  if (!split.IsDone() || split.HasErrors()) {
    why = "internal error: the skin could not be split by the surface of a curved end face";
    return false;
  }
  TopTools_IndexedMapOfShape pieces;
  TopExp::MapShapes(split.Shape(), TopAbs_FACE, pieces);
  int count = 0;
  for (int p = 1; p <= pieces.Extent(); ++p) {
    GProp_GProps props;
    BRepGProp::SurfaceProperties(pieces(p), props);
    double height = 0;
    if (!end_height(blend, side, props.CentreOfMass(), height)) {
      why = "internal error: the surface of a curved end face could not be projected on";
      return false;
    }
    if (height < -kOnSurface * diagonal) {
      face = TopoDS::Face(pieces(p));
      ++count;
    }
  }
  if (count != 1) {
    why = count == 0 ? "internal error: the surface of the curved end face does not cut the skin of the blend (no piece of it lies on the solid's side)"
                     : "internal error: the surface of a curved end face cuts the skin into " + std::to_string(count) + " pieces on the solid's side (one expected)";
    return false;
  }
  return true;
}

}  // namespace rails
}  // namespace blend
}  // namespace llull
