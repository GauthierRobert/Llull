// Face blends (BLD M4, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.6): a rolling-ball blend between two faces that need not share an
// edge (`fillet_faces`) and the full round of a rib top (`fillet_full_round`). Scope of this build: planar faces and a constant radius, ending on
// flat faces square to the blend; the blend is the boolean of the source with the spandrel (or half-disc) prism of the virtual corner, built by
// the same tools as the profile blends (blend_profile.cxx). A reason that starts with "[CODE] " carries the stable BLD_* code it maps to.
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRep_Tool.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepGProp.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GProp_GProps.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace {

gp_Vec unit(const gp_Vec &vector) {
  gp_Vec copy = vector;
  copy.Normalize();
  return copy;
}

gp_Pnt location_of(const TopoDS_Face &face) { return BRepAdaptor_Surface(face, Standard_True).Plane().Location(); }

gp_Pnt centroid_of(const TopoDS_Face &face) {
  GProp_GProps props;
  BRepGProp::SurfaceProperties(face, props);
  return props.CentreOfMass();
}

// Smallest and largest coordinate of the vertices of `face` along `axis` measured from `origin`.
void extent_along(const TopoDS_Face &face, const gp_Pnt &origin, const gp_Vec &axis, double &low, double &high) {
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(face, TopAbs_VERTEX, vertices);
  low = 1e300;
  high = -1e300;
  for (int v = 1; v <= vertices.Extent(); ++v) {
    const double at = gp_Vec(origin, BRep_Tool::Pnt(TopoDS::Vertex(vertices(v)))).Dot(axis);
    low = std::min(low, at);
    high = std::max(high, at);
  }
}

// Whether the source has a planar face perpendicular to `axis` through `point` (the flat square end a flush prism needs).
bool capped_at(const TopoDS_Shape &shape, const gp_Pnt &point, const gp_Vec &axis) {
  const TopTools_IndexedMapOfShape faces = query::distinct(shape, TopAbs_FACE);
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) continue;
    const gp_Vec normal = normal_of(face);
    if (std::fabs(std::fabs(normal.Dot(axis)) - 1.0) > 1e-9) continue;
    if (std::fabs(gp_Vec(location_of(face), point).Dot(normal)) < 1e-6) return true;
  }
  return false;
}

// Geometry of the virtual corner of two planar faces.
struct Corner {
  gp_Pnt start, end, a, b;
  gp_Vec direction, normal_a, normal_b, inward_a, inward_b;
  double fold = 0;
  double length = 0;
  bool convex = true;
};

bool bad(std::string &why, const std::string &message) {
  why = message;
  return false;
}

// The corner of faces `fa` / `fb` of `shape` with legs `leg`, or the reason there is none.
bool corner_of(const TopoDS_Shape &shape, const TopoDS_Face &fa, const TopoDS_Face &fb, double leg, Corner &c, std::string &why) {
  if (BRepAdaptor_Surface(fa, Standard_True).GetType() != GeomAbs_Plane || BRepAdaptor_Surface(fb, Standard_True).GetType() != GeomAbs_Plane)
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] this build blends planar faces only");
  c.normal_a = outward_normal(shape, fa);
  c.normal_b = outward_normal(shape, fb);
  const double cosine = std::max(-1.0, std::min(1.0, c.normal_a.Dot(c.normal_b)));
  c.fold = std::acos(cosine);
  if (c.fold < kTangentAngle) return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces are coplanar (nothing to blend)");
  if (c.fold > kPi - kTangentAngle)
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces are parallel and facing away from each other: use fillet_full_round");
  c.direction = unit(c.normal_a.Crossed(c.normal_b));
  const double da = gp_Vec(gp_Pnt(0, 0, 0), location_of(fa)).Dot(c.normal_a);
  const double db = gp_Vec(gp_Pnt(0, 0, 0), location_of(fb)).Dot(c.normal_b);
  const gp_Vec on_line = (c.normal_a * (da - db * cosine) + c.normal_b * (db - da * cosine)) / (1.0 - cosine * cosine);
  const gp_Pnt line_point(on_line.X(), on_line.Y(), on_line.Z());
  gp_Vec across_a = unit(c.normal_a.Crossed(c.direction));
  gp_Vec across_b = unit(c.normal_b.Crossed(c.direction));
  if (gp_Vec(line_point, centroid_of(fa)).Dot(across_a) < 0) across_a.Reverse();
  if (gp_Vec(line_point, centroid_of(fb)).Dot(across_b) < 0) across_b.Reverse();
  c.inward_a = across_a;
  c.inward_b = across_b;
  c.convex = c.normal_a.Dot(c.inward_b) < 0;
  double low_a, high_a, low_b, high_b;
  extent_along(fa, line_point, c.direction, low_a, high_a);
  extent_along(fb, line_point, c.direction, low_b, high_b);
  const double s0 = std::max(low_a, low_b), s1 = std::min(high_a, high_b);
  if (!(s1 - s0 > 1e-9)) return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces do not overlap along their common direction");
  c.start = line_point.Translated(c.direction * s0);
  c.end = line_point.Translated(c.direction * s1);
  c.length = s1 - s0;
  if (!capped_at(shape, c.start, c.direction) || !capped_at(shape, c.end, c.direction))
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the blend does not end on flat faces square to it (this build needs both ends capped)");
  c.a = c.start.Translated(c.inward_a * leg);
  c.b = c.start.Translated(c.inward_b * leg);
  return true;
}

