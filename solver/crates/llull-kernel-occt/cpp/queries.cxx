// Exact topology (occtTopology.ts shapeTopology), surface parameters (occtFaceSurface.ts surfaceParams) and distances
// (occtAnalysis.ts shapeDistance, occtFaceDistance.ts pointDistances) for the native kernel. Index rule: queries.hxx.
#include "llull-kernel-occt/cpp/queries.hxx"

#include <set>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Pln.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

using query::distinct;
using query::index_in;

namespace query {

void write_surface_params(JsonWriter &out, const BRepAdaptor_Surface &adaptor) {
  const char *kind = surface_kind(adaptor.GetType());
  const auto frame = [&out](const gp_Ax3 &position, const char *axis_key) {
    out.key("origin").point(position.Location()).key(axis_key).direction(position.Direction());
    out.key("xDir").direction(position.XDirection());
  };
  out.begin_object();
  switch (adaptor.GetType()) {
    case GeomAbs_Plane:
      out.key("type").string("plane");
      frame(adaptor.Plane().Position(), "normal");
      break;
    case GeomAbs_Cylinder: {
      const gp_Cylinder cylinder = adaptor.Cylinder();
      out.key("type").string("cylinder");
      frame(cylinder.Position(), "axis");
      out.key("radius").number(cylinder.Radius());
      break;
    }
    case GeomAbs_Cone: {
      const gp_Cone cone = adaptor.Cone();
      // OCC's radius shrinks along +axis when the semi-angle is negative: report the equivalent cone opening along +axis.
      const gp_Dir axis = cone.Position().Direction();
      out.key("type").string("cone").key("apex").point(cone.Apex());
      out.key("axis").direction(cone.SemiAngle() < 0 ? axis.Reversed() : axis);
      out.key("xDir").direction(cone.Position().XDirection()).key("semiAngle").number(std::fabs(cone.SemiAngle()));
      break;
    }
    case GeomAbs_Sphere: {
      const gp_Sphere sphere = adaptor.Sphere();
      out.key("type").string("sphere").key("center").point(sphere.Position().Location()).key("radius").number(sphere.Radius());
      break;
    }
    case GeomAbs_Torus: {
      const gp_Torus torus = adaptor.Torus();
      out.key("type").string("torus").key("center").point(torus.Position().Location());
      out.key("axis").direction(torus.Position().Direction());
      out.key("major").number(torus.MajorRadius()).key("minor").number(torus.MinorRadius());
      break;
    }
    default:
      out.key("type").string("other").key("kind").string(kind);
  }
  out.end_object();
}

}  // namespace query

