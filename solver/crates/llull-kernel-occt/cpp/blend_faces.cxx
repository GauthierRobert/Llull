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
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepTools.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GProp_GProps.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <Precision.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
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

using FaceSet = std::vector<TopoDS_Face>;

gp_Pnt location_of(const TopoDS_Face &face) { return BRepAdaptor_Surface(face, Standard_True).Plane().Location(); }

// Area-weighted centre of the surfaces of a face set.
gp_Pnt set_centroid(const FaceSet &set) {
  GProp_GProps props;
  for (const TopoDS_Face &face : set) {
    GProp_GProps one;
    BRepGProp::SurfaceProperties(face, one);
    props.Add(one);
  }
  return props.CentreOfMass();
}

// Whether `point` is IN or ON some face of `set`.
bool set_inside(const FaceSet &set, const gp_Pnt &point) {
  for (const TopoDS_Face &face : set)
    if (inside(face, point)) return true;
  return false;
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

void set_extent(const FaceSet &set, const gp_Pnt &origin, const gp_Vec &axis, double &low, double &high) {
  low = 1e300;
  high = -1e300;
  for (const TopoDS_Face &face : set) {
    double face_low, face_high;
    extent_along(face, origin, axis, face_low, face_high);
    low = std::min(low, face_low);
    high = std::max(high, face_high);
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

// Geometry of the virtual corner of two faces: a straight corner line swept by a prism (two planes) or a corner in a meridian plane swept once
// around an axis (a plane square to the axis, a cylinder or a cone about it).
struct Corner {
  gp_Pnt start, end, a, b;
  gp_Vec direction, normal_a, normal_b, inward_a, inward_b;
  double fold = 0;
  double length = 0;
  bool convex = true;
  bool revolved = false;
  gp_Ax1 axis;

  // `point` of the section at the start moved to the fraction `s` of the sweep.
  gp_Pnt station(const gp_Pnt &point, double s) const { return revolved ? point.Rotated(axis, 2 * kPi * s) : point.Translated(direction * (s * length)); }
  // Where the legs and the arc are checked: eighths of the sweep (a revolution closes on its start), the arc of a prism at its middle only.
  std::vector<double> stations(bool arc) const {
    std::vector<double> at;
    if (!revolved && arc) return {0.5};
    for (int k = 0; k <= (revolved ? 7 : 8); ++k) at.push_back(k / 8.0);
    return at;
  }
};

bool bad(std::string &why, const std::string &message) {
  why = message;
  return false;
}

const char *surface_name(GeomAbs_SurfaceType type) {
  switch (type) {
    case GeomAbs_Plane: return "plane";
    case GeomAbs_Cylinder: return "cylinder";
    case GeomAbs_Cone: return "cone";
    case GeomAbs_Sphere: return "sphere";
    case GeomAbs_Torus: return "torus";
    case GeomAbs_BezierSurface: return "Bezier surface";
    case GeomAbs_BSplineSurface: return "B-spline surface";
    case GeomAbs_SurfaceOfRevolution: return "surface of revolution";
    case GeomAbs_SurfaceOfExtrusion: return "surface of extrusion";
    default: return "other surface";
  }
}

bool all_planar(const FaceSet &set) {
  for (const TopoDS_Face &face : set)
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) return false;
  return true;
}

// Every face of `set` lies on the plane of its first face with the same outward normal (several faces of one support, e.g. the two sides of a groove).
bool one_plane(const TopoDS_Shape &shape, const FaceSet &set, const char *which, std::string &why) {
  const gp_Vec normal = outward_normal(shape, set[0]);
  const gp_Pnt origin = location_of(set[0]);
  for (size_t f = 1; f < set.size(); ++f) {
    const double tilt = std::acos(std::max(-1.0, std::min(1.0, normal.Dot(outward_normal(shape, set[f])))));
    const double offset = std::fabs(gp_Vec(origin, location_of(set[f])).Dot(normal));
    if (tilt > 1e-9 || offset > 1e-6 * std::max(1.0, diagonal_of(shape)))
      return bad(why, std::string("[BLD_FACE_BLEND_UNSUPPORTED] the faces of ") + which + " are not on one plane (face " + std::to_string(f) + " is tilted " +
                          std::to_string(tilt) + " rad and offset " + std::to_string(offset) +
                          " from the first): a set between faces that do not meet is one support surface");
  }
  return true;
}

// The corner of face sets `fa` / `fb` of `shape` that lie on two planes, legs `leg` (the straight corner line the prism is swept along).
bool planar_corner(const TopoDS_Shape &shape, const FaceSet &fa, const FaceSet &fb, double leg, Corner &c, std::string &why) {
  if (!one_plane(shape, fa, "facesA", why) || !one_plane(shape, fb, "facesB", why)) return false;
  c.normal_a = outward_normal(shape, fa[0]);
  c.normal_b = outward_normal(shape, fb[0]);
  const double cosine = std::max(-1.0, std::min(1.0, c.normal_a.Dot(c.normal_b)));
  c.fold = std::acos(cosine);
  if (c.fold < kTangentAngle) return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces are coplanar (nothing to blend)");
  if (c.fold > kPi - kTangentAngle)
    return bad(why,
               "[BLD_FACE_BLEND_UNSUPPORTED] the two faces are parallel (their outward normals are opposite): a ball between them has no blend "
               "(fillet_full_round rounds the top of a rib between two parallel sides)");
  c.direction = unit(c.normal_a.Crossed(c.normal_b));
  const double da = gp_Vec(gp_Pnt(0, 0, 0), location_of(fa[0])).Dot(c.normal_a);
  const double db = gp_Vec(gp_Pnt(0, 0, 0), location_of(fb[0])).Dot(c.normal_b);
  const gp_Vec on_line = (c.normal_a * (da - db * cosine) + c.normal_b * (db - da * cosine)) / (1.0 - cosine * cosine);
  const gp_Pnt line_point(on_line.X(), on_line.Y(), on_line.Z());
  gp_Vec across_a = unit(c.normal_a.Crossed(c.direction));
  gp_Vec across_b = unit(c.normal_b.Crossed(c.direction));
  if (gp_Vec(line_point, set_centroid(fa)).Dot(across_a) < 0) across_a.Reverse();
  if (gp_Vec(line_point, set_centroid(fb)).Dot(across_b) < 0) across_b.Reverse();
  c.inward_a = across_a;
  c.inward_b = across_b;
  c.convex = c.normal_a.Dot(c.inward_b) < 0;
  double low_a, high_a, low_b, high_b;
  set_extent(fa, line_point, c.direction, low_a, high_a);
  set_extent(fb, line_point, c.direction, low_b, high_b);
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

// A face's support line in the meridian half plane (rho from the axis, z along it): a point and a unit direction.
struct Line2 {
  double rho = 0, z = 0, d_rho = 0, d_z = 0;
};

void to_rho_z(const gp_Pnt &point, const gp_Pnt &origin, const gp_Vec &axis, double &rho, double &z) {
  const gp_Vec v(origin, point);
  z = v.Dot(axis);
  rho = (v - axis * z).Magnitude();
}

// The meridian line of `face` about the axis (`origin`, `axis`): a plane square to the axis, a cylinder or a cone about it; false with the reason.
bool support_line(const TopoDS_Face &face, const gp_Pnt &origin, const gp_Vec &axis, double scale, Line2 &line, std::string &why) {
  const BRepAdaptor_Surface surface(face, Standard_True);
  const GeomAbs_SurfaceType type = surface.GetType();
  if (type == GeomAbs_Plane) {
    const gp_Pln plane = surface.Plane();
    const double square = std::fabs(gp_Vec(plane.Axis().Direction()).Dot(axis));
    if (std::fabs(square - 1.0) > 1e-9)
      return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] a plane against a cylinder or cone must be square to its axis (this plane is tilted " +
                          std::to_string(std::acos(std::min(1.0, square))) + " rad from it)");
    line = {0.0, gp_Vec(origin, plane.Location()).Dot(axis), 1.0, 0.0};
    return true;
  }
  if (type != GeomAbs_Cylinder && type != GeomAbs_Cone)
    return bad(why, std::string("[BLD_FACE_BLEND_UNSUPPORTED] a ") + surface_name(type) +
                        " is not blended between faces that do not meet (planes, and cylinders or cones about one axis, are)");
  const gp_Ax1 own = type == GeomAbs_Cylinder ? surface.Cylinder().Axis() : surface.Cone().Axis();
  const gp_Vec along(own.Direction());
  const gp_Vec to_own(origin, own.Location());
  const gp_Vec off = to_own - axis * to_own.Dot(axis);
  if (std::fabs(std::fabs(along.Dot(axis)) - 1.0) > 1e-9 || off.Magnitude() > 1e-6 * scale)
    return bad(why, std::string("[BLD_FACE_BLEND_UNSUPPORTED] the ") + surface_name(type) + " is not about the same axis as the other round face (axis off by " +
                        std::to_string(off.Magnitude()) + "): a blend between faces that do not meet is built about one axis");
  double u1, u2, v1, v2;
  BRepTools::UVBounds(face, u1, u2, v1, v2);
  const bool finite = !Precision::IsInfinite(v1) && !Precision::IsInfinite(v2) && v2 - v1 > 1e-12;
  const double lo = finite ? v1 + 0.25 * (v2 - v1) : 0.0, hi = finite ? v1 + 0.75 * (v2 - v1) : 1.0;
  double rho1, z1, rho2, z2;
  to_rho_z(surface.Value(u1, lo), origin, axis, rho1, z1);
  to_rho_z(surface.Value(u1, hi), origin, axis, rho2, z2);
  const double length = std::hypot(rho2 - rho1, z2 - z1);
  if (!(length > 1e-12)) return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the round face has no extent along its axis");
  line = {rho1, z1, (rho2 - rho1) / length, (z2 - z1) / length};
  return true;
}

// The corner of two face sets about one axis: the meridian lines meet at the corner, the blend is swept once around the axis.
bool revolved_corner(const TopoDS_Shape &shape, const FaceSet &fa, const FaceSet &fb, double leg, Corner &c, std::string &why) {
  const double scale = std::max(1.0, diagonal_of(shape));
  gp_Pnt origin;
  gp_Vec axis;
  bool found = false;
  for (const FaceSet *set : {&fa, &fb})
    for (const TopoDS_Face &face : *set) {
      const BRepAdaptor_Surface surface(face, Standard_True);
      const GeomAbs_SurfaceType type = surface.GetType();
      if (found || (type != GeomAbs_Cylinder && type != GeomAbs_Cone)) continue;
      const gp_Ax1 own = type == GeomAbs_Cylinder ? surface.Cylinder().Axis() : surface.Cone().Axis();
      origin = own.Location();
      axis = unit(gp_Vec(own.Direction()));
      found = true;
    }
  if (!found) {
    for (const FaceSet *set : {&fa, &fb})
      for (const TopoDS_Face &face : *set) {
        const GeomAbs_SurfaceType type = BRepAdaptor_Surface(face, Standard_True).GetType();
        if (type != GeomAbs_Plane)
          return bad(why, std::string("[BLD_FACE_BLEND_UNSUPPORTED] a ") + surface_name(type) +
                              " is not blended between faces that do not meet (planes, and cylinders or cones about one axis, are)");
      }
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] no cylinder or cone in either set");
  }
  const gp_Vec radial = unit(gp_Vec(gp_Ax2(origin, gp_Dir(axis)).XDirection()));
  const auto point_of = [&](double rho, double z) { return origin.Translated(radial * rho + axis * z); };
  Line2 lines[2];
  const FaceSet *sets[2] = {&fa, &fb};
  for (int side = 0; side < 2; ++side) {
    const FaceSet &set = *sets[side];
    for (size_t f = 0; f < set.size(); ++f) {
      Line2 line;
      if (!support_line(set[f], origin, axis, scale, line, why)) return false;
      if (f == 0) {
        lines[side] = line;
        continue;
      }
      const Line2 &first = lines[side];
      const double cross = std::fabs(line.d_rho * first.d_z - line.d_z * first.d_rho);
      const double apart = std::fabs((line.rho - first.rho) * first.d_z - (line.z - first.z) * first.d_rho);
      if (cross > 1e-9 || apart > 1e-6 * scale)
        return bad(why, std::string("[BLD_FACE_BLEND_UNSUPPORTED] the faces of ") + (side == 0 ? "facesA" : "facesB") + " are not on one support surface (face " +
                            std::to_string(f) + " differs from the first by " + std::to_string(std::max(cross, apart)) +
                            "): a set between faces that do not meet is one plane, cylinder or cone");
    }
  }
  const double determinant = lines[0].d_rho * lines[1].d_z - lines[0].d_z * lines[1].d_rho;
  if (std::fabs(determinant) < 1e-9)
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces are parallel in section (coaxial cylinders, cones of one angle): a ball between them has no blend");
  const double along_a = ((lines[1].rho - lines[0].rho) * lines[1].d_z - (lines[1].z - lines[0].z) * lines[1].d_rho) / determinant;
  const double corner_rho = lines[0].rho + along_a * lines[0].d_rho, corner_z = lines[0].z + along_a * lines[0].d_z;
  if (!(corner_rho > 1e-9 * scale))
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the virtual corner of the two faces lies on the axis (a cone tip): nothing to roll a ball into");
  gp_Vec inward[2], normal[2];
  for (int side = 0; side < 2; ++side) {
    const Line2 &line = lines[side];
    double best = 0, low = 1e300, high = -1e300;
    for (const TopoDS_Face &face : *sets[side]) {
      TopTools_IndexedMapOfShape vertices;
      TopExp::MapShapes(face, TopAbs_VERTEX, vertices);
      for (int v = 1; v <= vertices.Extent(); ++v) {
        double rho, z;
        to_rho_z(BRep_Tool::Pnt(TopoDS::Vertex(vertices(v))), origin, axis, rho, z);
        const double s = (rho - corner_rho) * line.d_rho + (z - corner_z) * line.d_z;
        if (std::fabs(s) > std::fabs(best)) best = s;
        low = std::min(low, s);
        high = std::max(high, s);
      }
    }
    const double sign = best < 0 ? -1.0 : 1.0;
    const double near_end = sign > 0 ? low : -high, far_end = sign > 0 ? high : -low;
    if (near_end < -1e-6 * scale)
      return bad(why, std::string("[BLD_FACE_BLEND_UNSUPPORTED] the ") + (side == 0 ? "facesA" : "facesB") +
                          " faces reach past the virtual corner of the two supports (by " + std::to_string(-near_end) +
                          "): faces that meet are blended along their shared edge");
    inward[side] = radial * (sign * line.d_rho) + axis * (sign * line.d_z);
    const double mid = sign * (near_end + far_end) / 2;
    const gp_Pnt middle = point_of(corner_rho + mid * line.d_rho, corner_z + mid * line.d_z);
    const gp_Vec candidate = radial * (-line.d_z) + axis * line.d_rho;
    const double offset = 1e-6 * scale;
    BRepClass3d_SolidClassifier classifier(shape);
    classifier.Perform(middle.Translated(candidate * offset), kInsideTolerance);
    if (classifier.State() == TopAbs_OUT) {
      normal[side] = candidate;
    } else {
      classifier.Perform(middle.Translated(candidate * -offset), kInsideTolerance);
      if (classifier.State() != TopAbs_OUT) return bad(why, "the outward side of a round face could not be told");
      normal[side] = candidate.Reversed();
    }
  }
  c.revolved = true;
  c.axis = gp_Ax1(origin, gp_Dir(axis));
  c.normal_a = normal[0];
  c.normal_b = normal[1];
  c.inward_a = inward[0];
  c.inward_b = inward[1];
  c.fold = std::acos(std::max(-1.0, std::min(1.0, c.normal_a.Dot(c.normal_b))));
  if (c.fold < kTangentAngle) return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces are tangent at their corner (nothing to blend)");
  if (c.fold > kPi - kTangentAngle)
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the two faces fold back on each other at their corner: a ball between them has no blend");
  c.direction = unit(radial.Crossed(axis));
  c.convex = c.normal_a.Dot(c.inward_b) < 0;
  c.start = point_of(corner_rho, corner_z);
  c.end = c.start;
  c.length = 0;
  c.a = c.start.Translated(c.inward_a * leg);
  c.b = c.start.Translated(c.inward_b * leg);
  double rho_a, z_a, rho_b, z_b;
  to_rho_z(c.a, origin, axis, rho_a, z_a);
  to_rho_z(c.b, origin, axis, rho_b, z_b);
  if (!(rho_a > 1e-9 * scale) || !(rho_b > 1e-9 * scale))
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the ball's contact would lie on or across the axis (radius " + std::to_string(leg / std::tan(c.fold / 2)) +
                        " is too large for the round faces)");
  return true;
}

