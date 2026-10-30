// Profile blends (BLD M2, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.3): conic, curvature-continuous and asymmetric sections that
// OCCT's MakeFillet (circle representations only) cannot build. Scope of this build: a STRAIGHT edge between two PLANAR faces with a constant
// size, ending on faces perpendicular to it. The blend is the boolean of the source with a prism of the corner spandrel R (the region
// between the corner and the section curve): CUT for a convex edge, FUSE for a concave one. The prism has two planar faces flush with the
// support faces and one B-spline lateral face that becomes the blend face "blend(<edge name>)".
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <TopoDS_Wire.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/blends.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace blend {

double diagonal_of(const TopoDS_Shape &shape) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, Standard_False, Standard_False);
  if (box.IsVoid()) return 0.0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return gp_Pnt(x0, y0, z0).Distance(gp_Pnt(x1, y1, z1));
}

double vertex_diagonal_of(const TopoDS_Shape &shape) {
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

gp_Vec normal_of(const TopoDS_Face &face) {
  const BRepAdaptor_Surface surface(face, Standard_True);
  gp_Vec normal(surface.Plane().Axis().Direction());
  if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
  return normal;
}

gp_Vec outward_normal(const TopoDS_Shape &shape, const TopoDS_Face &face) {
  const gp_Vec normal = normal_of(face);
  GProp_GProps props;
  BRepGProp::SurfaceProperties(face, props);
  const gp_Pnt centre = props.CentreOfMass();
  if (!inside(face, centre)) return normal;
  BRepClass3d_SolidClassifier classifier(shape);
  classifier.Perform(centre.Translated(normal * 1e-4), kInsideTolerance);
  return classifier.State() == TopAbs_IN ? normal.Reversed() : normal;
}

bool inside(const TopoDS_Face &face, const gp_Pnt &point) {
  BRepClass_FaceClassifier classifier(face, point, kInsideTolerance);
  return classifier.State() == TopAbs_IN || classifier.State() == TopAbs_ON;
}

Handle(Geom_Curve) section_curve(const gp_Pnt &start, const gp_Pnt &a, const gp_Pnt &b, int kind, double param, double wedge) {
  const double leg_a = start.Distance(a), leg_b = start.Distance(b);
  if (kind == 2 && std::fabs(leg_a - leg_b) <= 1e-9 * std::max(leg_a, 1.0)) {
    // Equal legs: the circle tangent to both lines. Its centre lies on the bisector at distance leg / cos(wedge / 2) from the corner, its
    // radius is leg tan(wedge / 2), and its point nearest the corner is the shoulder.
    gp_Vec bisector = gp_Vec(start, a) / leg_a + gp_Vec(start, b) / leg_b;
    bisector.Normalize();
    const double to_centre = leg_a / std::cos(wedge / 2);
    const double radius = leg_a * std::tan(wedge / 2);
    const gp_Pnt shoulder = start.Translated(bisector * (to_centre - radius));
    GC_MakeArcOfCircle arc(a, shoulder, b);
    if (arc.IsDone()) return arc.Value();
  }
  Handle(Geom_BezierCurve) section;
  if (kind == 1) {
    TColgp_Array1OfPnt poles(1, 5);
    poles.SetValue(1, a);
    poles.SetValue(2, a.Translated(gp_Vec(a, start) * param));
    poles.SetValue(3, start);
    poles.SetValue(4, b.Translated(gp_Vec(b, start) * param));
    poles.SetValue(5, b);
    section = new Geom_BezierCurve(poles);
  } else {
    const double weight = kind == 0 ? param / (1.0 - param) : std::sin(wedge / 2);
    TColgp_Array1OfPnt poles(1, 3);
    poles.SetValue(1, a);
    poles.SetValue(2, start);
    poles.SetValue(3, b);
    TColStd_Array1OfReal weights(1, 3);
    weights.SetValue(1, 1.0);
    weights.SetValue(2, weight);
    weights.SetValue(3, 1.0);
    section = new Geom_BezierCurve(poles, weights);
  }
  return section;
}

static bool spandrel_wire(const gp_Pnt &start, const gp_Pnt &a, const gp_Pnt &b, int kind, double param, double wedge, TopoDS_Wire &wire_out,
                   std::string &why) {
  const Handle(Geom_Curve) section = section_curve(start, a, b, kind, param, wedge);
  BRepBuilderAPI_MakeEdge corner_to_a(start, a);
  BRepBuilderAPI_MakeEdge arc(section);
  BRepBuilderAPI_MakeEdge b_to_corner(b, start);
  if (!corner_to_a.IsDone() || !arc.IsDone() || !b_to_corner.IsDone()) {
    why = "the section curve could not be built";
    return false;
  }
  BRepBuilderAPI_MakeWire wire;
  wire.Add(corner_to_a.Edge());
  wire.Add(arc.Edge());
  wire.Add(b_to_corner.Edge());
  if (!wire.IsDone()) {
    why = "the section outline does not close";
    return false;
  }
  wire_out = wire.Wire();
  return true;
}

bool tapered_spandrel_tool(const gp_Pnt &start_from, const gp_Pnt &a_from, const gp_Pnt &b_from, const gp_Pnt &start_to, const gp_Pnt &a_to,
                           const gp_Pnt &b_to, double wedge, const std::string &blend_name, Tool &tool, std::string &why) {
  TopoDS_Wire first, last;
  if (!spandrel_wire(start_from, a_from, b_from, 2, 0.0, wedge, first, why) || !spandrel_wire(start_to, a_to, b_to, 2, 0.0, wedge, last, why)) return false;
  BRepOffsetAPI_ThruSections loft(Standard_True, Standard_True);
  loft.AddWire(first);
  loft.AddWire(last);
  loft.Build();
  if (!loft.IsDone()) {
    why = "the tapered blend tool could not be lofted";
    return false;
  }
  tool.shape = loft.Shape();
  const TopTools_IndexedMapOfShape tool_faces = query::distinct(tool.shape, TopAbs_FACE);
  tool.names.assign(static_cast<size_t>(tool_faces.Extent()), "");
  for (TopExp_Explorer it(first, TopAbs_EDGE); it.More(); it.Next()) {
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() == GeomAbs_Line) continue;
    const int blend_face = tool_faces.FindIndex(loft.GeneratedFace(it.Current()));
    if (blend_face > 0) tool.names[static_cast<size_t>(blend_face - 1)] = blend_name;
  }
  return std::find(tool.names.begin(), tool.names.end(), blend_name) != tool.names.end();
}

