// Exact space deformation of a B-rep (01 DEF M2, TECHNICAL_SPEC §5.6). The map F (twist, taper, stretch, bend, lattice, point push) is applied to
// the geometry, not to a mesh: a BRepTools_Modification replaces every face surface S by a cubic B-spline fitted to F(S) and every edge curve C by
// one fitted to F(C) (deform_fit.hxx), within the tolerance. The (u, v) parameterisation of each face is kept, so every curve on surface stays
// valid. Faces crossing a place where the law is not analytic (region ends, lattice box faces) are split there first; a full-turn bend drops its
// two coincident end caps and sews the ring closed. The result is checked (BRepCheck, positive volume) and refused with a coded reason rather
// than returned wrong.
#include "llull-kernel-occt/cpp/deform.hxx"

#include <algorithm>
#include <cmath>
#include <Geom2d_Curve.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepCheck_ListIteratorOfListOfStatus.hxx>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_ModifyShape.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepTools.hxx>
#include <BRepTools_History.hxx>
#include <BRepTools_Modification.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <ShapeAnalysis_ShapeTolerance.hxx>
#include <ShapeFix_Shape.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <Precision.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Pln.hxx>

#include "llull-kernel-occt/cpp/deform_fit.hxx"
#include "llull-kernel-occt/cpp/deform_spec.hxx"
#include "llull-kernel-occt/cpp/deform_topology.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"

namespace llull {

namespace {

using deform::Falloff;
using deform::LawKind;
using deform::Warp;

// det J at or below this counts as folded (01 DEF §5.9 Jacobian floor).
constexpr double kJacobianFloor = 1e-6;
// Share of the tolerance given to faces, edges: an edge lies within tol_c + tol_s of its faces (§5.6).
constexpr double kSurfaceShare = 0.5;
constexpr double kCurveShare = 0.25;

thread_local std::string g_report;

// What the run found out; becomes the JSON report.
struct Stats {
  bool ok = false;
  std::string code;
  std::string message;
  double surface_error = 0;
  double min_determinant = 1;
  double curve_error = 0;
  int faces = 0;
  int edges = 0;
  int split_faces = 0;
  bool ring = false;
  bool fixed = false;  // ShapeFix_Shape repaired the result; its largest sub-shape tolerance was measured again
  double fixed_tolerance = 0;
  double volume = 0;
  bool failed = false;  // an approximation failed inside the modification
};

void publish(const Stats &stats) {
  JsonWriter json;
  json.begin_object();
  json.key("ok").boolean(stats.ok);
  json.key("code").string(stats.code);
  json.key("message").string(stats.message);
  json.key("maxError").number(std::max(stats.surface_error, stats.curve_error));
  json.key("surfaceError").number(stats.surface_error);
  json.key("curveError").number(stats.curve_error);
  json.key("faces").integer(stats.faces);
  json.key("edges").integer(stats.edges);
  json.key("splitFaces").integer(stats.split_faces);
  json.key("ring").boolean(stats.ring);
  json.key("fixed").boolean(stats.fixed);
  json.key("fixedTolerance").number(stats.fixed_tolerance);
  json.key("minDeterminant").number(stats.min_determinant);
  json.key("volume").number(stats.volume);
  json.end_object();
  g_report = json.text();
}

std::unique_ptr<Shape> refuse(Stats &stats, const char *code, const std::string &message) {
  stats.ok = false;
  stats.code = code;
  stats.message = message;
  publish(stats);
  return nullptr;
}

class WarpModification : public BRepTools_Modification {
  DEFINE_STANDARD_RTTI_INLINE(WarpModification, BRepTools_Modification)
 public:
  WarpModification(const Warp &warp, double tolerance, Stats &stats) : warp_(warp), tolerance_(tolerance), stats_(stats) {}

