// Profile blends with two legs (`size2`) on curved edges, curved faces and with legs that vary (BLD §13.34, DES-6c). The circular fillet of OCCT has no
// asymmetric counterpart, so the contact lines of a leg pair are the ones of the CHAMFER of those legs: a leg is the chord of length d in the plane
// perpendicular to the edge (the definition of the chamfer, §13.24), and the chamfer face is bounded by exactly those two lines on the supports.
// 1. The chamfer of the legs: OCCT's two-distance chamfer for constant legs (open or closed edges, any faces), the variable chamfer of blend_chamfer.cxx
//    for legs that run linearly along the edge. Its supports are trimmed at the contact lines.
// 2. Per station along each edge the contact points A, B are computed again from the source (leg_point), the apex T of the tangent lines of the two supports
//    at A and B in the plane perpendicular to the edge, and the section is the conic (A, T, B) of the profile's weight (a conic: rho / (1 - rho); a circular
//    profile: sin(wedge / 2), the weight of the circular arc between the same tangents), so the new face is G1 to both supports along the contact lines.
// 3. The chamfer face is replaced by the surface interpolating the sections (stations inserted where the surface misses a section by 1e-8 x the diagonal),
//    the end faces it met are rebuilt around the new section curve, and everything is sewn. The measured gap to the supports and the volume window
//    (between the source and the chamfer, the profile's solid) are the acceptance; reasons carry no BLD code.
// Scope: edges that do not meet at a vertex, flat square ends (or a closed edge), a conic or circular section; a curvature section is refused by name.
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

