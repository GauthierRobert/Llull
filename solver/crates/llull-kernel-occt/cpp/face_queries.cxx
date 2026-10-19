// Face-query port (01 §5.9) of the native kernel, following occtFaceQuery.ts and occtFaceGraph.ts of the retired opencascade.js kernel
// (same OCC algorithms, same sample grids, same arithmetic order). Index rule: queries.hxx.
#include <algorithm>
#include <set>
#include <stdexcept>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepTools.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>

#include "llull-kernel-occt/cpp/queries.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

using query::distinct;
using query::index_in;

namespace {

constexpr double kSmoothAngle = 1e-6;
constexpr int kMaxGridPoints = 4096;
constexpr double kOccCurvatureSign = -1;  // occtFaceSurface.ts OCC_CURVATURE_SIGN

rust::String text_of(const JsonWriter &out) { return rust::String(out.text()); }

std::optional<TopoDS_Face> face_at(const TopoDS_Shape &shape, int32_t index) {
  if (index < 0) return std::nullopt;
  const TopTools_IndexedMapOfShape faces = distinct(shape, TopAbs_FACE);
  if (index >= faces.Extent()) return std::nullopt;
  return TopoDS::Face(faces(index + 1));
}

std::vector<gp_Pnt> points_of(rust::Slice<const double> flat) {
  if (flat.size() % 3 != 0) throw std::invalid_argument("points: need x, y, z triples");
  std::vector<gp_Pnt> points;
  for (size_t i = 0; i < flat.size(); i += 3) points.emplace_back(flat[i], flat[i + 1], flat[i + 2]);
  return points;
}

std::vector<std::array<double, 2>> pairs_of(rust::Slice<const double> flat) {
  if (flat.size() % 2 != 0) throw std::invalid_argument("uv: need u, v pairs");
  std::vector<std::array<double, 2>> pairs;
  for (size_t i = 0; i < flat.size(); i += 2) pairs.push_back({flat[i], flat[i + 1]});
  return pairs;
}

gp_Vec as_vec(const gp_Dir &d) { return gp_Vec(d.X(), d.Y(), d.Z()); }

// Up to `count` points inside the trimmed face: uv cell centres the classifier puts IN, thinned evenly (interiorSamples).
void write_interior_samples(JsonWriter &out, const TopoDS_Face &face, const BRepAdaptor_Surface &adaptor, int count) {
  const auto range = query::uv_range(adaptor);
  out.begin_array();
  if (count <= 0 || !query::all_finite(range)) {
    out.end_array();
    return;
  }
  const auto [u_min, u_max, v_min, v_max] = range;
  const int side = std::max(4, static_cast<int>(std::ceil(std::sqrt(static_cast<double>(count)) * 2)));
  BRepClass_FaceClassifier classifier;
  std::vector<std::array<double, 2>> inside;
  for (int i = 0; i < side; ++i) {
    for (int j = 0; j < side; ++j) {
      const std::array<double, 2> uv = {u_min + ((u_max - u_min) * (i + 0.5)) / side, v_min + ((v_max - v_min) * (j + 0.5)) / side};
      classifier.Perform(face, gp_Pnt2d(uv[0], uv[1]), 1e-7);
      if (classifier.State() == TopAbs_IN) inside.push_back(uv);
    }
  }
  const size_t kept = std::min(static_cast<size_t>(count), inside.size());
  const double step = static_cast<double>(inside.size()) / static_cast<double>(std::max<size_t>(kept, 1));
  for (size_t k = 0; k < kept; ++k) {
    const auto &uv = inside.size() <= static_cast<size_t>(count) ? inside[k] : inside[static_cast<size_t>(std::floor(k * step))];
    out.point(adaptor.Value(uv[0], uv[1]));
  }
  out.end_array();
}

void write_face_detail(JsonWriter &out, const TopoDS_Face &face, int index, int samples) {
  const BRepAdaptor_Surface adaptor(face, Standard_True);
  const query::FaceMetric metric = query::face_metric(face);
  out.begin_object().key("index").integer(index).key("surface").string(query::surface_kind(adaptor.GetType()));
  out.key("area").number(metric.area).key("centroid").point(metric.centroid);
  switch (adaptor.GetType()) {
    case GeomAbs_Plane: {
      const gp_Dir normal = adaptor.Plane().Position().Direction();
      out.key("normal").direction(query::is_reversed(face) ? normal.Reversed() : normal);
      break;
    }
    case GeomAbs_Cylinder: {
      const gp_Cylinder cylinder = adaptor.Cylinder();
      out.key("axis").begin_object().key("origin").point(cylinder.Position().Location());
      out.key("dir").direction(cylinder.Position().Direction()).end_object().key("radius").number(cylinder.Radius());
      break;
    }
    case GeomAbs_Cone: {
      const gp_Cone cone = adaptor.Cone();
      const gp_Pnt apex = cone.Apex();
      const gp_Dir position_axis = cone.Position().Direction();
      const gp_Dir axis = cone.SemiAngle() < 0 ? position_axis.Reversed() : position_axis;
      const gp_Vec to_centroid(apex, metric.centroid);
      const double along = to_centroid.Dot(as_vec(axis));
      out.key("axis").begin_object().key("origin").point(apex).key("dir").direction(axis).end_object();
      out.key("radius").number((to_centroid - as_vec(axis) * along).Magnitude());
      break;
    }
    case GeomAbs_Sphere: {
      const gp_Sphere sphere = adaptor.Sphere();
      out.key("axis").begin_object().key("origin").point(sphere.Position().Location()).key("dir").vec3(0, 0, 1).end_object();
      out.key("radius").number(sphere.Radius());
      break;
    }
    case GeomAbs_Torus: {
      const gp_Torus torus = adaptor.Torus();
      out.key("axis").begin_object().key("origin").point(torus.Position().Location());
      out.key("dir").direction(torus.Position().Direction()).end_object().key("radius").number(torus.MinorRadius());
      break;
    }
    default:
      break;
  }
  out.key("samples");
  write_interior_samples(out, face, adaptor, samples);
  out.end_object();
}

void write_point_normal(JsonWriter &out, const query::PointNormal &local) {
  out.begin_object().key("point").point(local.point).key("normal").direction(local.normal).end_object();
}

// Curvature sample at (u, v), signs relative to the outward normal (occtFaceSurface.ts surfaceSample).
void write_surface_sample(JsonWriter &out, const BRepAdaptor_Surface &adaptor, bool reversed, double u, double v) {
  BRepLProp_SLProps props(adaptor, u, v, 2, 1e-9);
  const gp_Pnt point = props.Value();
  const auto degenerate = [&](const gp_Vec &normal) {
    out.begin_object().key("u").number(u).key("v").number(v).key("point").point(point).key("normal").vector(normal);
    out.key("k1").number(0).key("k2").number(0).key("dir1").vec3(0, 0, 0).key("dir2").vec3(0, 0, 0);
    out.key("gaussian").number(0).key("mean").number(0).key("degenerate").boolean(true).end_object();
  };
  if (!props.IsNormalDefined() || !props.IsCurvatureDefined()) return degenerate(gp_Vec(0, 0, 0));
  const gp_Dir surface_normal = props.Normal();
  const gp_Dir normal = reversed ? surface_normal.Reversed() : surface_normal;
  const double k_max = props.MaxCurvature();
  const double k_min = props.MinCurvature();
  gp_Vec dir_max;
  gp_Vec dir_min;
  if (props.IsUmbilic()) {
    if (!props.IsTangentUDefined()) return degenerate(as_vec(normal));
    gp_Dir tangent;
    props.TangentU(tangent);
    dir_max = as_vec(tangent);
    dir_min = as_vec(normal).Crossed(dir_max);
  } else {
    gp_Dir max_direction;
    gp_Dir min_direction;
    props.CurvatureDirections(max_direction, min_direction);
    dir_max = as_vec(max_direction);
    dir_min = as_vec(min_direction);
  }
  const bool flip = kOccCurvatureSign * (reversed ? -1 : 1) < 0;
  const double k1 = flip ? -k_min : k_max;
  const double k2 = flip ? -k_max : k_min;
  out.begin_object().key("u").number(u).key("v").number(v).key("point").point(point).key("normal").direction(normal);
  out.key("k1").number(k1).key("k2").number(k2).key("dir1").vector(flip ? dir_min : dir_max).key("dir2").vector(flip ? dir_max : dir_min);
  out.key("gaussian").number(k1 * k2).key("mean").number((k1 + k2) / 2).key("degenerate").boolean(false).end_object();
}

struct EdgeUse {
  int edge;
  bool reversed;
};

// Wires of `face`, outer first, as edge uses in explorer order (occtFaceGraph.ts faceLoops).
std::vector<std::vector<EdgeUse>> face_loops(const TopoDS_Face &face, const TopTools_IndexedMapOfShape &edges) {
  const TopoDS_Wire outer = BRepTools::OuterWire(face);
  std::vector<std::vector<EdgeUse>> outer_loops;
  std::vector<std::vector<EdgeUse>> inner_loops;
  for (TopExp_Explorer wires(face, TopAbs_WIRE); wires.More(); wires.Next()) {
    std::vector<EdgeUse> uses;
    for (TopExp_Explorer explorer(wires.Current(), TopAbs_EDGE); explorer.More(); explorer.Next()) {
      const int edge = index_in(edges, explorer.Current());
      if (edge >= 0) uses.push_back({edge, query::is_reversed(explorer.Current())});
    }
    (wires.Current().IsSame(outer) ? outer_loops : inner_loops).push_back(uses);
  }
  outer_loops.insert(outer_loops.end(), inner_loops.begin(), inner_loops.end());
  return outer_loops;
}

const char *convexity_at(const TopoDS_Edge &edge, const TopoDS_Face &face_a, const TopoDS_Face &face_b, bool reversed_in_a) {
  if (BRep_Tool::Degenerated(edge)) return "unknown";
  const BRepAdaptor_Curve curve(edge);
  gp_Pnt mid;
  gp_Vec derivative;
  curve.D1((curve.FirstParameter() + curve.LastParameter()) / 2, mid, derivative);
  const double length = derivative.Magnitude();
  if (!(length > 0)) return "unknown";
  const gp_Vec tangent = derivative * (1 / length);
  std::optional<gp_Vec> normals[2];
  const TopoDS_Face *faces[2] = {&face_a, &face_b};
  for (int k = 0; k < 2; ++k) {
    const BRepAdaptor_Surface adaptor(*faces[k], Standard_True);
    const auto uv = query::uv_of_point(*faces[k], adaptor, mid);
    const auto local = query::point_and_normal(adaptor, query::is_reversed(*faces[k]), uv[0], uv[1]);
    if (!local) return "unknown";
    normals[k] = as_vec(local->normal);
  }
  const gp_Vec &n_a = *normals[0];
  const gp_Vec &n_b = *normals[1];
  if (n_a.Dot(n_b) > 0 && n_a.Crossed(n_b).Magnitude() < kSmoothAngle) return "smooth";
  const gp_Vec inward = n_a.Crossed(tangent * (reversed_in_a ? -1 : 1));
  const double side = inward.Dot(n_b);
  if (std::fabs(side) < 1e-9) return "unknown";
  return side < 0 ? "convex" : "concave";
}

}  // namespace

