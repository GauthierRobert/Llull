// The exact-boundary corner patch (BLD 13.21): a star of Hermite-Coons sub-patches around a centre point, one per edge of the hole, whose boundaries are the hole's edges
// themselves and whose cross-boundary tangent planes are those of the supports.
#pragma once

#include <string>
#include <vector>

#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt.hxx>

namespace llull::corner_exact {

struct Patches {
  std::vector<TopoDS_Face> faces;  // one per edge of the loop, around the centre
  gp_Pnt centre;                   // where the sub-patches meet
  double gap = 0;                  // largest distance from a sample of a loop edge to the patch edge at the same parameter
  double angle = 0;                // largest angle between the patch normal and the support normal along the loop, and between neighbouring sub-patches along their shared spokes
};

// The loop (ordered, closed) with the support face of each edge (`supports[k]` carries `loop[k]`; the faces are the outward ones of the split solid). False with `why` when the
// construction is refused or its own measures exceed `max_gap` / `max_angle`; the caller falls back to another fill.
bool build(const std::vector<TopoDS_Edge> &loop, const std::vector<TopoDS_Face> &supports, double max_gap, double max_angle, Patches &out, std::string &why);

}  // namespace llull::corner_exact
