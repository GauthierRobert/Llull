// Variable chamfer (BLD M5, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.7, §13.14 and §13.24): OCCT's MakeChamfer takes constant distances, so a
// chamfer whose legs run linearly from `first` at the start of an edge to `last` at its end is the boolean of the source with a loft of the section
// triangles (corner, point at the first leg on one face, point at the second leg on the other face). The legs are measured on each face from the edge,
// in the plane perpendicular to it, and may differ (asymmetric: the leg on the face named by `faces` is the first one).
// - A straight edge between two planar faces: the ruled loft of the two end triangles; the lateral face is the bilinear patch whose cross-section at
//   every station is the straight chamfer section, so the removed volume of a right-angle edge is exactly 1/2 integral d1(s) d2(s) ds.
// - Any other edge (an arc, a B-spline, a generator line between a plane and a cylinder): a smooth loft through the sections at equal arc-length stations.
//   A leg is the chord of length d in the plane perpendicular to the edge (found by projecting a tangent-plane guess onto the face and rescaling to d until
//   it is on the face to 1e-9 d), so what check_blends measures is what was asked. Each section is the parallelogram a' b' b'+O a'+O: the chamfer line a-b
//   extended along itself by a tenth of its length at both ends (the ends lie outside the solid for a convex edge, inside it for a concave one) and offset
//   past the corner by its height plus the same margin, so the tool shares no face with the solid and cannot reach a support the legs do not.
// CUT for a convex edge, FUSE for a concave one (blend_tool.hxx `apply_tools`).
// Chosen edges may share a vertex when all are convex or all concave: the tools overlap there and the boolean leaves the chamfer faces meeting along the mitre
// lines of their surfaces, a point (three planes) or a line, so the corner needs no patch and is G0 by construction (13.25).
// Scope: flat square ends, an edge that is not closed.
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepGProp.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_UniformAbscissa.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomLProp_SLProps.hxx>
#include <Geom_Surface.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_MapOfShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace {

// Stations of a curved edge's loft (equal arc length): the cubic interpolation of a circular arc over 64 intervals is within 1e-7 of its radius.
constexpr int kStations = 65;
// Two directions closer than this to perpendicular / parallel are a tangent or a degenerate edge.
constexpr double kDegenerate = 1e-6;

// The legs of one edge: `start[k]` .. `end[k]` on the face k of the edge's frame (linear in the arc length between).
struct Legs {
  double start[2];
  double end[2];
  double at(int k, double s) const { return start[k] + (end[k] - start[k]) * s; }
  double smallest() const { return std::min(std::min(start[0], end[0]), std::min(start[1], end[1])); }
};

// The triangle wire corner -> a -> b -> corner.
bool triangle(const gp_Pnt &corner, const gp_Pnt &a, const gp_Pnt &b, TopoDS_Wire &wire_out, std::string &why) {
  BRepBuilderAPI_MakeEdge one(corner, a), two(a, b), three(b, corner);
  if (!one.IsDone() || !two.IsDone() || !three.IsDone()) {
    why = "the chamfer section could not be built";
    return false;
  }
  BRepBuilderAPI_MakeWire wire;
  wire.Add(one.Edge());
  wire.Add(two.Edge());
  wire.Add(three.Edge());
  if (!wire.IsDone()) {
    why = "the chamfer section does not close";
    return false;
  }
  wire_out = wire.Wire();
  return true;
}

