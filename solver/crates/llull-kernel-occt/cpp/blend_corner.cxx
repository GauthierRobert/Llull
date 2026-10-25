// Setback corners (BLD M3, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.5). Scope of this build: every edge that meets a setback vertex is a
// STRAIGHT convex edge between two PLANAR faces with a constant radius, every such edge is rounded, and each rounded edge ends at a setback vertex
// (the other end of an edge may be free: it ends on one flat face). The edge blends are the spandrel prisms of blend_profile.cxx, each stopping at
// the section plane `setback` away from its vertex; the sharp stubs and the flat end walls that leave at the vertex are then replaced by a patch
// (BRepOffsetAPI_MakeFilling, G1 to the blend ends and to the support faces along straight chords between the contact points), sewn into a solid.
// A reason that starts with "[CODE] " carries the stable BLD_* code it maps to.
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_MakeFilling.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_Surface.hxx>
#include <GProp_GProps.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace {

// Two points closer than this fraction of the solid's bounding-box diagonal are the same vertex (the same rule as geometry/blend/vertices.ts).
constexpr double kVertexFraction = 1e-7;
// The patch may leave its support surfaces by at most this angle (radians): the OCCT MakeFilling TolAng default of the SRF pack.
constexpr double kFillAngle = 0.01;
// The patch is a B-spline approximation of the plate surface: it leaves the edges it is sewn to by up to about 2e-6 x the diagonal at the fill settings
// below (MakeFilling's own G0Error does not see it), so a patch is accepted up to 5e-6 x the diagonal.
constexpr double kPatchGapFraction = 5e-6;
// The 3D tolerance of the fill is at most this fraction of the smallest setback of its corner.
constexpr double kFillSetbackFraction = 1e-4;
// MakeFilling settings: plate degree, constraint points per curve, iterations, and the B-spline approximation of the plate (maximum degree and
// segments; the OCCT defaults 8 / 9 leave the patch up to 6e-4 off the edges it is sewn to and 0.019 rad off tangent at the corners).
constexpr int kFillDegree = 3, kFillPoints = 15, kFillIterations = 2, kFillMaxDegree = 12, kFillSegments = 60;
// A setback must exceed the distance its blends reach by this relative margin (equal means the contact lines meet in one point).
constexpr double kMarginRelative = 1e-9;

constexpr const char *kUnsupported = "[BLD_CORNER_UNSUPPORTED] ";
constexpr const char *kTooShort = "[BLD_SETBACK_TOO_SHORT] ";
constexpr const char *kFailed = "[BLD_CORNER_FAILED] ";

struct Corner {
  gp_Pnt at;
  std::vector<std::pair<int, double>> setbacks;  // unique edge index of the source, distance
};

struct Wall {
  gp_Pnt point;   // where the sharp stub of an edge ends (the section plane meets the edge)
  gp_Vec stub;    // unit direction of the stub, away from the vertex
};

std::string number(double value) {
  std::ostringstream text;
  text.precision(6);
  text << value;
  return text.str();
}

std::string where(const gp_Pnt &point) { return "[" + number(point.X()) + ", " + number(point.Y()) + ", " + number(point.Z()) + "]"; }

bool same_point(const gp_Pnt &a, const gp_Pnt &b, double tolerance) { return a.Distance(b) <= tolerance; }

// Diagonal of the bounding box of the vertices of `shape`.
double diagonal_of(const TopoDS_Shape &shape) {
  gp_Pnt low(1e300, 1e300, 1e300), high(-1e300, -1e300, -1e300);
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);
  for (int v = 1; v <= vertices.Extent(); ++v) {
    const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vertices(v)));
    low = gp_Pnt(std::min(low.X(), p.X()), std::min(low.Y(), p.Y()), std::min(low.Z(), p.Z()));
    high = gp_Pnt(std::max(high.X(), p.X()), std::max(high.Y(), p.Y()), std::max(high.Z(), p.Z()));
  }
  return vertices.Extent() == 0 ? 0.0 : low.Distance(high);
}

bool listed(const TopTools_ListOfShape &list, const TopoDS_Shape &shape) {
  for (TopTools_ListIteratorOfListOfShape it(list); it.More(); it.Next())
    if (it.Value().IsSame(shape)) return true;
  return false;
}

