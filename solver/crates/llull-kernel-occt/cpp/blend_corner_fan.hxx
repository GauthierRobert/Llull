// The vertex fans of a G2 corner star (BLD 13.45): around every vertex V of the loop the two sub-patch corners that meet at V are replaced by two faces in polar coordinates about V.
#pragma once

#include <string>
#include <vector>

#include <Geom_BSplineSurface.hxx>
#include <TopoDS_Face.hxx>

namespace llull::corner_exact {

// The share of a spoke (its parameter v) a fan reaches: past the stretch over which the correction of 13.38 fades in (0.2), where the two sub-patches are curvature-continuous already.
constexpr double kFanSpan = 0.34;

struct Fans {
  std::vector<TopoDS_Face> trimmed;  // one per sub-patch: the sub-patch less its two corner triangles
  std::vector<TopoDS_Face> fans;     // two per loop vertex k: the fan of sub-patch k (its corner u = 0), then the fan of sub-patch k - 1 (its corner u = 1)
  double seam_relative = 0;          // largest share of the larger curvature of the curvature jump across the fan seams, over the marks below
  double seam_jump = 0;              // the largest jump (1/length)
  double arc_gap = 0, arc_angle = 0, arc_g2 = 0;  // the fans against the sub-patches they replace along the arc (distance, normal angle, curvature jump)
  std::vector<double> marks;         // the relative jump at 0.25, 0.5, 1, 2, 4, 8, 16, 24 % of the spoke
};

// `surfaces[k]` are the sub-patches of the ring (the spoke between k - 1 and k is u = 0 of k and u = 1 of k - 1). False with `why` when a fan cannot be built within the gates or OCCT throws (`inject`: test hook, 1 throws an OCCT exception, 2 a std::exception, 3 fails the faces of the first pole rung).
bool make_fans(const std::vector<Handle(Geom_BSplineSurface)> &surfaces, double max_gap, double mean_length, int inject, Fans &out, std::string &why);

}  // namespace llull::corner_exact
