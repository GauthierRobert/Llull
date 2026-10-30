// preserveAnalytic of the exact warp (01 DEF FR-DEF-12, §17.11); see deform_recognise.hxx.
#include "llull-kernel-occt/cpp/deform_recognise.hxx"

#include <algorithm>

#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_ListIteratorOfListOfStatus.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <TopExp_Explorer.hxx>
#include <TopAbs.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomLProp_SLProps.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_SphericalSurface.hxx>
#include <ShapeAnalysis_CanonicalRecognition.hxx>
#include <ShapeBuild_ReShape.hxx>
#include <ShapeFix_Face.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Pln.hxx>
#include <gp_Sphere.hxx>

namespace llull {
namespace deform {

namespace {

enum class Kind { None, Plane, Cylinder, Cone, Sphere };

struct Found {
  Kind kind = Kind::None;
  Handle(Geom_Surface) surface;
  double gap = 0;
};

// The first of plane, cylinder, cone, sphere that the face is within `tolerance` (a plane first: a cylinder or cone of a huge radius is not a better answer).
Found recognise(const TopoDS_Face &face, double tolerance) {
  Found found;
  ShapeAnalysis_CanonicalRecognition recognition(face);
  gp_Pln plane;
  gp_Cylinder cylinder;
  gp_Cone cone;
  gp_Sphere sphere;
  if (recognition.IsPlane(tolerance, plane)) {
    found = {Kind::Plane, new Geom_Plane(plane), recognition.GetGap()};
    return found;
  }
  recognition.ClearStatus();
  if (recognition.IsCylinder(tolerance, cylinder)) {
    found = {Kind::Cylinder, new Geom_CylindricalSurface(cylinder), recognition.GetGap()};
    return found;
  }
  recognition.ClearStatus();
  if (recognition.IsCone(tolerance, cone)) {
    found = {Kind::Cone, new Geom_ConicalSurface(cone), recognition.GetGap()};
    return found;
  }
  recognition.ClearStatus();
  if (recognition.IsSphere(tolerance, sphere)) found = {Kind::Sphere, new Geom_SphericalSurface(sphere), recognition.GetGap()};
  return found;
}

// +1 when the normals of the analytic surface and of the fitted one agree at the middle of the face, -1 when they oppose, 0 when it cannot be told.
int normal_agreement(const TopoDS_Face &face, const Handle(Geom_Surface) & fitted, const Handle(Geom_Surface) & analytic) {
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  const double u = 0.5 * (u0 + u1), v = 0.5 * (v0 + v1);
  GeomLProp_SLProps old_props(fitted, u, v, 1, 1e-9);
  if (!old_props.IsNormalDefined()) return 0;
  GeomAPI_ProjectPointOnSurf projection(fitted->Value(u, v), analytic);
  if (projection.NbPoints() < 1) return 0;
  double ua = 0, va = 0;
  projection.LowerDistanceParameters(ua, va);
  GeomLProp_SLProps new_props(analytic, ua, va, 1, 1e-9);
  if (!new_props.IsNormalDefined()) return 0;
  return old_props.Normal().Dot(new_props.Normal()) >= 0 ? 1 : -1;
}

// The first BRepCheck status that is not NoError on the face or its edges (the face: +1000), for the report of a rejected rebuild.
int first_status(const BRepCheck_Analyzer &checked, const TopoDS_Face &face) {
  const Handle(BRepCheck_Result) &own = checked.Result(face);
  if (!own.IsNull())
    for (BRepCheck_ListIteratorOfListOfStatus it(own->Status()); it.More(); it.Next())
      if (it.Value() != BRepCheck_NoError) return 1000 + static_cast<int>(it.Value());
  for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next()) {
    const Handle(BRepCheck_Result) &result = checked.Result(edges.Current());
    if (result.IsNull()) continue;
    for (BRepCheck_ListIteratorOfListOfStatus it(result->Status()); it.More(); it.Next())
      if (it.Value() != BRepCheck_NoError) return static_cast<int>(it.Value());
  }
  return -1;
}

// `face` on the recognised surface: the same wires (their 3D edges are shared with the neighbours), the curves on the new surface projected (exactly on a plane, by ShapeFix_Face
// otherwise). The surface is turned to face the way the fitted one did, so the face keeps its orientation and its wires keep theirs (iterated without the face's orientation).
TopoDS_Face rebuilt(const TopoDS_Face &face, const Handle(Geom_Surface) & fitted, const Handle(Geom_Surface) & recognised, double tolerance, int &status) {
  const int agreement = normal_agreement(face, fitted, recognised);
  if (agreement == 0) return TopoDS_Face();
  {
    Handle(Geom_Surface) analytic = Handle(Geom_Surface)::DownCast(recognised->Copy());
    if (agreement < 0) analytic->VReverse();
    BRep_Builder builder;
    TopoDS_Face fresh;
    builder.MakeFace(fresh, analytic, BRep_Tool::Tolerance(face));
    for (TopoDS_Iterator wires(face, Standard_False, Standard_True); wires.More(); wires.Next())
      if (wires.Value().ShapeType() == TopAbs_WIRE) builder.Add(fresh, wires.Value());
    if (!Handle(Geom_Plane)::DownCast(analytic).IsNull()) {
      for (TopExp_Explorer edges(fresh, TopAbs_EDGE); edges.More(); edges.Next()) BRepLib::BuildPCurveForEdgeOnPlane(TopoDS::Edge(edges.Current()), fresh);
    } else {
      ShapeFix_Face fixer(fresh);
      fixer.SetPrecision(tolerance);
      fixer.Perform();
      fresh = TopoDS::Face(fixer.Face());
    }
    fresh.Orientation(face.Orientation());
    BRepLib::SameParameter(fresh, tolerance, Standard_True);
    const BRepCheck_Analyzer checked(fresh, Standard_True);
    if (checked.IsValid()) return fresh;
    status = first_status(checked, fresh);
  }
  return TopoDS_Face();
}

// The analytic surface of the source face, when the face still lies on it within `tolerance` (sample points of the fitted surface projected on it).
Found from_source(const TopoDS_Face &face, const Handle(Geom_Surface) & fitted, const TopoDS_Face &source, double tolerance) {
  Found found;
  const Handle(Geom_Surface) own = BRep_Tool::Surface(source);
  if (own.IsNull()) return found;
  Kind kind = Kind::None;
  if (!Handle(Geom_Plane)::DownCast(own).IsNull()) kind = Kind::Plane;
  else if (!Handle(Geom_CylindricalSurface)::DownCast(own).IsNull()) kind = Kind::Cylinder;
  else if (!Handle(Geom_ConicalSurface)::DownCast(own).IsNull()) kind = Kind::Cone;
  else if (!Handle(Geom_SphericalSurface)::DownCast(own).IsNull()) kind = Kind::Sphere;
  if (kind == Kind::None) return found;
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  const int steps = 12;
  double worst = 0;
  for (int i = 0; i <= steps; ++i)
    for (int j = 0; j <= steps; ++j) {
      GeomAPI_ProjectPointOnSurf projection(fitted->Value(u0 + (u1 - u0) * i / steps, v0 + (v1 - v0) * j / steps), own);
      if (projection.NbPoints() < 1) return found;
      worst = std::max(worst, projection.LowerDistance());
      if (worst > tolerance) return found;
    }
  found.kind = kind;
  found.surface = Handle(Geom_Surface)::DownCast(own->Copy());
  found.gap = worst;
  return found;
}

}  // namespace

TopoDS_Shape recognise_analytic(const TopoDS_Shape &result, double tolerance, const TopTools_DataMapOfShapeShape &origin, Recognised &counts,
                                TopTools_DataMapOfShapeShape &replaced) {
  ShapeBuild_ReShape reshape;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(result, TopAbs_FACE, faces);
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    TopLoc_Location location;
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(face, location);
    if (surface.IsNull() || Handle(Geom_BSplineSurface)::DownCast(surface).IsNull()) continue;
    ++counts.tried;
    Found found = recognise(face, tolerance);
    if (found.kind == Kind::None && origin.IsBound(face)) {
      found = from_source(face, surface, TopoDS::Face(origin.Find(face)), tolerance);
      if (found.kind != Kind::None) ++counts.from_source;
    }
    if (found.kind == Kind::None) continue;
    const TopoDS_Face fresh = rebuilt(face, surface, found.surface, tolerance, counts.status);
    if (fresh.IsNull()) {
      ++counts.rejected;
      continue;
    }
    reshape.Replace(face, fresh);
    replaced.Bind(face, fresh);
    counts.worst_gap = std::max(counts.worst_gap, found.gap);
    switch (found.kind) {
      case Kind::Plane: ++counts.plane; break;
      case Kind::Cylinder: ++counts.cylinder; break;
      case Kind::Cone: ++counts.cone; break;
      default: ++counts.sphere; break;
    }
  }
  return counts.total() == 0 ? result : reshape.Apply(result);
}

}  // namespace deform
}  // namespace llull