std::string joined_names(std::vector<std::string> parts) {
  std::sort(parts.begin(), parts.end());
  parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
  std::string text;
  for (size_t i = 0; i < parts.size(); ++i) text += (i == 0 ? "" : ",") + parts[i];
  return text;
}

// The vertex of `shape` nearest to `at` within the vertex tolerance (null when none).
TopoDS_Vertex vertex_at(const TopoDS_Shape &shape, const gp_Pnt &at, double tolerance) {
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);
  TopoDS_Vertex best;
  double nearest = 1e300;
  for (int v = 1; v <= vertices.Extent(); ++v) {
    const double gap = BRep_Tool::Pnt(TopoDS::Vertex(vertices(v))).Distance(at);
    if (gap < nearest && same_point(BRep_Tool::Pnt(TopoDS::Vertex(vertices(v))), at, tolerance)) {
      nearest = gap;
      best = TopoDS::Vertex(vertices(v));
    }
  }
  return best;
}

// The unique indices of the non-degenerate edges meeting at `vertex`.
std::vector<int> edges_at(const TopTools_IndexedDataMapOfShapeListOfShape &vertex_edges, const TopTools_IndexedMapOfShape &edge_map,
                          const TopoDS_Vertex &vertex) {
  std::vector<int> found;
  for (TopTools_ListIteratorOfListOfShape it(vertex_edges.FindFromKey(vertex)); it.More(); it.Next()) {
    if (BRep_Tool::Degenerated(TopoDS::Edge(it.Value()))) continue;
    const int index = edge_map.FindIndex(it.Value()) - 1;
    if (index >= 0 && std::find(found.begin(), found.end(), index) == found.end()) found.push_back(index);
  }
  return found;
}

bool parse(rust::Slice<const double> edges, rust::Slice<const double> corners, std::map<int, double> &radius, std::vector<Corner> &list,
           std::string &why) {
  if (edges.empty() || edges.size() % 2 != 0) {
    why = std::string(kFailed) + "the setback blend parameters are malformed (edges)";
    return false;
  }
  for (size_t at = 0; at < edges.size(); at += 2) {
    if (!(edges[at + 1] > 0) || edges[at] < 0) {
      why = std::string(kFailed) + "the radius of every rounded edge must be > 0";
      return false;
    }
    radius[static_cast<int>(edges[at])] = edges[at + 1];
  }
  size_t at = 0;
  while (at < corners.size()) {
    if (at + 4 > corners.size()) {
      why = std::string(kFailed) + "the setback blend parameters are malformed (corners)";
      return false;
    }
    Corner corner;
    corner.at = gp_Pnt(corners[at], corners[at + 1], corners[at + 2]);
    const size_t count = static_cast<size_t>(corners[at + 3]);
    at += 4;
    if (count < 3 || at + 2 * count > corners.size()) {
      why = std::string(kFailed) + "the setback blend parameters are malformed (corner edges)";
      return false;
    }
    for (size_t k = 0; k < count; ++k) corner.setbacks.emplace_back(static_cast<int>(corners[at + 2 * k]), corners[at + 2 * k + 1]);
    at += 2 * count;
    list.push_back(std::move(corner));
  }
  if (list.empty()) {
    why = std::string(kFailed) + "the setback blend needs at least one corner";
    return false;
  }
  return true;
}

// What the build learns about the source before any geometry is made.
struct Plan {
  double tolerance = 1e-9;                          // two points closer than this are the same vertex
  std::map<int, EdgeFrame> frames;
  std::map<int, double> legs;                       // tangent distance of each rounded edge
  std::vector<TopoDS_Vertex> vertices;              // source vertex of each corner
  std::vector<std::map<int, gp_Vec>> stubs;         // per corner: unit direction away from the vertex of each incident edge
};

