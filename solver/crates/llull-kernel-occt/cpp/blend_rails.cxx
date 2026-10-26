// Rail-preserving profile blends (BLD M2, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.4 and §13.11): conic and curvature-continuous sections on
// CURVED edges, CURVED faces and edges whose size varies. OCCT builds the circular fillet (MakeFillet, any radius law); every blend face of it is
// then re-skinned: at stations along the blend (inserted where the surface between two stations would leave the section by more than 1e-8 x the
// diagonal) the contact points A, B on the two supports and the apex T of their tangent lines are read from the circular section, the conic (A, T, B)
// or the quintic (the quartic A, A + k (T - A), T, B + k (T - B), B raised to degree 5, its middle poles moved along the support normals so the
// section has the curvature of each support) replaces the arc, and a B-spline surface is interpolated through the stations. The contact lines are the
// circular fillet's own, so the supports keep their trimming and no boolean meets a tangent contact; the ends (a flat face the blend leaves square,
// or the next blend of a tangent chain) are rebuilt around the new section curve and everything is sewn into a solid. Reasons carry no BLD code
// (the host maps them to BLD_PROFILE_FAILED).
#include <algorithm>
#include <cmath>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRep_Tool.hxx>
#include <GC_MakeCircle.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
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
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/blends.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace {

// How far (x the diagonal) the interpolated section poles may leave the circular fillet's contact lines between two stations.
constexpr double kDeviationFraction = 1e-8;
// Stations along a blend: the first uniform set, and the most the refinement inserts (where the surface between two stations misses the section).
constexpr int kFirstStations = 24, kMostStations = 6000;
// The profile faces must meet the faces around them within this fraction of the diagonal (the corner patches' rule of 13.10.2); the sewing
// tolerance below is an input of the sewing, not an acceptance rule.
constexpr double kGapLimit = 5e-6;
// The volume a profile changes, against the circular fillet's of the same contact lines (only checked when every blend is convex, or every blend
// concave: a step that mixes them adds and removes material and the totals cancel). Per section the profile removes the spandrel between the corner
// and its curve, the circle the one between the corner and its arc. The conic of weight w is inside the triangle A T B, so the ratio of the two
// areas is below (triangle) / (circle spandrel) = tan^2(f/2) sin f / (2 (tan(f/2) - f/2)) for the fold f, which is 3 as f -> 0 and 2.33 at a right
// angle; it is above (1 - f(w)) of the weight 19 of rho 0.95, 0.016 at a right angle. The window is [0.01, 4].
constexpr double kMinVolumeRatio = 0.01, kMaxVolumeRatio = 4.0;
// Two blends of a chain may meet at this angle (radians) at most: 0.95 x the check_blends G1 default (0.01), a margin so that check_blends, which
// samples the junction at other points, never reads above the default.
constexpr double kJunctionAngle = 0.0095;
// Sewing tolerance (x the diagonal): the check_blends default g0; never less than twice the tolerance OCCT gave the edges of its own blend (its
// approximation error: about 1e-6 in absolute terms, more than 1e-6 x the diagonal on a millimetre part) and never more than the cap.
constexpr double kSewingFraction = 1e-6, kSewingCap = 1e-3;
// A contact point moves onto its support face when it is that close (x the distance to the apex): OCCT's approximation error, not a different point.
constexpr double kSnapFraction = 1e-3;
// A face is tangent to its neighbour along a rail when the normals are within this angle (radians).
constexpr double kRailAngle = 5e-3;
// Parameter values closer than this fraction of the face's parameter range are the same iso-line.
constexpr double kIsoFraction = 1e-6;

struct Section {
  gp_Pnt a, t, b;
  gp_Pnt centre;  // of the section circle (the rolling ball)
  gp_Vec bend_a{0, 0, 0}, bend_b{0, 0, 0};  // curvature-continuous sections: the offset of the 3rd / 4th pole of the quintic along the support normal
};

// The part of a rail over one support face: the face and the range of the along parameter it covers.
struct RailPiece {
  TopoDS_Face face;
  double lo, hi;
};

// A blend face of the circular fillet and what bounds it.
struct Blend {
  TopoDS_Face face;
  bool across_is_u = true;      // the section runs along u (the rails are u = const)
  double across[2] = {0, 0};    // parameter of the rails
  double lo = 0, hi = 0;        // parameter range along the blend
  bool closed = false;          // a seam instead of ends (a rim)
  TopoDS_Edge end[2];           // the section edge at lo / hi (null: none)
  TopoDS_Face end_face[2];      // its neighbour when that is a flat end face to rebuild (null: another blend of the chain)
  std::vector<RailPiece> supports[2];  // the support faces along each rail
};

// The support face of rail `side` at `along`.
TopoDS_Face support_at(const Blend &blend, int side, double along) {
  const RailPiece *best = nullptr;
  double gap = 1e300;
  for (const RailPiece &piece : blend.supports[side]) {
    const double away = along < piece.lo ? piece.lo - along : (along > piece.hi ? along - piece.hi : 0.0);
    if (away < gap) {
      gap = away;
      best = &piece;
    }
  }
  return best == nullptr ? TopoDS_Face() : best->face;
}

std::string number(double value) {
  std::ostringstream text;
  text.precision(6);
  text << value;
  return text.str();
}

gp_Vec face_normal(const BRepAdaptor_Surface &surface, const gp_Pnt2d &uv) {
  gp_Pnt point;
  gp_Vec du, dv;
  surface.D1(uv.X(), uv.Y(), point, du, dv);
  gp_Vec normal = du.Crossed(dv);
  if (normal.Magnitude() < 1e-14) return gp_Vec(0, 0, 0);
  return normal.Normalized();
}

// Midpoint (u, v) of `edge` on `face`.
bool mid_uv(const TopoDS_Edge &edge, const TopoDS_Face &face, gp_Pnt2d &uv) {
  double first = 0, last = 0;
  const Handle(Geom2d_Curve) pcurve = BRep_Tool::CurveOnSurface(edge, face, first, last);
  if (pcurve.IsNull()) return false;
  uv = pcurve->Value(0.5 * (first + last));
  return true;
}

// The section circle of a blend at `along`: contact points on both rails, the arc midpoint, and the apex of the two tangent lines.
bool section_at(const BRepAdaptor_Surface &surface, const Blend &blend, double along, bool curved, double shape, Section &out, std::string &why) {
  const auto at = [&](double across) {
    return blend.across_is_u ? surface.Value(across, along) : surface.Value(along, across);
  };
  const gp_Pnt a = at(blend.across[0]), b = at(blend.across[1]), m = at(0.5 * (blend.across[0] + blend.across[1]));
  GC_MakeCircle circle(a, m, b);
  if (!circle.IsDone()) {
    why = "a section of the circular blend is not a circle arc";
    return false;
  }
  const gp_Pnt centre = circle.Value()->Location();
  const double radius = circle.Value()->Radius();
  gp_Vec to_a(centre, a), to_b(centre, b);
  gp_Vec bisector = to_a / radius + to_b / radius;
  if (bisector.Magnitude() < 1e-6) {
    why = "a section of the circular blend is a half circle or more";
    return false;
  }
  bisector.Normalize();
  const double half_cos = to_a.Dot(bisector) / radius;
  if (half_cos < 1e-3 || bisector.Dot(gp_Vec(centre, m)) <= 0) {
    why = "a section of the circular blend turns through 180 degrees or more (no apex)";
    return false;
  }
  // The circular blend's contact points carry OCCT's own approximation error (up to ~1e-6 in absolute terms, more than 1e-6 x the diagonal on a
  // millimetre part): they are moved onto the support faces, so the profile meets them to the interpolation accuracy only.
  out.a = a;
  out.b = b;
  out.centre = centre;
  out.t = centre.Translated(bisector * (radius / half_cos));
  const gp_Pnt contacts[2] = {a, b};
  for (int side = 0; side < 2; ++side) {
    gp_Pnt on;
    const TopoDS_Face support = support_at(blend, side, along);
    if (support.IsNull() || !project_on_face(support, contacts[side], on)) continue;
    if (on.Distance(contacts[side]) <= kSnapFraction * out.t.Distance(contacts[side])) (side == 0 ? out.a : out.b) = on;
  }
  if (!curved) return true;
  // G2: the section leaves each support with the support's own curvature along the section (the quintic of section_poles).
  const gp_Pnt snapped[2] = {out.a, out.b};
  for (int side = 0; side < 2; ++side) {
    const gp_Pnt from = snapped[side], other = snapped[1 - side];
    const double reach = from.Distance(out.t);
    gp_Vec nu;
    double kappa = 0;
    if (!(reach > 0) || !support_curvature(support_at(blend, side, along), from, gp_Vec(from, out.t), gp_Vec(from, other), nu, kappa)) {
      why = "the curvature of a support face could not be read at a contact point";
      return false;
    }
    const double lead = 0.8 * shape * reach;
    const double offset = std::max(-0.25 * reach, std::min(0.25 * reach, 1.25 * kappa * lead * lead));
    (side == 0 ? out.bend_a : out.bend_b) = nu * offset;
  }
  return true;
}

// The poles of the section curve of kind 0 (conic: weight param / (1 - param)) or 1 (curvature: the quartic A, A + k (T - A), T, B + k (T - B), B of the
// prism builder, raised to degree 5 and with its 3rd and 4th pole moved along the support normals: zero offsets give the quartic exactly, the offsets
// give the section the curvature of each support at its contact point).
std::vector<gp_Pnt> section_poles(const Section &s, int kind, double param) {
  if (kind == 1) {
    const double lead = 0.8 * param, reach = 0.4 * param + 0.6;
    return {s.a,
            s.a.Translated(gp_Vec(s.a, s.t) * lead),
            s.a.Translated(gp_Vec(s.a, s.t) * reach + s.bend_a),
            s.b.Translated(gp_Vec(s.b, s.t) * reach + s.bend_b),
            s.b.Translated(gp_Vec(s.b, s.t) * lead),
            s.b};
  }
  return {s.a, s.t, s.b};
}

// Reads the faces around `face` and fills `blend`; false with the reason in `why`.
bool analyse(const TopoDS_Face &face, const TopTools_IndexedDataMapOfShapeListOfShape &edge_faces, const TopTools_IndexedMapOfShape &blends,
             Blend &blend, std::string &why) {
  blend.face = face;
  double u_lo, u_hi, v_lo, v_hi;
  BRepTools::UVBounds(face, u_lo, u_hi, v_lo, v_hi);
  const BRepAdaptor_Surface surface(face, Standard_False);
  const double range[2] = {std::max(u_hi - u_lo, 1e-12), std::max(v_hi - v_lo, 1e-12)};
  struct Item {
    TopoDS_Edge edge;
    TopoDS_Face neighbour;
    bool is_blend;
    gp_Pnt2d from, to;
  };
  std::vector<Item> rails, others;
  bool seam = false;
  TopTools_IndexedMapOfShape seen;
  for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
    if (!seen.Add(it.Current())) continue;
    const TopoDS_Edge edge = TopoDS::Edge(it.Current());
    if (BRep_Tool::Degenerated(edge)) {
      why = "the blend face has a degenerate edge";
      return false;
    }
    TopoDS_Face neighbour;
    for (TopTools_ListIteratorOfListOfShape owner(edge_faces.FindFromKey(edge)); owner.More(); owner.Next())
      if (!owner.Value().IsSame(face)) {
        if (!neighbour.IsNull() && !neighbour.IsSame(owner.Value())) {
          why = "an edge of the blend face is shared by more than two faces";
          return false;
        }
        neighbour = TopoDS::Face(owner.Value());
      }
    if (neighbour.IsNull()) {
      seam = true;
      continue;
    }
    double first = 0, last = 0;
    const Handle(Geom2d_Curve) pcurve = BRep_Tool::CurveOnSurface(edge, face, first, last);
    if (pcurve.IsNull()) {
      why = "an edge of the blend face has no parametric curve";
      return false;
    }
    Item item{edge, neighbour, blends.Contains(neighbour) == Standard_True, pcurve->Value(first), pcurve->Value(last)};
    bool tangent = false;
    if (!item.is_blend) {
      gp_Pnt2d other;
      gp_Pnt2d mine = pcurve->Value(0.5 * (first + last));
      if (mid_uv(edge, neighbour, other)) {
        const gp_Vec n1 = face_normal(surface, mine), n2 = face_normal(BRepAdaptor_Surface(neighbour, Standard_False), other);
        tangent = n1.Magnitude() > 0.5 && n2.Magnitude() > 0.5 && std::fabs(n1.Dot(n2)) > std::cos(kRailAngle);
      }
    }
    (tangent ? rails : others).push_back(item);
  }
  if (rails.empty()) {
    why = "the blend face has no edge tangent to a support face";
    return false;
  }
  // Which parameter is constant along the rails (the across parameter), and its two values.
  const auto iso = [&](const Item &item, int coordinate) {
    const double a = coordinate == 0 ? item.from.X() : item.from.Y(), b = coordinate == 0 ? item.to.X() : item.to.Y();
    return std::fabs(a - b) <= kIsoFraction * range[coordinate];
  };
  blend.across_is_u = iso(rails.front(), 0);
  const int across_coordinate = blend.across_is_u ? 0 : 1, along_coordinate = 1 - across_coordinate;
  const auto value = [&](const gp_Pnt2d &uv, int coordinate) { return coordinate == 0 ? uv.X() : uv.Y(); };
  std::vector<double> values;
  double lo = 1e300, hi = -1e300;
  for (const Item &rail : rails) {
    if (!iso(rail, across_coordinate) || iso(rail, along_coordinate)) {
      why = "a contact line of the blend is not an iso-line of its surface";
      return false;
    }
    const double v = value(rail.from, across_coordinate);
    const auto known = std::find_if(values.begin(), values.end(), [&](double other) { return std::fabs(other - v) <= kIsoFraction * range[across_coordinate]; });
    const size_t cluster = static_cast<size_t>(known - values.begin());
    if (known == values.end()) values.push_back(v);
    const double piece_lo = std::min(value(rail.from, along_coordinate), value(rail.to, along_coordinate));
    const double piece_hi = std::max(value(rail.from, along_coordinate), value(rail.to, along_coordinate));
    if (cluster < 2) blend.supports[cluster].push_back({rail.neighbour, piece_lo, piece_hi});
    lo = std::min(lo, piece_lo);
    hi = std::max(hi, piece_hi);
  }
  if (values.size() != 2) {
    why = "the blend face does not lie between exactly two contact lines (" + std::to_string(values.size()) + " found)";
    return false;
  }
  blend.across[0] = values[0];
  blend.across[1] = values[1];
  blend.lo = lo;
  blend.hi = hi;
  for (const Item &other : others) {
    if (!iso(other, along_coordinate)) {
      why = "the blend ends obliquely on a neighbouring face (profile blends end on a face square to the blend, or on the next blend of a chain)";
      return false;
    }
    const double at = value(other.from, along_coordinate);
    const double tolerance = kIsoFraction * range[along_coordinate];
    const int side = std::fabs(at - lo) <= tolerance ? 0 : (std::fabs(at - hi) <= tolerance ? 1 : -1);
    if (side < 0 || !blend.end[side].IsNull()) {
      why = "the blend face has an edge that is neither a contact line nor one clean end";
      return false;
    }
    if (!other.is_blend && BRepAdaptor_Surface(other.neighbour, Standard_False).GetType() != GeomAbs_Plane) {
      why = "the blend ends on a curved or non-flat face (profile blends end on a flat face square to the blend)";
      return false;
    }
    blend.end[side] = other.edge;
    if (!other.is_blend) blend.end_face[side] = other.neighbour;
  }
  blend.closed = blend.end[0].IsNull() && blend.end[1].IsNull();
  if (blend.closed && !seam) {
    why = "the blend face has no ends and no seam";
    return false;
  }
  if (blend.end[0].IsNull() != blend.end[1].IsNull() || (!blend.closed && seam)) {
    why = "the blend face has only one end";
    return false;
  }
  return true;
}