double volume_of(const TopoDS_Shape &shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

// Names the faces of the loft's solid and gives the face generated from the edge a-b of `section` the chamfer name; false when there is none.
bool name_tool(BRepOffsetAPI_ThruSections &loft, const TopoDS_Wire &section, const gp_Pnt &a, const gp_Pnt &b, const std::string &chamfer_name, Tool &tool,
               std::string &why) {
  tool.shape = loft.Shape();
  const TopTools_IndexedMapOfShape tool_faces = query::distinct(tool.shape, TopAbs_FACE);
  tool.names.assign(static_cast<size_t>(tool_faces.Extent()), "");
  for (int f = 0; f < tool_faces.Extent(); ++f) tool.names[static_cast<size_t>(f)] = "tool." + std::to_string(f);
  for (TopExp_Explorer it(section, TopAbs_EDGE); it.More(); it.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(it.Current());
    const gp_Pnt p = BRep_Tool::Pnt(TopExp::FirstVertex(edge, Standard_True)), q = BRep_Tool::Pnt(TopExp::LastVertex(edge, Standard_True));
    const bool chamfer_edge = (p.Distance(a) < 1e-9 && q.Distance(b) < 1e-9) || (q.Distance(a) < 1e-9 && p.Distance(b) < 1e-9);
    if (!chamfer_edge) continue;
    const int face = tool_faces.FindIndex(loft.GeneratedFace(edge));
    if (face > 0) {
      tool.names[static_cast<size_t>(face - 1)] = chamfer_name;
      return true;
    }
  }
  why = "the chamfer face was not generated";
  return false;
}

// The side (index into the faces of the edge) that carries the first leg: `leg1` is the unique face index named by the caller (-1: symmetric legs).
bool first_leg_side(const TopoDS_Shape &shape, int leg1, const TopoDS_Face &face0, const TopoDS_Face &face1, int label, int &side, std::string &why) {
  side = 0;
  if (leg1 < 0) return true;
  const TopTools_IndexedMapOfShape faces = query::distinct(shape, TopAbs_FACE);
  if (leg1 >= faces.Extent()) {
    why = "face index out of range";
    return false;
  }
  const TopoDS_Shape &named = faces(leg1 + 1);
  if (named.IsSame(face0)) side = 0;
  else if (named.IsSame(face1)) side = 1;
  else {
    why = "face " + std::to_string(leg1) + " is not one of the two faces of edge " + std::to_string(label);
    return false;
  }
  return true;
}

// The legs of an edge from the caller's numbers: `given` = first leg start, end, second leg start, end; the first leg is on face `side`.
Legs legs_of(const double given[4], int side) {
  Legs legs;
  legs.start[side] = given[0];
  legs.end[side] = given[1];
  legs.start[1 - side] = given[2];
  legs.end[1 - side] = given[3];
  return legs;
}

// The chamfer tool of one straight edge between planar faces.
bool make_straight_tool(const TopoDS_Shape &shape, const std::vector<std::string> &edge_names, int index, int leg1, const double given[4], Tool &tool,
                        std::string &why) {
  EdgeFrame frame;
  if (!edge_frame(shape, index, "variable chamfers", frame, why)) return false;
  const std::string label = "edge " + std::to_string(index);
  if (!ends_square(shape, frame, "variable chamfers", why)) {
    why = label + ": " + why;
    return false;
  }
  int side = 0;
  if (!first_leg_side(shape, leg1, frame.faces[0], frame.faces[1], index, side, why)) return false;
  const Legs legs = legs_of(given, side);
  const gp_Pnt a_from = frame.start.Translated(frame.inward[0] * legs.start[0]), b_from = frame.start.Translated(frame.inward[1] * legs.start[1]);
  const gp_Pnt a_to = frame.end.Translated(frame.inward[0] * legs.end[0]), b_to = frame.end.Translated(frame.inward[1] * legs.end[1]);
  for (const double s : {0.0, 0.25, 0.5, 0.75, 1.0}) {
    const gp_Vec along = frame.direction * (s * frame.length);
    if (!inside(frame.faces[0], frame.start.Translated(frame.inward[0] * legs.at(0, s)).Translated(along)) ||
        !inside(frame.faces[1], frame.start.Translated(frame.inward[1] * legs.at(1, s)).Translated(along))) {
      why = "a leg of " + std::to_string(std::max(legs.at(0, s), legs.at(1, s))) + " reaches past the faces of " + label + "; use smaller distances";
      return false;
    }
  }
  TopoDS_Wire from, to;
  if (!triangle(frame.start, a_from, b_from, from, why) || !triangle(frame.end, a_to, b_to, to, why)) return false;
  BRepOffsetAPI_ThruSections loft(Standard_True, Standard_True);
  loft.AddWire(from);
  loft.AddWire(to);
  loft.Build();
  if (!loft.IsDone()) {
    why = "the chamfer tool of " + label + " could not be lofted";
    return false;
  }
  tool.convex = frame.convex;
  return name_tool(loft, from, a_from, b_from, "chamfer(" + edge_names[static_cast<size_t>(index)] + ")", tool, why);
}

// The outward unit normal of `face` at the point of it nearest to `point`; false when the surface has none there.
bool face_normal(const TopoDS_Face &face, const gp_Pnt &point, gp_Vec &normal) {
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  GeomAPI_ProjectPointOnSurf projection(point, surface);
  if (projection.NbPoints() < 1) return false;
  double u = 0, v = 0;
  projection.LowerDistanceParameters(u, v);
  GeomLProp_SLProps props(surface, u, v, 1, 1e-9);
  if (!props.IsNormalDefined()) return false;
  normal = gp_Vec(props.Normal());
  if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
  return true;
}

// Whether both ends of the curved edge lie on a planar face perpendicular to the tangent there (the other faces at each end vertex).
bool curved_ends_square(const TopoDS_Shape &shape, const TopoDS_Edge &edge, const TopoDS_Face &face0, const TopoDS_Face &face1, const gp_Vec &start_tangent,
                        const gp_Vec &end_tangent, std::string &why) {
  TopTools_IndexedDataMapOfShapeListOfShape vertex_faces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);
  int end = 0;
  for (const TopoDS_Vertex &vertex : {TopExp::FirstVertex(edge, Standard_True), TopExp::LastVertex(edge, Standard_True)}) {
    const gp_Vec &tangent = end++ == 0 ? start_tangent : end_tangent;
    bool capped = false;
    for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) {
      const TopoDS_Face face = TopoDS::Face(it.Value());
      if (face.IsSame(face0) || face.IsSame(face1)) continue;
      if (BRepAdaptor_Surface(face, Standard_True).GetType() == GeomAbs_Plane && std::fabs(std::fabs(normal_of(face).Dot(tangent)) - 1.0) < 1e-6) capped = true;
    }
    if (!capped) {
      why = "an end of the edge is not on a face perpendicular to it (variable chamfers need flat square ends)";
      return false;
    }
  }
  return true;
}