// Checks the corner `c` against the source and fills `plan`; false with the reason in `why`.
bool plan_corner(const TopoDS_Shape &shape, const TopTools_IndexedMapOfShape &edge_map, const TopTools_IndexedDataMapOfShapeListOfShape &vertex_edges,
                 const TopTools_IndexedDataMapOfShapeListOfShape &vertex_faces, const std::map<int, double> &radius, const Corner &corner,
                 Plan &plan, std::string &why) {
  const TopoDS_Vertex vertex = vertex_at(shape, corner.at, plan.tolerance);
  if (vertex.IsNull()) {
    why = std::string(kFailed) + "the solid has no vertex at " + where(corner.at);
    return false;
  }
  plan.vertices.push_back(vertex);
  const std::vector<int> incident = edges_at(vertex_edges, edge_map, vertex);
  if (incident.size() < 3) {
    why = std::string(kUnsupported) + "only " + std::to_string(incident.size()) + " edge(s) meet at " + where(corner.at) +
          ": a setback corner needs 3 or more";
    return false;
  }
  std::map<int, gp_Vec> stub;
  std::map<int, double> distance;
  for (const int edge : incident) {
    if (radius.find(edge) == radius.end()) {
      why = std::string(kUnsupported) + "edge " + std::to_string(edge) + " meets the setback vertex " + where(corner.at) +
            " but is not rounded: a setback corner rounds every edge that meets there";
      return false;
    }
    const auto found = std::find_if(corner.setbacks.begin(), corner.setbacks.end(), [&](const auto &entry) { return entry.first == edge; });
    if (found == corner.setbacks.end() || !(found->second > 0)) {
      why = std::string(kFailed) + "no setback distance for edge " + std::to_string(edge) + " at " + where(corner.at);
      return false;
    }
    distance[edge] = found->second;
    const EdgeFrame &frame = plan.frames.at(edge);
    if (same_point(frame.start, corner.at, plan.tolerance)) stub[edge] = frame.direction;
    else if (same_point(frame.end, corner.at, plan.tolerance)) stub[edge] = frame.direction.Reversed();
    else {
      why = std::string(kFailed) + "edge " + std::to_string(edge) + " does not end at " + where(corner.at);
      return false;
    }
  }
  // Each face at the vertex is bounded there by exactly two rounded edges i, j whose contact lines (distance leg_i, leg_j from the edges, inside the
  // face) meet in one point; the setback of an edge must end beyond it, else the chord of the patch across the face has no length.
  std::map<int, double> required;
  for (const int edge : incident) required[edge] = plan.legs.at(edge);
  for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) {
    std::vector<int> on_face;
    for (const int edge : incident) {
      const EdgeFrame &frame = plan.frames.at(edge);
      if (frame.faces[0].IsSame(it.Value()) || frame.faces[1].IsSame(it.Value())) on_face.push_back(edge);
    }
    if (on_face.size() != 2) {
      why = std::string(kUnsupported) + "a face meets the vertex " + where(corner.at) + " with " + std::to_string(on_face.size()) +
            " rounded edges (2 expected)";
      return false;
    }
    const int i = on_face[0], j = on_face[1];
    const double cosine = stub[i].Dot(stub[j]);
    const double sine = stub[i].Crossed(stub[j]).Magnitude();
    if (sine < 1e-6) {
      why = std::string(kUnsupported) + "two edges leave " + where(corner.at) + " along one line";
      return false;
    }
    required[i] = std::max(required[i], (plan.legs.at(j) + plan.legs.at(i) * cosine) / sine);
    required[j] = std::max(required[j], (plan.legs.at(i) + plan.legs.at(j) * cosine) / sine);
  }
  for (const int edge : incident)
    if (distance[edge] <= required[edge] * (1 + kMarginRelative)) {
      why = std::string(kTooShort) + "setback " + number(distance[edge]) + " on edge " + std::to_string(edge) + " at " + where(corner.at) +
            " must exceed " + number(required[edge]) + " (the distance along the edge its neighbours' blends reach)";
      return false;
    }
  plan.stubs.push_back(stub);
  return true;
}