rust::String face_details_json(const Shape &shape, int32_t samples) {
  const TopTools_IndexedMapOfShape faces = distinct(shape.shape, TopAbs_FACE);
  JsonWriter out;
  out.begin_array();
  for (int f = 1; f <= faces.Extent(); ++f) write_face_detail(out, TopoDS::Face(faces(f)), f - 1, std::max(0, samples));
  out.end_array();
  return text_of(out);
}

rust::String face_contains_json(const Shape &shape, int32_t face, rust::Slice<const double> point, double tolerance) {
  const auto target = face_at(shape.shape, face);
  if (!target || point.size() != 3) return rust::String("null");
  const auto nearest = query::nearest_on(*target, gp_Pnt(point[0], point[1], point[2]));
  if (!nearest) return rust::String("null");
  return rust::String(nearest->distance <= tolerance ? "true" : "false");
}

rust::String face_geometry_json(const Shape &shape, int32_t face) {
  const auto target = face_at(shape.shape, face);
  if (!target) return rust::String("null");
  const BRepAdaptor_Surface adaptor(*target, Standard_True);
  const auto [u_min, u_max, v_min, v_max] = query::uv_range(adaptor);
  JsonWriter out;
  out.begin_object().key("surface");
  query::write_surface_params(out, adaptor);
  out.key("uvBounds").begin_array().begin_array().number(u_min).number(v_min).end_array();
  out.begin_array().number(u_max).number(v_max).end_array().end_array().end_object();
  return text_of(out);
}