// The point of `face` at the chord `d` from `corner` in the plane perpendicular to `tangent`, starting from the tangent-plane offset along `inward`: project onto the
// face, drop the component along the edge, rescale to the chord, until the projected point is the rescaled one to 1e-9 d. False when it does not settle or leaves the face.
bool leg_point(const TopoDS_Face &face, const gp_Pnt &corner, const gp_Vec &tangent, const gp_Vec &inward, double d, gp_Pnt &out) {
  gp_Pnt guess = corner.Translated(inward * d);
  for (int pass = 0; pass < 40; ++pass) {
    gp_Pnt on;
    if (!project_on_face(face, guess, on)) return false;
    gp_Vec across(corner, on);
    across -= tangent * across.Dot(tangent);
    const double length = across.Magnitude();
    if (!(length > 1e-12 * d)) return false;
    const gp_Pnt next = corner.Translated(across * (d / length));
    if (next.Distance(on) < 1e-9 * d) {
      out = on;
      return inside(face, on);
    }
    guess = next;
  }
  return false;
}

// Whether the faces around `edge` are both planes.
bool faces_planar(const TopoDS_Shape &shape, const TopoDS_Edge &edge) {
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  for (TopTools_ListIteratorOfListOfShape it(owners.FindFromKey(edge)); it.More(); it.Next())
    if (BRepAdaptor_Surface(TopoDS::Face(it.Value()), Standard_True).GetType() != GeomAbs_Plane) return false;
  return true;
}