// The corner of faces `fa` / `fb` of `shape` with legs `leg`, or the reason there is none: two planes (a prism) or planes and cylinders / cones about
// one axis (a revolution).
bool corner_of(const TopoDS_Shape &shape, const FaceSet &fa, const FaceSet &fb, double leg, Corner &c, std::string &why) {
  return all_planar(fa) && all_planar(fb) ? planar_corner(shape, fa, fb, leg, c, why) : revolved_corner(shape, fa, fb, leg, c, why);
}

double leg_at(double leg_start, double leg_end, double s) { return leg_start + (leg_end - leg_start) * s; }

// Whether the contact points of the ball (legs from `leg_start` to `leg_end` over the sweep) lie on the faces all along it.
bool legs_fit(const Corner &c, const FaceSet &fa, const FaceSet &fb, double leg_start, double leg_end) {
  for (const double s : c.stations(false)) {
    const double leg = leg_at(leg_start, leg_end, s);
    if (!set_inside(fa, c.station(c.start.Translated(c.inward_a * leg), s)) || !set_inside(fb, c.station(c.start.Translated(c.inward_b * leg), s)))
      return false;
  }
  return true;
}

// Whether the section arc is where the blend needs it: inside the material for a convex corner (the blend removes material up to it), outside the
// material for a concave one (the blend adds material up to it).
bool arc_fits(const TopoDS_Shape &shape, const Corner &c, int kind, double param, double leg_start, double leg_end) {
  BRepClass3d_SolidClassifier classifier(shape);
  for (const double s : c.stations(true)) {
    const double leg = leg_at(leg_start, leg_end, s);
    const Handle(Geom_Curve) curve = section_curve(c.station(c.start, s), c.station(c.start.Translated(c.inward_a * leg), s),
                                                   c.station(c.start.Translated(c.inward_b * leg), s), kind, param, kPi - c.fold);
    for (int k = 1; k < 8; ++k) {
      classifier.Perform(curve->Value(curve->FirstParameter() + (curve->LastParameter() - curve->FirstParameter()) * k / 8.0), kInsideTolerance);
      if (classifier.State() == (c.convex ? TopAbs_OUT : TopAbs_IN)) return false;
    }
  }
  return true;
}

