// Helpers shared by the query translation units (queries.cxx, face_queries.cxx): the sub-shape numbering rule (see queries.hxx),
// surface / curve classification and the surface evaluators of occtFaceSurface.ts of the retired opencascade.js kernel.
#pragma once

#include <array>
#include <cmath>
#include <optional>

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

// occtFaceMetrics.ts: BRepGProp surface properties of one face.
inline FaceMetric face_metric(const TopoDS_Face &face) {
  GProp_GProps props;
  BRepGProp::SurfaceProperties(face, props, Standard_False, Standard_False);
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
