// Profile blends with two legs (`size2`) on curved edges, curved faces and with legs that vary (BLD §13.34, DES-6c). The circular fillet of OCCT has no
// asymmetric counterpart, so the contact lines of a leg pair are the ones of the CHAMFER of those legs: a leg is the chord of length d in the plane
// perpendicular to the edge (the definition of the chamfer, §13.24), and the chamfer face is bounded by exactly those two lines on the supports.
// 1. The chamfer of the legs: OCCT's two-distance chamfer for constant legs (open or closed edges, any faces), the variable chamfer of blend_chamfer.cxx
//    for legs that run linearly along the edge. Its supports are trimmed at the contact lines.
// 2. Per station along each edge the contact points A, B are computed again from the source (leg_point), the apex T of the tangent lines of the two supports
//    at A and B in the plane perpendicular to the edge, and the section is the conic (A, T, B) of the profile's weight (a conic: rho / (1 - rho); a circular
//    profile: sin(wedge / 2), the weight of the circular arc between the same tangents: an ellipse when the legs differ, the circle when they are equal), so the new face is G1 to both supports along the contact lines.
// 3. The chamfer face is replaced by the surface interpolating the sections (stations inserted where the surface misses a section by 1e-8 x the diagonal),
//    the end faces it met are rebuilt around the new section curve, and everything is sewn. The measured gap to the supports and the volume window
//    (between the source and the chamfer, the profile's solid) are the acceptance; reasons carry no BLD code.
// Scope: edges that do not meet at a vertex, flat square ends (or a closed edge), a conic or circular section; a curvature section is refused by name.#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepGProp.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomLProp_SLProps.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_Surface.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TColStd_HArray1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_solid.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

#include "llull-kernel-occt/cpp/blend_legs.hxx"