// Whether every vertex of `face` lies at `low` or at `high` along `axis` from `origin` (the face is a band between two straight edges square to
// `axis`: the shape a cliff edge needs).
bool is_band(const TopoDS_Face &face, const gp_Pnt &origin, const gp_Vec &axis, double low, double high) {
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(face, TopAbs_VERTEX, vertices);
  const double tolerance = 1e-6 * std::max(1.0, high - low);
  for (int v = 1; v <= vertices.Extent(); ++v) {
    const double at = gp_Vec(origin, BRep_Tool::Pnt(TopoDS::Vertex(vertices(v)))).Dot(axis);
    if (std::fabs(at - low) > tolerance && std::fabs(at - high) > tolerance) return false;
  }
  return true;
}

// The cliff blend of `fa` (the face whose far edge is the cliff, narrower than the ball's tangent contact) against `fb`: the ball of `radius` stays
// tangent to `fb` and touches the far straight edge of `fa` instead of being tangent to it (TECHNICAL_SPEC 13.28). In the section plane with `fb` along
// u and `fa` at the angle `wedge` from it, P at distance w along `fa` and Q at u = t along `fb`, the ball centre is (t, r) with
// (t - w cos wedge)^2 + (r - w sin wedge)^2 = r^2, t the larger root; the blend is the arc Q -> P facing the corner, swept along the corner.
bool cliff_tool(const TopoDS_Shape &shape, const Corner &c, const TopoDS_Face &fa, const TopoDS_Face &fb, double radius, const std::string &blend_name,
                Tool &tool, std::string &why) {
  double low, high;
  extent_along(fa, c.start, c.inward_a, low, high);
  if (std::fabs(low) > 1e-6 * std::max(1.0, high))
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the cliff face must reach the corner line of the two faces (its near edge at the corner, not " + std::to_string(low) +
                        " away from it): the material between would be removed with it");
  if (!is_band(fa, c.start, c.inward_a, low, high))
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the cliff face must be a band between two straight edges parallel to the blend (its far edge is the cliff)");
  const double wedge = kPi - c.fold;
  const double width = high;
  const double height = width * std::sin(wedge);
  if (height > radius)
    return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the cliff edge stands " + std::to_string(height) + " off the other face, more than the ball radius " +
                        std::to_string(radius) + ": use a larger radius");
  const double reach = width * std::cos(wedge) + std::sqrt(radius * radius - (radius - height) * (radius - height));
  if (!(reach > 1e-9)) return bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] the ball touching the cliff edge has no contact with the other face");
  const gp_Vec across = unit(c.inward_a - c.inward_b * c.inward_a.Dot(c.inward_b));
  const gp_Pnt p = c.start.Translated(c.inward_a * width), q = c.start.Translated(c.inward_b * reach);
  const gp_Pnt centre = q.Translated(across * radius);
  const gp_Vec to_p(centre, p);
  const double angle_q = -kPi / 2;
  double angle_p = std::atan2(to_p.Dot(across), to_p.Dot(c.inward_b));
  if (angle_p > angle_q) angle_p -= 2 * kPi;
  const double middle = (angle_q + angle_p) / 2;
  const gp_Pnt shoulder = centre.Translated((c.inward_b * std::cos(middle) + across * std::sin(middle)) * radius);
  for (double s : {0.0, 0.5, 1.0}) {
    const gp_Vec along = c.direction * (s * c.length);
    if (!inside(fb, q.Translated(along)) || !inside(fa, p.Translated(along)))
      return bad(why, "[BLD_FACE_FILLET_NO_SOLUTION] the ball of radius " + std::to_string(radius) + " touching the cliff edge leaves the other face (contact " +
                          std::to_string(reach) + " from the corner); use a smaller radius");
  }
  GC_MakeArcOfCircle arc_maker(q, shoulder, p);
  if (!arc_maker.IsDone()) return bad(why, "the cliff arc could not be built");
  BRepClass3d_SolidClassifier classifier(shape);
  const Handle(Geom_TrimmedCurve) arc_curve = arc_maker.Value();
  for (int k = 1; k < 8; ++k) {
    const double at = arc_curve->FirstParameter() + (arc_curve->LastParameter() - arc_curve->FirstParameter()) * k / 8.0;
    classifier.Perform(arc_curve->Value(at).Translated(c.direction * (c.length / 2)), kInsideTolerance);
    if (classifier.State() == (c.convex ? TopAbs_OUT : TopAbs_IN))
      return bad(why, "[BLD_FACE_FILLET_NO_SOLUTION] the ball of radius " + std::to_string(radius) +
                          " touching the cliff edge is in the wrong region of the solid (the arc leaves the material); use a different radius");
  }
  BRepBuilderAPI_MakeEdge corner_to_q(c.start, q), arc(arc_curve), p_to_corner(p, c.start);
  BRepBuilderAPI_MakeWire wire;
  wire.Add(corner_to_q.Edge());
  wire.Add(arc.Edge());
  wire.Add(p_to_corner.Edge());
  if (!corner_to_q.IsDone() || !arc.IsDone() || !p_to_corner.IsDone() || !wire.IsDone()) return bad(why, "the cliff outline does not close");
  BRepBuilderAPI_MakeFace profile(wire.Wire(), Standard_True);
  BRepPrimAPI_MakePrism prism(profile.Face(), gp_Vec(c.start, c.end));
  prism.Build();
  if (!profile.IsDone() || !prism.IsDone()) return bad(why, "the cliff blend tool could not be swept");
  tool.shape = prism.Shape();
  tool.convex = c.convex;
  const TopTools_IndexedMapOfShape tool_faces = query::distinct(tool.shape, TopAbs_FACE);
  tool.names.assign(static_cast<size_t>(tool_faces.Extent()), "");
  for (int f = 0; f < tool_faces.Extent(); ++f) tool.names[static_cast<size_t>(f)] = "tool." + std::to_string(f);
  TopoDS_Shape arc_edge;
  for (TopExp_Explorer it(profile.Face(), TopAbs_EDGE); it.More(); it.Next())
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() != GeomAbs_Line) arc_edge = it.Current();
  const TopTools_ListOfShape &lateral = prism.Generated(arc_edge);
  if (lateral.IsEmpty()) return bad(why, "the cliff blend face was not generated");
  const int blend_face = tool_faces.FindIndex(lateral.First());
  if (blend_face > 0) tool.names[static_cast<size_t>(blend_face - 1)] = blend_name;
  return true;
}

