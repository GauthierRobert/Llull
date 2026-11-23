// Test-only probe of mass_patch.cxx: synthetic B-spline faces (full, a corner cut off by lines, circular holes, reversed), integrated by strips and by BRepGProp.
#include "llull-kernel-occt/cpp/facade.hxx"

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <GProp_GProps.hxx>
#include "llull-kernel-occt/cpp/mass_patch.hxx"
#include <Geom2d_Circle.hxx>
#include <Geom2dAPI_Interpolate.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_Line.hxx>
#include <TColgp_HArray1OfPnt2d.hxx>
#include <Geom_BSplineSurface.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Ax2d.hxx>
#include <gp_Dir2d.hxx>
#include <gp_Pnt2d.hxx>

#include <cmath>
#include <vector>

namespace llull {

namespace {

struct Circle {
  double u, v, r;
  double first = 0, last = 2 * M_PI;  // the parameter range of the hole's edge
};

// A square of side 10 as a clamped uniform B-spline of `count` x `count` poles: flat (poles at the Greville points, so the surface is the plane z = 0 with x = 10 u, y = 10 v) or wavy.
Handle(Geom_BSplineSurface) make_surface(int count, int degree, bool wavy) {
  const int spans = count - degree;
  TColStd_Array1OfReal knots(1, spans + 1);
  TColStd_Array1OfInteger mults(1, spans + 1);
  std::vector<double> flat;
  for (int k = 1; k <= spans + 1; ++k) {
    knots(k) = static_cast<double>(k - 1) / spans;
    mults(k) = (k == 1 || k == spans + 1) ? degree + 1 : 1;
    for (int m = 0; m < mults(k); ++m) flat.push_back(knots(k));
  }
  std::vector<double> greville(count, 0.0);
  for (int i = 0; i < count; ++i) {
    for (int k = 1; k <= degree; ++k) greville[i] += flat[i + k];
    greville[i] /= degree;
  }
  TColgp_Array2OfPnt poles(1, count, 1, count);
  for (int i = 1; i <= count; ++i)
    for (int j = 1; j <= count; ++j) {
      const double x = 10 * greville[i - 1], y = 10 * greville[j - 1];
      poles(i, j) = gp_Pnt(x + (wavy ? 0.1 * std::sin(0.3 * j) : 0.0), y + (wavy ? 0.1 * std::cos(0.25 * i) : 0.0), wavy ? 0.8 * std::sin(0.3 * i) * std::cos(0.25 * j) + 0.03 * i : 0.0);
    }
  return new Geom_BSplineSurface(poles, knots, knots, mults, mults, degree, degree);
}

TopoDS_Wire polygon_wire(const Handle(Geom_BSplineSurface) & surface, const std::vector<gp_Pnt2d> &corners) {
  std::vector<TopoDS_Vertex> vertices;
  for (const gp_Pnt2d &corner : corners) vertices.push_back(BRepBuilderAPI_MakeVertex(surface->Value(corner.X(), corner.Y())));
  BRepBuilderAPI_MakeWire wire;
  for (size_t k = 0; k < corners.size(); ++k) {
    const gp_Pnt2d from = corners[k], to = corners[(k + 1) % corners.size()];
    wire.Add(BRepBuilderAPI_MakeEdge(new Geom2d_Line(from, gp_Dir2d(to.X() - from.X(), to.Y() - from.Y())), surface, vertices[k], vertices[(k + 1) % corners.size()], 0.0, from.Distance(to)).Edge());
  }
  return wire.Wire();
}

// The face of `surface` bounded by `outer` (the whole parameter square when empty) with circular holes.
TopoDS_Face make_face(const Handle(Geom_BSplineSurface) & surface, const std::vector<gp_Pnt2d> &outer, const std::vector<Circle> &holes) {
  BRepBuilderAPI_MakeFace maker = outer.empty() ? BRepBuilderAPI_MakeFace(surface, 0.0, 1.0, 0.0, 1.0, 1e-7) : BRepBuilderAPI_MakeFace(surface, polygon_wire(surface, outer), true);
  for (const Circle &hole : holes) {
    const Handle(Geom2d_Circle) circle = new Geom2d_Circle(gp_Ax2d(gp_Pnt2d(hole.u, hole.v), gp_Dir2d(1, 0)), hole.r, false);  // clockwise: a hole
    maker.Add(BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(circle, surface, hole.first, hole.last).Edge()).Wire());
  }
  TopoDS_Face face = maker.Face();
  BRepLib::BuildCurves3d(face, 1e-9);
  return face;
}

// The flat square whose left side is a B-spline pcurve with a short double bump in the middle (u = 0.1 + 0.01 sin(2 pi (v - 0.495) / 0.01) for v in [0.495, 0.505], 80 points per period, v from 0.9 down to
// 0.1): two extrema of u within 1 % of the parameter range, between two of 48 samples of the whole curve. The parameter domain has the area 0.64 (the bump is one whole period).
TopoDS_Face wiggly_face(const Handle(Geom_BSplineSurface) & surface) {
  std::vector<double> vs;
  for (double v = 0.9; v > 0.505 + 1e-9; v -= 0.005) vs.push_back(v);
  for (int i = 0; i <= 80; ++i) vs.push_back(0.505 - 0.01 * i / 80);
  for (double v = 0.495 - 0.005; v > 0.1 + 1e-9; v -= 0.005) vs.push_back(v);
  vs.push_back(0.1);
  Handle(TColgp_HArray1OfPnt2d) points = new TColgp_HArray1OfPnt2d(1, static_cast<int>(vs.size()));
  for (size_t i = 0; i < vs.size(); ++i) {
    const double v = vs[i];
    const bool bump = v >= 0.495 && v <= 0.505;
    points->SetValue(static_cast<int>(i) + 1, gp_Pnt2d(0.1 + (bump ? 0.01 * std::sin(2 * M_PI * (v - 0.495) / 0.01) : 0.0), v));
  }
  Geom2dAPI_Interpolate interpolate(points, Standard_False, 1e-9);
  interpolate.Perform();
  const Handle(Geom2d_BSplineCurve) wiggle = interpolate.Curve();
  const gp_Pnt2d corners[4] = {gp_Pnt2d(0.1, 0.1), gp_Pnt2d(0.9, 0.1), gp_Pnt2d(0.9, 0.9), gp_Pnt2d(0.1, 0.9)};
  TopoDS_Vertex vertices[4];
  for (int k = 0; k < 4; ++k) vertices[k] = BRepBuilderAPI_MakeVertex(surface->Value(corners[k].X(), corners[k].Y()));
  BRepBuilderAPI_MakeWire wire;
  for (int k = 0; k < 3; ++k) {
    const gp_Pnt2d from = corners[k], to = corners[k + 1];
    wire.Add(BRepBuilderAPI_MakeEdge(new Geom2d_Line(from, gp_Dir2d(to.X() - from.X(), to.Y() - from.Y())), surface, vertices[k], vertices[k + 1], 0.0, from.Distance(to)).Edge());
  }
  wire.Add(BRepBuilderAPI_MakeEdge(wiggle, surface, vertices[3], vertices[0], wiggle->FirstParameter(), wiggle->LastParameter()).Edge());
  TopoDS_Face face = BRepBuilderAPI_MakeFace(surface, wire.Wire(), true).Face();
  BRepLib::BuildCurves3d(face, 1e-9);
  return face;
}

}  // namespace