// The interpolated surface through `stations` sections (closed: the last section is not repeated); null with the reason in `why`.
// `along` holds the parameter of each station (strictly increasing); a closed blend also takes the parameter where it closes, `period_end`.
Handle(Geom_BSplineSurface) skin(const std::vector<Section> &stations, const std::vector<double> &along, double period_end, bool closed, int kind,
                                 double param, double tolerance, std::vector<Handle(Geom_BSplineCurve)> &rows_out, std::string &why) {
  const int count = static_cast<int>(stations.size());
  const std::vector<std::vector<gp_Pnt>> poles = [&] {
    std::vector<std::vector<gp_Pnt>> out;
    for (const Section &s : stations) out.push_back(section_poles(s, kind, param));
    return out;
  }();
  const int rows = static_cast<int>(poles.front().size());
  Handle(TColStd_HArray1OfReal) parameters = new TColStd_HArray1OfReal(1, closed ? count + 1 : count);
  for (int j = 1; j <= parameters->Length(); ++j) parameters->SetValue(j, j <= count ? along[static_cast<size_t>(j - 1)] : period_end);
  std::vector<Handle(Geom_BSplineCurve)> curves;
  for (int i = 0; i < rows; ++i) {
    Handle(TColgp_HArray1OfPnt) points = new TColgp_HArray1OfPnt(1, count);
    for (int j = 0; j < count; ++j) points->SetValue(j + 1, poles[static_cast<size_t>(j)][static_cast<size_t>(i)]);
    GeomAPI_Interpolate interpolation(points, parameters, closed ? Standard_True : Standard_False, tolerance);
    interpolation.Perform();
    if (!interpolation.IsDone()) {
      why = "the section poles could not be interpolated along the blend";
      return nullptr;
    }
    curves.push_back(interpolation.Curve());
  }
  rows_out = curves;
  const Handle(Geom_BSplineCurve) &first = curves.front();
  const int columns = first->NbPoles();
  for (const auto &curve : curves)
    if (curve->NbPoles() != columns || curve->Degree() != first->Degree() || curve->NbKnots() != first->NbKnots()) {
      why = "the pole curves of a blend do not share their knots";
      return nullptr;
    }
  TColgp_Array2OfPnt grid(1, rows, 1, columns);
  for (int i = 0; i < rows; ++i)
    for (int j = 1; j <= columns; ++j) grid.SetValue(i + 1, j, curves[static_cast<size_t>(i)]->Pole(j));
  TColStd_Array1OfReal u_knots(1, 2), v_knots(1, first->NbKnots());
  u_knots.SetValue(1, 0.0);
  u_knots.SetValue(2, 1.0);
  for (int k = 1; k <= first->NbKnots(); ++k) v_knots.SetValue(k, first->Knot(k));
  TColStd_Array1OfInteger u_mults(1, 2), v_mults(1, first->NbKnots());
  u_mults.SetValue(1, rows);
  u_mults.SetValue(2, rows);
  for (int k = 1; k <= first->NbKnots(); ++k) v_mults.SetValue(k, first->Multiplicity(k));
  if (kind == 1)
    return new Geom_BSplineSurface(grid, u_knots, v_knots, u_mults, v_mults, rows - 1, first->Degree(), Standard_False,
                                   first->IsPeriodic() ? Standard_True : Standard_False);
  TColStd_Array2OfReal weights(1, rows, 1, columns);
  const double conic_weight = param / (1.0 - param);
  for (int j = 1; j <= columns; ++j) {
    weights.SetValue(1, j, 1.0);
    weights.SetValue(2, j, conic_weight);
    weights.SetValue(3, j, 1.0);
  }
  return new Geom_BSplineSurface(grid, weights, u_knots, v_knots, u_mults, v_mults, rows - 1, first->Degree(), Standard_False,
                                 first->IsPeriodic() ? Standard_True : Standard_False);
}