bool spandrel_tool(const gp_Pnt &start, const gp_Pnt &end, const gp_Pnt &a, const gp_Pnt &b, int kind, double param, double wedge,
                   const std::string &blend_name, Tool &tool, std::string &why) {
  TopoDS_Wire outline;
  if (!spandrel_wire(start, a, b, kind, param, wedge, outline, why)) return false;
  BRepBuilderAPI_MakeFace profile(outline, Standard_True);
  if (!profile.IsDone()) {
    why = "the section outline is not planar";
    return false;
  }
  BRepPrimAPI_MakePrism prism(profile.Face(), gp_Vec(start, end));
  prism.Build();
  if (!prism.IsDone()) {
    why = "the blend tool could not be swept";
    return false;
  }
  tool.shape = prism.Shape();
  const TopTools_IndexedMapOfShape tool_faces = query::distinct(tool.shape, TopAbs_FACE);
  tool.names.assign(static_cast<size_t>(tool_faces.Extent()), "");
  for (int f = 0; f < tool_faces.Extent(); ++f) tool.names[static_cast<size_t>(f)] = "tool." + std::to_string(f);
  TopoDS_Shape section_edge;
  for (TopExp_Explorer it(profile.Face(), TopAbs_EDGE); it.More(); it.Next())
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() != GeomAbs_Line) section_edge = it.Current();
  const TopTools_ListOfShape &lateral = prism.Generated(section_edge);
  if (lateral.IsEmpty()) {
    why = "the blend face was not generated";
    return false;
  }
  const int blend_face = tool_faces.FindIndex(lateral.First());
  if (blend_face > 0) tool.names[static_cast<size_t>(blend_face - 1)] = blend_name;
  return true;
}