// kind % 16: 0 the flat square, whole; 1 the wavy surface, whole; 2 wavy with its corner (0, 0) cut off by lines; 3 flat with a round hole (u 0.4, v 0.55, r 0.2); 4 degree 7 on 18 x 18 poles, wavy, two holes (one crossing knot lines)
// and a corner cut off; 5 flat inside a diamond (area 10^2 times the shoelace area of the diamond in u, v) of straight sides crossing many cells; 6 degree 6, wavy, a hole and a diamond. 7 flat with the round hole of 3 whose edge runs over [-pi, pi] (a sample falls on the extremum); 8 flat with a left side that is a B-spline pcurve with a double bump (two extrema of u between two of 48 samples; area 64). kind >= 16: the same face reversed. Returns patch_properties_probe of the face.
rust::Vec<double> patch_synthetic_probe(int32_t kind, int32_t volume) {
  const bool reversed = kind >= 16;
  const int which = kind % 16;
  const Handle(Geom_BSplineSurface) surface = make_surface(which == 4 ? 18 : which == 6 ? 16 : 17, which == 6 ? 6 : 7, which != 0 && which != 3 && which != 5 && which < 7);
  const std::vector<gp_Pnt2d> corner_cut{gp_Pnt2d(0.15, 0), gp_Pnt2d(1, 0), gp_Pnt2d(1, 1), gp_Pnt2d(0, 1), gp_Pnt2d(0, 0.1)};
  const std::vector<gp_Pnt2d> diamond{gp_Pnt2d(0.5, 0.05), gp_Pnt2d(0.93, 0.47), gp_Pnt2d(0.55, 0.92), gp_Pnt2d(0.08, 0.5)};
  TopoDS_Face face;
  switch (which) {
    case 2: face = make_face(surface, corner_cut, {}); break;
    case 3: face = make_face(surface, {}, {{0.4, 0.55, 0.2}}); break;
    case 4: face = make_face(surface, corner_cut, {{0.37, 0.52, 0.21}, {0.78, 0.3, 0.09}}); break;
    case 5: face = make_face(surface, diamond, {}); break;
    case 6: face = make_face(surface, diamond, {{0.5, 0.5, 0.13}}); break;
    case 7: face = make_face(surface, {}, {{0.4, 0.55, 0.2, -M_PI, M_PI}}); break;
    case 8: face = wiggly_face(surface); break;
    default: face = make_face(surface, {}, {}); break;
  }
  if (reversed) face.Reverse();
  return patch_properties_probe(Shape{face}, volume);
}

rust::Vec<double> patch_synthetic_helper_probe(int32_t kind) {
  const bool reversed = kind >= 16;
  const int which = kind % 16;
  const Handle(Geom_BSplineSurface) surface = make_surface(which == 4 ? 18 : which == 6 ? 16 : 17, which == 6 ? 6 : 7, which != 0 && which != 3 && which != 5 && which < 7);
  TopoDS_Face face = which == 8 ? wiggly_face(surface) : make_face(surface, {}, {});
  if (reversed) face.Reverse();
  GProp_GProps helper, plain;
  query::surface_properties(face, helper);
  BRepGProp::SurfaceProperties(face, plain);
  rust::Vec<double> out;
  out.push_back(helper.Mass());
  out.push_back(plain.Mass());
  return out;
}

}  // namespace llull