namespace llull {

using namespace blend;

bool blend::face_unit_normal(const TopoDS_Face &face, const gp_Pnt &point, gp_Vec &normal) {
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

bool blend::leg_point(const TopoDS_Face &face, const gp_Pnt &corner, const gp_Vec &tangent, const gp_Vec &inward, double d, gp_Pnt &out) {
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

namespace {

// How far (x the diagonal) the interpolated section poles may leave the true sections between two stations.
constexpr double kDeviationFraction = 1e-8;
// Stations along an edge before refinement, and the most refinement inserts.
constexpr int kFirstStations = 24, kMostStations = 6000;
// A built gap is accepted up to kGapAccepted x this fraction of the smaller true diagonal: the default g0 of check_blends, because a circular two-leg row is judged at g0 (a profile row at 5 x it).
constexpr double kGapLimit = 1e-6;
constexpr double kSewingFraction = 1e-6, kSewingCap = 1e-3;
// Stations at which the contact points are compared with the chamfer face.
constexpr int kLegChecks = 21;
// Two unit tangents closer than this to parallel have no apex.
constexpr double kDegenerate = 1e-6;
// Leg numbers of one edge in the `legs` array.
constexpr size_t kLegWidth = 6;

// One section of the blend: the contact points, the apex of their tangent lines and the weight of the conic.
struct Section {
  gp_Pnt a, t, b;
  double weight = 1;
};

// One source edge and what its sections need.
struct EdgePlan {
  int index = 0;
  TopoDS_Edge edge;
  TopoDS_Face faces[2];  // faces[0] carries the first leg
  bool flip[2] = {false, false};
  double sign[2] = {1, 1};  // the side of normal x tangent that runs away from the edge inside face k
  bool convex = true;
  bool closed = false;
  double length = 0;
  double leg[4] = {0, 0, 0, 0};  // first start, first end, second start, second end (linear in the arc length)
  double at(int k, double s) const { return leg[2 * k] + (leg[2 * k + 1] - leg[2 * k]) * (s / length); }
};

double volume_of(const TopoDS_Shape &shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

std::string number_text(double value) {
  std::ostringstream text;
  text.precision(6);
  text << value;
  return text.str();
}

// The section of `plan` at arc length `s` from the start of the edge; false with the reason in `why`.
bool section_at(const EdgePlan &plan, const BRepAdaptor_Curve &curve, double s, int kind, double param, Section &out, std::string &why) {
  GCPnts_AbscissaPoint place(curve, s, curve.FirstParameter());
  if (!place.IsDone()) {
    why = "edge " + std::to_string(plan.index) + " could not be measured along its length";
    return false;
  }
  gp_Pnt corner;
  gp_Vec tangent;
  curve.D1(place.Parameter(), corner, tangent);
  if (tangent.Magnitude() < 1e-12) {
    why = "edge " + std::to_string(plan.index) + " has no tangent at a station";
    return false;
  }
  tangent.Normalize();
  gp_Pnt contact[2];
  gp_Vec direction[2], normals[2], inward[2];
  for (int f = 0; f < 2; ++f) {
    gp_Vec &normal = normals[f];
    if (!face_unit_normal(plan.faces[f], corner, normal)) {
      why = "edge " + std::to_string(plan.index) + " meets a face with no normal at a station";
      return false;
    }
    if (plan.flip[f]) normal.Reverse();
    gp_Vec across = normal.Crossed(tangent);
    if (across.Magnitude() < kDegenerate) {
      why = "edge " + std::to_string(plan.index) + " lies along the normal of a face";
      return false;
    }
    across.Normalize();
    inward[f] = across * plan.sign[f];
    if (!leg_point(plan.faces[f], corner, tangent, inward[f], plan.at(f, s), contact[f])) {
      why = "a leg of " + number_text(plan.at(f, s)) + " reaches past the faces of edge " + std::to_string(plan.index) + ", or does not settle on them (at " +
            number_text(s) + " along it); use smaller sizes";
      return false;
    }
    // the tangent line of the support at the contact point, in the plane perpendicular to the edge
    gp_Vec normal_here;
    if (!face_unit_normal(plan.faces[f], contact[f], normal_here)) {
      why = "edge " + std::to_string(plan.index) + ": a support has no normal at a contact point";
      return false;
    }
    direction[f] = tangent.Crossed(normal_here);
    if (direction[f].Magnitude() < kDegenerate) {
      why = "edge " + std::to_string(plan.index) + ": a support is perpendicular to the plane of the section at a contact point";
      return false;
    }
    direction[f].Normalize();
  }
  // the corner keeps its sense along the edge (the chamfer builder's rule)
  const double fold0 = inward[0].Dot(normals[1]), fold1 = inward[1].Dot(normals[0]);
  if (std::fabs(fold0) < kDegenerate || std::fabs(fold1) < kDegenerate || (fold1 < 0) != plan.convex || (fold0 < 0) != plan.convex) {
    why = "edge " + std::to_string(plan.index) + " joins tangent faces or changes between convex and concave at " + number_text(s) + " along it";
    return false;
  }
  // apex: the closest point of the two tangent lines A + alpha dA, B + beta dB (they meet: both lie in the plane perpendicular to the edge)
  const double cross = direction[0].Dot(direction[1]);
  const double determinant = 1.0 - cross * cross;
  if (determinant < kDegenerate) {
    why = "the supports of edge " + std::to_string(plan.index) + " are tangent to each other at " + number_text(s) + " along it (no corner to blend)";
    return false;
  }
  const gp_Vec ab(contact[0], contact[1]);
  const double p = ab.Dot(direction[0]), q = ab.Dot(direction[1]);
  const double alpha = (p - cross * q) / determinant;
  const double beta = (cross * p - q) / determinant;
  const gp_Pnt on_a = contact[0].Translated(direction[0] * alpha), on_b = contact[1].Translated(direction[1] * beta);
  const gp_Pnt apex(0.5 * (on_a.XYZ() + on_b.XYZ()));
  // the apex lies on the corner side of both contact points, past the chord
  const gp_Vec to_corner_a(contact[0], corner), to_corner_b(contact[1], corner);
  if (!(gp_Vec(contact[0], apex).Dot(to_corner_a) > 0) || !(gp_Vec(contact[1], apex).Dot(to_corner_b) > 0)) {
    why = "the tangent lines of the supports meet behind the contact points of edge " + std::to_string(plan.index) + " at " + number_text(s) +
          " along it (the legs are too long for this corner)";
    return false;
  }
  const gp_Vec to_a(apex, contact[0]), to_b(apex, contact[1]);
  const double cosine = to_a.Dot(to_b) / (to_a.Magnitude() * to_b.Magnitude());
  const double wedge = std::acos(std::max(-1.0, std::min(1.0, cosine)));
  out.a = contact[0];
  out.b = contact[1];
  out.t = apex;
  out.weight = kind == 0 ? param / (1.0 - param) : std::sin(wedge / 2.0);
  return true;
}


// The surface interpolating the sections at `along` (a closed edge: the last section is not repeated and `period_end` closes the period): u runs across (the
// rational quadratic A, T, B), v along. `rows_out` holds the interpolated pole curves A, w T, B and the weights.
Handle(Geom_BSplineSurface) skin(const std::vector<Section> &stations, const std::vector<double> &along, double period_end, bool closed, double tolerance,
                                 std::vector<Handle(Geom_BSplineCurve)> &rows_out, std::string &why) {
  const int count = static_cast<int>(stations.size());
  Handle(TColStd_HArray1OfReal) parameters = new TColStd_HArray1OfReal(1, closed ? count + 1 : count);
  for (int j = 1; j <= parameters->Length(); ++j) parameters->SetValue(j, j <= count ? along[static_cast<size_t>(j - 1)] : period_end);
  std::vector<Handle(Geom_BSplineCurve)> curves;
  for (int i = 0; i < 4; ++i) {
    Handle(TColgp_HArray1OfPnt) points = new TColgp_HArray1OfPnt(1, count);
    for (int j = 0; j < count; ++j) {
      const Section &s = stations[static_cast<size_t>(j)];
      const gp_Pnt &pole = i == 0 ? s.a : (i == 1 ? s.t : s.b);
      // the apex row is interpolated as w T, the weight row as (w, v): the station parameter keeps equal weights apart (coincident points are refused)
      const double scale = i == 1 ? s.weight : 1.0;
      if (i == 3) points->SetValue(j + 1, gp_Pnt(s.weight, along[static_cast<size_t>(j)], 0));
      else points->SetValue(j + 1, gp_Pnt(scale * pole.X(), scale * pole.Y(), scale * pole.Z()));
    }
    GeomAPI_Interpolate interpolation(points, parameters, closed ? Standard_True : Standard_False, tolerance);
    interpolation.Perform();
    if (!interpolation.IsDone()) {
      why = "the section poles could not be interpolated along the blend";
      return nullptr;
    }
    curves.push_back(interpolation.Curve());
  }
  const Handle(Geom_BSplineCurve) &first = curves.front();
  const int columns = first->NbPoles();
  for (const auto &curve : curves)
    if (curve->NbPoles() != columns || curve->Degree() != first->Degree() || curve->NbKnots() != first->NbKnots()) {
      why = "the pole curves of a blend do not share their knots";
      return nullptr;
    }
  rows_out = curves;
  TColgp_Array2OfPnt grid(1, 3, 1, columns);
  TColStd_Array2OfReal pole_weights(1, 3, 1, columns);
  for (int j = 1; j <= columns; ++j) {
    const double weight = curves[3]->Pole(j).X();
    if (!(weight > 1e-9)) {
      why = "the section weights of the blend interpolate to a non-positive weight";
      return nullptr;
    }
    for (int i = 0; i < 3; ++i) {
      const gp_Pnt pole = curves[static_cast<size_t>(i)]->Pole(j);
      const double divisor = i == 1 ? weight : 1.0;
      grid.SetValue(i + 1, j, gp_Pnt(pole.X() / divisor, pole.Y() / divisor, pole.Z() / divisor));
      pole_weights.SetValue(i + 1, j, i == 1 ? weight : 1.0);
    }
  }
  TColStd_Array1OfReal u_knots(1, 2), v_knots(1, first->NbKnots());
  u_knots.SetValue(1, 0.0);
  u_knots.SetValue(2, 1.0);
  for (int k = 1; k <= first->NbKnots(); ++k) v_knots.SetValue(k, first->Knot(k));
  TColStd_Array1OfInteger u_mults(1, 2), v_mults(1, first->NbKnots());
  u_mults.SetValue(1, 3);
  u_mults.SetValue(2, 3);
  for (int k = 1; k <= first->NbKnots(); ++k) v_mults.SetValue(k, first->Multiplicity(k));
  return new Geom_BSplineSurface(grid, pole_weights, u_knots, v_knots, u_mults, v_mults, 2, first->Degree(), Standard_False,
                                 first->IsPeriodic() ? Standard_True : Standard_False);
}

// The skin of the blend of `plan`, with stations inserted where the interpolated section poles miss the true ones by more than `limit` between two stations.
Handle(Geom_BSplineSurface) skin_edge(const EdgePlan &plan, const BRepAdaptor_Curve &curve, int kind, double param, double limit, std::string &why) {
  std::map<double, Section> truth;
  const auto truth_at = [&](double at, const Section *&out) {
    auto found = truth.find(at);
    if (found == truth.end()) {
      Section section;
      if (!section_at(plan, curve, at, kind, param, section, why)) return false;
      found = truth.emplace(at, section).first;
    }
    out = &found->second;
    return true;
  };
  std::vector<double> along;
  std::vector<Section> stations;
  for (int j = 0; j < (plan.closed ? kFirstStations : kFirstStations + 1); ++j) {
    const Section *section = nullptr;
    const double at = plan.length * j / kFirstStations;
    if (!truth_at(at, section)) return nullptr;
    along.push_back(at);
    stations.push_back(*section);
  }
  for (;;) {
    std::vector<Handle(Geom_BSplineCurve)> rows;
    const Handle(Geom_BSplineSurface) surface = skin(stations, along, plan.length, plan.closed, 1e-14, rows, why);
    if (surface.IsNull()) return nullptr;
    std::vector<double> added;
    std::vector<Section> added_sections;
    double worst = 0;
    const size_t intervals = plan.closed ? along.size() : along.size() - 1;
    for (size_t j = 0; j < intervals; ++j) {
      const double from = along[j], to = j + 1 < along.size() ? along[j + 1] : plan.length;
      const double at = 0.5 * (from + to);
      const Section *middle = nullptr;
      if (!truth_at(at, middle)) return nullptr;
      const gp_Pnt want[3] = {middle->a, gp_Pnt(middle->weight * middle->t.X(), middle->weight * middle->t.Y(), middle->weight * middle->t.Z()), middle->b};
      double gap = std::fabs(rows[3]->Value(at).X() - middle->weight) * middle->a.Distance(middle->t);
      for (int i = 0; i < 3; ++i) gap = std::max(gap, rows[static_cast<size_t>(i)]->Value(at).Distance(want[i]));
      worst = std::max(worst, gap);
      if (gap > limit) {
        if (to - from < 1e-9 * plan.length) {
          why = "the blend surface follows the sections only to " + number_text(gap) + " (limit " + number_text(limit) + ") where the contact lines kink";
          return nullptr;
        }
        added.push_back(at);
        added_sections.push_back(*middle);
      }
    }
    if (added.empty()) return surface;
    if (along.size() + added.size() > static_cast<size_t>(kMostStations)) {
      why = "the blend surface follows the sections only to " + number_text(worst) + " (limit " + number_text(limit) + ") with " + std::to_string(along.size()) +
            " stations";
      return nullptr;
    }
    for (size_t k = 0; k < added.size(); ++k) {
      const auto place = std::lower_bound(along.begin(), along.end(), added[k]) - along.begin();
      along.insert(along.begin() + place, added[k]);
      stations.insert(stations.begin() + place, added_sections[k]);
    }
  }
}

// The plan of one edge from its numbers; false with the reason in `why`.
bool make_plan(const TopoDS_Shape &shape, const TopTools_IndexedMapOfShape &unique_edges, const TopTools_IndexedMapOfShape &unique_faces,
               const TopTools_IndexedDataMapOfShapeListOfShape &owners, const double *numbers, double diagonal, EdgePlan &plan, std::string &why) {
  const int index = static_cast<int>(numbers[0]);
  if (index < 0 || index >= unique_edges.Extent()) {
    why = "edge index out of range";
    return false;
  }
  plan.index = index;
  const std::string label = "edge " + std::to_string(index);
  plan.edge = TopoDS::Edge(unique_edges(index + 1));
  const BRepAdaptor_Curve curve(plan.edge);
  std::vector<TopoDS_Face> around;
  for (TopTools_ListIteratorOfListOfShape it(owners.FindFromKey(plan.edge)); it.More(); it.Next()) {
    const TopoDS_Face face = TopoDS::Face(it.Value());
    if (std::none_of(around.begin(), around.end(), [&](const TopoDS_Face &known) { return known.IsSame(face); })) around.push_back(face);
  }
  if (around.size() != 2) {
    why = label + " does not join exactly two faces";
    return false;
  }
  const int side = static_cast<int>(numbers[1]);
  if (side < 0 || side >= unique_faces.Extent() || !(unique_faces(side + 1).IsSame(around[0]) || unique_faces(side + 1).IsSame(around[1]))) {
    why = "side1 is not a face of " + label;
    return false;
  }
  if (unique_faces(side + 1).IsSame(around[1])) std::swap(around[0], around[1]);
  plan.faces[0] = around[0];
  plan.faces[1] = around[1];
  plan.length = GCPnts_AbscissaPoint::Length(curve);
  plan.closed = curve.Value(curve.FirstParameter()).Distance(curve.Value(curve.LastParameter())) < 1e-7 * diagonal;
  const double size = numbers[2], size_end = std::isnan(numbers[3]) ? numbers[2] : numbers[3];
  const double size2 = numbers[4], size2_end = std::isnan(numbers[5]) ? numbers[4] : numbers[5];
  plan.leg[0] = size;
  plan.leg[1] = size_end;
  plan.leg[2] = size2;
  plan.leg[3] = size2_end;
  for (const double leg : plan.leg)
    if (!(leg > 0) || !std::isfinite(leg)) {
      why = "the legs must be > 0";
      return false;
    }
  if (!(plan.length > 1e-9 * diagonal)) {
    why = label + " has no length";
    return false;
  }
  if (plan.closed && (size != size_end || size2 != size2_end)) {
    why = label + " is a closed edge: legs that run from a start to an end have no start and end around it; give constant sizes";
    return false;
  }
  // which way each face runs away from the edge, and whether the edge is convex: read at the middle (the answers hold along the edge, which section_at checks)
  gp_Pnt corner;
  gp_Vec tangent;
  GCPnts_AbscissaPoint middle(curve, 0.5 * plan.length, curve.FirstParameter());
  if (!middle.IsDone()) {
    why = label + " could not be measured along its length";
    return false;
  }
  curve.D1(middle.Parameter(), corner, tangent);
  if (tangent.Magnitude() < 1e-12) {
    why = label + " has no tangent at its middle";
    return false;
  }
  tangent.Normalize();
  gp_Vec normal[2], inward[2];
  BRepClass3d_SolidClassifier classifier(shape);
  for (int f = 0; f < 2; ++f) {
    if (!face_unit_normal(plan.faces[f], corner, normal[f])) {
      why = label + " meets a face with no normal at its middle";
      return false;
    }
    classifier.Perform(corner.Translated(normal[f] * (1e-4 * diagonal)), 1e-9);
    plan.flip[f] = classifier.State() == TopAbs_IN;
    if (plan.flip[f]) normal[f].Reverse();
    gp_Vec across = normal[f].Crossed(tangent);
    if (across.Magnitude() < kDegenerate) {
      why = label + " lies along the normal of a face";
      return false;
    }
    across.Normalize();
    // The face lies to the left of its boundary edge seen from its own (oriented) normal, whatever the orientation flag says about the solid: the way into the
    // face is N x T with both taken with the face's orientation. A seam (the edge twice in the face) has no single way in.
    int seen = 0;
    double edge_sense = 1.0;
    for (TopExp_Explorer it(plan.faces[f], TopAbs_EDGE); it.More(); it.Next())
      if (it.Current().IsSame(plan.edge)) {
        ++seen;
        edge_sense = it.Current().Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
      }
    gp_Vec face_normal;
    if (seen != 1 || !face_unit_normal(plan.faces[f], corner, face_normal)) {
      why = "cannot tell which way face " + std::to_string(f + 1) + " runs away from " + label + " (the edge is a seam of the face or the face has no normal there)";
      return false;
    }
    const gp_Vec way = face_normal.Crossed(tangent * edge_sense);
    plan.sign[f] = way.Dot(across) >= 0 ? 1.0 : -1.0;
    inward[f] = across * plan.sign[f];
  }
  const double fold0 = inward[0].Dot(normal[1]), fold1 = inward[1].Dot(normal[0]);
  if (std::fabs(fold0) < kDegenerate || std::fabs(fold1) < kDegenerate) {
    why = label + " joins tangent faces (no corner to blend)";
    return false;
  }
  plan.convex = fold1 < 0;
  return true;
}

// The edge of `face` whose two vertices are the contact points `a`, `b` (either order) and the other face it joins, or false.
bool end_edge_of(const TopoDS_Face &face, const TopTools_IndexedDataMapOfShapeListOfShape &edge_faces, const gp_Pnt &a, const gp_Pnt &b, double tolerance,
                 TopoDS_Edge &edge, TopoDS_Face &neighbour) {
  TopTools_IndexedMapOfShape seen;
  for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
    if (!seen.Add(it.Current())) continue;
    const TopoDS_Edge candidate = TopoDS::Edge(it.Current());
    TopoDS_Vertex first, last;
    TopExp::Vertices(candidate, first, last);
    if (first.IsNull() || last.IsNull()) continue;
    const gp_Pnt p = BRep_Tool::Pnt(first), q = BRep_Tool::Pnt(last);
    const bool match = (p.Distance(a) < tolerance && q.Distance(b) < tolerance) || (p.Distance(b) < tolerance && q.Distance(a) < tolerance);
    if (!match) continue;
    for (TopTools_ListIteratorOfListOfShape owner(edge_faces.FindFromKey(candidate)); owner.More(); owner.Next())
      if (!owner.Value().IsSame(face)) {
        edge = candidate;
        neighbour = TopoDS::Face(owner.Value());
        return true;
      }
  }
  return false;
}

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
          why = "the blend of edge " + std::to_string(plan.index) + " ends on a curved face at its " + (end == 0 ? "start" : "end") + " (two-leg blends end on a flat face)";
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
    why = "the contact lines of the chamfer deviate from the chord legs by " + number_text(leg_gap) + " (limit " + number_text(accepted_gap) +
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
    why = "the blend faces do not close the solid (" + std::to_string(sewing.NbFreeEdges()) + " free edge(s) after sewing): the contact lines of the blend and of the chamfer differ";
    return nullptr;
  }
  std::string shells_why;
  TopoDS_Solid solid = blend::solid_of_shells(sewn, shells_why);
  if (solid.IsNull() && !shells_why.empty()) {
    why = "the blend cannot hold the sewn shells in one solid: " + shells_why;
    return nullptr;
  }
  if (solid.IsNull() || !BRepCheck_Analyzer(solid, Standard_True).IsValid()) {
    why = "the blend fails the BRepCheck validity analysis";
    return nullptr;
  }
  // The profile's solid lies between the source and its chamfer.
  const double before = volume_of(shape), chamfer_volume = volume_of(chamfered.shape), after = volume_of(solid);
  const bool all_convex = std::all_of(plans.begin(), plans.end(), [](const EdgePlan &plan) { return plan.convex; });
  const bool all_concave = std::none_of(plans.begin(), plans.end(), [](const EdgePlan &plan) { return plan.convex; });
  if (!(after > 0) || (all_convex && !(after > chamfer_volume && after < before)) || (all_concave && !(after < chamfer_volume && after > before))) {
    why = "the blend volume " + number_text(after) + " is not between the source's " + number_text(before) + " and the chamfer's " + number_text(chamfer_volume);
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
    why = "the blend faces meet their neighbours only to " + number_text(gap) + " (limit " + number_text(accepted) + " = 0.95 x 1e-6 x the smaller bounding-box diagonal)";
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