// How far past the free vertex of a rounded edge the prism must run to leave the solid through the one face that closes it there (0 when that
// face is square to the edge); false with the reason in `why` when the end is not a plain 3-face vertex.
bool free_extension(const TopoDS_Shape &shape, double tolerance, const TopTools_IndexedDataMapOfShapeListOfShape &vertex_faces,
                    const EdgeFrame &frame, bool at_end, double leg, double &extension, std::string &why) {
  const gp_Pnt point = at_end ? frame.end : frame.start;
  const TopoDS_Vertex vertex = vertex_at(shape, point, tolerance);
  if (vertex.IsNull()) {
    why = std::string(kFailed) + "the free end " + where(point) + " of a rounded edge is not a vertex";
    return false;
  }
  TopTools_IndexedMapOfShape around;
  for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) around.Add(it.Value());
  // The faces other than the two of the edge must be flat and coplanar (one face, or a face the sewing left in several pieces).
  TopoDS_Face closing;
  bool plain = true;
  for (int f = 1; f <= around.Extent(); ++f) {
    if (around(f).IsSame(frame.faces[0]) || around(f).IsSame(frame.faces[1])) continue;
    const TopoDS_Face face = TopoDS::Face(around(f));
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) plain = false;
    else if (closing.IsNull()) closing = face;
    else plain = plain && outward_normal(shape, face).Dot(outward_normal(shape, closing)) > 1 - 1e-9;
  }
  if (!plain || closing.IsNull()) {
    why = std::string(kUnsupported) + "a rounded edge ends at " + where(point) + ", which has no setback corner and is not a vertex closed by one flat face";
    return false;
  }
  const gp_Vec outward = at_end ? frame.direction : frame.direction.Reversed();
  const gp_Vec normal = outward_normal(shape, closing);
  const double slope = normal.Dot(outward);
  if (slope < 0.1) {
    why = std::string(kUnsupported) + "the face closing the rounded edge at " + where(point) + " is too oblique to the edge";
    return false;
  }
  extension = 0;
  if (slope > 1 - 1e-9) return true;
  const gp_Pnt corners[3] = {point, point.Translated(frame.inward[0] * leg), point.Translated(frame.inward[1] * leg)};
  for (const gp_Pnt &corner : corners) extension = std::max(extension, -normal.Dot(gp_Vec(point, corner)) / slope);
  extension += 0.25 * leg;
  return true;
}

// The flat wall that the prism of the edge with sharp stub `wall` leaves in `shape` (planar, square to the stub, through its end); null if none.
TopoDS_Face wall_in(const TopoDS_Shape &shape, const Wall &wall, double tolerance) {
  TopTools_IndexedMapOfShape faces = query::distinct(shape, TopAbs_FACE);
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) continue;
    const gp_Vec normal = normal_of(face);
    const gp_Pnt origin = BRepAdaptor_Surface(face, Standard_True).Plane().Location();
    // `inside` projects the point onto the plane, so the plane itself must be the one through the point.
    if (std::fabs(normal.Dot(wall.stub)) > 1 - 1e-9 && std::fabs(normal.Dot(gp_Vec(origin, wall.point))) < tolerance && inside(face, wall.point))
      return face;
  }
  return TopoDS_Face();
}

TopoDS_Edge arc_of(const TopoDS_Face &wall) {
  for (TopExp_Explorer it(wall, TopAbs_EDGE); it.More(); it.Next())
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() != GeomAbs_Line) return TopoDS::Edge(it.Current());
  return TopoDS_Edge();
}

// The edges of `pending` chained into one closed loop, or empty when they do not form one.
std::vector<TopoDS_Edge> loop_of(std::vector<TopoDS_Edge> pending) {
  std::vector<TopoDS_Edge> loop;
  if (pending.empty()) return loop;
  loop.push_back(pending.back());
  pending.pop_back();
  TopoDS_Vertex tail = TopExp::LastVertex(loop.back(), Standard_True);
  while (!pending.empty()) {
    bool extended = false;
    for (size_t k = 0; k < pending.size() && !extended; ++k) {
      const TopoDS_Vertex first = TopExp::FirstVertex(pending[k], Standard_True), last = TopExp::LastVertex(pending[k], Standard_True);
      if (first.IsSame(tail) || last.IsSame(tail)) {
        tail = first.IsSame(tail) ? last : first;
        loop.push_back(pending[k]);
        pending.erase(pending.begin() + static_cast<long>(k));
        extended = true;
      }
    }
    if (!extended) return {};
  }
  return loop;
}

// Largest distance between the 3D curve of `edge` and the surface of `face` at the pcurve of the edge, over 21 samples; false when the edge has no
// pcurve on the face or its curves do not share a parameter (the distance would mean nothing).
bool edge_gap(const TopoDS_Edge &edge, const TopoDS_Face &face, double &worst) {
  double first = 0, last = 0;
  const Handle(Geom2d_Curve) pcurve = BRep_Tool::CurveOnSurface(edge, face, first, last);
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  if (pcurve.IsNull() || surface.IsNull() || !BRep_Tool::SameParameter(edge)) return false;
  const BRepAdaptor_Curve curve(edge);
  worst = 0;
  for (int k = 0; k <= 20; ++k) {
    const double t = first + (last - first) * k / 20.0;
    const gp_Pnt2d uv = pcurve->Value(t);
    worst = std::max(worst, surface->Value(uv.X(), uv.Y()).Distance(curve.Value(t)));
  }
  return true;
}