// The blend tool swept once around the axis: the section outline of the corner (corner -> a, the section curve, b -> corner) revolved 360 degrees. The
// face of the section curve is named `blend_name`.
bool revolved_tool(const Corner &c, int kind, double param, const std::string &blend_name, Tool &tool, std::string &why) {
  const Handle(Geom_Curve) curve = section_curve(c.start, c.a, c.b, kind, param, kPi - c.fold);
  BRepBuilderAPI_MakeEdge corner_to_a(c.start, c.a), arc(curve), b_to_corner(c.b, c.start);
  BRepBuilderAPI_MakeWire wire;
  if (!corner_to_a.IsDone() || !arc.IsDone() || !b_to_corner.IsDone()) return bad(why, "the section curve could not be built");
  wire.Add(corner_to_a.Edge());
  wire.Add(arc.Edge());
  wire.Add(b_to_corner.Edge());
  if (!wire.IsDone()) return bad(why, "the section outline does not close");
  BRepBuilderAPI_MakeFace profile(wire.Wire(), Standard_True);
  if (!profile.IsDone()) return bad(why, "the section outline is not planar");
  BRepPrimAPI_MakeRevol revolution(profile.Face(), c.axis);
  revolution.Build();
  if (!revolution.IsDone()) return bad(why, "the blend tool could not be revolved");
  tool.shape = revolution.Shape();
  tool.convex = c.convex;
  const TopTools_IndexedMapOfShape tool_faces = query::distinct(tool.shape, TopAbs_FACE);
  tool.names.assign(static_cast<size_t>(tool_faces.Extent()), "");
  for (int f = 0; f < tool_faces.Extent(); ++f) tool.names[static_cast<size_t>(f)] = "tool." + std::to_string(f);
  TopoDS_Shape arc_edge;
  for (TopExp_Explorer it(profile.Face(), TopAbs_EDGE); it.More(); it.Next())
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() != GeomAbs_Line) arc_edge = it.Current();
  const TopTools_ListOfShape &lateral = revolution.Generated(arc_edge);
  if (lateral.IsEmpty()) return bad(why, "the revolved blend face was not generated");
  const int blend_face = tool_faces.FindIndex(lateral.First());
  if (blend_face > 0) tool.names[static_cast<size_t>(blend_face - 1)] = blend_name;
  return true;
}

