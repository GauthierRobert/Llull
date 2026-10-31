// Test-only probe of surface_bounds.hxx (CHK1): synthetic many-patch B-spline faces whose extremes lie inside the patches, bounded three ways.
#include "llull-kernel-occt/cpp/facade.hxx"

#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <Bnd_Box.hxx>
#include <Geom_BSplineSurface.hxx>
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

}  // namespace

// kind 0: a wavy bicubic surface (bumps inside the patches); 1: the same, rational with weights 0.4 to 2.5; 2: flat with one narrow spike (a pole raised on fine knots);
// 3: a face that is not a full patch (a corner trimmed off): no fast path. Returns [fast box (0 x 6 when refused), AddOptimal box, dense 300 x 300 sample box].
rust::Vec<double> spline_bounds_probe(int32_t kind) {
  constexpr int kCount = 14, kDegree = 3;
  TColgp_Array2OfPnt poles(1, kCount, 1, kCount);
  TColStd_Array2OfReal weights(1, kCount, 1, kCount);
  for (int i = 1; i <= kCount; ++i)
    for (int j = 1; j <= kCount; ++j) {
      double z = 0.8 * std::sin(0.9 * i) * std::cos(0.7 * j) + 0.05 * i;
      if (kind == 2) z = (i == 7 && j == 7) ? 3.0 : 0.0;
      poles(i, j) = gp_Pnt(i * 1.0 + 0.2 * std::sin(0.5 * j), j * 1.0 + 0.2 * std::cos(0.4 * i), z);
      weights(i, j) = kind == 1 ? 0.4 + 2.1 * (0.5 + 0.5 * std::sin(1.3 * i + 0.8 * j)) : 1.0;
    }
  const int spans = kCount - kDegree;
  TColStd_Array1OfReal knots(1, spans + 1);
  TColStd_Array1OfInteger mults(1, spans + 1);
  for (int k = 1; k <= spans + 1; ++k) {
    knots(k) = static_cast<double>(k - 1) / spans;
    mults(k) = (k == 1 || k == spans + 1) ? kDegree + 1 : 1;
  }
  const Handle(Geom_BSplineSurface) surface = kind == 1 ? new Geom_BSplineSurface(poles, weights, knots, knots, mults, mults, kDegree, kDegree)
                                                        : new Geom_BSplineSurface(poles, knots, knots, mults, mults, kDegree, kDegree);
  BRepBuilderAPI_MakeFace maker(surface, 1e-7);
  TopoDS_Face face = maker.Face();
  if (kind == 3) {
    BRepBuilderAPI_MakeFace trimmed(surface, 0.0, 0.8, 0.0, 1.0, 1e-7);
    face = trimmed.Face();
  }
  rust::Vec<double> out;
  Bnd_Box fast;
  if (query::add_spline_bounds(face, fast)) push(out, fast);
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

}  // namespace llull
