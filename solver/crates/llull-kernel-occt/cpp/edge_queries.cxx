// Edge queries of the face-query port (BLD M0 / TR-BLD-04): `edgeSamples` (curve frame along one edge) and `edgeContinuity` (G0 gap, G1 normal
// angle and the normal curvatures of the two faces across one edge). Index rule: queries.hxx. Result shapes: EdgeCurveSample and
// EdgeContinuitySample of packages/core/src/geometry/kernelPorts.ts.
#include <algorithm>
#include <cmath>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <Geom2d_Curve.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/queries.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

namespace {

constexpr int kMaxEdgeSamples = 1001;
constexpr double kOccCurvatureSign = -1;  // same convention as face_queries.cxx / occtFaceSurface.ts

bool edge_at(const TopoDS_Shape &shape, int32_t index, TopoDS_Edge &edge) {
  const TopTools_IndexedMapOfShape edges = query::distinct(shape, TopAbs_EDGE);
  if (index < 0 || index >= edges.Extent()) return false;
  edge = TopoDS::Edge(edges(index + 1));
  return !BRep_Tool::Degenerated(edge);
}

double curvature_at(const BRepAdaptor_Curve &curve, double u) {
  gp_Pnt point;
  gp_Vec d1, d2;
  curve.D2(u, point, d1, d2);
  const double speed = d1.Magnitude();
  return speed < 1e-14 ? 0.0 : d1.Crossed(d2).Magnitude() / (speed * speed * speed);
}

// Curvature of the surface in the unit tangent-plane direction `direction`, signed against the outward normal; false where undefined.
bool normal_curvature(const BRepAdaptor_Surface &surface, bool reversed, double u, double v, const gp_Vec &edge_tangent, gp_Vec &normal_out,
                      double &curvature) {
  BRepLProp_SLProps props(surface, u, v, 2, 1e-9);
  if (!props.IsNormalDefined() || !props.IsCurvatureDefined()) return false;
  const gp_Dir n = reversed ? props.Normal().Reversed() : props.Normal();
  normal_out = gp_Vec(n.X(), n.Y(), n.Z());
  gp_Vec across = normal_out.Crossed(edge_tangent);
  if (across.Magnitude() < 1e-12) return false;
  across.Normalize();
  gp_Dir dir_max, dir_min;
  if (props.IsUmbilic()) {
    curvature = props.MaxCurvature() * (kOccCurvatureSign * (reversed ? -1 : 1) < 0 ? -1 : 1);
    return true;
  }
  props.CurvatureDirections(dir_max, dir_min);
  const bool flip = kOccCurvatureSign * (reversed ? -1 : 1) < 0;
  const double k_max = flip ? -props.MinCurvature() : props.MaxCurvature();
  const double k_min = flip ? -props.MaxCurvature() : props.MinCurvature();
  const gp_Vec a = flip ? gp_Vec(dir_min.X(), dir_min.Y(), dir_min.Z()) : gp_Vec(dir_max.X(), dir_max.Y(), dir_max.Z());
  const gp_Vec b = flip ? gp_Vec(dir_max.X(), dir_max.Y(), dir_max.Z()) : gp_Vec(dir_min.X(), dir_min.Y(), dir_min.Z());
  const double ca = across.Dot(a);
  const double cb = across.Dot(b);
  curvature = k_max * ca * ca + k_min * cb * cb;
  return true;
}

}  // namespace