// The chamfer tool of one curved edge.
bool make_curved_tool(const TopoDS_Shape &shape, const std::vector<std::string> &edge_names, int index, int leg1, const double given[4], Tool &tool,
                      std::string &why) {
  const TopTools_IndexedMapOfShape unique_edges = query::distinct(shape, TopAbs_EDGE);
  const TopoDS_Edge edge = TopoDS::Edge(unique_edges(index + 1));
  const std::string label = "edge " + std::to_string(index);
  const BRepAdaptor_Curve curve(edge);
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  std::vector<TopoDS_Face> around;
  for (TopTools_ListIteratorOfListOfShape it(owners.FindFromKey(edge)); it.More(); it.Next()) {
    const TopoDS_Face face = TopoDS::Face(it.Value());
    if (std::none_of(around.begin(), around.end(), [&](const TopoDS_Face &known) { return known.IsSame(face); })) around.push_back(face);
  }
  if (around.size() != 2) {
    why = label + " does not join exactly two faces";
    return false;
  }
  const double diagonal = std::max(diagonal_of(shape), 1.0);
  if (curve.Value(curve.FirstParameter()).Distance(curve.Value(curve.LastParameter())) < 1e-7 * diagonal) {
    why = label + " is a closed edge: a variable chamfer runs from its start to its end, so give a constant distance (no distanceEnd) around a closed edge";
    return false;
  }
  int side = 0;
  if (!first_leg_side(shape, leg1, around[0], around[1], index, side, why)) return false;
  const Legs legs = legs_of(given, side);
  const double probe = std::min(1e-4 * diagonal, 0.1 * legs.smallest());
  GCPnts_UniformAbscissa stations(curve, kStations);
  if (!stations.IsDone() || stations.NbPoints() < kStations) {
    why = label + " could not be divided into stations";
    return false;
  }
  std::vector<std::vector<gp_Pnt>> polygons;
  gp_Vec first_tangent, last_tangent;
  bool flip[2] = {false, false};
  double sigma = 0;
  for (int k = 0; k < kStations; ++k) {
    const double s = static_cast<double>(k) / (kStations - 1);
    gp_Pnt corner;
    gp_Vec tangent;
    curve.D1(stations.Parameter(k + 1), corner, tangent);
    if (tangent.Magnitude() < 1e-12) {
      why = label + " has no tangent at a station";
      return false;
    }
    tangent.Normalize();
    if (k == 0) first_tangent = tangent;
    if (k == kStations - 1) last_tangent = tangent;
    gp_Vec normal[2], inward[2];
    for (int f = 0; f < 2; ++f) {
      if (!face_normal(around[static_cast<size_t>(f)], corner, normal[f])) {
        why = label + " meets a face with no normal at a station";
        return false;
      }
      if (k == 0) {
        // the orientation of a face of a built solid is not reliable: a probe just off the face must lie outside the solid; the answer holds along the whole edge
        BRepClass3d_SolidClassifier classifier(shape);
        classifier.Perform(corner.Translated(normal[f] * (1e-4 * diagonal)), 1e-9);
        flip[f] = classifier.State() == TopAbs_IN;
      }
      if (flip[f]) normal[f].Reverse();
      gp_Vec across = normal[f].Crossed(tangent);
      if (across.Magnitude() < kDegenerate) {
        why = label + " lies along the normal of a face";
        return false;
      }
      across.Normalize();
      gp_Pnt on;
      const bool forward = project_on_face(around[static_cast<size_t>(f)], corner.Translated(across * probe), on) && inside(around[static_cast<size_t>(f)], on);
      const bool backward = project_on_face(around[static_cast<size_t>(f)], corner.Translated(across * -probe), on) && inside(around[static_cast<size_t>(f)], on);
      if (forward == backward) {
        why = "cannot tell which way face " + std::to_string(f + 1) + " runs away from " + label;
        return false;
      }
      inward[f] = forward ? across : across.Reversed();
    }
    const double fold0 = inward[0].Dot(normal[1]), fold1 = inward[1].Dot(normal[0]);
    if (std::fabs(fold0) < kDegenerate || std::fabs(fold1) < kDegenerate) {
      why = label + " joins tangent faces (no corner to chamfer)";
      return false;
    }
    if (k == 0) sigma = fold1 < 0 ? 1.0 : -1.0;
    if ((fold0 < 0) != (sigma > 0) || (fold1 < 0) != (sigma > 0)) {
      why = label + " changes between convex and concave along its length";
      return false;
    }
    gp_Pnt leg[2];
    for (int f = 0; f < 2; ++f)
      if (!leg_point(around[static_cast<size_t>(f)], corner, tangent, inward[f], legs.at(f, s), leg[f])) {
        why = "a leg of " + std::to_string(legs.at(f, s)) + " reaches past the faces of " + label + ", or does not settle on them; use smaller distances";
        return false;
      }
    gp_Vec line(leg[0], leg[1]);
    const double span = line.Magnitude();
    if (!(span > 1e-9 * diagonal)) {
      why = "the chamfer line of " + label + " has no length";
      return false;
    }
    line /= span;
    const double margin = 0.1 * span;
    const gp_Vec to_corner(leg[0], corner);
    const gp_Vec height = to_corner - line * to_corner.Dot(line);
    if (!(height.Magnitude() > 1e-9 * span)) {
      why = "the corner of " + label + " lies on its chamfer line";
      return false;
    }
    const gp_Vec offset = height * ((height.Magnitude() + margin) / height.Magnitude());
    const gp_Pnt a_end = leg[0].Translated(line * -margin), b_end = leg[1].Translated(line * margin);
    polygons.push_back({a_end, b_end, b_end.Translated(offset), a_end.Translated(offset)});
  }
  if (!curved_ends_square(shape, edge, around[0], around[1], first_tangent, last_tangent, why)) {
    why = label + ": " + why;
    return false;
  }
  BRepOffsetAPI_ThruSections loft(Standard_True, Standard_False);
  loft.CheckCompatibility(Standard_False);
  TopoDS_Wire first_wire;
  for (size_t k = 0; k < polygons.size(); ++k) {
    BRepBuilderAPI_MakePolygon polygon;
    for (const gp_Pnt &point : polygons[k]) polygon.Add(point);
    polygon.Close();
    if (!polygon.IsDone()) {
      why = "the chamfer section of " + label + " does not close";
      return false;
    }
    if (k == 0) first_wire = polygon.Wire();
    loft.AddWire(polygon.Wire());
  }
  loft.Build();
  if (!loft.IsDone()) {
    why = "the chamfer tool of " + label + " could not be lofted";
    return false;
  }
  tool.convex = sigma > 0;
  return name_tool(loft, first_wire, polygons[0][0], polygons[0][1], "chamfer(" + edge_names[static_cast<size_t>(index)] + ")", tool, why);
}