rust::String project_on_face_json(const Shape &shape, int32_t face, rust::Slice<const double> points) {
  const auto target = face_at(shape.shape, face);
  if (!target) return rust::String("null");
  const BRepAdaptor_Surface adaptor(*target, Standard_True);
  JsonWriter out;
  out.begin_array();
  for (const gp_Pnt &point : points_of(points)) {
    const auto nearest = query::nearest_on(*target, point);
    if (!nearest) {
      out.null();
      continue;
    }
    const auto uv = query::uv_of_point(*target, adaptor, nearest->point);
    const auto local = query::point_and_normal(adaptor, query::is_reversed(*target), uv[0], uv[1]);
    if (!local) {
      out.null();
      continue;
    }
    out.begin_object().key("point").point(nearest->point).key("normal").direction(local->normal);
    out.key("uv").begin_array().number(uv[0]).number(uv[1]).end_array().key("distance").number(nearest->distance).end_object();
  }
  out.end_array();
  return text_of(out);
}

rust::String evaluate_face_json(const Shape &shape, int32_t face, rust::Slice<const double> uv) {
  const auto target = face_at(shape.shape, face);
  if (!target) return rust::String("null");
  const BRepAdaptor_Surface adaptor(*target, Standard_True);
  JsonWriter out;
  out.begin_array();
  for (const auto &[u, v] : pairs_of(uv)) {
    const auto local = query::point_and_normal(adaptor, query::is_reversed(*target), u, v);
    if (!local) return rust::String("null");
    write_point_normal(out, *local);
  }
  out.end_array();
  return text_of(out);
}