namespace llull {

using namespace blend;
using namespace blend::legs;

namespace {

// The edits of one face the blend meets: the edges of the face that the new section curves replace.
struct Edit {
  TopoDS_Face face;
  std::vector<rails::Replacement> replacements;
};

}  // namespace

std::unique_ptr<Shape> blend::legs_blend(const Shape &source, rust::Slice<const double> legs, int kind, double param, std::string &notes, std::string &why) {
  if (kind == 1) {
    why = "a curvature profile with two legs is built on straight edges between planes only (curved edges and faces take a conic or circular profile)";
    return nullptr;
  }
  if (legs.empty() || legs.size() % kLegWidth != 0) {
    why = "the leg specification is malformed";
    return nullptr;
  }
  const TopoDS_Shape &shape = source.shape;
  const double diagonal = std::max(diagonal_of(shape), 1e-9);
  const TopTools_IndexedMapOfShape unique_edges = query::distinct(shape, TopAbs_EDGE);
  const TopTools_IndexedMapOfShape unique_faces = query::distinct(shape, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape owners, vertex_edges;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges);
  std::vector<EdgePlan> plans(legs.size() / kLegWidth);
  std::set<int> listed;
  bool varying = false;
  for (size_t k = 0; k < plans.size(); ++k) {
    const double *numbers = legs.data() + k * kLegWidth;
    if (!make_plan(shape, unique_edges, unique_faces, owners, numbers, diagonal, plans[k], why)) return nullptr;
    if (!listed.insert(plans[k].index).second) {
      why = "edge " + std::to_string(plans[k].index) + " is listed twice";
      return nullptr;
    }
    varying = varying || !std::isnan(numbers[3]) || !std::isnan(numbers[5]);
  }
  // a step that adds and removes material has no single volume window: refuse it by name
  const auto convex_at = std::find_if(plans.begin(), plans.end(), [](const EdgePlan &plan) { return plan.convex; });
  const auto concave_at = std::find_if(plans.begin(), plans.end(), [](const EdgePlan &plan) { return !plan.convex; });
  if (convex_at != plans.end() && concave_at != plans.end()) {
    why = "edge " + std::to_string(convex_at->index) + " is convex and edge " + std::to_string(concave_at->index) +
          " is concave: a two-leg blend step removes material at the one and adds it at the other, so blend them in separate steps";
    return nullptr;
  }
  // edges that meet at a vertex have no corner patch with two legs
  for (const EdgePlan &plan : plans) {
    TopTools_IndexedMapOfShape ends;
    TopExp::MapShapes(plan.edge, TopAbs_VERTEX, ends);
    for (int v = 1; v <= ends.Extent(); ++v)
      for (TopTools_ListIteratorOfListOfShape it(vertex_edges.FindFromKey(ends(v))); it.More(); it.Next()) {
        const int other = unique_edges.FindIndex(it.Value()) - 1;
        if (other != plan.index && listed.count(other) > 0) {
          why = "edges " + std::to_string(plan.index) + " and " + std::to_string(other) +
                " meet at a vertex: two-leg profile blends have no corner patch (round one edge per vertex, or use equal legs)";
          return nullptr;
        }
      }
  }

  // the legs must fit on their faces before a chamfer is asked for them
  for (const EdgePlan &plan : plans) {
    const BRepAdaptor_Curve curve(plan.edge);
    Section probe;
    for (const double fraction : {0.0, 0.5, 1.0})
      if (!section_at(plan, curve, plan.length * fraction, kind, param, probe, why)) return nullptr;
  }

  // 1. the chamfer of the legs
  const naming::Named input = naming::named(source);
  const std::vector<std::string> edge_names = naming::edge_names(shape, input.names);
  naming::Named chamfered;
  const char *chamfer_kind = varying ? "variable" : "occt";
  if (varying) {
    std::vector<ChamferEdge> each;
    for (const EdgePlan &plan : plans)
      each.push_back({static_cast<uint32_t>(plan.index), unique_faces.FindIndex(plan.faces[0]) - 1, {plan.leg[0], plan.leg[1], plan.leg[2], plan.leg[3]}});
    std::string chamfer_why;
    const std::unique_ptr<Shape> built = chamfer_per_edge(source, each, chamfer_why);
    if (!built) {
      why = "the chamfer the contact lines come from could not be built: " + chamfer_why;
      return nullptr;
    }
    chamfered = naming::named(*built);
  } else {
    BRepFilletAPI_MakeChamfer maker(shape);
    for (const EdgePlan &plan : plans) maker.Add(plan.leg[0], plan.leg[2], plan.edge, plan.faces[0]);
    maker.Build();
    if (!maker.IsDone() || maker.Shape().IsNull() || !BRepCheck_Analyzer(maker.Shape(), Standard_True).IsValid()) {
      why = "the chamfer the contact lines come from could not be built (the legs may reach past a face)";
      return nullptr;
    }
    // OCCT chamfers the whole tangent chain of an edge: every edge of every contour needs its sections
    for (int contour = 1; contour <= maker.NbContours(); ++contour)
      for (int k = 1; k <= maker.NbEdges(contour); ++k) {
        const int index = unique_edges.FindIndex(maker.Edge(contour, k)) - 1;
        if (listed.count(index) == 0) {
          why = "edge " + std::to_string(index) + " continues the tangent chain of a listed edge and is chamfered with it: list every edge of the chain with its legs";
          return nullptr;
        }
      }
    const std::vector<naming::Named> inputs{input};
    chamfered = naming::Named{maker.Shape(), naming::inherit(maker.Shape(), inputs, naming::history_of(inputs, maker), "chamfer")};
  }
  const TopTools_IndexedMapOfShape chamfered_faces = query::distinct(chamfered.shape, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
  TopExp::MapShapesAndAncestors(chamfered.shape, TopAbs_EDGE, TopAbs_FACE, edge_faces);

  // 2. the sections, the new faces, and what the ends of the old ones touch
  std::vector<TopoDS_Face> replaced_faces, new_faces;
  std::vector<std::string> new_names;
  std::vector<Edit> edits;
  const auto edit_of = [&edits](const TopoDS_Face &face) -> Edit & {
    for (Edit &edit : edits)
      if (edit.face.IsSame(face)) return edit;
    edits.push_back(Edit{face, {}});
    return edits.back();
  };
  double leg_gap = 0;
  double blend_tolerance = 0;
  for (const EdgePlan &plan : plans) {
    const std::string chamfer_name = "chamfer(" + edge_names[static_cast<size_t>(plan.index)] + ")";
    TopoDS_Face chamfer_face;
    int found = 0;
    for (int f = 1; f <= chamfered_faces.Extent(); ++f)
      if (chamfered.names[static_cast<size_t>(f - 1)] == chamfer_name) {
        chamfer_face = TopoDS::Face(chamfered_faces(f));
        ++found;
      }
    if (found != 1) {
      why = "the chamfer of edge " + std::to_string(plan.index) + " has " + std::to_string(found) + " faces named " + chamfer_name + " (one is needed)";
      return nullptr;
    }
    const BRepAdaptor_Curve curve(plan.edge);
    const Handle(Geom_BSplineSurface) surface = skin_edge(plan, curve, kind, param, kDeviationFraction * diagonal, why);
    if (surface.IsNull()) return nullptr;
    // the contact points are the chamfer's own: compare them with the chamfer face
    for (int k = 0; k <= kLegChecks; ++k) {
      Section section;
      if (!section_at(plan, curve, plan.length * k / kLegChecks, kind, param, section, why)) return nullptr;
      for (const gp_Pnt &contact : {section.a, section.b}) {
        BRepExtrema_DistShapeShape distance(BRepBuilderAPI_MakeVertex(contact).Vertex(), chamfer_face);
        if (!distance.IsDone()) {
          why = "the contact points could not be compared with the chamfer face";
          return nullptr;
        }
        leg_gap = std::max(leg_gap, distance.Value());
      }
    }
    double u0, u1, v0, v1;
    surface->Bounds(u0, u1, v0, v1);
    BRepBuilderAPI_MakeFace made(surface, u0, u1, v0, v1, 1e-9 * diagonal);
    if (!made.IsDone()) {
      why = "the blend surface could not be turned into a face";
      return nullptr;
    }
    if (!plan.closed) {
      Section from, to;
      if (!section_at(plan, curve, 0.0, kind, param, from, why) || !section_at(plan, curve, plan.length, kind, param, to, why)) return nullptr;
      const double tolerance = 1e-4 * std::min(std::min(plan.leg[0], plan.leg[1]), std::min(plan.leg[2], plan.leg[3])) + 1e-7 * diagonal;
      const Section *ends_of[2] = {&from, &to};
      for (int end = 0; end < 2; ++end) {
        TopoDS_Edge edge;
        TopoDS_Face neighbour;
        if (!end_edge_of(chamfer_face, edge_faces, ends_of[end]->a, ends_of[end]->b, tolerance, edge, neighbour)) {
          why = "the chamfer face of edge " + std::to_string(plan.index) + " does not end on a face square to the edge at its " + (end == 0 ? "start" : "end") +
                " (two-leg blends end on a flat face perpendicular to the edge)";
          return nullptr;
        }
        if (BRepAdaptor_Surface(neighbour, Standard_True).GetType() != GeomAbs_Plane) {
          why = "internal error (report it): the blend of edge " + std::to_string(plan.index) + " ends on a curved face at its " + (end == 0 ? "start" : "end") + " (two-leg blends end on a flat face)";
          return nullptr;
        }
        edit_of(neighbour).replacements.push_back({edge, surface->VIso(end == 0 ? v0 : v1), {}});
      }
    }
    for (TopExp_Explorer it(chamfer_face, TopAbs_EDGE); it.More(); it.Next()) blend_tolerance = std::max(blend_tolerance, BRep_Tool::Tolerance(TopoDS::Edge(it.Current())));
    replaced_faces.push_back(chamfer_face);
    new_faces.push_back(made.Face());
    new_names.push_back("blend" + chamfer_name.substr(std::string("chamfer").size()));
  }
  const double accepted_gap = blend::kGapAccepted * kGapLimit * diagonal;
  if (leg_gap > accepted_gap) {
    why = "internal error (report it): the contact lines of the chamfer deviate from the chord legs by " + number_text(leg_gap) + " (limit " + number_text(accepted_gap) +
          " = 0.95 x 1e-6 x the diagonal): the legs are not measured as the chord in the plane perpendicular to the edge there";
    return nullptr;
  }
  std::vector<TopoDS_Face> rebuilt;
  std::vector<TopoDS_Face> rebuilt_from;
  for (const Edit &edit : edits) {
    TopoDS_Face face;
    if (!rails::rebuild_face(rails::FaceEdit{edit.face, edit.replacements}, face, why)) return nullptr;
    rebuilt.push_back(face);
    rebuilt_from.push_back(edit.face);
  }

  // 3. sew
  BRepBuilderAPI_Sewing sewing(std::min(std::max(kSewingFraction * diagonal, 2.0 * blend_tolerance), kSewingCap * diagonal));
  std::vector<TopoDS_Face> members;
  std::vector<std::string> member_names;
  const auto is_in = [](const std::vector<TopoDS_Face> &list, const TopoDS_Shape &face) {
    return std::any_of(list.begin(), list.end(), [&](const TopoDS_Face &known) { return known.IsSame(face); });
  };
  for (int f = 1; f <= chamfered_faces.Extent(); ++f) {
    if (is_in(replaced_faces, chamfered_faces(f)) || is_in(rebuilt_from, chamfered_faces(f))) continue;
    members.push_back(TopoDS::Face(chamfered_faces(f)));
    member_names.push_back(chamfered.names[static_cast<size_t>(f - 1)]);
  }
  const size_t stays = members.size();
  for (size_t k = 0; k < new_faces.size(); ++k) {
    members.push_back(new_faces[k]);
    member_names.push_back(new_names[k]);
  }
  for (size_t k = 0; k < rebuilt.size(); ++k) {
    members.push_back(rebuilt[k]);
    member_names.push_back(chamfered.names[static_cast<size_t>(chamfered_faces.FindIndex(rebuilt_from[k]) - 1)]);
  }
  for (const TopoDS_Face &face : members) sewing.Add(face);
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  if (sewing.NbFreeEdges() > 0) {
    why = "internal error (report it): the blend faces do not close the solid (" + std::to_string(sewing.NbFreeEdges()) + " free edge(s) after sewing): the contact lines of the blend and of the chamfer differ";
    return nullptr;
  }
  std::string shells_why;
  TopoDS_Solid solid = blend::solid_of_shells(sewn, shells_why);
  if (solid.IsNull() && !shells_why.empty()) {
    why = "internal error (report it): the blend cannot hold the sewn shells in one solid: " + shells_why;
    return nullptr;
  }
  if (solid.IsNull() || !BRepCheck_Analyzer(solid, Standard_True).IsValid()) {
    why = "internal error (report it): the blend fails the BRepCheck validity analysis";
    return nullptr;
  }
  // The profile's solid lies between the source and its chamfer.
  const double before = volume_of(shape), chamfer_volume = volume_of(chamfered.shape), after = volume_of(solid);
  // every edge has the same sense (mixed steps are refused above)
  const bool convex = plans.front().convex;
  if (!(after > 0) || (convex && !(after > chamfer_volume && after < before)) || (!convex && !(after < chamfer_volume && after > before))) {
    why = "the blend volume " + number_text(after) + " is not between the source's " + number_text(before) + " and the chamfer's " + number_text(chamfer_volume) +
          ": the section leaves the solid (the tangent lines of the supports meet too far from the corner for these legs; use smaller legs)";
    return nullptr;
  }
  // the real gap along every edge a new face shares with a neighbour
  const TopTools_IndexedMapOfShape final_faces = query::distinct(solid, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape solid_edge_faces;
  TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, solid_edge_faces);
  double gap = 0;
  for (size_t m = stays; m < members.size(); ++m) {
    const TopoDS_Shape image = sewing.IsModified(members[m]) ? sewing.Modified(members[m]) : members[m];
    for (TopExp_Explorer it(image, TopAbs_EDGE); it.More(); it.Next()) {
      const TopoDS_Edge edge = TopoDS::Edge(it.Current());
      if (!solid_edge_faces.Contains(edge)) continue;
      std::vector<TopoDS_Face> around;
      for (TopTools_ListIteratorOfListOfShape owner(solid_edge_faces.FindFromKey(edge)); owner.More(); owner.Next())
        if (around.empty() || !around.front().IsSame(owner.Value())) around.push_back(TopoDS::Face(owner.Value()));
      if (around.size() != 2) continue;
      double first = 0, last = 0, first2 = 0, last2 = 0;
      const Handle(Geom2d_Curve) on_first = BRep_Tool::CurveOnSurface(edge, around[0], first, last);
      const Handle(Geom2d_Curve) on_second = BRep_Tool::CurveOnSurface(edge, around[1], first2, last2);
      if (on_first.IsNull() || on_second.IsNull()) continue;
      const BRepAdaptor_Surface one(around[0], Standard_False), two(around[1], Standard_False);
      for (int k = 0; k <= 40; ++k) {
        const double u = static_cast<double>(k) / 40;
        const gp_Pnt2d a = on_first->Value(first + (last - first) * u), b = on_second->Value(first2 + (last2 - first2) * u);
        gap = std::max(gap, one.Value(a.X(), a.Y()).Distance(two.Value(b.X(), b.Y())));
      }
    }
  }
  const double accepted = blend::kGapAccepted * kGapLimit * std::min(diagonal, std::max(diagonal_of(solid), 1e-9));
  if (gap > accepted) {
    why = "the blend faces meet their neighbours only to " + number_text(gap) + " (limit " + number_text(accepted) + " = 0.95 x 1e-6 x the smaller bounding-box diagonal)" +
          std::string(varying ? "; running legs come from a 65-station loft of the chamfer, which is the likely cause (use constant legs or a smaller part scale)" : "");
    return nullptr;
  }
  std::vector<std::string> names(static_cast<size_t>(final_faces.Extent()));
  for (size_t m = 0; m < members.size(); ++m) {
    const TopoDS_Shape image = sewing.IsModified(members[m]) ? sewing.Modified(members[m]) : members[m];
    const int index = final_faces.FindIndex(image);
    if (index > 0) names[static_cast<size_t>(index - 1)] = member_names[m];
  }
  JsonWriter out;
  out.begin_object().key("builder").string("legs").key("chamfer").string(chamfer_kind).key("gap").number(gap).key("gapLimit").number(accepted).key("legGap").number(leg_gap).end_object();
  notes = out.text();
  return naming::wrap_named(solid, names);
}

}  // namespace llull
