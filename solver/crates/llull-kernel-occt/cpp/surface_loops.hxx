// Surface and (u, v) loop descriptions of the face commands (cpp/surface_loops.cxx), shared by the slab / emboss / split builders of cpp/surfaces.cxx.
#pragma once

#include <cstdint>
#include <vector>

#include <Geom2d_Curve.hxx>
#include <Geom_Surface.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>

#include "rust/cxx.h"

namespace llull {
namespace surface_wire {

enum SurfaceKind { kBSpline = 0, kPlane = 1, kCylinder = 2, kCone = 3, kSphere = 4, kTorus = 5 };

struct Segment {
  Handle(Geom2d_Curve) curve;
  gp_Pnt2d from;
  gp_Pnt2d to;
};

struct Loop {
  bool outer;
  std::vector<Segment> segments;
};

gp_Pnt point_at(rust::Slice<const double> values, size_t offset);
gp_Dir dir_at(rust::Slice<const double> values, size_t offset);
Handle(Geom_Surface) make_surface(int kind, rust::Slice<const double> d);
Segment line_segment(const gp_Pnt2d &a, const gp_Pnt2d &b);
std::vector<Loop> read_loops(rust::Slice<const double> d);
std::vector<std::vector<Loop>> read_regions(rust::Slice<const double> d);
std::vector<Loop> read_chains(rust::Slice<const double> d);
TopoDS_Wire loop_wire(const Handle(Geom_Surface) & surface, const Loop &loop, std::vector<TopoDS_Edge> &edges);

}  // namespace surface_wire
}  // namespace llull