namespace {

constexpr int kEdgeSamples = 16;

// Axis, outward plane normal and convexity of an analytic face (occtTopology.ts faceGeometry).
void write_face_geometry(JsonWriter &out, const TopoDS_Face &face, const BRepAdaptor_Surface &adaptor) {
  const bool forward = face.Orientation() == TopAbs_FORWARD;
  switch (adaptor.GetType()) {
    case GeomAbs_Plane: {
      const gp_Dir normal = adaptor.Plane().Axis().Direction();
      const double sign = forward ? 1 : -1;
      out.key("normal").vec3(normal.X() * sign, normal.Y() * sign, normal.Z() * sign);
      return;
    }
    case GeomAbs_Cylinder: {
      const gp_Cylinder cylinder = adaptor.Cylinder();
      out.key("axis").begin_object().key("origin").point(cylinder.Axis().Location()).key("direction").direction(cylinder.Axis().Direction());
      out.key("radius").number(cylinder.Radius());
      out.key("span").begin_array().number(adaptor.FirstVParameter()).number(adaptor.LastVParameter()).end_array().end_object();
      out.key("convex").boolean(forward == cylinder.Direct());
      return;
    }
    case GeomAbs_Cone: {
      const gp_Cone cone = adaptor.Cone();
      out.key("axis").begin_object().key("origin").point(cone.Axis().Location()).key("direction").direction(cone.Axis().Direction());
      out.end_object().key("convex").boolean(forward == cone.Direct());
      return;
    }
    case GeomAbs_SurfaceOfRevolution: {
      const gp_Ax1 axis = adaptor.AxeOfRevolution();
      out.key("axis").begin_object().key("origin").point(axis.Location()).key("direction").direction(axis.Direction()).end_object();
      return;
    }
    default:
      return;
  }
}

void write_edge(JsonWriter &out, const TopoDS_Edge &edge, int index, int face_count, const std::string &name) {
  out.begin_object().key("index").integer(index).key("name").string(name);
  if (BRep_Tool::Degenerated(edge)) {
    const gp_Pnt at = BRep_Tool::Pnt(TopExp::FirstVertex(edge, Standard_False));
    out.key("curve").string("other").key("length").number(0);
    out.key("start").point(at).key("end").point(at).key("mid").point(at);
    out.key("seam").boolean(false).key("degenerate").boolean(true).end_object();
    return;
  }
  const BRepAdaptor_Curve curve(edge);
  const double first = curve.FirstParameter();
  const double last = curve.LastParameter();
  GProp_GProps props;
  BRepGProp::LinearProperties(edge, props, Standard_False, Standard_False);
  const char *kind = query::curve_kind(curve.GetType());
  out.key("curve").string(kind).key("length").number(props.Mass());
  out.key("start").point(curve.Value(first)).key("end").point(curve.Value(last)).key("mid").point(curve.Value((first + last) / 2));
  if (std::string(kind) != "line") {
    out.key("samples").begin_array();
    for (int k = 0; k <= kEdgeSamples; ++k) out.point(curve.Value(first + ((last - first) * k) / kEdgeSamples));
    out.end_array();
  }
  out.key("seam").boolean(face_count == 1).key("degenerate").boolean(false).end_object();
}

// Number of distinct faces each distinct edge bounds (1 = a seam), indexed like `edges` (occtTopology.ts adjacentFaceCounts).
std::vector<int> adjacent_face_counts(const TopTools_IndexedMapOfShape &faces, const TopTools_IndexedMapOfShape &edges) {
  std::vector<std::set<int>> owners(static_cast<size_t>(edges.Extent()));
  for (int f = 1; f <= faces.Extent(); ++f) {
    for (TopExp_Explorer explorer(faces(f), TopAbs_EDGE); explorer.More(); explorer.Next()) {
      const int edge = index_in(edges, explorer.Current());
      if (edge >= 0) owners[static_cast<size_t>(edge)].insert(f - 1);
    }
  }
  std::vector<int> counts;
  for (const auto &set : owners) counts.push_back(static_cast<int>(set.size()));
  return counts;
}

rust::String text_of(const JsonWriter &out) { return rust::String(out.text()); }

}  // namespace

rust::String topology_json(const Shape &shape) {
  const TopoDS_Shape &solid = shape.shape;
  const TopTools_IndexedMapOfShape faces = distinct(solid, TopAbs_FACE);
  const TopTools_IndexedMapOfShape edges = distinct(solid, TopAbs_EDGE);
  const std::vector<int> face_counts = adjacent_face_counts(faces, edges);
  const std::vector<std::string> face_names = naming::face_names(shape);
  const std::vector<std::string> edge_names = naming::edge_names(solid, face_names);
  const GProp_GProps volume = volume_props(shape, solid, false, nullptr);
  JsonWriter out;
  out.begin_object().key("solids").integer(distinct(solid, TopAbs_SOLID).Extent());
  out.key("faces").begin_array();
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    const BRepAdaptor_Surface adaptor(face, Standard_True);
    out.begin_object().key("index").integer(f - 1).key("name").string(face_names[static_cast<size_t>(f - 1)]);
    out.key("surface").string(query::surface_kind(adaptor.GetType()));
    out.key("area").number(query::face_metric(face).area);
    write_face_geometry(out, face, adaptor);
    out.end_object();
  }
  out.end_array().key("edges").begin_array();
  for (int e = 1; e <= edges.Extent(); ++e) write_edge(out, TopoDS::Edge(edges(e)), e - 1, face_counts[static_cast<size_t>(e - 1)], edge_names[static_cast<size_t>(e - 1)]);
  out.end_array().key("vertices").integer(distinct(solid, TopAbs_VERTEX).Extent());
  out.key("volume").number(std::fabs(volume.Mass())).end_object();
  return text_of(out);
}

namespace query {

std::optional<Nearest> nearest_on(const TopoDS_Shape &target, const gp_Pnt &point) {
  BRepBuilderAPI_MakeVertex vertex(point);
  BRepExtrema_DistShapeShape extrema;
  extrema.LoadS1(vertex.Vertex());
  extrema.LoadS2(target);
  if (!extrema.Perform() || !extrema.IsDone() || extrema.NbSolution() < 1) return std::nullopt;
  return Nearest{extrema.Value(), extrema.PointOnShape2(1), extrema.SupportOnShape2(1)};
}

}  // namespace query