bool legs_fit(const Corner &c, const TopoDS_Face &fa, const TopoDS_Face &fb) {
  for (double s : {0.0, 0.5, 1.0}) {
    const gp_Vec along = c.direction * (s * c.length);
    if (!inside(fa, c.a.Translated(along)) || !inside(fb, c.b.Translated(along))) return false;
  }
  return true;
}

// Whether the section arc (at mid-length) is where the blend needs it: inside the material for a convex corner (the blend removes material
// up to it), outside the material for a concave one (the blend adds material up to it).
bool arc_fits(const bool convex, const TopoDS_Shape &shape, const Corner &c, int kind, double param) {
  const Handle(Geom_Curve) curve = section_curve(c.start, c.a, c.b, kind, param, kPi - c.fold);
  BRepClass3d_SolidClassifier classifier(shape);
  const gp_Vec middle = c.direction * (c.length / 2);
  for (int k = 1; k < 8; ++k) {
    const gp_Pnt point = curve->Value(curve->FirstParameter() + (curve->LastParameter() - curve->FirstParameter()) * k / 8.0).Translated(middle);
    classifier.Perform(point, kInsideTolerance);
    if (classifier.State() == (convex ? TopAbs_OUT : TopAbs_IN)) return false;
  }
  return true;
}

std::string sorted_name(const std::string &first, const std::string &second) {
  return first < second ? "blend(e(" + first + "|" + second + "))" : "blend(e(" + second + "|" + first + "))";
}

}  // namespace

static std::unique_ptr<Shape> build_face_blend(const Shape &source, rust::Slice<const double> raw, std::string &why) {
  if (raw.size() != 5) {
    why = "face blend specification is malformed";
    return nullptr;
  }
  const int ia = static_cast<int>(raw[0]), ib = static_cast<int>(raw[1]);
  const double radius = raw[2];
  const int kind = static_cast<int>(raw[3]);
  const double param = raw[4];
  const TopTools_IndexedMapOfShape faces = query::distinct(source.shape, TopAbs_FACE);
  if (ia < 0 || ib < 0 || ia >= faces.Extent() || ib >= faces.Extent() || !(radius > 0)) {
    why = "face index out of range or radius <= 0";
    return nullptr;
  }
  if (ia == ib) {
    why = "[BLD_FACESETS_OVERLAP] the two face sets are the same face";
    return nullptr;
  }
  const naming::Named input = naming::named(source);
  const TopoDS_Face fa = TopoDS::Face(faces(ia + 1)), fb = TopoDS::Face(faces(ib + 1));
  Corner c;
  // The legs depend on the fold, which corner_of computes: first with a unit leg to get the fold, then with the real one.
  if (!corner_of(source.shape, fa, fb, 1.0, c, why)) return nullptr;
  const double leg = radius * std::tan(c.fold / 2);
  if (!corner_of(source.shape, fa, fb, leg, c, why)) return nullptr;
  if (!legs_fit(c, fa, fb)) {
    why = "[BLD_FACE_FILLET_NO_SOLUTION] a ball of radius " + std::to_string(radius) + " does not fit between the two faces (its contact lines leave them); use a smaller radius";
    return nullptr;
  }
  if (!arc_fits(c.convex, source.shape, c, kind, param)) {
    // The smallest radius whose blend stays in the material, by bisection from the radius given up to a radius that works.
    const auto works = [&](double r) {
      Corner trial;
      std::string ignored;
      return corner_of(source.shape, fa, fb, r * std::tan(c.fold / 2), trial, ignored) && legs_fit(trial, fa, fb) && arc_fits(trial.convex, source.shape, trial, kind, param);
    };
    double high = radius * 2;
    for (int step = 0; step < 24 && !works(high); ++step) high *= 2;
    std::string hint;
    if (works(high)) {
      double low = radius;
      for (int step = 0; step < 40; ++step) {
        const double middle = (low + high) / 2;
        (works(middle) ? high : low) = middle;
      }
      hint = "; the smallest radius that does is about " + std::to_string(high);
    }
    why = "[BLD_FACE_FILLET_NO_SOLUTION] no ball of radius " + std::to_string(radius) + " touches both faces on the side the blend needs (the arc is in the wrong region of the solid)" + hint;
    return nullptr;
  }
  Tool tool;
  if (!spandrel_tool(c.start, c.end, c.a, c.b, kind, param, kPi - c.fold, sorted_name(input.names[static_cast<size_t>(ia)], input.names[static_cast<size_t>(ib)]), tool, why))
    return nullptr;
  tool.convex = c.convex;
  naming::Named current = input;
  if (!apply_tools(current, {tool}, why)) return nullptr;
  return naming::wrap_named(current.shape, current.names);
}

