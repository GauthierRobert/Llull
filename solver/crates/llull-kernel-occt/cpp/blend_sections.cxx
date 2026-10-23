// Section readback of a blend face (BLD M1 / TR-BLD-05): the radius of the circle through the two contact points and the mid point of the
// face's cross-section, at uniform parameter fractions of one contact edge. Core derives the blend faces and their contact edges from the
// persistent names (packages/core/src/geometry/blend/blendInfo.ts); the result shape is BlendSection of kernelPorts.ts.
#include <algorithm>
#include <array>
#include <cmath>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/queries.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

namespace {

constexpr int kMaxSections = 1001;

struct EdgeOnFace {
  Handle(Geom2d_Curve) curve;
  double first = 0, last = 0;
  gp_Pnt2d at(double t) const { return curve->Value(first + t * (last - first)); }
};

bool pcurve_of(const TopoDS_Shape &shape, int32_t index, const TopoDS_Face &face, EdgeOnFace &out) {
  const TopTools_IndexedMapOfShape edges = query::distinct(shape, TopAbs_EDGE);
  if (index < 0 || index >= edges.Extent()) return false;
  const TopoDS_Edge edge = TopoDS::Edge(edges(index + 1));
  if (BRep_Tool::Degenerated(edge)) return false;
  out.curve = BRep_Tool::CurveOnSurface(edge, face, out.first, out.last);
  return !out.curve.IsNull() && out.last > out.first;
}

// Circumcentre and radius of three points; false when they are collinear.
bool circle_through(const gp_Pnt &a, const gp_Pnt &b, const gp_Pnt &c, gp_Pnt &centre, double &radius) {
  const gp_Vec ab(a, b), ac(a, c);
  const gp_Vec normal = ab.Crossed(ac);
  const double twice_area_squared = normal.SquareMagnitude();
  if (twice_area_squared < 1e-24) return false;
  const gp_Vec toward = (normal.Crossed(ab) * ac.SquareMagnitude() + ac.Crossed(normal) * ab.SquareMagnitude()) / (2.0 * twice_area_squared);
  centre = a.Translated(toward);
  radius = toward.Magnitude();
  return true;
}

}  // namespace

rust::String blend_sections_json(const Shape &shape, int32_t face_index, int32_t edge_a, int32_t edge_b, int32_t count) {
  const TopTools_IndexedMapOfShape faces = query::distinct(shape.shape, TopAbs_FACE);
  if (count < 2 || count > kMaxSections || face_index < 0 || face_index >= faces.Extent()) return rust::String("null");
  const TopoDS_Face face = TopoDS::Face(faces(face_index + 1));
  EdgeOnFace a, b;
  if (!pcurve_of(shape.shape, edge_a, face, a) || !pcurve_of(shape.shape, edge_b, face, b)) return rust::String("null");
  const BRepAdaptor_Surface surface(face, Standard_True);
  // The spine runs along the parameter the first contact edge changes most; the section crosses to the other contact edge.
  const gp_Pnt2d a0 = a.at(0), a_mid = a.at(0.5), a1 = a.at(1);
  const double span_u = std::max(std::abs(a1.X() - a0.X()), std::abs(a_mid.X() - a0.X()));
  const double span_v = std::max(std::abs(a1.Y() - a0.Y()), std::abs(a_mid.Y() - a0.Y()));
  const bool along_u = span_u >= span_v;
  const gp_Pnt2d b_mid = b.at(0.5);
  const double across_a = along_u ? a_mid.Y() : a_mid.X();
  const double across_b = along_u ? b_mid.Y() : b_mid.X();
  if (std::abs(across_a - across_b) < 1e-12) return rust::String("null");
  JsonWriter out;
  out.begin_array();
  for (int i = 0; i < count; ++i) {
    const double t = static_cast<double>(i) / (count - 1);
    const gp_Pnt2d on_a = a.at(t);
    const double along = along_u ? on_a.X() : on_a.Y();
    const auto at = [&](double across) { return along_u ? surface.Value(along, across) : surface.Value(across, along); };
    const gp_Pnt start = at(across_a), middle = at(0.5 * (across_a + across_b)), end = at(across_b);
    gp_Pnt centre;
    double radius = 0;
    out.begin_object().key("t").number(t).key("a").point(start).key("mid").point(middle).key("b").point(end);
    if (circle_through(start, middle, end, centre, radius))
      out.key("radius").number(radius).key("centre").point(centre);
    else
      out.key("radius").null().key("centre").null();
    out.end_object();
  }
  out.end_array();
  return rust::String(out.text());
}

}  // namespace llull
