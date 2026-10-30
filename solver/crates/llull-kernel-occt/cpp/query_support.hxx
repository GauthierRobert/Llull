// Helpers shared by the query translation units (queries.cxx, face_queries.cxx): the sub-shape numbering rule (see queries.hxx),
// surface / curve classification and the surface evaluators of occtFaceSurface.ts of the retired opencascade.js kernel.
#pragma once

#include <array>
#include <cmath>
#include <optional>
#include <sstream>
#include <string>

#include <BRepAdaptor_Surface.hxx>
#include <BRepGProp.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <ShapeAnalysis_Surface.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt2d.hxx>

#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/mass_spans.hxx"

namespace llull {
namespace query {

// Distinct sub-shapes of `kind`, numbered from 1 in first-seen explorer order (index k + 1 = the port's index k).
inline TopTools_IndexedMapOfShape distinct(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, kind, map);
  return map;
}

// 0-based index of `sub` in `map` (IsSame), -1 when absent.
inline int index_in(const TopTools_IndexedMapOfShape &map, const TopoDS_Shape &sub) { return map.FindIndex(sub) - 1; }

inline const char *surface_kind(GeomAbs_SurfaceType type) {
  switch (type) {
    case GeomAbs_Plane:
      return "plane";
    case GeomAbs_Cylinder:
      return "cylinder";
    case GeomAbs_Cone:
      return "cone";
    case GeomAbs_Sphere:
      return "sphere";
    case GeomAbs_Torus:
      return "torus";
    case GeomAbs_BSplineSurface:
    case GeomAbs_BezierSurface:
      return "bspline";
    case GeomAbs_SurfaceOfRevolution:
      return "revolution";
    case GeomAbs_SurfaceOfExtrusion:
      return "extrusion";
    default:
      return "other";
  }
}

inline const char *curve_kind(GeomAbs_CurveType type) {
  switch (type) {
    case GeomAbs_Line:
      return "line";
    case GeomAbs_Circle:
      return "circle";
    case GeomAbs_Ellipse:
      return "ellipse";
    case GeomAbs_BSplineCurve:
    case GeomAbs_BezierCurve:
      return "bspline";
    default:
      return "other";
  }
}

inline bool is_reversed(const TopoDS_Shape &shape) { return shape.Orientation() == TopAbs_REVERSED; }

struct FaceMetric {
  double area;
  gp_Pnt centroid;
};

// Relative accuracy asked of the adaptive rule for a face of a shape with a C0 knot in a boundary, and the error estimate up to which it is trusted.
constexpr double kRefinedFaceEps = 1e-9;
constexpr double kRefinedFaceDrift = 1e-5;

// The note a result carries when the adaptive rule's own error estimate (`worst`, the largest over the tripped integrals) exceeded
// kRefinedFaceDrift and the fixed Gauss rule was used there instead; empty when no guard tripped (`worst` NaN).
inline std::string guard_note(double worst) {
  if (!std::isfinite(worst)) return {};
  std::ostringstream text;
  text << "the adaptive integration rule's error estimate (largest " << worst << ") exceeded " << kRefinedFaceDrift
       << " on at least one face or volume of this shape, so the fixed Gauss rule was used there; areas and volumes may be off by the kinks of the boundaries";
  return text.str();
}

// occtFaceMetrics.ts: BRepGProp surface properties of one face. `refined` (Shape::refined_mass and a freeform face: `adaptive_rule`): the adaptive
// rule when its own error estimate is within kRefinedFaceDrift, else the fixed Gauss rule (that rule is wrong across a C0 knot of a boundary, a
// straight radius law with a kink); a tripped guard raises `*tripped` (may be null) to its estimate.
inline FaceMetric face_metric(const TopoDS_Face &face, bool refined = false, double *tripped = nullptr) {
  GProp_GProps props;
  if (refined) {
    GProp_GProps adaptive;
    int cut = 0;
    const TopoDS_Compound spans = span_faces(face, cut);
    const double error = BRepGProp::SurfaceProperties(cut > 0 ? static_cast<TopoDS_Shape>(spans) : static_cast<TopoDS_Shape>(face), adaptive, kRefinedFaceEps, Standard_False);
    if (error <= kRefinedFaceDrift) return {adaptive.Mass(), adaptive.CentreOfMass()};
    if (tripped != nullptr && !(*tripped >= error)) *tripped = error;
  }
  // the fixed rule too: by knot span when the face is a graded full B-spline patch (mass_spans.hxx)
  int cut = 0;
  const TopoDS_Compound spans = span_faces(face, cut);
  BRepGProp::SurfaceProperties(cut > 0 ? static_cast<TopoDS_Shape>(spans) : static_cast<TopoDS_Shape>(face), props, Standard_False, Standard_False);
  return {props.Mass(), props.CentreOfMass()};
}

// `[uMin, uMax, vMin, vMax]` of an adaptor restricted to its face (occtFaceSurface.ts uvRange).
inline std::array<double, 4> uv_range(const BRepAdaptor_Surface &adaptor) {
  return {adaptor.FirstUParameter(), adaptor.LastUParameter(), adaptor.FirstVParameter(), adaptor.LastVParameter()};
}

inline bool all_finite(const std::array<double, 4> &values) {
  for (double value : values)
    if (!std::isfinite(value)) return false;
  return true;
}

// JavaScript Math.round (halves round up).
inline double js_round(double value) { return std::floor(value + 0.5); }

inline double wrap_into(double value, double min, double max, double period) {
  if (!(period > 0) || (value >= min - 1e-9 && value <= max + 1e-9)) return value;
  const double shifted = value + js_round((min + max) / 2 / period - value / period) * period;
  return shifted >= min - 1e-9 && shifted <= max + 1e-9 ? shifted : value;
}

// (u, v) of the surface point nearest to `point`, shifted into the face's range on periodic directions (occtFaceSurface.ts uvOfPoint).
inline std::array<double, 2> uv_of_point(const TopoDS_Face &face, const BRepAdaptor_Surface &adaptor, const gp_Pnt &point) {
  ShapeAnalysis_Surface analysis(BRep_Tool::Surface(face));
  const gp_Pnt2d uv = analysis.ValueOfUV(point, 1e-9);
  const auto range = uv_range(adaptor);
  return {adaptor.IsUPeriodic() ? wrap_into(uv.X(), range[0], range[1], adaptor.UPeriod()) : uv.X(),
          adaptor.IsVPeriodic() ? wrap_into(uv.Y(), range[2], range[3], adaptor.VPeriod()) : uv.Y()};
}

struct PointNormal {
  gp_Pnt point;
  gp_Dir normal;
};

// Point and outward unit normal at (u, v); empty where the normal is undefined (occtFaceSurface.ts pointAndNormal).
inline std::optional<PointNormal> point_and_normal(const BRepAdaptor_Surface &adaptor, bool reversed, double u, double v) {
  BRepLProp_SLProps props(adaptor, u, v, 2, 1e-9);
  if (!props.IsNormalDefined()) return std::nullopt;
  const gp_Dir normal = props.Normal();
  return PointNormal{props.Value(), reversed ? normal.Reversed() : normal};
}

struct Nearest {
  double distance;
  gp_Pnt point;
  // The sub-shape of the target carrying the nearest point (a face, edge or vertex).
  TopoDS_Shape support;
};

// Nearest point of `target` to `point` (BRepExtrema_DistShapeShape from a vertex); empty when the extrema does not solve.
std::optional<Nearest> nearest_on(const TopoDS_Shape &target, const gp_Pnt &point);

// SurfaceParams (TR-KRN-91) of the adaptor's surface (occtFaceSurface.ts surfaceParams).
void write_surface_params(JsonWriter &out, const BRepAdaptor_Surface &adaptor);

}  // namespace query
}  // namespace llull
