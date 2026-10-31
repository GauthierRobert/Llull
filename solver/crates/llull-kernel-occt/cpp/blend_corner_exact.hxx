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

// The curvature across the spokes between the sub-patches of a star (13.38), measured on the built patches.
struct SpokeReading {
  double reach = 0;            // the stretch of each spoke, from its vertex, over which the correction fades in (0: the spokes are G1 seams)
  double jump = 0;             // largest jump (1/length) of the normal curvature across a spoke, over the whole spoke
  double relative = 0;         // largest share of the larger of the two curvatures beyond the stretch (the whole spoke when reach is 0)
  double vertex_relative = 0;  // the same within the stretch next to the vertices
  std::string refused;         // G1 spokes of a G2 star: why the G2 spokes were refused (the measure against the gate)
};

struct Patches {
  std::vector<TopoDS_Face> faces;  // one per chain of the loop (the stretch between two spoke vertices), around the centre
  std::vector<size_t> part;        // 1 when the sub-patch starts inside that edge (a hole of smooth edges is cut at their middles)
  std::vector<size_t> loop_index;  // the edge of the loop each sub-patch STARTS on (its bottom may run over several edges)
  gp_Pnt centre;                   // where the sub-patches meet
  bool centre_from_hint = false;   // the centre is where the replaced surface crosses the axis (else the 3/8 rule of 13.21.4)
  double gap = 0;                  // largest distance from a sample of a loop edge to the patch edge at the same parameter
  double angle = 0;                // largest angle between the patch normal and the support normal along the loop, and between neighbouring sub-patches along their shared spokes
  double crease = 0;               // largest angle between the normals on the two sides of a joint knot inside a sub-patch (the interior crease of a C0 knot)
  double g2 = 0;                   // G2 stars: largest jump (1/length) of the normal curvature across a loop edge between the sub-patch and its support, along the whole edge
  double g2_relative = 0;          // the same as a share of the larger of the two curvatures (0 where both are flat)
  bool g2_built = false;           // the patch carries the curvature of the supports (13.36)
  SpokeReading spokes;             // G2 stars: the curvature across the spokes (spokes.reach > 0: curvature-continuous beyond that stretch)
};

// The loop (ordered, closed) with the support face of each edge (`supports[k]` carries `loop[k]`; the faces are the outward ones of the split solid). False with `why` when the
// construction is refused or its own measures exceed `max_gap` / `max_angle`; the caller falls back to another fill.
// `allow_crease`: one vertex of the loop may join two supports that are NOT tangent (an unrounded edge of the part enters the hole there, 13.33.2); its spoke is a crease.
// `g2`: the patch is also curvature-continuous to its supports across every loop edge (13.36): refused (with `why`) at a chain with a joint, a crease vertex, or when the measured jump stays over the gate.
bool build(const std::vector<TopoDS_Edge> &loop, const std::vector<TopoDS_Face> &supports, double max_gap, double max_angle, Patches &out, std::string &why,
           const CentreHint &hint = nullptr, bool spokes_at_every_vertex = false, bool gate_crease = true, bool c0_knots_only = false, bool allow_crease = false, bool g2 = false);

}  // namespace llull::corner_exact