rust::String edge_samples_json(const Shape &shape, int32_t edge_index, int32_t count) {
  TopoDS_Edge edge;
  if (count < 2 || count > kMaxEdgeSamples || !edge_at(shape.shape, edge_index, edge)) return rust::String("null");
  const BRepAdaptor_Curve curve(edge);
  const double first = curve.FirstParameter();
  const double last = curve.LastParameter();
  if (!std::isfinite(first) || !std::isfinite(last) || !(last > first)) return rust::String("null");
  const double step = (last - first) * 1e-4;
  JsonWriter out;
  out.begin_array();
  for (int i = 0; i < count; ++i) {
    const double t = static_cast<double>(i) / (count - 1);
    const double u = first + t * (last - first);
    gp_Pnt point;
    gp_Vec d1, d2, d3;
    curve.D3(u, point, d1, d2, d3);
    const double speed = d1.Magnitude();
    if (speed < 1e-14) {
      out.begin_object().key("t").number(t).key("s").number(0).key("point").point(point).key("tangent").vec3(0, 0, 0).key("curvature").number(0);
      out.key("dCurvatureDs").number(0).key("torsion").number(0).key("normal").vec3(0, 0, 0).end_object();
      continue;
    }
    const gp_Vec tangent = d1 / speed;
    const gp_Vec cross = d1.Crossed(d2);
    const double cross_norm = cross.Magnitude();
    const double kappa = cross_norm / (speed * speed * speed);
    gp_Vec normal(0, 0, 0);
    if (cross_norm > 1e-14 * speed * speed) {
      normal = cross.Crossed(d1);
      normal.Normalize();
    }
    const double torsion = cross_norm > 1e-14 * speed * speed ? cross.Dot(d3) / (cross_norm * cross_norm) : 0.0;
    const double lo = std::max(first, u - step);
    const double hi = std::min(last, u + step);
    const double ds = GCPnts_AbscissaPoint::Length(curve, lo, hi);
    const double dk = ds > 1e-14 ? (curvature_at(curve, hi) - curvature_at(curve, lo)) / ds : 0.0;
    const double s = GCPnts_AbscissaPoint::Length(curve, first, u);
    out.begin_object().key("t").number(t).key("s").number(s).key("point").point(point).key("tangent").vector(tangent).key("curvature").number(kappa);
    out.key("dCurvatureDs").number(dk).key("torsion").number(torsion).key("normal").vector(normal).end_object();
  }
  out.end_array();
  return rust::String(out.text());
}

rust::String edge_continuity_json(const Shape &shape, int32_t edge_index, int32_t count) {
  TopoDS_Edge edge;
  if (count < 2 || count > kMaxEdgeSamples || !edge_at(shape.shape, edge_index, edge)) return rust::String("null");
  TopTools_IndexedDataMapOfShapeListOfShape ancestors;
  TopExp::MapShapesAndAncestors(shape.shape, TopAbs_EDGE, TopAbs_FACE, ancestors);
  std::vector<TopoDS_Face> faces;
  for (TopTools_ListIteratorOfListOfShape it(ancestors.FindFromKey(edge)); it.More(); it.Next()) {
    const TopoDS_Face face = TopoDS::Face(it.Value());
    if (std::none_of(faces.begin(), faces.end(), [&](const TopoDS_Face &known) { return known.IsSame(face); })) faces.push_back(face);
  }
  if (faces.size() != 2) return rust::String("null");  // boundary, seam or non-manifold edge: no two sides to compare
  const BRepAdaptor_Curve curve(edge);
  const double first = curve.FirstParameter();
  const double last = curve.LastParameter();
  struct Side {
    BRepAdaptor_Surface surface;
    bool reversed;
    Handle(Geom2d_Curve) pcurve;
    double pc_first, pc_last;
  };
  std::vector<Side> sides;
  for (const TopoDS_Face &face : faces) {
    double pc_first = 0, pc_last = 0;
    Handle(Geom2d_Curve) pcurve = BRep_Tool::CurveOnSurface(edge, face, pc_first, pc_last);
    if (pcurve.IsNull()) return rust::String("null");
    sides.push_back({BRepAdaptor_Surface(face, Standard_True), query::is_reversed(face), pcurve, pc_first, pc_last});
  }
  JsonWriter out;
  out.begin_array();
  for (int i = 0; i < count; ++i) {
    const double t = static_cast<double>(i) / (count - 1);
    gp_Pnt point;
    gp_Vec d1;
    curve.D1(first + t * (last - first), point, d1);
    const double speed = d1.Magnitude();
    if (speed < 1e-14) return rust::String("null");
    const gp_Vec tangent = d1 / speed;
    gp_Pnt on_surface[2];
    gp_Vec normals[2];
    double kappas[2] = {0, 0};
    for (int k = 0; k < 2; ++k) {
      const gp_Pnt2d uv = sides[k].pcurve->Value(sides[k].pc_first + t * (sides[k].pc_last - sides[k].pc_first));
      on_surface[k] = sides[k].surface.Value(uv.X(), uv.Y());
      if (!normal_curvature(sides[k].surface, sides[k].reversed, uv.X(), uv.Y(), tangent, normals[k], kappas[k])) return rust::String("null");
    }
    const double cosine = std::max(-1.0, std::min(1.0, normals[0].Dot(normals[1])));
    out.begin_object().key("t").number(t).key("point").point(point).key("g0").number(on_surface[0].Distance(on_surface[1]));
    out.key("g1").number(std::acos(cosine)).key("normalCurvature").begin_array().number(kappas[0]).number(kappas[1]).end_array().end_object();
  }
  out.end_array();
  return rust::String(out.text());
}

}  // namespace llull
