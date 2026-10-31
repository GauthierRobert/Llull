// The exact-boundary corner patch (BLD 13.21): a star of Hermite-Coons sub-patches around a centre point, one per edge of the hole, whose boundaries are the hole's edges
// themselves and whose cross-boundary tangent planes are those of the supports.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

namespace llull::corner_exact {

// Where the surface the patch replaces crosses the axis (from, direction): the signed distance from `from`; false when it does not. A hole cut out of a smooth blend (13.22) knows its centre.
using CentreHint = std::function<bool(const gp_Pnt &from, const gp_Dir &axis, double &height)>;

struct Patches {
  std::vector<TopoDS_Face> faces;  // one per chain of the loop (the stretch between two spoke vertices), around the centre
  std::vector<size_t> part;        // 1 when the sub-patch starts inside that edge (a hole of smooth edges is cut at their middles)
  std::vector<size_t> loop_index;  // the edge of the loop each sub-patch STARTS on (its bottom may run over several edges)
  gp_Pnt centre;                   // where the sub-patches meet
  bool centre_from_hint = false;   // the centre is where the replaced surface crosses the axis (else the 3/8 rule of 13.21.4)
  double gap = 0;                  // largest distance from a sample of a loop edge to the patch edge at the same parameter
  double angle = 0;                // largest angle between the patch normal and the support normal along the loop, and between neighbouring sub-patches along their shared spokes
};

// The loop (ordered, closed) with the support face of each edge (`supports[k]` carries `loop[k]`; the faces are the outward ones of the split solid). False with `why` when the
// construction is refused or its own measures exceed `max_gap` / `max_angle`; the caller falls back to another fill.
bool build(const std::vector<TopoDS_Edge> &loop, const std::vector<TopoDS_Face> &supports, double max_gap, double max_angle, Patches &out, std::string &why,
           const CentreHint &hint = nullptr, bool spokes_at_every_vertex = false);

}  // namespace llull::corner_exact