std::string sorted_name(const std::string &first, const std::string &second) {
  return first < second ? "blend(e(" + first + "|" + second + "))" : "blend(e(" + second + "|" + first + "))";
}

// The smallest radius (above `radius`) whose blend stays in the material, as a hint for a refusal; empty when none up to a large factor does.
std::string smallest_radius_hint(const TopoDS_Shape &shape, const FaceSet &fa, const FaceSet &fb, const Corner &c, double radius, int kind, double param) {
  const auto works = [&](double r) {
    Corner trial;
    std::string ignored;
    const double leg = r * std::tan(c.fold / 2);
    return corner_of(shape, fa, fb, leg, trial, ignored) && legs_fit(trial, fa, fb, leg, leg) && arc_fits(shape, trial, kind, param, leg, leg);
  };
  double high = radius * 2;
  for (int step = 0; step < 24 && !works(high); ++step) high *= 2;
  if (!works(high)) return "";
  double low = radius;
  for (int step = 0; step < 40; ++step) {
    const double middle = (low + high) / 2;
    (works(middle) ? high : low) = middle;
  }
  return "; the smallest radius that does is about " + std::to_string(high);
}

}  // namespace

// The face blend spec (flat numbers): [face A, face B, radius, section kind, rho / shape, cliff?] or, with several faces per set or a varying radius,
// [A, B, radius, kind, param, cliff, radius at the other end (0: constant), has start point, x, y, z, extra faces of A, extra faces of B, those faces...].
static std::unique_ptr<Shape> build_face_blend(const Shape &source, rust::Slice<const double> raw, std::string &why) {
  const bool extended = raw.size() >= 13;
  if (raw.size() != 5 && raw.size() != 6 && !extended) {
    why = "face blend specification is malformed";
    return nullptr;
  }
  const int ia = static_cast<int>(raw[0]), ib = static_cast<int>(raw[1]);
  const double radius = raw[2];
  const int kind = static_cast<int>(raw[3]);
  const double param = raw[4];
  const int cliff = raw.size() >= 6 ? static_cast<int>(raw[5]) : 0;
  double radius_end = extended ? raw[6] : 0.0;
  const bool has_start = extended && raw[7] != 0;
  const gp_Pnt start_near = extended ? gp_Pnt(raw[8], raw[9], raw[10]) : gp_Pnt();
  const size_t extra_a = extended ? static_cast<size_t>(raw[11]) : 0, extra_b = extended ? static_cast<size_t>(raw[12]) : 0;
  if (extended && raw.size() != 13 + extra_a + extra_b) {
    why = "face blend specification is malformed";
    return nullptr;
  }
  const TopTools_IndexedMapOfShape faces = query::distinct(source.shape, TopAbs_FACE);
  std::vector<int> indices_a{ia}, indices_b{ib};
  for (size_t k = 0; k < extra_a; ++k) indices_a.push_back(static_cast<int>(raw[13 + k]));
  for (size_t k = 0; k < extra_b; ++k) indices_b.push_back(static_cast<int>(raw[13 + extra_a + k]));
  for (const std::vector<int> *indices : {&indices_a, &indices_b})
    for (const int index : *indices)
      if (index < 0 || index >= faces.Extent()) {
        why = "face index out of range or radius <= 0";
        return nullptr;
      }
  if (!(radius > 0) || radius_end < 0) {
    why = "face index out of range or radius <= 0";
    return nullptr;
  }
  for (const int index : indices_a)
    if (std::find(indices_b.begin(), indices_b.end(), index) != indices_b.end()) {
      why = "[BLD_FACESETS_OVERLAP] the two face sets share a face";
      return nullptr;
    }
  if (cliff < 0 || cliff > 2 || (cliff != 0 && kind != 2)) {
    why = "[BLD_FACE_BLEND_UNSUPPORTED] a cliff edge takes the circular section only";
    return nullptr;
  }
  if (cliff != 0 && (indices_a.size() != 1 || indices_b.size() != 1 || radius_end > 0)) {
    why = "[BLD_FACE_BLEND_UNSUPPORTED] a cliff edge needs one planar face in each set and a constant radius";
    return nullptr;
  }
  if (std::fabs(radius_end - radius) <= 1e-12 * radius) radius_end = 0;
  const naming::Named input = naming::named(source);
  const std::string blend_name = sorted_name(input.names[static_cast<size_t>(ia)], input.names[static_cast<size_t>(ib)]);
  FaceSet set_a, set_b;
  for (const int index : indices_a) set_a.push_back(TopoDS::Face(faces(index + 1)));
  for (const int index : indices_b) set_b.push_back(TopoDS::Face(faces(index + 1)));
  // cliff 2 is the cliff on face B: the same build with the faces swapped
  const FaceSet &fa = cliff == 2 ? set_b : set_a, &fb = cliff == 2 ? set_a : set_b;
  Corner c;
  // The legs depend on the fold, which corner_of computes: first with a unit leg to get the fold, then with the real one.
  if (!corner_of(source.shape, fa, fb, 1.0, c, why)) return nullptr;
  const double fold_factor = std::tan(c.fold / 2);
  if (radius_end > 0) {
    if (kind != 2) {
      bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] a varying radius between faces that do not meet takes the circular section only");
      return nullptr;
    }
    if (c.revolved)
      {
      bad(why, "[BLD_FACE_BLEND_UNSUPPORTED] a varying radius between faces that do not meet is built between planar faces; a blend about an axis has a constant radius");
      return nullptr;
    }
    // radius at the start of the corner line (the end with the smaller coordinate along n_A x n_B) unless the start point is nearer the other end
    const bool from_end = has_start && start_near.Distance(c.end) < start_near.Distance(c.start);
    const double leg_start = (from_end ? radius_end : radius) * fold_factor, leg_end = (from_end ? radius : radius_end) * fold_factor;
    if (!corner_of(source.shape, fa, fb, leg_start, c, why)) return nullptr;
    if (!legs_fit(c, fa, fb, leg_start, leg_end)) {
      why = "[BLD_FACE_FILLET_NO_SOLUTION] a ball whose radius goes from " + std::to_string(from_end ? radius_end : radius) + " to " +
            std::to_string(from_end ? radius : radius_end) + " does not fit between the two faces (its contact lines leave them); use smaller radii";
      return nullptr;
    }
    if (!arc_fits(source.shape, c, kind, param, leg_start, leg_end)) {
      why = "[BLD_FACE_FILLET_NO_SOLUTION] no ball whose radius goes from " + std::to_string(from_end ? radius_end : radius) + " to " +
            std::to_string(from_end ? radius : radius_end) + " touches both faces on the side the blend needs (the arc is in the wrong region of the solid); use larger radii";
      return nullptr;
    }
    Tool tool;
    const gp_Pnt a_end = c.end.Translated(c.inward_a * leg_end), b_end = c.end.Translated(c.inward_b * leg_end);
    if (!tapered_spandrel_tool(c.start, c.a, c.b, c.end, a_end, b_end, kPi - c.fold, blend_name, tool, why)) return nullptr;
    tool.convex = c.convex;
    naming::Named tapered = input;
    if (!apply_tools(tapered, {tool}, why)) return nullptr;
    return naming::wrap_named(tapered.shape, tapered.names);
  }
  const double leg = radius * fold_factor;
  if (!corner_of(source.shape, fa, fb, leg, c, why)) return nullptr;
  if (cliff != 0) {
    double low, high;
    extent_along(fa[0], c.start, c.inward_a, low, high);
    if (high < leg - 1e-9 * std::max(1.0, leg)) {
      Tool tool;
      if (!cliff_tool(source.shape, c, fa[0], fb[0], radius, blend_name, tool, why)) return nullptr;
      naming::Named cliffed = input;
      if (!apply_tools(cliffed, {tool}, why)) return nullptr;
      return naming::wrap_named(cliffed.shape, cliffed.names);
    }
  }
  if (!legs_fit(c, fa, fb, leg, leg)) {
    why = "[BLD_FACE_FILLET_NO_SOLUTION] a ball of radius " + std::to_string(radius) + " does not fit between the two faces (its contact lines leave them); use a smaller radius";
    return nullptr;
  }
  if (!arc_fits(source.shape, c, kind, param, leg, leg)) {
    why = "[BLD_FACE_FILLET_NO_SOLUTION] no ball of radius " + std::to_string(radius) +
          " touches both faces on the side the blend needs (the arc is in the wrong region of the solid)" +
          smallest_radius_hint(source.shape, fa, fb, c, radius, kind, param);
    return nullptr;
  }
  Tool tool;
  if (c.revolved ? !revolved_tool(c, kind, param, blend_name, tool, why) : !spandrel_tool(c.start, c.end, c.a, c.b, kind, param, kPi - c.fold, blend_name, tool, why))
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
    why = blend::occt_failure(error);
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