bool apply_tools(naming::Named &current, const std::vector<Tool> &tools, std::string &why) {
  for (const bool convex : {true, false}) {
    TopTools_ListOfShape arguments, tool_list;
    arguments.Append(current.shape);
    std::vector<naming::Named> inputs{current};
    for (const Tool &tool : tools) {
      if (tool.convex != convex) continue;
      tool_list.Append(tool.shape);
      inputs.push_back(naming::Named{tool.shape, tool.names});
    }
    if (tool_list.IsEmpty()) continue;
    TopoDS_Shape result;
    Handle(BRepTools_History) history;
    if (convex) {
      BRepAlgoAPI_Cut op;
      op.SetArguments(arguments);
      op.SetTools(tool_list);
      op.Build();
      if (!op.IsDone() || op.HasErrors()) {
        why = "the boolean cut of the blend tools failed";
        return false;
      }
      result = op.Shape();
      history = naming::history_of(inputs, op);
    } else {
      BRepAlgoAPI_Fuse op;
      op.SetArguments(arguments);
      op.SetTools(tool_list);
      op.Build();
      if (!op.IsDone() || op.HasErrors()) {
        why = "the boolean fuse of the blend tools failed";
        return false;
      }
      result = op.Shape();
      history = naming::history_of(inputs, op);
    }
    if (result.IsNull() || !BRepCheck_Analyzer(result, Standard_True).IsValid()) {
      why = "the blended solid fails the BRepCheck validity analysis";
      return false;
    }
    current = naming::Named{result, naming::inherit(result, inputs, history, "boolean")};
  }
  return true;
}

bool edge_frame(const TopoDS_Shape &shape, int index, const char *what, EdgeFrame &frame, std::string &why) {
  const TopTools_IndexedMapOfShape edges = query::distinct(shape, TopAbs_EDGE);
  if (index < 0 || index >= edges.Extent()) {
    why = "edge index out of range";
    return false;
  }
  const std::string label = "edge " + std::to_string(index);
  frame.edge = TopoDS::Edge(edges(index + 1));
  const BRepAdaptor_Curve curve(frame.edge);
  if (curve.GetType() != GeomAbs_Line) {
    why = label + " is not a straight line (" + what + " need a straight edge)";
    return false;
  }
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  std::vector<TopoDS_Face> around;
  for (TopTools_ListIteratorOfListOfShape it(owners.FindFromKey(frame.edge)); it.More(); it.Next()) {
    const TopoDS_Face face = TopoDS::Face(it.Value());
    if (std::none_of(around.begin(), around.end(), [&](const TopoDS_Face &known) { return known.IsSame(face); })) around.push_back(face);
  }
  if (around.size() != 2) {
    why = label + " does not join exactly two faces";
    return false;
  }
  for (const TopoDS_Face &face : around)
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) {
      why = label + " meets a curved face (" + what + " need two planar faces)";
      return false;
    }
  frame.faces[0] = around[0];
  frame.faces[1] = around[1];
  frame.start = curve.Value(curve.FirstParameter());
  frame.end = curve.Value(curve.LastParameter());
  frame.length = frame.start.Distance(frame.end);
  if (!(frame.length > 1e-9)) {
    why = label + " has no length";
    return false;
  }
  frame.direction = gp_Vec(frame.start, frame.end) / frame.length;
  for (int k = 0; k < 2; ++k) {
    frame.normals[k] = outward_normal(shape, around[k]);
    gp_Vec across = frame.normals[k].Crossed(frame.direction);
    if (across.Magnitude() < 1e-9) {
      why = label + " lies along the normal of a face";
      return false;
    }
    across.Normalize();
    const gp_Pnt middle = frame.start.Translated(frame.direction * (frame.length / 2));
    const double probe = std::min(1e-3 * frame.length, 1e-3);
    if (inside(around[k], middle.Translated(across * probe))) frame.inward[k] = across;
    else if (inside(around[k], middle.Translated(across * -probe))) frame.inward[k] = across.Reversed();
    else {
      why = "cannot tell which way face " + std::to_string(k + 1) + " runs away from " + label;
      return false;
    }
  }
  frame.fold = std::acos(std::max(-1.0, std::min(1.0, frame.normals[0].Dot(frame.normals[1]))));
  if (frame.fold < kTangentAngle || frame.fold > kPi - kTangentAngle) {
    why = label + " joins tangent or folded-flat faces (no corner to blend)";
    return false;
  }
  frame.convex = frame.normals[0].Dot(frame.inward[1]) < 0;
  return true;
}

