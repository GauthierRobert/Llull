// Test-only probe of surface_bounds.hxx (CHK1): synthetic many-patch B-spline faces whose extremes lie inside the patches, bounded three ways.
#include "llull-kernel-occt/cpp/facade.hxx"

#include <BRepBndLib.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <BRepLib.hxx>
#include <TopoDS_Vertex.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <Bnd_Box.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <Geom2d_Line.hxx>
#include <Geom_BSplineSurface.hxx>
#include <gp_Dir2d.hxx>
#include <gp_Pnt2d.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TopoDS_Face.hxx>

#include <cmath>
#include <stdexcept>

#include "llull-kernel-occt/cpp/surface_bounds.hxx"

namespace llull {

namespace {

void push(rust::Vec<double> &out, const Bnd_Box &box) {
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  for (const double value : {x0, y0, z0, x1, y1, z1}) out.push_back(value);
}

TopoDS_Face probe_face(int32_t kind);

}  // namespace

// kind 0: a wavy bicubic surface (bumps inside the patches); 1: the same, rational with weights 0.4 to 2.5; 2: flat with one narrow spike (a pole raised on fine knots); 4: rational with weights 0.02 to 30 (non-uniform);
// 7: the unturned surface with its corner (0, 0) cut off (the face reaches every side of its rectangle box elsewhere: accepted by the proof); 6: a surface turned 45 degrees with a spike in one corner, that corner cut off by a pcurve line (fill 0.995): the rectangle box overstands the face, so the fast path must refuse; 3: a face that is not a full patch (a corner trimmed off): no fast path; 5: kind 0 with the depth limit lowered to 2 (a patch reaches it outside the found box: refused). Returns [fast box (0 x 6 when refused), AddOptimal box, dense 300 x 300 sample box].
rust::Vec<double> spline_bounds_probe(int32_t kind) {
  const TopoDS_Face face = probe_face(kind);
  rust::Vec<double> out;
  Bnd_Box fast;
  if (query::add_spline_bounds(face, fast, kind == 5 ? 2 : query::kBoundsMaxDepth)) push(out, fast);
  else
    for (int k = 0; k < 6; ++k) out.push_back(0.0);
  Bnd_Box optimal;
  BRepBndLib::AddOptimal(face, optimal, Standard_False, Standard_False);
  push(out, optimal);
  Bnd_Box sampled;
  const BRepAdaptor_Surface adaptor(face, Standard_False);
  constexpr int kSamples = 300;
  for (int i = 0; i <= kSamples; ++i)
    for (int j = 0; j <= kSamples; ++j)
      sampled.Add(adaptor.Value(adaptor.FirstUParameter() + (adaptor.LastUParameter() - adaptor.FirstUParameter()) * i / kSamples,
                                adaptor.FirstVParameter() + (adaptor.LastVParameter() - adaptor.FirstVParameter()) * j / kSamples));
  push(out, sampled);
  return out;
}

namespace {

TopoDS_Face probe_face(int32_t kind) {
  constexpr int kCount = 14, kDegree = 3;
  TColgp_Array2OfPnt poles(1, kCount, 1, kCount);
  TColStd_Array2OfReal weights(1, kCount, 1, kCount);
  for (int i = 1; i <= kCount; ++i)
    for (int j = 1; j <= kCount; ++j) {
      double z = 0.8 * std::sin(0.9 * i) * std::cos(0.7 * j) + 0.05 * i;
      if (kind == 2) z = (i == 7 && j == 7) ? 3.0 : 0.0;
      if (kind == 6 && i >= kCount - 1 && j >= kCount - 1) z += 4.0;  // a spike at the corner that is cut off below
      gp_Pnt at(i * 1.0 + 0.2 * std::sin(0.5 * j), j * 1.0 + 0.2 * std::cos(0.4 * i), z);
      if (kind == 6) at = gp_Pnt((at.X() - at.Y()) * std::sqrt(0.5), (at.X() + at.Y()) * std::sqrt(0.5), z);  // turned 45 degrees about z
      poles(i, j) = at;
      weights(i, j) = kind == 1 ? 0.4 + 2.1 * (0.5 + 0.5 * std::sin(1.3 * i + 0.8 * j)) : 1.0;
      if (kind == 4) weights(i, j) = 0.02 + 30.0 * std::pow(0.5 + 0.5 * std::sin(2.1 * i + 1.7 * j), 3);
    }
  const int spans = kCount - kDegree;
  TColStd_Array1OfReal knots(1, spans + 1);
  TColStd_Array1OfInteger mults(1, spans + 1);
  for (int k = 1; k <= spans + 1; ++k) {
    knots(k) = static_cast<double>(k - 1) / spans;
    mults(k) = (k == 1 || k == spans + 1) ? kDegree + 1 : 1;
  }
  const Handle(Geom_BSplineSurface) surface = kind == 1 || kind == 4 ? new Geom_BSplineSurface(poles, weights, knots, knots, mults, mults, kDegree, kDegree)
                                                        : new Geom_BSplineSurface(poles, knots, knots, mults, mults, kDegree, kDegree);
  BRepBuilderAPI_MakeFace maker(surface, 1e-7);
  TopoDS_Face face = maker.Face();
  if (kind == 3) {
    BRepBuilderAPI_MakeFace trimmed(surface, 0.0, 0.8, 0.0, 1.0, 1e-7);
    face = trimmed.Face();
  }
  if (kind == 6 || kind == 7) {
    // the corner (1, 1) cut off by a straight pcurve (legs 0.1, fill 0.995): the box of the face stays under the spike of that corner
    const gp_Pnt2d corners[5] = {gp_Pnt2d(0, 0), gp_Pnt2d(1, 0), gp_Pnt2d(1, 0.9), gp_Pnt2d(0.9, 1), gp_Pnt2d(0, 1)};
    const gp_Pnt2d low_corner[5] = {gp_Pnt2d(0.1, 0), gp_Pnt2d(1, 0), gp_Pnt2d(1, 1), gp_Pnt2d(0, 1), gp_Pnt2d(0, 0.1)};
    TopoDS_Vertex vertices[5];
    const gp_Pnt2d *cut = kind == 7 ? low_corner : corners;
    for (int k = 0; k < 5; ++k) vertices[k] = BRepBuilderAPI_MakeVertex(surface->Value(cut[k].X(), cut[k].Y()));
    BRepBuilderAPI_MakeWire wire;
    for (int k = 0; k < 5; ++k) {
      const gp_Pnt2d from = cut[k], to = cut[(k + 1) % 5];
      BRepBuilderAPI_MakeEdge edge(new Geom2d_Line(from, gp_Dir2d(to.X() - from.X(), to.Y() - from.Y())), surface, vertices[k], vertices[(k + 1) % 5], 0.0, from.Distance(to));
      wire.Add(edge.Edge());
    }
    face = BRepBuilderAPI_MakeFace(surface, wire.Wire(), true).Face();
    BRepLib::BuildCurves3d(face, 1e-9);
  }
  return face;
}

}  // namespace

// The bounds of a shape of a full many-patch face and the trimmed face of kind 6 (a spike in its cut-off corner), alone (`contained` 0) or inside a box far larger than everything (1):
// [shape_bounds, AddOptimal of the compound]. Alone, the spike stands outside the face, so the trimmed face is deferred, found not contained and given to AddOptimal; in the big box it is contained.
rust::Vec<double> trimmed_shape_bounds_probe(int32_t contained) {
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  builder.Add(compound, probe_face(0));
  builder.Add(compound, probe_face(6));
  if (contained != 0) builder.Add(compound, BRepPrimAPI_MakeBox(gp_Pnt(-100, -100, -100), 200, 200, 200).Shape());
  const Shape shape{compound};
  rust::Vec<double> out = shape_bounds(shape);
  Bnd_Box optimal;
  BRepBndLib::AddOptimal(compound, optimal, Standard_False, Standard_False);
  push(out, optimal);
  return out;
}

}  // namespace llull
