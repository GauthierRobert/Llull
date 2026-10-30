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
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRep_Builder.hxx>
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

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_solid.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/blends.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;
using namespace blend::rails;

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
// A face is tangent to its neighbour along a rail when the normals are within this angle (radians).
constexpr double kRailAngle = 5e-3;
// Parameter values closer than this fraction of the face's parameter range are the same iso-line.
constexpr double kIsoFraction = 1e-6;

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
    if (cluster < 2) blend.supports[cluster].push_back({rail.neighbour, piece_lo, piece_hi, rail.edge});
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
      if (BRepAdaptor_Surface(other.neighbour, Standard_False).GetType() == GeomAbs_Plane) {
        // The end face against the direction of the blend: parallel to it (0 rad) is a crease of the picked contour that OCCT did not chain with the
        // next edge (it chains them below about 0.1 rad), perpendicular is the square end the builder wants.
        gp_Pnt at;
        gp_Vec du, dv;
        surface.D1(0.5 * (other.from.X() + other.to.X()), 0.5 * (other.from.Y() + other.to.Y()), at, du, dv);
        const gp_Vec direction = blend.across_is_u ? dv : du;
        if (direction.Magnitude() > 1e-14) {
          const double crease = std::asin(std::min(1.0, std::fabs(direction.Normalized().Dot(normal_of(other.neighbour)))));
          why += crease < 0.5 ? ": it runs out onto the next flat face at a crease of " + number(crease) +
                                    " rad, which OCCT did not chain with it (OCCT chains the edges of a contour across creases of up to about 0.1 rad)"
                              : ": its end is " + number(kPi / 2 - crease) + " rad away from square on a flat face";
        }
      }
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
    (other.is_blend ? blend.end_blend[side] : blend.end_face[side]) = other.neighbour;
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
  double crease = 0;       // mitred chains: the largest crease (turn between the end section planes) a junction was mitred across
  std::vector<int> chain;  // unique edges of the contours OCCT rounded (the picked edges and the rest of their tangent chains)
  bool mitred = false;     // blends of a chain end on a crease: the result is read with the adaptive mass rule (the fixed rule is off by 1e-4 of the swept volume)
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
  LawFillet maker(shape);
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
  BRepClass3d_SolidClassifier classifier(circular);
  bool any_convex = false, any_concave = false;
  for (const Blend &blend : faces) {
    const BRepAdaptor_Surface surface(blend.face, Standard_False);
    // The first stations of the blend (a face whose convexity flips along its length counts as mixed), interior ones only on an open blend: at an end that is square to a flat face the ball centre lies IN that face (ON the solid), which says
    // nothing about the convexity. A centre that is ON is skipped as well.
    for (int j = blend.closed ? 0 : 1; j < kFirstStations; ++j) {
      Section station;
      if (!section_at(surface, blend, blend.lo + (blend.hi - blend.lo) * j / kFirstStations, false, 0.5, station, why)) return nullptr;
      classifier.Perform(station.centre, 1e-9 * diagonal);
      if (classifier.State() == TopAbs_IN) any_convex = true;
      else if (classifier.State() == TopAbs_OUT) any_concave = true;
    }
  }
  const bool mixed = any_convex && any_concave;

  // Creases between blends of the chain: both blends end in the bisector plane of their end section planes (13.16).
  TopTools_IndexedDataMapOfShapeListOfShape vertex_faces;
  TopExp::MapShapesAndAncestors(circular, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);
  // A mitre is exact for a constant size only (laws: start, end (NaN: none), straight flag, count of control points per edge).
  bool constant_size = true;
  for (size_t offset = 0; offset + 4 <= static_cast<size_t>(laws.size()); offset += 4 + 2 * static_cast<size_t>(laws[offset + 3]))
    constant_size = constant_size && std::isnan(laws[offset + 1]) && laws[offset + 3] == 0;
  if (!plan_mitres(faces, blends, vertex_faces, diagonal, constant_size, why)) return nullptr;

  // New blend faces; the faces around them whose edges change (a flat end face, a support face re-trimmed at a mitre) are rebuilt.
  std::vector<TopoDS_Face> skinned;
  std::vector<FaceEdit> edits;
  const auto edit_of = [&edits](const TopoDS_Face &face) -> FaceEdit & {
    for (FaceEdit &edit : edits)
      if (edit.face.IsSame(face)) return edit;
    edits.push_back(FaceEdit{face, {}});
    return edits.back();
  };
  struct Meeting {
    TopoDS_Edge junction;
    TopoDS_Face support;
    TopoDS_Vertex vertex;
  };
  std::vector<Meeting> meetings;  // the vertex two rails of one support share at a mitre
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
      if (!blend.end_face[side].IsNull()) edit_of(blend.end_face[side]).replacements.push_back({blend.end[side], surface->VIso(side == 0 ? v0 : v1), {}});
    // The rails of a mitred blend end at new points: the support faces take the rail curves of the new surface between a shared vertex at each mitre.
    for (int rail = 0; rail < 2; ++rail) {
      bool moves[2];
      for (int end = 0; end < 2; ++end)
        moves[end] = blend.mitre[end].active && blend.mitre[end].shift[rail == 0 ? 0 : 2].Magnitude() > kStillFraction * diagonal;
      if (!moves[0] && !moves[1]) continue;
      const RailPiece &piece = blend.supports[rail][0];
      Replacement replacement{piece.edge, surface->UIso(rail == 0 ? u0 : u1), {}};
      for (int end = 0; end < 2; ++end) {
        if (!moves[end]) continue;
        auto known = std::find_if(meetings.begin(), meetings.end(), [&](const Meeting &meeting) {
          return meeting.junction.IsSame(blend.end[end]) && meeting.support.IsSame(piece.face);
        });
        if (known == meetings.end()) {
          BRep_Builder builder;
          TopoDS_Vertex vertex;
          builder.MakeVertex(vertex, replacement.curve->Value(end == 0 ? v0 : v1), kGapLimit * diagonal);
          meetings.push_back({blend.end[end], piece.face, vertex});
          known = meetings.end() - 1;
        }
        replacement.vertex[end] = known->vertex;
      }
      edit_of(piece.face).replacements.push_back(replacement);
    }
  }
  std::vector<TopoDS_Face> rebuilt;
  for (const FaceEdit &edit : edits) {
    TopoDS_Face face;
    if (!rebuild_face(edit, face, why)) return nullptr;
    rebuilt.push_back(face);
  }

  // Shell: every face that stays, the new blends and the rebuilt faces, sewn. The tolerance OCCT gave the edges where two blends of a chain meet is
  // not an input: those edges are made again.
  const TopTools_IndexedMapOfShape circular_faces = query::distinct(circular, TopAbs_FACE);
  double blend_tolerance = 0;
  for (int b = 1; b <= blends.Extent(); ++b)
    for (TopExp_Explorer it(blends(b), TopAbs_EDGE); it.More(); it.Next()) {
      const TopoDS_Edge edge = TopoDS::Edge(it.Current());
      bool between_blends = true;
      for (TopTools_ListIteratorOfListOfShape owner(edge_faces.FindFromKey(edge)); owner.More(); owner.Next())
        between_blends = between_blends && blends.Contains(owner.Value());
      if (!between_blends) blend_tolerance = std::max(blend_tolerance, BRep_Tool::Tolerance(edge));
    }
  BRepBuilderAPI_Sewing sewing(std::min(std::max(kSewingFraction * diagonal, 2.0 * blend_tolerance), kSewingCap * diagonal));
  std::vector<TopoDS_Face> members;
  std::vector<std::string> member_names;
  const auto replaced = [&](const TopoDS_Shape &face) {
    return std::any_of(edits.begin(), edits.end(), [&](const FaceEdit &edit) { return edit.face.IsSame(face); });
  };
  for (int f = 1; f <= circular_faces.Extent(); ++f) {
    if (blends.Contains(circular_faces(f)) || replaced(circular_faces(f))) continue;
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
  for (size_t e = 0; e < rebuilt.size(); ++e) {
    const int at = circular_faces.FindIndex(edits[e].face);
    if (at < 1) {
      why = "a face the profile blend rebuilds is not a face of the circular fillet";
      return nullptr;
    }
    members.push_back(rebuilt[e]);
    member_names.push_back(circular_names[static_cast<size_t>(at - 1)]);
  }
  const size_t reskinned = skinned.size() + rebuilt.size();
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
  // A void sews into a shell of its own: it becomes an inner shell of the solid (a second body outside the first is refused by name).
  std::string shells_why;
  TopoDS_Solid solid = blend::solid_of_shells(sewn, shells_why);
  if (solid.IsNull() && !shells_why.empty()) {
    why = "the profile blend cannot hold the sewn shells in one solid: " + shells_why;
    return nullptr;
  }
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
  double circular_change = 0;
  if (std::any_of(faces.begin(), faces.end(), [](const Blend &blend) { return blend.mitre[0].active || blend.mitre[1].active; })) {
    for (const Blend &blend : faces) {
      double section_volume = 0;
      if (!circular_section_volume(blend, section_volume, why)) return nullptr;
      circular_change += (any_convex ? 1.0 : -1.0) * section_volume;  // a sanity window on the mitred circular sections
    }
  } else {
    circular_change = volume_of(shape) - volume_of(circular);
  }
  const double before = volume_of(shape), after = volume_of(solid), change = before - after;
  if (!(after > 0) || (!mixed && (!(circular_change * change > 0) || std::fabs(change) < kMinVolumeRatio * std::fabs(circular_change) ||
                                  std::fabs(change) > kMaxVolumeRatio * std::fabs(circular_change)))) {
    why = "the profile blend changed the volume by " + number(change) + " where the circular fillet changes it by " + number(circular_change) +
          " (a profile section changes it between " + number(kMinVolumeRatio) + " and " + number(kMaxVolumeRatio) + " times as much, the same way)";
    return nullptr;
  }
  // The real gap: along every edge a re-skinned face shares with a neighbour, the distance between the two surfaces at the pcurves of the edge (what
  // check_blends reads as g0), sampled at four times the knots of the blend surfaces there (at least 21 points); and, where both faces are blends of
  // the chain, the angle between their normals (a junction). The tolerance OCCT gives a sewn edge is only a bound and can be many times the gap.
  const bool mitred = std::any_of(faces.begin(), faces.end(), [](const Blend &blend) { return blend.mitre[0].active || blend.mitre[1].active; });
  double gap = 0, junction = 0, crease = 0;
  struct Over {
    double excess, largest, allowed;
  } over{0, 0, 0};  // the junction that exceeds its limit by the most
  const TopTools_IndexedMapOfShape final_faces = query::distinct(solid, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape solid_edge_faces;
  TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, solid_edge_faces);
  std::vector<TopoDS_Shape> blend_images;
  for (size_t b = 0; b < skinned.size(); ++b) {
    const TopoDS_Face &member = members[members.size() - reskinned + b];  // the faces that stay come first, then the blends, then the end faces
    blend_images.push_back(sewing.IsModified(member) ? sewing.Modified(member) : member);
  }
  const auto blend_index = [&](const TopoDS_Face &face) {
    for (size_t b = 0; b < blend_images.size(); ++b)
      if (blend_images[b].IsSame(face)) return static_cast<int>(b);
    return -1;
  };
  // The crease a junction of two blends runs across: the turn the mitre was planned for, 0 when the pair was not mitred (a smooth junction).
  const auto planned_crease = [&](int one, int two) {
    for (int side = 0; side < 2; ++side) {
      const Mitre &mitre = faces[static_cast<size_t>(one)].mitre[side];
      if (mitre.active && faces[static_cast<size_t>(one)].end_blend[side].IsSame(faces[static_cast<size_t>(two)].face)) return mitre.turn;
    }
    return 0.0;
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
      const int first_blend = blend_index(around[0]), second_blend = blend_index(around[1]);
      const bool chain_junction = first_blend >= 0 && second_blend >= 0;
      const int samples = std::max(21, 4 * std::max(knots_of(around[0]), knots_of(around[1])));
      double edge_largest = 0;
      for (int k = 0; k <= samples; ++k) {
        const double u = static_cast<double>(k) / samples;
        const gp_Pnt2d a = on_first->Value(first + (last - first) * u), b = on_second->Value(first2 + (last2 - first2) * u);
        gap = std::max(gap, one.Value(a.X(), a.Y()).Distance(two.Value(b.X(), b.Y())));
        if (!chain_junction) continue;
        const gp_Vec n1 = outward(one, around[0], a), n2 = outward(two, around[1], b);
        if (!(n1.Magnitude() > 0.5 && n2.Magnitude() > 0.5)) continue;
        const double angle = std::acos(std::max(-1.0, std::min(1.0, n1.Dot(n2))));
        edge_largest = std::max(edge_largest, angle);
      }
      // Where the chain turns (a mitre), the two blends are tangent to two different support faces at one end of their junction, so the angle there
      // is the crease of the part (the turn the mitre was planned for, from the circular sections), not a defect: only what the junction adds beyond it
      // is held to the limit. A smooth junction, mitred chain or not, keeps the plain limit.
      if (!chain_junction) continue;
      junction = std::max(junction, edge_largest);
      const double allowance = std::max(planned_crease(first_blend, second_blend), planned_crease(second_blend, first_blend));
      crease = std::max(crease, allowance);
      if (edge_largest - allowance - kJunctionAngle > over.excess) over = {edge_largest - allowance - kJunctionAngle, edge_largest, kJunctionAngle + allowance};
    }
  }
  // The acceptance limit is relative to the smaller true box of the source and the result: a fillet that lowers an extreme shrinks the box, and
  // check_blends (mass-properties bounds of the result) must never read a larger gap than the builder accepted.
  const double accepted = blend::kGapAccepted * kGapLimit * std::min(diagonal, std::max(result_diagonal(solid, blend_images), 1e-9));
  if (gap > accepted) {
    why = "the profile faces meet their neighbours only to " + number(gap) + " (limit " + number(accepted) + " = 0.95 x 5e-6 x the smaller bounding-box diagonal of the source and the result): the circular blend OCCT gave is not accurate enough at this size";
    return nullptr;
  }
  if (over.excess > 0) {
    why = "two blends of the chain meet at " + number(over.largest) + " rad (limit " + number(over.allowed) +
          " rad, 0.95 x the check_blends default of 0.01 plus the crease angle of the part at that junction): the apex of the section moves with the fold angle, whose derivative jumps where the curvature of a wall jumps";
    stage = Stage::Junction;
    return nullptr;
  }
  measured = {gap, accepted, mixed, junction, crease, chain, mitred};
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
  if (has_straight_kink(laws) || measured.mitred) built->refined_mass = true;
  JsonWriter out;
  out.begin_object().key("builder").string("rails").key("gap").number(measured.gap).key("gapLimit").number(measured.limit).key("junctionG1").number(measured.junction).key("creaseRad").number(measured.crease).key("mixed").boolean(measured.mixed);
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