bool ends_square(const TopoDS_Shape &shape, const EdgeFrame &frame, const char *what, std::string &why) {
  TopTools_IndexedDataMapOfShapeListOfShape vertex_faces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);
  for (const TopoDS_Vertex &vertex : {TopExp::FirstVertex(frame.edge), TopExp::LastVertex(frame.edge)}) {
    bool capped = false;
    for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) {
      const TopoDS_Face face = TopoDS::Face(it.Value());
      if (face.IsSame(frame.faces[0]) || face.IsSame(frame.faces[1])) continue;
      if (BRepAdaptor_Surface(face, Standard_True).GetType() == GeomAbs_Plane &&
          std::fabs(std::fabs(normal_of(face).Dot(frame.direction)) - 1.0) < 1e-9)
        capped = true;
    }
    if (!capped) {
      why = "an end of the edge is not on a face perpendicular to it (" + std::string(what) + " need flat square ends)";
      return false;
    }
  }
  return true;
}

}  // namespace blend

namespace {


constexpr size_t kSpecWidth = 7;

struct Spec {
  int edge;
  int kind;  // 0 conic, 1 curvature, 2 circular (asymmetric legs)
  double param;
  double size;
  double size2;  // NaN: the size is a radius, else the second leg
  int side;      // unique face index carrying `size` when size2 is given, else -1
};

// Spec k of `raw`.
std::vector<Spec> specs_of(rust::Slice<const double> raw) {
  std::vector<Spec> specs;
  for (size_t at = 0; at + kSpecWidth <= raw.size(); at += kSpecWidth)
    specs.push_back({static_cast<int>(raw[at]), static_cast<int>(raw[at + 1]), raw[at + 2], raw[at + 3], raw[at + 4], static_cast<int>(raw[at + 5])});
  return specs;
}

// The spandrel prism of one edge, or the reason it cannot be built.
bool make_tool(const TopoDS_Shape &shape, const std::vector<std::string> &edge_names, const Spec &spec, Tool &tool, std::string &why) {
  const TopTools_IndexedMapOfShape faces = query::distinct(shape, TopAbs_FACE);
  EdgeFrame frame;
  if (!edge_frame(shape, spec.edge, "profile blends", frame, why)) return false;
  const std::string label = "edge " + std::to_string(spec.edge);
  const TopoDS_Edge edge = frame.edge;
  const gp_Pnt start = frame.start, end = frame.end;
  const double length = frame.length;
  const gp_Vec direction = frame.direction;
  std::vector<TopoDS_Face> around{frame.faces[0], frame.faces[1]};
  gp_Vec normals[2] = {frame.normals[0], frame.normals[1]}, inward[2] = {frame.inward[0], frame.inward[1]};
  if (!std::isnan(spec.size2) && spec.side >= 0) {
    const int first = faces.FindIndex(around[0]) - 1;
    const int second = faces.FindIndex(around[1]) - 1;
    if (spec.side == second) {
      std::swap(around[0], around[1]);
      std::swap(normals[0], normals[1]);
      std::swap(inward[0], inward[1]);
    } else if (spec.side != first) {
      why = "side1 is not a face of " + label;
      return false;
    }
  }
  const double fold = frame.fold;
  tool.convex = frame.convex;
  const double wedge = kPi - fold;
  const double leg1 = std::isnan(spec.size2) ? spec.size * std::tan(fold / 2) : spec.size;
  const double leg2 = std::isnan(spec.size2) ? leg1 : spec.size2;
  if (!(leg1 > 0) || !(leg2 > 0)) {
    why = "sizes must be > 0";
    return false;
  }
  const gp_Pnt a = start.Translated(inward[0] * leg1);
  const gp_Pnt b = start.Translated(inward[1] * leg2);
  for (double s : {0.0, 0.5, 1.0}) {
    const gp_Vec along = direction * (s * length);
    if (!inside(around[0], a.Translated(along)) || !inside(around[1], b.Translated(along))) {
      why = "the legs (" + std::to_string(leg1) + ", " + std::to_string(leg2) + ") reach past the faces of " + label + "; use a smaller size";
      return false;
    }
  }
  if (!ends_square(shape, frame, "profile blends", why)) {
    why = label + ": " + why;
    return false;
  }
  return spandrel_tool(start, end, a, b, spec.kind, spec.param, wedge, "blend(" + edge_names[static_cast<size_t>(spec.edge)] + ")", tool, why);
}

}  // namespace