  Standard_Boolean NewSurface(const TopoDS_Face &face, Handle(Geom_Surface) & surface, TopLoc_Location &location, Standard_Real &tol,
                              Standard_Boolean &rev_wires, Standard_Boolean &rev_face) override {
    rev_wires = Standard_False;
    rev_face = Standard_False;
    const Handle(Geom_Surface) base = BRep_Tool::Surface(face);
    if (base.IsNull() || stats_.failed) return Standard_False;
    double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
    BRepTools::UVBounds(face, u0, u1, v0, v1);
    if (!(u1 > u0) || !(v1 > v0)) return fail("a face has an empty parameter box");
    const double wanted = kSurfaceShare * tolerance_;
    const deform::SurfaceFit fit = deform::fit_surface(warp_, base, u0, u1, v0, v1, wanted);
    stats_.surface_error = std::max(stats_.surface_error, fit.error);
    stats_.min_determinant = std::min(stats_.min_determinant, fit.min_determinant);
    ++stats_.faces;
    if (!fit.ok || fit.surface.IsNull()) {
      stats_.code = "DEF_APPROX_TOLERANCE";
      stats_.message = "a face approximation reaches " + std::to_string(fit.error) + " against the allowed " + std::to_string(wanted);
      stats_.failed = true;
      return Standard_False;
    }
    surface = fit.surface;
    location = TopLoc_Location();
    tol = std::max(BRep_Tool::Tolerance(face), fit.error);
    return Standard_True;
  }

  Standard_Boolean NewCurve(const TopoDS_Edge &edge, Handle(Geom_Curve) & curve, TopLoc_Location &location, Standard_Real &tol) override {
    location = TopLoc_Location();
    tol = BRep_Tool::Tolerance(edge);
    if (stats_.failed) return Standard_False;
    if (BRep_Tool::Degenerated(edge)) {
      curve.Nullify();
      return Standard_True;
    }
    double first = 0, last = 0;
    const Handle(Geom_Curve) base = BRep_Tool::Curve(edge, first, last);
    if (base.IsNull()) return Standard_False;
    const double wanted = kCurveShare * tolerance_;
    const deform::CurveFit fit = deform::fit_curve(warp_, base, first, last, wanted);
    stats_.curve_error = std::max(stats_.curve_error, fit.error);
    ++stats_.edges;
    if (!fit.ok || fit.curve.IsNull()) {
      stats_.code = "DEF_APPROX_TOLERANCE";
      stats_.message = "an edge approximation reaches " + std::to_string(fit.error) + " against the allowed " + std::to_string(wanted);
      stats_.failed = true;
      return Standard_False;
    }
    curve = fit.curve;
    tol = std::max(tol, fit.error);
    return Standard_True;
  }


  Standard_Boolean NewPoint(const TopoDS_Vertex &vertex, gp_Pnt &point, Standard_Real &tol) override {
    const gp_Pnt old = BRep_Tool::Pnt(vertex);
    const double in[3] = {old.X(), old.Y(), old.Z()};
    double out[3];
    warp_.point(in, out);
    point.SetCoord(out[0], out[1], out[2]);
    tol = std::max(BRep_Tool::Tolerance(vertex), 0.5 * tolerance_);
    return Standard_True;
  }

  // The (u, v) parameterisation of every face is kept, so the curve on surface of the edge is the old one; the modifier does not carry it over
  // by itself when the surface changed, so it is handed back explicitly.
  Standard_Boolean NewCurve2d(const TopoDS_Edge &edge, const TopoDS_Face &face, const TopoDS_Edge &, const TopoDS_Face &, Handle(Geom2d_Curve) & curve,
                              Standard_Real &tol) override {
    double first = 0, last = 0;
    const Handle(Geom2d_Curve) old = BRep_Tool::CurveOnSurface(edge, face, first, last);
    if (old.IsNull()) return Standard_False;
    curve = Handle(Geom2d_Curve)::DownCast(old->Copy());
    tol = BRep_Tool::Tolerance(edge);
    return Standard_True;
  }

  // The fitted curve keeps the parameterisation, so a vertex keeps its parameter on the edge (a closed edge has two: the modifier must not
  // recompute them from the geometry).
  Standard_Boolean NewParameter(const TopoDS_Vertex &vertex, const TopoDS_Edge &edge, Standard_Real &parameter, Standard_Real &tol) override {
    if (BRep_Tool::Degenerated(edge)) return Standard_False;
    parameter = BRep_Tool::Parameter(vertex, edge);
    tol = std::max(BRep_Tool::Tolerance(vertex), 0.5 * tolerance_);
    return Standard_True;
  }

  GeomAbs_Shape Continuity(const TopoDS_Edge &edge, const TopoDS_Face &first, const TopoDS_Face &second, const TopoDS_Edge &,
                           const TopoDS_Face &, const TopoDS_Face &) override {
    return BRep_Tool::Continuity(edge, first, second);
  }