// The skin of `blend`, with stations inserted until its contact lines and section stay within `limit` of the circular blend's between two stations;
// null with the reason in `why`.
Handle(Geom_BSplineSurface) skin_blend(const Blend &blend, int kind, double param, bool curved, double limit, std::string &why) {
  const BRepAdaptor_Surface source(blend.face, Standard_False);
  const double span = blend.hi - blend.lo;
  std::vector<double> along;
  std::vector<Section> stations;
  const int first = blend.closed ? kFirstStations : kFirstStations + 1;
  for (int j = 0; j < first; ++j) along.push_back(blend.lo + span * j / kFirstStations);
  for (double at : along) {
    Section section;
    if (!section_at(source, blend, at, curved, param, section, why)) return nullptr;
    stations.push_back(section);
  }
  for (;;) {
    std::vector<Handle(Geom_BSplineCurve)> rows;
    const Handle(Geom_BSplineSurface) surface = skin(stations, along, blend.hi, blend.closed, kind, param, 1e-14, rows, why);
    if (surface.IsNull()) return nullptr;
    std::vector<double> added;
    std::vector<Section> added_sections;
    double worst = 0;
    const size_t intervals = blend.closed ? along.size() : along.size() - 1;
    for (size_t j = 0; j < intervals; ++j) {
      const double from = along[j], to = j + 1 < along.size() ? along[j + 1] : blend.hi;
      const double at = 0.5 * (from + to);
      Section middle;
      if (!section_at(source, blend, at, curved, param, middle, why)) return nullptr;
      // every pole of the interpolated section against the pole of the true one: by the convex hull property this bounds the whole section
      const std::vector<gp_Pnt> expected = section_poles(middle, kind, param);
      double gap = 0;
      for (size_t row = 0; row < rows.size() && row < expected.size(); ++row) gap = std::max(gap, rows[row]->Value(at).Distance(expected[row]));
      worst = std::max(worst, gap);
      if (gap > limit) {
        if (to - from < 1e-9 * span) {
          why = "the blend surface follows the contact lines only to " + number(gap) + " (limit " + number(limit) + ") where the circular blend has a kink";
          return nullptr;
        }
        added.push_back(at);
        added_sections.push_back(middle);
      }
    }
    if (added.empty()) return surface;
    if (along.size() + added.size() > static_cast<size_t>(kMostStations)) {
      why = "the blend surface follows the contact lines only to " + number(worst) + " (limit " + number(limit) + ") with " + std::to_string(along.size()) +
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

// Where a pass failed: only a chain junction that does not sew in a curved pass is worth the zero-curvature pass.
enum class Stage { Other, Junction };

// What a successful pass measured.
struct Measured {
  double gap = 0, limit = 0;
  bool mixed = false;      // convex and concave blends in one step: the volume window is not applied
  double junction = 0;     // largest angle between the normals of two blends of a chain along their junction (radians)
  std::vector<int> chain;  // unique edges of the contours OCCT rounded (the picked edges and the rest of their tangent chains)
};

std::unique_ptr<Shape> rails_once(const Shape &source, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, int kind, double param,
                                  bool curved, Stage &stage, Measured &measured, std::string &why) {
  stage = Stage::Other;
  const TopoDS_Shape &shape = source.shape;
  // true box of the source: construction tolerances; the acceptance limits below use the smaller of this and the result's
  const double diagonal = std::max(blend::diagonal_of(shape), 1e-9);
  const TopTools_IndexedMapOfShape unique = query::distinct(shape, TopAbs_EDGE);
  if (edges.empty()) {
    why = "no edge to blend";
    return nullptr;
  }
  BRepFilletAPI_MakeFillet maker(shape, ChFi3d_Rational);
  if (!add_fillet_laws(maker, unique, edges, laws)) {
    why = "edge index or radius law out of range";
    return nullptr;
  }
  maker.Build();
  if (!maker.IsDone()) {
    why = "the circular blend the profile is cut from could not be built (try a smaller size)";
    return nullptr;
  }
  const TopoDS_Shape circular = maker.Shape();
  if (circular.IsNull() || !BRepCheck_Analyzer(circular, Standard_True).IsValid()) {
    why = "the circular blend the profile is cut from is not a valid solid (try a smaller size)";
    return nullptr;
  }
  const std::vector<naming::Named> inputs{naming::named(source)};
  const std::vector<std::string> circular_names = naming::inherit(circular, inputs, naming::history_of(inputs, maker), "blend");

  TopTools_IndexedMapOfShape blends;
  std::vector<int> chain;
  // OCCT rounds the whole tangent chain of a picked edge: every edge of every contour has its blend face.
  for (int contour = 1; contour <= maker.NbContours(); ++contour)
    for (int k = 1; k <= maker.NbEdges(contour); ++k) {
      const int index = unique.FindIndex(maker.Edge(contour, k)) - 1;
      if (index >= 0) chain.push_back(index);
      for (TopTools_ListIteratorOfListOfShape it(maker.Generated(maker.Edge(contour, k))); it.More(); it.Next())
        if (it.Value().ShapeType() == TopAbs_FACE) blends.Add(it.Value());
    }
  if (blends.IsEmpty()) {
    why = "the circular blend produced no blend face";
    return nullptr;
  }
  TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
  TopExp::MapShapesAndAncestors(circular, TopAbs_EDGE, TopAbs_FACE, edge_faces);
  std::vector<Blend> faces(static_cast<size_t>(blends.Extent()));
  for (int b = 1; b <= blends.Extent(); ++b)
    if (!analyse(TopoDS::Face(blends(b)), edge_faces, blends, faces[static_cast<size_t>(b - 1)], why)) return nullptr;

  // Convex blends have the rolling ball inside the material, concave ones outside: a step that mixes them is not checked against the circular volume.
  bool any_convex = false, any_concave = false;
  for (const Blend &blend : faces) {
    const BRepAdaptor_Surface surface(blend.face, Standard_False);
    // The first stations of the blend (a face whose convexity flips along its length counts as mixed), interior ones only on an open blend: at an end that is square to a flat face the ball centre lies IN that face (ON the solid), which says
    // nothing about the convexity. A centre that is ON is skipped as well.
    for (int j = blend.closed ? 0 : 1; j < kFirstStations; ++j) {
      Section station;
      if (!section_at(surface, blend, blend.lo + (blend.hi - blend.lo) * j / kFirstStations, false, 0.5, station, why)) return nullptr;
      BRepClass3d_SolidClassifier classifier(circular, station.centre, 1e-9 * diagonal);
      if (classifier.State() == TopAbs_IN) any_convex = true;
      else if (classifier.State() == TopAbs_OUT) any_concave = true;
    }
  }
  const bool mixed = any_convex && any_concave;

  // New blend faces and the end faces to rebuild around their section curves.
  std::vector<TopoDS_Face> skinned;
  struct End {
    TopoDS_Edge old_edge;
    Handle(Geom_Curve) curve;
    TopoDS_Face face;
  };
  std::vector<End> ends;
  for (const Blend &blend : faces) {
    const Handle(Geom_BSplineSurface) surface = skin_blend(blend, kind, param, curved, kDeviationFraction * diagonal, why);
    if (surface.IsNull()) return nullptr;
    double u0, u1, v0, v1;
    surface->Bounds(u0, u1, v0, v1);
    BRepBuilderAPI_MakeFace made(surface, u0, u1, v0, v1, 1e-9 * diagonal);
    if (!made.IsDone()) {
      why = "the blend surface could not be turned into a face";
      return nullptr;
    }
    skinned.push_back(made.Face());
    for (int side = 0; side < 2; ++side)
      if (!blend.end_face[side].IsNull()) ends.push_back({blend.end[side], surface->VIso(side == 0 ? v0 : v1), blend.end_face[side]});
  }

  // End faces: the arc of the circular blend is replaced by the section curve.
  std::vector<TopoDS_Face> rebuilt_ends;
  std::vector<TopoDS_Shape> old_ends;
  for (size_t e = 0; e < ends.size(); ++e) {
    bool done = false;
    for (const TopoDS_Shape &known : old_ends) done = done || known.IsSame(ends[e].face);
    if (done) continue;
    BRepTools_ReShape reshape;
    std::vector<TopoDS_Edge> fresh;
    for (const End &end : ends) {
      if (!end.face.IsSame(ends[e].face)) continue;
      const TopoDS_Edge forward = TopoDS::Edge(end.old_edge.Oriented(TopAbs_FORWARD));
      TopoDS_Vertex first, last;
      TopExp::Vertices(forward, first, last);
      Handle(Geom_Curve) curve = end.curve;
      const gp_Pnt head = BRep_Tool::Pnt(first);
      if (curve->Value(curve->FirstParameter()).Distance(head) > curve->Value(curve->LastParameter()).Distance(head)) curve = curve->Reversed();
      BRepBuilderAPI_MakeEdge edge(curve, first, last);
      if (!edge.IsDone()) {
        why = "the section curve could not be made an edge of the end face";
        return nullptr;
      }
      reshape.Replace(forward, edge.Edge());
      fresh.push_back(edge.Edge());
    }
    const TopoDS_Face face = TopoDS::Face(reshape.Apply(ends[e].face));
    for (const TopoDS_Edge &edge : fresh) BRepLib::BuildPCurveForEdgeOnPlane(edge, face);
    rebuilt_ends.push_back(face);
    old_ends.push_back(ends[e].face);
  }

  // Shell: every face that stays, the new blends and the rebuilt end faces, sewn.
  const TopTools_IndexedMapOfShape circular_faces = query::distinct(circular, TopAbs_FACE);
  double blend_tolerance = 0;
  for (int b = 1; b <= blends.Extent(); ++b)
    for (TopExp_Explorer it(blends(b), TopAbs_EDGE); it.More(); it.Next()) blend_tolerance = std::max(blend_tolerance, BRep_Tool::Tolerance(TopoDS::Edge(it.Current())));
  BRepBuilderAPI_Sewing sewing(std::min(std::max(kSewingFraction * diagonal, 2.0 * blend_tolerance), kSewingCap * diagonal));
  std::vector<TopoDS_Face> members;
  std::vector<std::string> member_names;
  const auto replaced_end = [&](const TopoDS_Shape &face) {
    return std::any_of(old_ends.begin(), old_ends.end(), [&](const TopoDS_Shape &old) { return old.IsSame(face); });
  };
  for (int f = 1; f <= circular_faces.Extent(); ++f) {
    if (blends.Contains(circular_faces(f)) || replaced_end(circular_faces(f))) continue;
    members.push_back(TopoDS::Face(circular_faces(f)));
    member_names.push_back(circular_names[static_cast<size_t>(f - 1)]);
  }
  for (size_t b = 0; b < skinned.size(); ++b) {
    const int at = circular_faces.FindIndex(faces[b].face);
    if (at < 1) {
      why = "a blend face of the circular fillet is not a face of its solid";
      return nullptr;
    }
    members.push_back(skinned[b]);
    member_names.push_back(circular_names[static_cast<size_t>(at - 1)]);
  }
  for (size_t e = 0; e < rebuilt_ends.size(); ++e) {
    const int at = circular_faces.FindIndex(old_ends[e]);
    if (at < 1) {
      why = "an end face of the circular fillet is not a face of its solid";
      return nullptr;
    }
    members.push_back(rebuilt_ends[e]);
    member_names.push_back(circular_names[static_cast<size_t>(at - 1)]);
  }
  const size_t reskinned = skinned.size() + rebuilt_ends.size();
  for (const TopoDS_Face &face : members) sewing.Add(face);
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  TopoDS_Shell shell;
  for (TopExp_Explorer it(sewn, TopAbs_SHELL); it.More() && shell.IsNull(); it.Next()) shell = TopoDS::Shell(it.Current());
  if (shell.IsNull() && sewn.ShapeType() == TopAbs_SHELL) shell = TopoDS::Shell(sewn);
  if (shell.IsNull() || sewing.NbFreeEdges() > 0) {
    why = "the profile faces do not close the solid (" + std::to_string(sewing.NbFreeEdges()) + " free edge(s) after sewing)";
    const bool junction = std::any_of(faces.begin(), faces.end(), [](const Blend &blend) {
      return (!blend.end[0].IsNull() && blend.end_face[0].IsNull()) || (!blend.end[1].IsNull() && blend.end_face[1].IsNull());
    });
    if (curved && junction) stage = Stage::Junction;
    return nullptr;
  }
  // A void (or a second body) sews into a shell or a closed face of its own, which the solid built from one shell would drop.
  if (query::distinct(shell, TopAbs_FACE).Extent() != query::distinct(sewn, TopAbs_FACE).Extent()) {
    why = "the solid has several shells (a void or a second body): a profile blend rebuilds one closed shell";
    return nullptr;
  }
  BRepBuilderAPI_MakeSolid solid_maker(shell);
  TopoDS_Solid solid = solid_maker.Solid();
  BRepLib::OrientClosedSolid(solid);
  if (solid.IsNull() || !BRepCheck_Analyzer(solid, Standard_True).IsValid()) {
    why = "the profile blend fails the BRepCheck validity analysis";
    return nullptr;
  }
  const auto volume_of = [](const TopoDS_Shape &body) {
    GProp_GProps props;
    BRepGProp::VolumeProperties(body, props);
    return props.Mass();
  };
  // The section only changes the shape of the corner cut: the volume moves the same way as the circular fillet's, and by a bounded multiple of it
  // (the window and its derivation: kMinVolumeRatio / kMaxVolumeRatio above).
  const double before = volume_of(shape), after = volume_of(solid), circular_change = before - volume_of(circular), change = before - after;
  if (!(after > 0) || (!mixed && (!(circular_change * change > 0) || std::fabs(change) < kMinVolumeRatio * std::fabs(circular_change) ||
                                  std::fabs(change) > kMaxVolumeRatio * std::fabs(circular_change)))) {
    why = "the profile blend changed the volume by " + number(change) + " where the circular fillet changes it by " + number(circular_change) +
          " (a profile section changes it between " + number(kMinVolumeRatio) + " and " + number(kMaxVolumeRatio) + " times as much, the same way)";
    return nullptr;
  }
  // The real gap: along every edge a re-skinned face shares with a neighbour, the distance between the two surfaces at the pcurves of the edge (what
  // check_blends reads as g0), sampled at four times the knots of the blend surfaces there (at least 21 points); and, where both faces are blends of
  // the chain, the angle between their normals (a junction). The tolerance OCCT gives a sewn edge is only a bound and can be many times the gap.
  double gap = 0, junction = 0;
  const TopTools_IndexedMapOfShape final_faces = query::distinct(solid, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape solid_edge_faces;
  TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, solid_edge_faces);
  std::vector<TopoDS_Shape> blend_images;
  for (size_t b = 0; b < skinned.size(); ++b) {
    const TopoDS_Face &member = members[members.size() - reskinned + b];  // the faces that stay come first, then the blends, then the end faces
    blend_images.push_back(sewing.IsModified(member) ? sewing.Modified(member) : member);
  }
  const auto is_blend = [&](const TopoDS_Face &face) {
    return std::any_of(blend_images.begin(), blend_images.end(), [&](const TopoDS_Shape &image) { return image.IsSame(face); });
  };
  const auto knots_of = [](const TopoDS_Face &face) {
    const Handle(Geom_BSplineSurface) surface = Handle(Geom_BSplineSurface)::DownCast(BRep_Tool::Surface(face));
    return surface.IsNull() ? 0 : surface->NbVKnots();
  };
  const auto outward = [](const BRepAdaptor_Surface &surface, const TopoDS_Face &face, const gp_Pnt2d &uv) {
    gp_Pnt at;
    gp_Vec du, dv;
    surface.D1(uv.X(), uv.Y(), at, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() < 1e-14) return gp_Vec(0, 0, 0);
    normal.Normalize();
    return face.Orientation() == TopAbs_REVERSED ? normal.Reversed() : normal;
  };
  for (size_t m = members.size() - reskinned; m < members.size(); ++m) {
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
      const bool chain_junction = is_blend(around[0]) && is_blend(around[1]);
      const int samples = std::max(21, 4 * std::max(knots_of(around[0]), knots_of(around[1])));
      for (int k = 0; k <= samples; ++k) {
        const double u = static_cast<double>(k) / samples;
        const gp_Pnt2d a = on_first->Value(first + (last - first) * u), b = on_second->Value(first2 + (last2 - first2) * u);
        gap = std::max(gap, one.Value(a.X(), a.Y()).Distance(two.Value(b.X(), b.Y())));
        if (!chain_junction) continue;
        const gp_Vec n1 = outward(one, around[0], a), n2 = outward(two, around[1], b);
        if (n1.Magnitude() > 0.5 && n2.Magnitude() > 0.5) junction = std::max(junction, std::acos(std::max(-1.0, std::min(1.0, n1.Dot(n2)))));
      }
    }
  }
  // The acceptance limit is relative to the smaller true box of the source and the result: a fillet that lowers an extreme shrinks the box, and
  // check_blends (mass-properties bounds of the result) must never read a larger gap than the builder accepted.
  const double accepted = blend::kGapAccepted * kGapLimit * std::min(diagonal, std::max(blend::diagonal_of(solid), 1e-9));
  if (gap > accepted) {
    why = "the profile faces meet their neighbours only to " + number(gap) + " (limit " + number(accepted) + " = 0.95 x 5e-6 x the smaller bounding-box diagonal of the source and the result): the circular blend OCCT gave is not accurate enough at this size";
    return nullptr;
  }
  if (junction > kJunctionAngle) {
    why = "two blends of the chain meet at " + number(junction) + " rad (limit " + number(kJunctionAngle) +
          " rad, 0.95 x the check_blends default of 0.01): the apex of the section moves with the fold angle, whose derivative jumps where the curvature of a wall jumps";
    stage = Stage::Junction;
    return nullptr;
  }
  measured = {gap, accepted, mixed, junction, chain};
  std::vector<std::string> names(static_cast<size_t>(final_faces.Extent()));
  for (size_t m = 0; m < members.size(); ++m) {
    const TopoDS_Shape image = sewing.IsModified(members[m]) ? sewing.Modified(members[m]) : members[m];
    const int index = final_faces.FindIndex(image);
    if (index > 0) names[static_cast<size_t>(index - 1)] = member_names[m];
  }
  return naming::wrap_named(solid, names);
}

}  // namespace

std::unique_ptr<Shape> blend::rails_blend(const Shape &source, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, int kind, double param,
                                          std::string &notes, std::string &why) {
  // A curvature profile matches the curvature of its supports. Where two blends of a chain meet over supports whose curvature jumps their sections
  // differ at the junction and do not sew; only that failure is answered with the zero-curvature quartic (G1 to the supports, G2 only to a planar
  // one), and the fallback is reported. Every other failure of the curved pass is the pass's own reason.
  Stage stage = Stage::Other;
  Measured measured;
  std::unique_ptr<Shape> built = rails_once(source, edges, laws, kind, param, kind == 1, stage, measured, why);
  std::string curved_reason;
  if (!built && stage == Stage::Junction && kind == 1) {
    curved_reason = why;
    built = rails_once(source, edges, laws, kind, param, false, stage, measured, why);
    if (!built) {
      why = "the curvature-continuous pass failed (" + curved_reason + ") and so did the zero-curvature quartic (" + why + ")";
      return nullptr;
    }
  }
  if (!built) return nullptr;
  JsonWriter out;
  out.begin_object().key("builder").string("rails").key("gap").number(measured.gap).key("gapLimit").number(measured.limit).key("junctionG1").number(measured.junction).key("mixed").boolean(measured.mixed);
  if (!curved_reason.empty()) {
    out.key("fallback").begin_object().key("edges").begin_array();
    for (int index : measured.chain) out.integer(index);
    out.end_array()
        .key("reason")
        .string("support curvature jumps at a chain junction: the curvature-continuous pass failed there (" + curved_reason + ")")
        .end_object();
  }
  notes = out.end_object().text();
  return built;
}

std::unique_ptr<Shape> fillet_rails(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, double kind,
                                    double param) {
  std::string why;
  std::string notes;
  try {
    std::unique_ptr<Shape> built = blend::rails_blend(shape, edges, laws, static_cast<int>(kind), param, notes, why);
    if (built) built->notes = notes;
    return built;
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String rails_reason(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, double kind, double param) {
  std::string why;
  std::unique_ptr<Shape> built;
  std::string notes;
  try {
    built = blend::rails_blend(shape, edges, laws, static_cast<int>(kind), param, notes, why);
  } catch (const Standard_Failure &error) {
    why = std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the profile blend failed") : why));
}

}  // namespace llull