double volume_of(const TopoDS_Shape &shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

std::unique_ptr<Shape> build_setback(const Shape &source, rust::Slice<const double> edge_raw, rust::Slice<const double> corner_raw,
                                     std::string &why) {
  std::map<int, double> radius;
  std::vector<Corner> corners;
  if (!parse(edge_raw, corner_raw, radius, corners, why)) return nullptr;
  const TopoDS_Shape &shape = source.shape;
  const double diagonal = diagonal_of(shape);
  const double vertex_tolerance = kVertexFraction * std::max(diagonal, 1e-9);
  // The sewing tolerance and the gap every patch edge must stay within: the check_blends default (1e-6 x the diagonal).
  const double sewing_tolerance = std::max(1e-6 * diagonal, 1e-12);
  // How far a corner patch may leave the edges it is sewn to (check_blends judges corner contacts against the same fraction).
  const double patch_gap_limit = kPatchGapFraction * diagonal;
  const TopTools_IndexedMapOfShape edge_map = query::distinct(shape, TopAbs_EDGE);
  TopTools_IndexedDataMapOfShapeListOfShape vertex_edges, vertex_faces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges);
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);

  Plan plan;
  plan.tolerance = vertex_tolerance;
  for (const auto &[index, size] : radius) {
    EdgeFrame frame;
    if (!edge_frame(shape, index, "setback blends", frame, why)) {
      why = std::string(kUnsupported) + why;
      return nullptr;
    }
    if (!frame.convex) {
      why = std::string(kUnsupported) + "edge " + std::to_string(index) + " is concave: setback corners round convex edges";
      return nullptr;
    }
    plan.frames[index] = frame;
    plan.legs[index] = size * std::tan(frame.fold / 2);
  }
  for (const Corner &corner : corners)
    if (!plan_corner(shape, edge_map, vertex_edges, vertex_faces, radius, corner, plan, why)) return nullptr;

  // Edge blends: one prism per rounded edge, from the section plane at its setback end(s) to the vertex plane (or past a free end).
  const naming::Named input = naming::named(source);
  const std::vector<std::string> edge_names = naming::edge_names(shape, input.names);
  const auto corner_at = [&](const gp_Pnt &point) {
    for (size_t c = 0; c < corners.size(); ++c)
      if (same_point(corners[c].at, point, vertex_tolerance)) return static_cast<int>(c);
    return -1;
  };
  // The setback of `edge` at `corner`; plan_corner guarantees an entry for every edge meeting a corner, a missing one is -1.
  const auto setback_of = [&](int corner, int edge) {
    const auto &list = corners[static_cast<size_t>(corner)].setbacks;
    const auto found = std::find_if(list.begin(), list.end(), [&](const auto &entry) { return entry.first == edge; });
    return found == list.end() ? -1.0 : found->second;
  };
  std::vector<Tool> tools;
  for (const auto &[index, size] : radius) {
    const EdgeFrame &frame = plan.frames.at(index);
    const double leg = plan.legs.at(index);
    const int start_corner = corner_at(frame.start), end_corner = corner_at(frame.end);
    const std::string label = "edge " + std::to_string(index);
    if (start_corner < 0 && end_corner < 0) {
      why = std::string(kUnsupported) + label + " does not end at a setback vertex: every rounded edge must meet one in this build";
      return nullptr;
    }
    double lo = 0, hi = frame.length;
    for (const bool at_end : {false, true}) {
      const int corner = at_end ? end_corner : start_corner;
      if (corner >= 0) {
        const double distance = setback_of(corner, index);
        if (!(distance > 0)) {
          why = std::string(kFailed) + "no setback distance for " + label + " at " + where(corners[static_cast<size_t>(corner)].at);
          return nullptr;
        }
        (at_end ? hi : lo) += (at_end ? -1 : 1) * distance;
        continue;
      }
      const gp_Pnt free_point = at_end ? frame.end : frame.start;
      const TopoDS_Vertex vertex = vertex_at(shape, free_point, vertex_tolerance);
      for (const int other : edges_at(vertex_edges, edge_map, vertex))
        if (other != index && radius.find(other) != radius.end()) {
          why = std::string(kUnsupported) + "edges " + std::to_string(index) + " and " + std::to_string(other) + " meet at " + where(free_point) +
                ", which has no setback corner";
          return nullptr;
        }
      double extension = 0;
      if (!free_extension(shape, vertex_tolerance, vertex_faces, frame, at_end, leg, extension, why)) return nullptr;
      (at_end ? hi : lo) += (at_end ? 1 : -1) * extension;
    }
    if (!(hi - lo > 1e-6 * frame.length)) {
      why = std::string(kFailed) + "the setbacks at both ends of " + label + " leave no length to round (edge length " + number(frame.length) + ")";
      return nullptr;
    }
    const auto leg_ok = [&](double along) {
      const gp_Pnt base = frame.start.Translated(frame.direction * along);
      return inside(frame.faces[0], base.Translated(frame.inward[0] * leg)) && inside(frame.faces[1], base.Translated(frame.inward[1] * leg));
    };
    if ((start_corner >= 0 && !leg_ok(lo)) || (end_corner >= 0 && !leg_ok(hi))) {
      why = std::string(kUnsupported) + "the round of " + label + " (tangent distance " + number(leg) + ") reaches past its faces at the setback section";
      return nullptr;
    }
    const gp_Pnt from = frame.start.Translated(frame.direction * lo), to = frame.start.Translated(frame.direction * hi);
    Tool tool;
    if (!spandrel_tool(from, to, from.Translated(frame.inward[0] * leg), from.Translated(frame.inward[1] * leg), 2, 0.0, kPi - frame.fold,
                       "blend(" + edge_names[static_cast<size_t>(index)] + ")", tool, why))
      return nullptr;
    tool.convex = true;
    tools.push_back(std::move(tool));
  }
  naming::Named current = input;
  const double volume_before = volume_of(shape);
  if (!apply_tools(current, tools, why)) return nullptr;

  // Corners: chords across the support faces between the contact points at the wall arcs, then the patch over the hole they bound.
  std::vector<std::vector<Wall>> walls(corners.size());
  for (size_t c = 0; c < corners.size(); ++c)
    for (const auto &[edge, stub] : plan.stubs[c])
      walls[c].push_back({corners[c].at.Translated(stub * std::max(0.0, setback_of(static_cast<int>(c), edge))), stub});
  TopTools_IndexedDataMapOfShapeListOfShape cut_vertex_faces;
  TopExp::MapShapesAndAncestors(current.shape, TopAbs_VERTEX, TopAbs_FACE, cut_vertex_faces);
  TopTools_ListOfShape chords;
  for (size_t c = 0; c < corners.size(); ++c) {
    std::vector<TopoDS_Vertex> ends;
    for (const Wall &wall : walls[c]) {
      const TopoDS_Edge arc = arc_of(wall_in(current.shape, wall, vertex_tolerance));
      if (arc.IsNull()) {
        why = std::string(kFailed) + "the blend end at " + where(wall.point) + " was not found after the cut";
        return nullptr;
      }
      TopoDS_Vertex a, b;
      TopExp::Vertices(arc, a, b);
      ends.push_back(a);
      ends.push_back(b);
    }
    const TopoDS_Vertex apex = vertex_at(current.shape, corners[c].at, vertex_tolerance);
    if (apex.IsNull()) {
      why = std::string(kFailed) + "the vertex " + where(corners[c].at) + " is gone after the cut";
      return nullptr;
    }
    for (TopTools_ListIteratorOfListOfShape it(cut_vertex_faces.FindFromKey(apex)); it.More(); it.Next()) {
      std::vector<TopoDS_Vertex> on_face;
      for (const TopoDS_Vertex &end : ends)
        if (listed(cut_vertex_faces.FindFromKey(end), it.Value())) on_face.push_back(end);
      if (on_face.size() != 2) {
        why = std::string(kFailed) + "a face at " + where(corners[c].at) + " touches " + std::to_string(on_face.size()) + " blend ends (2 expected)";
        return nullptr;
      }
      BRepBuilderAPI_MakeEdge chord(on_face[0], on_face[1]);
      if (!chord.IsDone()) {
        why = std::string(kFailed) + "the chord across a face at " + where(corners[c].at) + " could not be made";
        return nullptr;
      }
      chords.Append(chord.Edge());
    }
  }
  BRepAlgoAPI_Splitter splitter;
  TopTools_ListOfShape arguments;
  arguments.Append(current.shape);
  splitter.SetArguments(arguments);
  splitter.SetTools(chords);
  splitter.Build();
  if (!splitter.IsDone() || splitter.HasErrors()) {
    why = std::string(kFailed) + "the support faces could not be split along the corner chords";
    return nullptr;
  }
  const TopoDS_Shape split = splitter.Shape();
  const std::vector<naming::Named> inputs{current};
  const std::vector<std::string> split_names = naming::inherit(split, inputs, naming::history_of(inputs, splitter), "boolean");
  TopTools_IndexedMapOfShape split_faces = query::distinct(split, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape split_vertex_faces, split_edge_faces;
  TopExp::MapShapesAndAncestors(split, TopAbs_VERTEX, TopAbs_FACE, split_vertex_faces);
  TopExp::MapShapesAndAncestors(split, TopAbs_EDGE, TopAbs_FACE, split_edge_faces);

  TopTools_IndexedMapOfShape dropped;
  std::vector<TopoDS_Face> patches;
  std::vector<std::string> patch_names;
  for (size_t c = 0; c < corners.size(); ++c) {
    TopTools_IndexedMapOfShape removed;
    const TopoDS_Vertex apex = vertex_at(split, corners[c].at, vertex_tolerance);
    if (apex.IsNull()) {
      why = std::string(kFailed) + "the vertex " + where(corners[c].at) + " is gone after the split";
      return nullptr;
    }
    for (TopTools_ListIteratorOfListOfShape it(split_vertex_faces.FindFromKey(apex)); it.More(); it.Next()) removed.Add(it.Value());
    for (const Wall &wall : walls[c]) {
      const TopoDS_Face face = wall_in(split, wall, vertex_tolerance);
      if (!face.IsNull()) removed.Add(face);
    }
    std::vector<TopoDS_Edge> boundary;
    std::vector<TopoDS_Face> supports;
    TopTools_IndexedMapOfShape seen;
    for (int f = 1; f <= removed.Extent(); ++f)
      for (TopExp_Explorer it(removed(f), TopAbs_EDGE); it.More(); it.Next()) {
        if (!seen.Add(it.Current())) continue;
        for (TopTools_ListIteratorOfListOfShape owner(split_edge_faces.FindFromKey(it.Current())); owner.More(); owner.Next())
          if (removed.FindIndex(owner.Value()) == 0) {
            boundary.push_back(TopoDS::Edge(it.Current()));
            supports.push_back(TopoDS::Face(owner.Value()));
          }
      }
    const size_t expected = 2 * plan.stubs[c].size();
    const std::vector<TopoDS_Edge> loop = boundary.size() == expected ? loop_of(boundary) : std::vector<TopoDS_Edge>();
    if (loop.size() != expected) {
      why = std::string(kFailed) + "the hole at " + where(corners[c].at) + " is bounded by " + std::to_string(boundary.size()) +
            " edge(s) that do not close one loop (" + std::to_string(expected) + " expected)";
      return nullptr;
    }
    // Both tolerances follow the corner: the 3D one is the sewing tolerance but never more than 1e-4 x the smallest setback, the
    // parametric one a fraction of the setback (a fixed value made the fill of a large part slow and a small corner on a large part coarse).
    double smallest = 1e300;
    for (const auto &entry : corners[c].setbacks) smallest = std::min(smallest, entry.second);
    const double fill_tolerance_3d = std::min(sewing_tolerance, kFillSetbackFraction * smallest);
    const double fill_tolerance_2d = 1e-5 * smallest / 2;
    BRepOffsetAPI_MakeFilling filling(kFillDegree, kFillPoints, kFillIterations, Standard_False, fill_tolerance_2d, fill_tolerance_3d, kFillAngle, 0.1, kFillMaxDegree, kFillSegments);
    for (const TopoDS_Edge &edge : loop) {
      const size_t at = static_cast<size_t>(std::find_if(boundary.begin(), boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); }) -
                                            boundary.begin());
      filling.Add(edge, supports[at], GeomAbs_G1);
    }
    filling.Build();
    if (!filling.IsDone()) {
      why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " could not be filled";
      return nullptr;
    }
    TopoDS_Face patch = TopoDS::Face(filling.Shape());
    double gap = 0;
    for (TopExp_Explorer it(patch, TopAbs_EDGE); it.More(); it.Next()) {
      double edge_worst = 0;
      if (!edge_gap(TopoDS::Edge(it.Current()), patch, edge_worst)) {
        why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " has an edge without a shared parameter on its surface";
        return nullptr;
      }
      gap = std::max(gap, edge_worst);
    }
    if (gap > patch_gap_limit) {
      why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " misses the blend ends by " + number(gap) + " (limit " +
            number(patch_gap_limit) + ")";
      return nullptr;
    }
    if (filling.G1Error() > kFillAngle) {
      why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " leaves its supports by " + number(filling.G1Error()) +
            " rad (limit " + number(kFillAngle) + ")";
      return nullptr;
    }
    patches.push_back(patch);
    std::vector<std::string> around;
    for (const int edge : edges_at(vertex_edges, edge_map, plan.vertices[c])) around.push_back(edge_names[static_cast<size_t>(edge)]);
    patch_names.push_back("blend(v:" + joined_names(around) + ")");
    for (int f = 1; f <= removed.Extent(); ++f) dropped.Add(removed(f));
  }

  // Shell: every face that stays plus the patches, sewn.
  BRepBuilderAPI_Sewing sewing(sewing_tolerance);
  std::vector<TopoDS_Face> members;
  std::vector<std::string> member_names;
  for (int f = 1; f <= split_faces.Extent(); ++f) {
    if (dropped.FindIndex(split_faces(f)) != 0) continue;
    members.push_back(TopoDS::Face(split_faces(f)));
    member_names.push_back(static_cast<size_t>(f) <= split_names.size() ? split_names[static_cast<size_t>(f - 1)] : std::string());
  }
  for (size_t p = 0; p < patches.size(); ++p) {
    members.push_back(patches[p]);
    member_names.push_back(patch_names[p]);
  }
  for (const TopoDS_Face &face : members) sewing.Add(face);
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  TopoDS_Shell shell;
  for (TopExp_Explorer it(sewn, TopAbs_SHELL); it.More() && shell.IsNull(); it.Next()) shell = TopoDS::Shell(it.Current());
  if (shell.IsNull() && sewn.ShapeType() == TopAbs_SHELL) shell = TopoDS::Shell(sewn);
  if (shell.IsNull() || sewing.NbFreeEdges() > 0) {
    why = std::string(kFailed) + "the corner patches do not close the solid (" + std::to_string(sewing.NbFreeEdges()) + " free edge(s) after sewing)";
    return nullptr;
  }
  BRepBuilderAPI_MakeSolid maker(shell);
  TopoDS_Solid solid = maker.Solid();
  BRepLib::OrientClosedSolid(solid);
  if (solid.IsNull() || !BRepCheck_Analyzer(solid, Standard_True).IsValid()) {
    why = std::string(kFailed) + "the blended solid fails the BRepCheck validity analysis";
    return nullptr;
  }
  const double volume_after = volume_of(solid);
  if (!(volume_after > 0) || !(volume_after < volume_before)) {
    why = std::string(kFailed) + "the corner patches left a solid of volume " + number(volume_after) + " (source " + number(volume_before) + ")";
    return nullptr;
  }
  const TopTools_IndexedMapOfShape final_faces = query::distinct(solid, TopAbs_FACE);
  std::vector<std::string> names(static_cast<size_t>(final_faces.Extent()));
  for (size_t m = 0; m < members.size(); ++m) {
    const TopoDS_Shape image = sewing.IsModified(members[m]) ? sewing.Modified(members[m]) : members[m];
    const int index = final_faces.FindIndex(image);
    if (index > 0) names[static_cast<size_t>(index - 1)] = member_names[m];
  }
  return naming::wrap_named(solid, names);
}

}  // namespace

std::unique_ptr<Shape> fillet_setback(const Shape &shape, rust::Slice<const double> edges, rust::Slice<const double> corners) {
  std::string why;
  try {
    return build_setback(shape, edges, corners, why);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String setback_reason(const Shape &shape, rust::Slice<const double> edges, rust::Slice<const double> corners) {
  std::string why;
  std::unique_ptr<Shape> built;
  try {
    built = build_setback(shape, edges, corners, why);
  } catch (const Standard_Failure &error) {
    why = std::string(kFailed) + "OCCT failed: " + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string(kFailed) + "the setback corner blend failed" : why));
}

}  // namespace llull