 private:
  Standard_Boolean fail(const char *message) {
    if (!stats_.failed) {
      stats_.code = "DEF_APPROX_TOLERANCE";
      stats_.message = message;
    }
    stats_.failed = true;
    return Standard_False;
  }

  Warp warp_;
  double tolerance_;
  Stats &stats_;
};

class WarpShape : public BRepBuilderAPI_ModifyShape {
 public:
  WarpShape(const TopoDS_Shape &shape, const Handle(WarpModification) & modification) : BRepBuilderAPI_ModifyShape() {
    DoModif(shape, modification);
  }
};

}  // namespace

std::unique_ptr<Shape> warp_shape(const Shape &input, rust::Slice<const double> spec) {
  Stats stats;
  Warp warp;
  double tolerance = 0;
  bool preserve = false;
  std::string why;
  if (!parse_spec(spec, warp, tolerance, preserve, why)) return refuse(stats, "DEF_KERNEL_REFUSED", why);
  if (input.shape.IsNull()) return refuse(stats, "DEF_KERNEL_REFUSED", "the source shape is empty");
  deform::base_unconverged() = false;
  std::vector<naming::Named> named{naming::named(input)};
  TopoDS_Shape source = input.shape;

  if (taper_scale_vanishes(warp, source))
    return refuse(stats, "DEF_FOLDOVER", "the map folds the body: the infinite taper scale reaches 0 inside the body (det J = s^2 touches 0)");

  // A full-turn ring: drop the two coincident end caps; sewing closes it again after the warp.
  bool full_turn = false;
  const TopoDS_Shape ring = ring_without_caps(source, warp, tolerance, full_turn);
  if (full_turn && ring.IsNull())
    return refuse(stats, "DEF_SELF_INTERSECTION",
                  "a full-turn bend needs exactly two planar end faces to close into a ring; this body's ends are split, filleted or not planar");
  if (!ring.IsNull()) {
    stats.ring = true;
    // the ring keeps the name of its first lateral face (sewing merges the faces, no history of its own)
    std::string ring_name = named[0].names.empty() ? std::string("ring") : named[0].names[0];
    TopTools_IndexedMapOfShape ring_faces, all_faces;
    TopExp::MapShapes(ring, TopAbs_FACE, ring_faces);
    TopExp::MapShapes(source, TopAbs_FACE, all_faces);
    std::vector<std::string> ring_names;
    for (int f = 1; f <= ring_faces.Extent(); ++f) {
      const int at = all_faces.FindIndex(ring_faces(f));
      ring_names.push_back(at > 0 ? named[0].names[static_cast<size_t>(at - 1)] : ring_name);
    }
    named = {naming::Named{ring, ring_names}};
    source = ring;
  }
  if (!stats.ring) {
    const std::vector<Cut> cuts = cuts_of(warp, source);
    if (!cuts.empty()) {
      const TopoDS_Shape split = split_faces(source, warp, cuts, named, stats.split_faces);
      if (!split.IsNull()) source = split;
    }
  }

  Handle(WarpModification) modification = new WarpModification(warp, tolerance, stats);
  WarpShape modifier(source, modification);
  if (stats.failed) return refuse(stats, stats.code.empty() ? "DEF_APPROX_TOLERANCE" : stats.code.c_str(), stats.message);
  if (!modifier.IsDone() || modifier.Shape().IsNull()) return refuse(stats, "DEF_KERNEL_REFUSED", "the geometry modifier failed");
  if (deform::base_unconverged())
    return refuse(stats, "DEF_FLOW_BASE_OUTSIDE", "the base coordinates of a point of the body could not be solved on the base table (it lies past the sheet or at its centre of curvature)");
  TopoDS_Shape result = modifier.Shape();

  if (stats.ring) {
    const TopoDS_Shape closed = sewn_solid(result, 2 * tolerance);
    if (closed.IsNull()) return refuse(stats, "DEF_KERNEL_REFUSED", "the full-turn ring could not be sewn closed");
    result = closed;
  }
  BRepLib::SameParameter(result, tolerance, Standard_True);
  if (!BRepCheck_Analyzer(result, Standard_True).IsValid()) {
    ShapeFix_Shape fixer(result);
    fixer.Perform();
    if (!fixer.Shape().IsNull()) result = fixer.Shape();
    if (!BRepCheck_Analyzer(result, Standard_True).IsValid())
      return refuse(stats, "DEF_KERNEL_REFUSED", "the deformed shape is not a valid B-rep (BRepCheck_Analyzer)");
    // the repair may have loosened the geometry: measure the deviation again (sub-shape tolerances bound it) and refuse above the allowed one
    stats.fixed = true;
    stats.fixed_tolerance = ShapeAnalysis_ShapeTolerance().Tolerance(result, 1);
    if (stats.fixed_tolerance > 4 * tolerance)
      return refuse(stats, "DEF_APPROX_TOLERANCE",
                    "repairing the deformed shape raised its tolerance to " + std::to_string(stats.fixed_tolerance) + " against the allowed " +
                        std::to_string(tolerance));
  }
  double volume = signed_volume(result);
  if (volume < 0 && result.ShapeType() == TopAbs_SOLID) {
    result.Reverse();
    volume = -volume;
  }
  stats.volume = volume;
  if (!(stats.min_determinant > kJacobianFloor))
    return refuse(stats, "DEF_FOLDOVER", "the map folds the body: det J reaches " + std::to_string(stats.min_determinant) + " on its surface");
  if (!(volume > 0)) return refuse(stats, "DEF_FOLDOVER", "the deformed shape has no positive volume (the map folds the body)");

  // Names: images of the (split) source faces; the sewn ring has no history, so it keeps one name per face from the source order.
  Handle(BRepTools_History) history = new BRepTools_History();
  if (!stats.ring) {
    TopTools_IndexedMapOfShape old_faces;
    TopExp::MapShapes(source, TopAbs_FACE, old_faces);
    for (int f = 1; f <= old_faces.Extent(); ++f) {
      for (TopTools_ListIteratorOfListOfShape image(modifier.Modified(old_faces(f))); image.More(); image.Next())
        if (!image.Value().IsSame(old_faces(f))) history->AddModified(old_faces(f), image.Value());
    }
  }
  std::vector<std::string> names;
  if (!stats.ring) {
    names = naming::inherit(result, named, history, "deform");
  } else {
    const int count = count_faces(result);
    const std::string base = named[0].names.empty() ? std::string("ring") : named[0].names.back();
    for (int f = 0; f < count; ++f) names.push_back(count == 1 ? base : base + "#" + std::to_string(f + 1));
  }
  stats.ok = true;
  publish(stats);
  std::unique_ptr<Shape> warped = naming::wrap_named(result, names);
  if (warped != nullptr) warped->refined_mass = true;
  return warped;
}

rust::String warp_report() { return rust::String(g_report); }

rust::Vec<double> warp_points(rust::Slice<const double> spec, rust::Slice<const double> points) {
  rust::Vec<double> out;
  Warp warp;
  double tolerance = 0;
  bool preserve = false;
  std::string why;
  if (!parse_spec(spec, warp, tolerance, preserve, why) || points.size() % 3 != 0) throw std::invalid_argument(why.empty() ? "points: wrong length" : why);
  for (size_t i = 0; i + 2 < points.size(); i += 3) {
    const double in[3] = {points[i], points[i + 1], points[i + 2]};
    double image[3];
    warp.point(in, image);
    for (double value : image) out.push_back(value);
  }
  return out;
}

rust::Vec<double> warp_determinants(rust::Slice<const double> spec, rust::Slice<const double> points) {
  rust::Vec<double> out;
  Warp warp;
  double tolerance = 0;
  bool preserve = false;
  std::string why;
  if (!parse_spec(spec, warp, tolerance, preserve, why) || points.size() % 3 != 0) throw std::invalid_argument(why.empty() ? "points: wrong length" : why);
  for (size_t i = 0; i + 2 < points.size(); i += 3) {
    // the world Jacobian column by column: one Jet evaluation per axis, seeded along it (the frame is a rotation, so det is the law's)
    double columns[3][3];
    for (size_t axis = 0; axis < 3; ++axis) {
      deform::Vec3J world = {deform::Jet(points[i]), deform::Jet(points[i + 1]), deform::Jet(points[i + 2])};
      world[axis].a = 1;
      const deform::Vec3J image = warp.apply(world);
      for (size_t k = 0; k < 3; ++k) columns[axis][k] = image[k].a;
    }
    const double* c0 = columns[0];
    const double* c1 = columns[1];
    const double* c2 = columns[2];
    out.push_back(c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]));
  }
  return out;
}

}  // namespace llull