std::unique_ptr<Shape> build(const Shape &source, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first, double last, double second,
                             double second_last, std::string &why) {
  if (edges.empty()) {
    why = "a variable chamfer needs its edges listed (not every edge of the solid)";
    return nullptr;
  }
  const bool sided = !faces.empty();
  if (sided && faces.size() != edges.size()) {
    why = "a variable chamfer with two legs needs one face per edge";
    return nullptr;
  }
  if (!(first > 0) || !(last > 0) || !std::isfinite(first) || !std::isfinite(last) ||
      (sided && (!(second > 0) || !(second_last > 0) || !std::isfinite(second) || !std::isfinite(second_last)))) {
    why = "the distances must be > 0";
    return nullptr;
  }
  const TopTools_IndexedMapOfShape unique_edges = query::distinct(source.shape, TopAbs_EDGE);
  TopTools_IndexedMapOfShape all;
  TopExp::MapShapes(source.shape, TopAbs_VERTEX, all);
  std::map<int, std::vector<size_t>> at_vertex;  // vertex -> the chosen edges (positions in `edges`) that end there
  std::set<uint32_t> seen;
  for (size_t position = 0; position < edges.size(); ++position) {
    const uint32_t index = edges[position];
    if (static_cast<int>(index) >= unique_edges.Extent()) {
      why = "edge index out of range";
      return nullptr;
    }
    if (!seen.insert(index).second) {
      why = "edge " + std::to_string(index) + " is listed twice";
      return nullptr;
    }
    const TopoDS_Edge edge = TopoDS::Edge(unique_edges(static_cast<int>(index) + 1));
    TopTools_IndexedMapOfShape ends;
    TopExp::MapShapes(edge, TopAbs_VERTEX, ends);
    for (int v = 1; v <= ends.Extent(); ++v) {
      at_vertex[all.FindIndex(ends(v))].push_back(position);
    }
  }
  const naming::Named input = naming::named(source);
  const std::vector<std::string> names = naming::edge_names(source.shape, input.names);
  std::vector<Tool> tools;
  for (size_t k = 0; k < edges.size(); ++k) {
    const int index = static_cast<int>(edges[k]);
    const double given[4] = {first, last, sided ? second : first, sided ? second_last : last};
    const BRepAdaptor_Curve curve(TopoDS::Edge(unique_edges(index + 1)));
    Tool tool;
    const int leg1 = sided ? static_cast<int>(faces[k]) : -1;
    const bool built = curve.GetType() == GeomAbs_Line && faces_planar(source.shape, TopoDS::Edge(unique_edges(index + 1))) ? make_straight_tool(source.shape, names, index, leg1, given, tool, why)
                                                       : make_curved_tool(source.shape, names, index, leg1, given, tool, why);
    if (!built) return nullptr;
    tools.push_back(std::move(tool));
  }
  // Edges that meet at a vertex are cut (or fused) one after the other: the chamfer faces then meet along the mitre lines of their planes, which is the corner
  // (no separate patch), provided all of them are cut or all fused.
  for (const auto &entry : at_vertex)
    for (const size_t other : entry.second)
      if (tools[other].convex != tools[entry.second.front()].convex) {
        why = "chamfered edges that meet at a vertex must be all convex or all concave";
        return nullptr;
      }
  naming::Named current = input;
  if (!apply_tools(current, tools, why)) return nullptr;
  if (std::any_of(tools.begin(), tools.end(), [](const Tool &tool) { return !tool.convex; })) {
    // The end faces of a fused (concave) tool that end flush on a face of the solid stay faces of their own next to it ("tool.<k>"): merge the coplanar ones.
    // Only the edges of those faces may disappear; every other edge is kept, so a face split by split_face or an imported coplanar face keeps its name.
    const TopTools_IndexedMapOfShape fused_faces = query::distinct(current.shape, TopAbs_FACE);
    TopTools_MapOfShape tool_edges, keep;
    for (int f = 1; f <= fused_faces.Extent(); ++f)
      if (current.names[static_cast<size_t>(f - 1)].rfind("tool.", 0) == 0)
        for (TopExp_Explorer it(fused_faces(f), TopAbs_EDGE); it.More(); it.Next()) tool_edges.Add(it.Current());
    for (TopExp_Explorer it(current.shape, TopAbs_EDGE); it.More(); it.Next())
      if (!tool_edges.Contains(it.Current())) keep.Add(it.Current());
    ShapeUpgrade_UnifySameDomain unifier(current.shape, Standard_False, Standard_True, Standard_False);
    unifier.KeepShapes(keep);
    unifier.AllowInternalEdges(Standard_False);
    unifier.Build();
    const std::vector<naming::Named> fused{current};
    current = naming::Named{unifier.Shape(), naming::inherit(unifier.Shape(), fused, unifier.History(), "unify")};
  }
  const bool all_convex = std::all_of(tools.begin(), tools.end(), [](const Tool &tool) { return tool.convex; });
  const bool all_concave = std::none_of(tools.begin(), tools.end(), [](const Tool &tool) { return tool.convex; });
  const double before = volume_of(source.shape), after = volume_of(current.shape);
  if (!(after > 0) || (all_convex && !(after < before)) || (all_concave && !(after > before))) {
    why = "the variable chamfer changed the volume from " + std::to_string(before) + " to " + std::to_string(after) + " the wrong way";
    return nullptr;
  }
  return naming::wrap_named(current.shape, current.names);
}

std::string failure_text(const Standard_Failure &error) {
  return std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
}

}  // namespace

std::unique_ptr<Shape> chamfer_variable(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first, double last,
                                        double second, double second_last) {
  std::string why;
  try {
    return build(shape, edges, faces, first, last, second, second_last, why);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String chamfer_variable_reason(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first, double last,
                                     double second, double second_last) {
  std::string why;
  std::unique_ptr<Shape> built;
  try {
    built = build(shape, edges, faces, first, last, second, second_last, why);
  } catch (const Standard_Failure &error) {
    why = failure_text(error);
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the variable chamfer failed") : why));
}

}  // namespace llull