static std::unique_ptr<Shape> build_full_round(const Shape &source, rust::Slice<const double> raw, std::string &why) {
  if (raw.size() != 3) {
    why = "full round specification is malformed";
    return nullptr;
  }
  const int i1 = static_cast<int>(raw[0]), ic = static_cast<int>(raw[1]), i2 = static_cast<int>(raw[2]);
  const TopTools_IndexedMapOfShape faces = query::distinct(source.shape, TopAbs_FACE);
  for (int index : {i1, ic, i2})
    if (index < 0 || index >= faces.Extent()) {
      why = "face index out of range";
      return nullptr;
    }
  if (i1 == i2 || i1 == ic || i2 == ic) {
    why = "[BLD_FACESETS_OVERLAP] a face is in two of the three sets";
    return nullptr;
  }
  const TopoDS_Face f1 = TopoDS::Face(faces(i1 + 1)), fc = TopoDS::Face(faces(ic + 1)), f2 = TopoDS::Face(faces(i2 + 1));
  for (const TopoDS_Face &face : {f1, fc, f2})
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) {
      why = "[BLD_FACE_BLEND_UNSUPPORTED] this build rounds planar faces only";
      return nullptr;
    }
  const gp_Vec n1 = outward_normal(source.shape, f1), n2 = outward_normal(source.shape, f2), nc = outward_normal(source.shape, fc);
  if (std::fabs(n1.Dot(n2) + 1.0) > 1e-9 || std::fabs(nc.Dot(n1)) > 1e-9) {
    why = "[BLD_FULL_ROUND_NOT_OPPOSED] the side faces must be parallel and face away from each other, the center face square to both";
    return nullptr;
  }
  const gp_Pnt origin(0, 0, 0);
  const double width = (gp_Vec(origin, location_of(f1)) - gp_Vec(origin, location_of(f2))).Dot(n1);
  if (!(width > 1e-9)) {
    why = "[BLD_FULL_ROUND_NOT_OPPOSED] the side faces face each other: the solid is not between them";
    return nullptr;
  }
  const double r = width / 2;
  const gp_Vec e = unit(n1.Crossed(nc));
  const gp_Vec mid_plane = gp_Vec(origin, location_of(f2)) + n1 * (width / 2);
  const double top = gp_Vec(origin, location_of(fc)).Dot(nc);
  const gp_Vec axis_vector = mid_plane + nc * (top - r - mid_plane.Dot(nc));
  const gp_Pnt axis(axis_vector.X(), axis_vector.Y(), axis_vector.Z());
  double l1, h1, l2, h2, lc, hc;
  extent_along(f1, axis, e, l1, h1);
  extent_along(f2, axis, e, l2, h2);
  extent_along(fc, axis, e, lc, hc);
  const double s0 = std::max({l1, l2, lc}), s1 = std::min({h1, h2, hc});
  if (!(s1 - s0 > 1e-9)) {
    why = "[BLD_FULL_ROUND_NO_SOLUTION] the three face sets do not overlap along their common direction";
    return nullptr;
  }
  double lo, hi;
  extent_along(fc, axis, n1, lo, hi);
  if (std::fabs((hi - lo) - width) > 1e-6 * width) {
    why = "[BLD_FULL_ROUND_NO_SOLUTION] the center face is not as wide as the gap between the sides, so no half-round is tangent to all three";
    return nullptr;
  }
  // The sides must reach from the axis up to the top, or the half-round would stand on air.
  for (const TopoDS_Face &side : {f1, f2}) {
    double below, above;
    extent_along(side, axis, nc, below, above);
    if (below > 1e-6 * width || above < r - 1e-6 * width) {
      why = "[BLD_FULL_ROUND_NO_SOLUTION] the side faces do not reach down to the axis of the half-round (the rib is lower than half its width)";
      return nullptr;
    }
  }
  const gp_Pnt start = axis.Translated(e * s0), end = axis.Translated(e * s1);
  if (!capped_at(source.shape, start, e) || !capped_at(source.shape, end, e)) {
    why = "[BLD_FACE_BLEND_UNSUPPORTED] the round does not end on flat faces square to it (this build needs both ends capped)";
    return nullptr;
  }
  const naming::Named input = naming::named(source);
  const double margin = 1e-3 * width + 1e-6;
  // 1. cut away everything above the axis; 2. fuse the half-round back.
  BRepBuilderAPI_MakePolygon box;
  for (const auto &[x, y] : std::vector<std::pair<double, double>>{{-(r + margin), 0}, {r + margin, 0}, {r + margin, r + margin}, {-(r + margin), r + margin}})
    box.Add(start.Translated(n1 * x + nc * y));
  box.Close();
  BRepBuilderAPI_MakeFace box_face(box.Wire(), Standard_True);
  BRepPrimAPI_MakePrism box_prism(box_face.Face(), gp_Vec(start, end));
  box_prism.Build();
  if (!box_face.IsDone() || !box_prism.IsDone()) {
    why = "the clearing box of the round could not be built";
    return nullptr;
  }
  Tool clear;
  clear.shape = box_prism.Shape();
  clear.convex = true;
  const TopTools_IndexedMapOfShape clear_faces = query::distinct(clear.shape, TopAbs_FACE);
  for (int f = 0; f < clear_faces.Extent(); ++f) clear.names.push_back("tool.clear." + std::to_string(f));
  const gp_Pnt q1 = start.Translated(n1 * r), q2 = start.Translated(n1 * -r), crown = start.Translated(nc * r);
  GC_MakeArcOfCircle arc_maker(q1, crown, q2);
  if (!arc_maker.IsDone()) {
    why = "the half-round arc could not be built";
    return nullptr;
  }
  BRepBuilderAPI_MakeEdge arc(arc_maker.Value()), chord(q2, q1);
  BRepBuilderAPI_MakeWire wire;
  wire.Add(arc.Edge());
  wire.Add(chord.Edge());
  BRepBuilderAPI_MakeFace half_disc(wire.Wire(), Standard_True);
  BRepPrimAPI_MakePrism round_prism(half_disc.Face(), gp_Vec(start, end));
  round_prism.Build();
  if (!wire.IsDone() || !half_disc.IsDone() || !round_prism.IsDone()) {
    why = "the half-round tool could not be built";
    return nullptr;
  }
  Tool round;
  round.shape = round_prism.Shape();
  round.convex = false;
  const TopTools_IndexedMapOfShape round_faces = query::distinct(round.shape, TopAbs_FACE);
  round.names.assign(static_cast<size_t>(round_faces.Extent()), "");
  for (int f = 0; f < round_faces.Extent(); ++f) round.names[static_cast<size_t>(f)] = "tool.round." + std::to_string(f);
  TopoDS_Shape arc_edge;
  for (TopExp_Explorer it(half_disc.Face(), TopAbs_EDGE); it.More(); it.Next())
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() == GeomAbs_Circle) arc_edge = it.Current();
  const TopTools_ListOfShape &lateral = round_prism.Generated(arc_edge);
  if (lateral.IsEmpty()) {
    why = "the half-round face was not generated";
    return nullptr;
  }
  const int blend_face = round_faces.FindIndex(lateral.First());
  if (blend_face > 0) round.names[static_cast<size_t>(blend_face - 1)] = sorted_name(input.names[static_cast<size_t>(i1)], input.names[static_cast<size_t>(i2)]);
  naming::Named current = input;
  if (!apply_tools(current, {clear, round}, why)) return nullptr;
  return naming::wrap_named(current.shape, current.names);
}

std::unique_ptr<Shape> face_blend(const Shape &shape, rust::Slice<const double> spec) {
  std::string why;
  try {
    return build_face_blend(shape, spec, why);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String face_blend_reason(const Shape &shape, rust::Slice<const double> spec) {
  std::string why;
  std::unique_ptr<Shape> built;
  try {
    built = build_face_blend(shape, spec, why);
  } catch (const Standard_Failure &error) {
    why = std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the face blend failed") : why));
}

std::unique_ptr<Shape> full_round(const Shape &shape, rust::Slice<const double> spec) {
  std::string why;
  try {
    return build_full_round(shape, spec, why);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String full_round_reason(const Shape &shape, rust::Slice<const double> spec) {
  std::string why;
  std::unique_ptr<Shape> built;
  try {
    built = build_full_round(shape, spec, why);
  } catch (const Standard_Failure &error) {
    why = std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the full round failed") : why));
}

}  // namespace llull