// Whether the unique edges `picked` meet at a vertex that is not a smooth junction of exactly two of them (parallel, opposite directions: one chain);
// false with the reason in `why` for a repeated or unknown edge.
static bool meets_at_corner(const TopoDS_Shape &shape, const std::vector<int> &picked, bool &corner, std::string &why) {
  const TopTools_IndexedMapOfShape edges = query::distinct(shape, TopAbs_EDGE);
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);
  std::set<int> selected;
  std::map<int, std::vector<gp_Vec>> leaving;  // per vertex: the unit direction away from it of each selected edge ending there
  for (const int index : picked) {
    if (!selected.insert(index).second) {
      why = "edge " + std::to_string(index) + " is listed twice";
      return false;
    }
    if (index < 0 || index >= edges.Extent()) {
      why = "edge index out of range";
      return false;
    }
    const TopoDS_Edge edge = TopoDS::Edge(edges(index + 1));
    const BRepAdaptor_Curve curve(edge);
    const TopoDS_Vertex ends[2] = {TopExp::FirstVertex(edge), TopExp::LastVertex(edge)};
    if (ends[0].IsSame(ends[1])) continue;  // a closed edge meets only itself
    for (int end = 0; end < 2; ++end) {
      gp_Pnt at;
      gp_Vec direction;
      curve.D1(end == 0 ? curve.FirstParameter() : curve.LastParameter(), at, direction);
      if (direction.Magnitude() > 1e-14) direction.Normalize();
      leaving[vertices.FindIndex(ends[end])].push_back(end == 0 ? direction : direction.Reversed());
    }
  }
  corner = false;
  for (const auto &[vertex, directions] : leaving) {
    if (directions.size() < 2) continue;
    // two edges that leave in opposite directions are one smooth chain (a tangent junction of blends), anything else is a corner
    const bool junction = directions.size() == 2 && directions[0].Dot(directions[1]) < -std::cos(kTangentAngle * 1e3);
    corner = corner || !junction;
  }
  return true;
}

// The profiled shape of the prism builder, or null with the reason in `why`; `scope` is true when the failure is a limit of the prism builder
// (straight edge, planar faces, square flat ends) that the rail builder does not share.
static std::unique_ptr<Shape> build_profile(const Shape &source, rust::Slice<const double> raw, std::string &notes, std::string &why, bool &scope) {
  scope = false;
  const std::vector<Spec> specs = specs_of(raw);
  if (specs.empty() || specs.size() * kSpecWidth != raw.size()) {
    why = "profile specification is malformed";
    return nullptr;
  }
  // Selected edges meeting at a vertex that is not a smooth junction of two edges meet in a corner: every edge there is profiled and the corner is
  // a G1 patch (blend_corner.cxx).
  std::vector<int> picked;
  for (const Spec &spec : specs) picked.push_back(spec.edge);
  bool shared = false;
  if (!meets_at_corner(source.shape, picked, shared, why)) return nullptr;
  if (shared) {
    std::vector<std::pair<int, double>> radii;
    for (const Spec &spec : specs) {
      if (!std::isnan(spec.size2) || spec.kind == 2 || spec.kind != specs.front().kind || spec.param != specs.front().param) {
        why = "edges that meet at a vertex need one conic or curvature profile with symmetric sizes (no size2, one rho / shape)";
        return nullptr;
      }
      radii.emplace_back(spec.edge, spec.size);
    }
    return profile_corner_blend(source, radii, specs.front().kind, specs.front().param, notes, why);
  }
  const naming::Named input = naming::named(source);
  const std::vector<std::string> edge_names = naming::edge_names(source.shape, input.names);
  std::vector<Tool> tools;
  scope = true;
  for (const Spec &spec : specs) {
    Tool tool;
    if (!make_tool(source.shape, edge_names, spec, tool, why)) return nullptr;
    tools.push_back(std::move(tool));
  }
  naming::Named current = input;
  const double volume_before = [&] {
    GProp_GProps props;
    BRepGProp::VolumeProperties(source.shape, props);
    return props.Mass();
  }();
  if (!apply_tools(current, tools, why)) return nullptr;
  GProp_GProps props;
  BRepGProp::VolumeProperties(current.shape, props);
  if (!(std::fabs(props.Mass() - volume_before) > 0)) {
    why = "the blend removed or added no material";
    return nullptr;
  }
  notes = "{\"builder\":\"prism\"}";
  return naming::wrap_named(current.shape, current.names);
}

