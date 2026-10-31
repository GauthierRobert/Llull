// Plan and sections of the two-leg profile blend (BLD §13.34): the chord legs on the supports (leg_point), the apex of their tangent lines, the interpolated
// skin of the sections and the plan of one edge. cpp/blend_legs.cxx assembles the blend.
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

#include "llull-kernel-occt/cpp/blend_legs.hxx"

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

namespace blend {
namespace legs {

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

std::vector<gp_Pnt> curvature_poles(const Section &s, double shape) {
  const double lead = 0.8 * shape, reach = 0.4 * shape + 0.6;
  return {s.a,
          s.a.Translated(gp_Vec(s.a, s.t) * lead),
          s.a.Translated(gp_Vec(s.a, s.t) * reach + s.bend_a),
          s.b.Translated(gp_Vec(s.b, s.t) * reach + s.bend_b),
          s.b.Translated(gp_Vec(s.b, s.t) * lead),
          s.b};
}

namespace {

// How far (x the chord A B) a curvature section may leave its triangle: a support that curves away from the corner makes the G2 section start on its far side of the
// tangent line, by up to the sag of the support; beyond this fraction the section bulges (the volume window and the measured gap judge the rest).
constexpr double kTriangleSlack = 1e-3;

// The bends that give the quintic the normal curvature of each support at its contact (the offset of the 3rd pole along the support normal is 1.25 kappa
// lead^2: Suu . N / |Su|^2 = 0.8 h / lead^2 at the start of a degree-5 Bezier), then the section measured: it must stay in the triangle A, T, B (the
// side of the chord that holds the corner, and the corner side of both tangent lines) and turn by less than pi (a loop turns by more).
bool curvature_section(const EdgePlan &plan, double shape, double s, Section &out, std::string &why) {
  const gp_Pnt ends[2] = {out.a, out.b};
  double kappas[2] = {0, 0}, offsets[2] = {0, 0};
  for (int side = 0; side < 2; ++side) {
    const gp_Pnt &from = ends[side];
    const double reach = from.Distance(out.t);
    gp_Vec nu;
    if (!support_curvature(plan.faces[side], from, gp_Vec(from, out.t), gp_Vec(from, ends[1 - side]), nu, kappas[side])) {
      why = "edge " + std::to_string(plan.index) + ": internal error (report it): the curvature of a support could not be read at a contact point (" + number_text(s) + " along it)";
      return false;
    }
    const double lead = 0.8 * shape * reach;
    offsets[side] = 1.25 * kappas[side] * lead * lead;
    (side == 0 ? out.bend_a : out.bend_b) = nu * offsets[side];
  }
  const std::vector<gp_Pnt> poles = curvature_poles(out, shape);
  const gp_Vec along_chord(out.a, out.b);
  const double chord = along_chord.Magnitude();
  const gp_Vec x_axis = along_chord / chord;
  gp_Vec up(out.a, out.t);
  up -= x_axis * up.Dot(x_axis);
  if (up.Magnitude() < 1e-12 * chord) {
    why = "edge " + std::to_string(plan.index) + ": internal error (report it): the tangent lines of the supports meet on the chord at " + number_text(s) + " along it (no corner)";
    return false;
  }
  const gp_Vec y_axis = up.Normalized();
  const auto plane = [&](const gp_Pnt &p) { return std::pair<double, double>(gp_Vec(out.a, p).Dot(x_axis), gp_Vec(out.a, p).Dot(y_axis)); };
  const std::pair<double, double> corners[3] = {plane(out.a), plane(out.t), plane(out.b)};
  // signed distance of q to the side k of the triangle, positive inside
  const auto inside_by = [&](int k, const std::pair<double, double> &q) {
    const auto &p = corners[k], &r = corners[(k + 1) % 3], &opposite = corners[(k + 2) % 3];
    const double dx = r.first - p.first, dy = r.second - p.second, length = std::hypot(dx, dy);
    const double reference = dx * (opposite.second - p.second) - dy * (opposite.first - p.first);
    const double here = dx * (q.second - p.second) - dy * (q.first - p.first);
    return (reference < 0 ? -here : here) / length;
  };
  double worst = 0, drift = 0, turn_low = 0, turn_high = 0, previous = 0;
  const gp_Vec z_axis = x_axis.Crossed(y_axis);
  constexpr int kSamples = 64;
  for (int k = 0; k <= kSamples; ++k) {
    const double u = static_cast<double>(k) / kSamples, v = 1.0 - u;
    const double basis[6] = {v * v * v * v * v, 5 * u * v * v * v * v, 10 * u * u * v * v * v, 10 * u * u * u * v * v, 5 * u * u * u * u * v, u * u * u * u * u};
    const double slope[5] = {5 * v * v * v * v, 20 * u * v * v * v, 30 * u * u * v * v, 20 * u * u * u * v, 5 * u * u * u * u};
    gp_Vec point(0, 0, 0), tangent(0, 0, 0);
    for (int i = 0; i < 6; ++i) point += gp_Vec(out.a, poles[static_cast<size_t>(i)]) * basis[i];
    for (int i = 0; i < 5; ++i) tangent += gp_Vec(poles[static_cast<size_t>(i)], poles[static_cast<size_t>(i + 1)]) * slope[i];
    const std::pair<double, double> q(point.Dot(x_axis), point.Dot(y_axis));
    drift = std::max(drift, std::fabs(point.Dot(z_axis)));
    for (int side = 0; side < 3; ++side) worst = std::max(worst, -inside_by(side, q));
    const double angle = std::atan2(tangent.Dot(y_axis), tangent.Dot(x_axis));
    double unwrapped = angle;
    if (k > 0) {
      while (unwrapped - previous > M_PI) unwrapped -= 2 * M_PI;
      while (unwrapped - previous < -M_PI) unwrapped += 2 * M_PI;
    } else {
      turn_low = turn_high = unwrapped;
    }
    previous = unwrapped;
    turn_low = std::min(turn_low, unwrapped);
    turn_high = std::max(turn_high, unwrapped);
  }
  const std::string needs = "the supports' normal curvatures " + number_text(kappas[0]) + " and " + number_text(kappas[1]) + " need pole offsets of " +
                            number_text(offsets[0]) + " and " + number_text(offsets[1]) + " (shape " + number_text(shape) + ")";
  if (worst > kTriangleSlack * chord) {
    why = "edge " + std::to_string(plan.index) + ": the curvature (G2) section leaves the triangle of its tangent lines by " + number_text(worst) + " at " + number_text(s) +
          " along it (the offsets along the support normals also lift it " + number_text(drift) + " out of the plane of A, T, B): " + needs +
          "; use smaller legs, a smaller or larger shape, or a conic profile";
    return false;
  }
  if (drift > 0.1 * chord) {
    why = "edge " + std::to_string(plan.index) + ": internal error (report it): the curvature (G2) section lies " + number_text(drift) + " out of the plane of A, T, B at " + number_text(s) +
          " along it (limit 0.1 x |A B| = " + number_text(0.1 * chord) + "): " + needs;
    return false;
  }
  if (turn_high - turn_low > M_PI) {
    why = "edge " + std::to_string(plan.index) + ": internal error (report it): the curvature (G2) section loops (its tangent turns through " + number_text(turn_high - turn_low) + " rad) at " + number_text(s) +
          " along it: " + needs + "; use smaller legs or a conic profile";
    return false;
  }
  return true;
}

}  // namespace

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
  return kind != 1 || curvature_section(plan, param, s, out, why);
}


// The surface interpolating the sections at `along` (a closed edge: the last section is not repeated and `period_end` closes the period): u runs across (the
// rational quadratic A, T, B), v along. `rows_out` holds the interpolated pole curves A, w T, B and the weights.
Handle(Geom_BSplineSurface) skin(const std::vector<Section> &stations, const std::vector<double> &along, double period_end, bool closed, double tolerance, double shape, bool polynomial,
                                 std::vector<Handle(Geom_BSplineCurve)> &rows_out, std::string &why) {
  const int count = static_cast<int>(stations.size());
  Handle(TColStd_HArray1OfReal) parameters = new TColStd_HArray1OfReal(1, closed ? count + 1 : count);
  for (int j = 1; j <= parameters->Length(); ++j) parameters->SetValue(j, j <= count ? along[static_cast<size_t>(j - 1)] : period_end);
  std::vector<Handle(Geom_BSplineCurve)> curves;
  const int pole_rows = polynomial ? 6 : 3;
  for (int i = 0; i < (polynomial ? 6 : 4); ++i) {
    Handle(TColgp_HArray1OfPnt) points = new TColgp_HArray1OfPnt(1, count);
    for (int j = 0; j < count; ++j) {
      const Section &s = stations[static_cast<size_t>(j)];
      if (polynomial) {
        const gp_Pnt pole = curvature_poles(s, shape)[static_cast<size_t>(i)];
        points->SetValue(j + 1, pole);
        continue;
      }
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
  TColgp_Array2OfPnt grid(1, pole_rows, 1, columns);
  TColStd_Array2OfReal pole_weights(1, pole_rows, 1, columns);
  for (int j = 1; j <= columns; ++j) {
    const double weight = polynomial ? 1.0 : curves[3]->Pole(j).X();
    if (!(weight > 1e-9)) {
      why = "the section weights of the blend interpolate to a non-positive weight";
      return nullptr;
    }
    for (int i = 0; i < pole_rows; ++i) {
      const gp_Pnt pole = curves[static_cast<size_t>(i)]->Pole(j);
      const double divisor = i == 1 && !polynomial ? weight : 1.0;
      grid.SetValue(i + 1, j, gp_Pnt(pole.X() / divisor, pole.Y() / divisor, pole.Z() / divisor));
      pole_weights.SetValue(i + 1, j, i == 1 && !polynomial ? weight : 1.0);
    }
  }
  TColStd_Array1OfReal u_knots(1, 2), v_knots(1, first->NbKnots());
  u_knots.SetValue(1, 0.0);
  u_knots.SetValue(2, 1.0);
  for (int k = 1; k <= first->NbKnots(); ++k) v_knots.SetValue(k, first->Knot(k));
  TColStd_Array1OfInteger u_mults(1, 2), v_mults(1, first->NbKnots());
  u_mults.SetValue(1, pole_rows);
  u_mults.SetValue(2, pole_rows);
  for (int k = 1; k <= first->NbKnots(); ++k) v_mults.SetValue(k, first->Multiplicity(k));
  return new Geom_BSplineSurface(grid, pole_weights, u_knots, v_knots, u_mults, v_mults, pole_rows - 1, first->Degree(), Standard_False,
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
    const Handle(Geom_BSplineSurface) surface = skin(stations, along, plan.length, plan.closed, 1e-14, param, kind == 1, rows, why);
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
      double gap = 0;
      if (kind == 1) {
        const std::vector<gp_Pnt> want = curvature_poles(*middle, param);
        for (size_t i = 0; i < want.size(); ++i) gap = std::max(gap, rows[i]->Value(at).Distance(want[i]));
      } else {
        const gp_Pnt want[3] = {middle->a, gp_Pnt(middle->weight * middle->t.X(), middle->weight * middle->t.Y(), middle->weight * middle->t.Z()), middle->b};
        gap = std::fabs(rows[3]->Value(at).X() - middle->weight) * middle->a.Distance(middle->t);
        for (int i = 0; i < 3; ++i) gap = std::max(gap, rows[static_cast<size_t>(i)]->Value(at).Distance(want[i]));
      }
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

}  // namespace legs
}  // namespace blend
}  // namespace llull
