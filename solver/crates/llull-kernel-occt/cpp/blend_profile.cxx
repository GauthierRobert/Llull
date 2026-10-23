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
#include <BRepPrimAPI_MakePrism.hxx>
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
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace blend {

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

bool spandrel_tool(const gp_Pnt &start, const gp_Pnt &end, const gp_Pnt &a, const gp_Pnt &b, int kind, double param, double wedge,
                   const std::string &blend_name, Tool &tool, std::string &why) {
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
  BRepBuilderAPI_MakeFace profile(wire.Wire(), Standard_True);
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
  const TopTools_IndexedMapOfShape edges = query::distinct(shape, TopAbs_EDGE);
  const TopTools_IndexedMapOfShape faces = query::distinct(shape, TopAbs_FACE);
  if (spec.edge < 0 || spec.edge >= edges.Extent()) {
    why = "edge index out of range";
    return false;
  }
  const std::string label = "edge " + std::to_string(spec.edge);
  const TopoDS_Edge edge = TopoDS::Edge(edges(spec.edge + 1));
  const BRepAdaptor_Curve curve(edge);
  if (curve.GetType() != GeomAbs_Line) {
    why = label + " is not a straight line (profile blends need a straight edge)";
    return false;
  }
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
  for (const TopoDS_Face &face : around)
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) {
      why = label + " meets a curved face (profile blends need two planar faces)";
      return false;
    }
  if (!std::isnan(spec.size2) && spec.side >= 0) {
    const int first = faces.FindIndex(around[0]) - 1;
    const int second = faces.FindIndex(around[1]) - 1;
    if (spec.side == second) std::swap(around[0], around[1]);
    else if (spec.side != first) {
      why = "side1 is not a face of " + label;
      return false;
    }
  }
  const gp_Pnt start = curve.Value(curve.FirstParameter());
  const gp_Pnt end = curve.Value(curve.LastParameter());
  const double length = start.Distance(end);
  if (!(length > 1e-9)) {
    why = label + " has no length";
    return false;
  }
  const gp_Vec direction = gp_Vec(start, end) / length;
  gp_Vec normals[2], inward[2];
  for (int k = 0; k < 2; ++k) {
    normals[k] = outward_normal(shape, around[k]);
    gp_Vec across = normals[k].Crossed(direction);
    if (across.Magnitude() < 1e-9) {
      why = label + " lies along the normal of a face";
      return false;
    }
    across.Normalize();
    const gp_Pnt middle = start.Translated(direction * (length / 2));
    const double probe = std::min(1e-3 * length, 1e-3);
    if (inside(around[k], middle.Translated(across * probe))) inward[k] = across;
    else if (inside(around[k], middle.Translated(across * -probe))) inward[k] = across.Reversed();
    else {
      why = "cannot tell which way face " + std::to_string(k + 1) + " runs away from " + label;
      return false;
    }
  }
  const double fold = std::acos(std::max(-1.0, std::min(1.0, normals[0].Dot(normals[1]))));
  if (fold < kTangentAngle || fold > kPi - kTangentAngle) {
    why = label + " joins tangent or folded-flat faces (no corner to blend)";
    return false;
  }
  tool.convex = normals[0].Dot(inward[1]) < 0;
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
  // Both ends must be closed by a planar face perpendicular to the edge, so the prism can end flush with it.
  TopTools_IndexedDataMapOfShapeListOfShape vertex_faces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);
  for (const TopoDS_Vertex &vertex : {TopExp::FirstVertex(edge), TopExp::LastVertex(edge)}) {
    bool capped = false;
    for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) {
      const TopoDS_Face face = TopoDS::Face(it.Value());
      if (face.IsSame(around[0]) || face.IsSame(around[1])) continue;
      if (BRepAdaptor_Surface(face, Standard_True).GetType() == GeomAbs_Plane &&
          std::fabs(std::fabs(normal_of(face).Dot(direction)) - 1.0) < 1e-9)
        capped = true;
    }
    if (!capped) {
      why = label + " does not end on a face perpendicular to it (profile blends need flat square ends)";
      return false;
    }
  }
  return spandrel_tool(start, end, a, b, spec.kind, spec.param, wedge, "blend(" + edge_names[static_cast<size_t>(spec.edge)] + ")", tool, why);
}

}  // namespace

// The profiled shape, or null with the reason in `why`.
static std::unique_ptr<Shape> build_profile(const Shape &source, rust::Slice<const double> raw, std::string &why) {
  const std::vector<Spec> specs = specs_of(raw);
  if (specs.empty() || specs.size() * kSpecWidth != raw.size()) {
    why = "profile specification is malformed";
    return nullptr;
  }
  const naming::Named input = naming::named(source);
  const std::vector<std::string> edge_names = naming::edge_names(source.shape, input.names);
  std::vector<Tool> tools;
  std::set<int> selected;
  for (const Spec &spec : specs) {
    if (!selected.insert(spec.edge).second) {
      why = "edge " + std::to_string(spec.edge) + " is listed twice";
      return nullptr;
    }
    Tool tool;
    if (!make_tool(source.shape, edge_names, spec, tool, why)) return nullptr;
    tools.push_back(std::move(tool));
  }
  // Selected edges sharing a vertex would need a corner patch: not built.
  const TopTools_IndexedMapOfShape edges = query::distinct(source.shape, TopAbs_EDGE);
  std::map<int, int> vertex_owner;
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(source.shape, TopAbs_VERTEX, vertices);
  for (const Spec &spec : specs) {
    const TopoDS_Edge edge = TopoDS::Edge(edges(spec.edge + 1));
    for (const TopoDS_Vertex &vertex : {TopExp::FirstVertex(edge), TopExp::LastVertex(edge)}) {
      const int index = vertices.FindIndex(vertex);
      const auto found = vertex_owner.find(index);
      if (found != vertex_owner.end() && found->second != spec.edge) {
        why = "edges " + std::to_string(found->second) + " and " + std::to_string(spec.edge) +
              " meet at a vertex: a corner between profile blends is not built (use the circular profile there)";
        return nullptr;
      }
      vertex_owner[index] = spec.edge;
    }
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
  return naming::wrap_named(current.shape, current.names);
}

std::unique_ptr<Shape> fillet_profile(const Shape &shape, rust::Slice<const double> specs) {
  std::string why;
  try {
    return build_profile(shape, specs, why);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String profile_reason(const Shape &shape, rust::Slice<const double> specs) {
  std::string why;
  std::unique_ptr<Shape> built;
  try {
    built = build_profile(shape, specs, why);
  } catch (const Standard_Failure &error) {
    why = std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the profile blend failed") : why));
}

}  // namespace llull
