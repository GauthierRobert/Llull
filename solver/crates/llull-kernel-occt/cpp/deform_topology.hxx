// Topology work of the exact warp: face splitting at the places a law is not analytic, the full-turn ring and its sewing.
#pragma once

#include <vector>

#include <TopoDS_Shape.hxx>

#include "llull-kernel-occt/cpp/deform_fit.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"

namespace llull {

struct Cut {
  int axis;  // 0 x, 1 y, 2 z of the deformation frame
  double offset;
  // an oriented lattice box face: the plane c . direction = offset, direction in local frame coordinates (axis is ignored)
  bool oriented = false;
  double direction[3] = {0, 0, 1};
};

int count_faces(const TopoDS_Shape &shape);

// Places where the law is not analytic and a face must not straddle: region ends for the axis laws, lattice box faces.
std::vector<Cut> cuts_of(const deform::Warp &warp, const TopoDS_Shape &shape);

// An infinite non-flat taper whose linear section scale s(z) is <= 0 anywhere on the body (det J = s^2 hides the sign and touches 0 at a zero, which sampling the
// surface can miss): true when the body spans such a height, measured in the frame. Always false for any other deformation.
bool taper_scale_vanishes(const deform::Warp &warp, const TopoDS_Shape &shape);

// `shape` with every face split along the planes of `cuts`; null shape when the split fails. `split_count` receives the faces added.
TopoDS_Shape split_faces(const TopoDS_Shape &shape, const deform::Warp &warp, const std::vector<Cut> &cuts, std::vector<naming::Named> &named,
                         int &split_count);

// A full-turn bend: its two end caps land on each other. Returns the shape without the planar faces at the region ends; a null shape when this
// deformation is not a full-turn ring, or is one (`full_turn` true) but the body has not exactly two planar end caps (the caller refuses).
TopoDS_Shape ring_without_caps(const TopoDS_Shape &shape, const deform::Warp &warp, double tolerance, bool &full_turn);

// The shell(s) of `open` sewn at `tolerance` into one solid; null shape when sewing does not close it.
TopoDS_Shape sewn_solid(const TopoDS_Shape &open, double tolerance);

double signed_volume(const TopoDS_Shape &shape);

}  // namespace llull