rust::String face_samples_json(const Shape &shape, int32_t face, rust::Slice<const double> uv, int32_t nu, int32_t nv) {
  const auto target = face_at(shape.shape, face);
  if (!target) return rust::String("null");
  const BRepAdaptor_Surface adaptor(*target, Standard_True);
  std::vector<std::array<double, 2>> list;
  if (nu == 0 && nv == 0) {
    list = pairs_of(uv);
    if (list.size() > static_cast<size_t>(kMaxGridPoints)) return rust::String("null");
  } else {
    if (nu < 1 || nv < 1 || static_cast<long long>(nu) * nv > kMaxGridPoints) return rust::String("null");
    const auto range = query::uv_range(adaptor);
    if (!query::all_finite(range)) return rust::String("null");
    const auto [u_min, u_max, v_min, v_max] = range;
    for (int i = 0; i < nu; ++i)
      for (int j = 0; j < nv; ++j) list.push_back({u_min + ((u_max - u_min) * (i + 0.5)) / nu, v_min + ((v_max - v_min) * (j + 0.5)) / nv});
  }
  JsonWriter out;
  out.begin_array();
  for (const auto &[u, v] : list) write_surface_sample(out, adaptor, query::is_reversed(*target), u, v);
  out.end_array();
  return text_of(out);
}

rust::String face_graph_json(const Shape &shape) {
  const TopTools_IndexedMapOfShape face_map = distinct(shape.shape, TopAbs_FACE);
  const TopTools_IndexedMapOfShape edge_map = distinct(shape.shape, TopAbs_EDGE);
  std::vector<TopoDS_Face> faces;
  for (int f = 1; f <= face_map.Extent(); ++f) faces.push_back(TopoDS::Face(face_map(f)));
  std::vector<std::vector<std::vector<EdgeUse>>> uses;
  for (const TopoDS_Face &face : faces) uses.push_back(face_loops(face, edge_map));
  JsonWriter out;
  out.begin_object().key("faces").begin_array();
  for (size_t f = 0; f < faces.size(); ++f) {
    const BRepAdaptor_Surface adaptor(faces[f], Standard_True);
    out.begin_object().key("index").integer(static_cast<long long>(f)).key("surface");
    query::write_surface_params(out, adaptor);
    out.key("reversed").boolean(query::is_reversed(faces[f])).key("area").number(query::face_metric(faces[f]).area);
    out.key("loops").begin_array();
    for (const auto &loop : uses[f]) {
      std::vector<int> seen;
      for (const EdgeUse &use : loop)
        if (std::find(seen.begin(), seen.end(), use.edge) == seen.end()) seen.push_back(use.edge);
      out.begin_array();
      for (int edge : seen) out.integer(edge);
      out.end_array();
    }
    const auto [u_min, u_max, v_min, v_max] = query::uv_range(adaptor);
    out.end_array().key("uvBounds").begin_array().number(u_min).number(u_max).number(v_min).number(v_max).end_array().end_object();
  }
  out.end_array();
  std::vector<std::vector<std::pair<int, bool>>> edge_uses(static_cast<size_t>(edge_map.Extent()));
  for (size_t f = 0; f < faces.size(); ++f)
    for (const auto &loop : uses[f])
      for (const EdgeUse &use : loop) edge_uses[static_cast<size_t>(use.edge)].push_back({static_cast<int>(f), use.reversed});
  std::vector<std::vector<int>> edge_faces;
  for (const auto &list : edge_uses) {
    std::set<int> unique;
    for (const auto &use : list) unique.insert(use.first);
    edge_faces.emplace_back(unique.begin(), unique.end());
  }
  out.key("edgeFaces").begin_array();
  for (const auto &list : edge_faces) {
    out.begin_array();
    for (int face : list) out.integer(face);
    out.end_array();
  }
  out.end_array().key("edgeConvexity").begin_array();
  for (size_t e = 0; e < edge_faces.size(); ++e) {
    const auto &list = edge_faces[e];
    if (list.size() == 1 && edge_uses[e].size() > 1) {
      out.string("smooth");
      continue;
    }
    if (list.size() != 2) {
      out.string("unknown");
      continue;
    }
    bool reversed = false;
    for (const auto &use : edge_uses[e]) {
      if (use.first == list[0]) {
        reversed = use.second;
        break;
      }
    }
    const TopoDS_Edge edge = TopoDS::Edge(edge_map(static_cast<int>(e) + 1));
    out.string(convexity_at(edge, faces[static_cast<size_t>(list[0])], faces[static_cast<size_t>(list[1])], reversed));
  }
  out.end_array().end_object();
  return text_of(out);
}

}  // namespace llull