namespace {

bool inside_any(const TopTools_IndexedMapOfShape &solids, const gp_Pnt &point, double tolerance) {
  for (int s = 1; s <= solids.Extent(); ++s) {
    BRepClass3d_SolidClassifier classifier(solids(s));
    classifier.Perform(point, tolerance);
    if (classifier.State() == TopAbs_IN) return true;
  }
  return false;
}

// Face carrying `support`: itself, or the only face of a seam edge; -1 for an edge between faces or a vertex (supportingFace).
int supporting_face(const TopoDS_Shape &support, const TopTools_IndexedMapOfShape &faces) {
  if (support.ShapeType() == TopAbs_FACE) return index_in(faces, support);
  if (support.ShapeType() != TopAbs_EDGE) return -1;
  int owner = -1;
  int owners = 0;
  for (int f = 1; f <= faces.Extent(); ++f) {
    if (distinct(faces(f), TopAbs_EDGE).Contains(support)) {
      owner = f - 1;
      ++owners;
    }
  }
  return owners == 1 ? owner : -1;
}

// Every solid of `inner` has its first vertex strictly inside a solid of `outer` (occtAnalysis.ts containedIn).
bool contained_in(const TopoDS_Shape &outer, const TopoDS_Shape &inner) {
  const TopTools_IndexedMapOfShape outer_solids = distinct(outer, TopAbs_SOLID);
  const TopTools_IndexedMapOfShape inner_solids = distinct(inner, TopAbs_SOLID);
  if (outer_solids.Extent() == 0 || inner_solids.Extent() == 0) return false;
  for (int s = 1; s <= inner_solids.Extent(); ++s) {
    const TopTools_IndexedMapOfShape vertices = distinct(inner_solids(s), TopAbs_VERTEX);
    if (vertices.Extent() == 0) return false;
    if (!inside_any(outer_solids, BRep_Tool::Pnt(TopoDS::Vertex(vertices(1))), 1e-6)) return false;
  }
  return true;
}

}  // namespace

rust::String point_distances_json(const Shape &shape, rust::Slice<const double> points) {
  if (points.size() % 3 != 0) throw std::invalid_argument("points: need x, y, z triples");
  const TopTools_IndexedMapOfShape faces = distinct(shape.shape, TopAbs_FACE);
  const TopTools_IndexedMapOfShape solids = distinct(shape.shape, TopAbs_SOLID);
  const TopTools_IndexedMapOfShape shells = distinct(shape.shape, TopAbs_SHELL);
  std::vector<TopoDS_Shape> targets;
  for (int s = 1; s <= shells.Extent(); ++s) targets.push_back(shells(s));
  if (targets.empty()) targets.push_back(shape.shape);
  JsonWriter out;
  out.begin_array();
  for (size_t i = 0; i < points.size(); i += 3) {
    const gp_Pnt point(points[i], points[i + 1], points[i + 2]);
    std::optional<query::Nearest> best;
    for (const TopoDS_Shape &target : targets) {
      const auto candidate = query::nearest_on(target, point);
      if (!candidate) return rust::String("null");
      if (!best || candidate->distance < best->distance) best = candidate;
    }
    const bool inside = inside_any(solids, point, 1e-7);
    out.begin_object().key("distance").number(best->distance).key("signed").number(inside ? -best->distance : best->distance);
    out.key("face").integer(supporting_face(best->support, faces)).end_object();
  }
  out.end_array();
  return text_of(out);
}

rust::String shape_distance_json(const Shape &a, const Shape &b) {
  BRepExtrema_DistShapeShape extrema;
  extrema.LoadS1(a.shape);
  extrema.LoadS2(b.shape);
  if (!extrema.Perform() || !extrema.IsDone() || extrema.NbSolution() < 1) return rust::String("null");
  const double distance = extrema.Value();
  const bool inside =
      extrema.InnerSolution() || (distance > 0 && (contained_in(a.shape, b.shape) || contained_in(b.shape, a.shape)));
  JsonWriter out;
  out.begin_object().key("distance").number(distance).key("pointA").point(extrema.PointOnShape1(1));
  out.key("pointB").point(extrema.PointOnShape2(1)).key("inside").boolean(inside).end_object();
  return text_of(out);
}

}  // namespace llull