// The reason the last fillet_profile_blend of this thread failed (empty after a success): the one it computed, so a refusal is explained without a rebuild.
static thread_local std::string g_last_reason;

// The profile blend: the prism builder for constant sizes on straight edges between planar faces (exact), corners where edges meet, else the rail
// builder (curved edges and faces, any size law). `specs` is empty when a size varies; `laws` is empty when a leg is asymmetric.
static std::unique_ptr<Shape> build_blend(const Shape &source, rust::Slice<const double> specs, rust::Slice<const uint32_t> edges,
                                          rust::Slice<const double> laws, double kind, double param, std::string &notes, std::string &why) {
  if (!specs.empty()) {
    bool scope = false;
    std::unique_ptr<Shape> built = build_profile(source, specs, notes, why, scope);
    if (built || !scope || laws.empty()) return built;
  }
  if (laws.empty()) {
    why = why.empty() ? "profile specification is malformed" : why;
    return nullptr;
  }
  // A varying size has no corner builder (the setbacks assume one constant size per edge): say so before the rail builder reports an end it cannot make.
  if (specs.empty()) {
    bool corner = false;
    std::vector<int> picked(edges.begin(), edges.end());
    if (!meets_at_corner(source.shape, picked, corner, why)) return nullptr;
    if (corner) {
      why = "profiled edges that meet at a vertex need one constant size (a varying size has no corner patch)";
      return nullptr;
    }
  }
  return rails_blend(source, edges, laws, static_cast<int>(kind), param, notes, why);
}

std::unique_ptr<Shape> fillet_profile(const Shape &shape, rust::Slice<const double> specs) {
  std::string why, notes;
  bool scope = false;
  try {
    std::unique_ptr<Shape> built = build_profile(shape, specs, notes, why, scope);
    if (built) built->notes = notes;
    return built;
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

std::unique_ptr<Shape> fillet_profile_blend(const Shape &shape, rust::Slice<const double> specs, rust::Slice<const uint32_t> edges,
                                            rust::Slice<const double> laws, double kind, double param) {
  g_last_reason.clear();
  std::string why, notes;
  try {
    std::unique_ptr<Shape> built = build_blend(shape, specs, edges, laws, kind, param, notes, why);
    if (built) built->notes = notes;
    if (built && has_straight_kink(laws)) built->refined_mass = true;
    g_last_reason = built ? std::string() : (why.empty() ? std::string("the profile blend failed") : why);
    return built;
  } catch (const Standard_Failure &error) {
    g_last_reason = blend::occt_failure(error);
    return nullptr;
  }
}

rust::String profile_blend_last_reason() { return rust::String(g_last_reason); }

rust::String shape_notes(const Shape &shape) { return rust::String(shape.notes); }

rust::String profile_blend_reason(const Shape &shape, rust::Slice<const double> specs, rust::Slice<const uint32_t> edges,
                                  rust::Slice<const double> laws, double kind, double param) {
  std::string why, notes;
  std::unique_ptr<Shape> built;
  try {
    built = build_blend(shape, specs, edges, laws, kind, param, notes, why);
  } catch (const Standard_Failure &error) {
    why = blend::occt_failure(error);
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the profile blend failed") : why));
}

rust::String profile_reason(const Shape &shape, rust::Slice<const double> specs) {
  std::string why, notes;
  std::unique_ptr<Shape> built;
  bool scope = false;
  try {
    built = build_profile(shape, specs, notes, why, scope);
  } catch (const Standard_Failure &error) {
    why = std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the profile blend failed") : why));
}

}  // namespace llull
