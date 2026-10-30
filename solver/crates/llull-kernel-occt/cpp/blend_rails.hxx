// Types and mitre pieces of the rail-preserving profile builder (cpp/blend_rails.cxx, cpp/blend_mitre.cxx; TECHNICAL_SPEC §13.11 and §13.16).
#pragma once

#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <Geom_Curve.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

namespace llull {
namespace blend {
namespace rails {

struct Section {
  gp_Pnt a, t, b;
  gp_Pnt centre;  // of the section circle (the rolling ball)
  double circle_weight = 0;  // the weight of the rational quadratic a, t, b that is the circular arc of the ball: cos of half the arc
  gp_Vec bend_a{0, 0, 0}, bend_b{0, 0, 0};  // curvature-continuous sections: the offset of the 3rd / 4th pole of the quintic along the support normal
};

// The part of a rail over one support face: the face, the edge of the circular blend that bounds it there and the range of the along parameter it covers.
struct RailPiece {
  TopoDS_Face face;
  double lo, hi;
  TopoDS_Edge edge;
};

// How a blend face ends on the next blend of its chain across a crease (a mitre): the points of every section within `length` of the end move along the
// end's section-plane normal (the displacement `shift` of the section's a, t, b and centre at the end, faded in by a smooth quintic) so that the
// section at the end lies in the bisector plane of the two section planes, where both blends have the same one.
struct Mitre {
  bool active = false;
  gp_Vec shift[4];
  double length = 0;
  double turn = 0;  // the crease (radians): the angle between the two end section planes, from the circular sections
};

// A blend face of the circular fillet and what bounds it.
struct Blend {
  TopoDS_Face face;
  bool across_is_u = true;      // the section runs along u (the rails are u = const)
  double across[2] = {0, 0};    // parameter of the rails
  double lo = 0, hi = 0;        // parameter range along the blend
  bool closed = false;          // a seam instead of ends (a rim)
  TopoDS_Edge end[2];           // the section edge at lo / hi (null: none)
  TopoDS_Face end_face[2];      // its neighbour when that is a flat end face to rebuild (null: another blend of the chain)
  TopoDS_Face end_blend[2];     // its neighbour when that is the next blend of the chain
  std::vector<RailPiece> supports[2];  // the support faces along each rail
  Mitre mitre[2];
};

// The conic of a blend that ends on the next blend of its chain fades to the circular arc at that end (TECHNICAL_SPEC 13.19): the weight of the
// section goes from the profile's to the circle's, by a smooth quintic over `reach[end]` of arc length of the ball centre. The circular family is
// G1 across a junction whatever the walls' curvature does, which is what the apex of a conic is not.
struct Fade {
  bool active = false;
  bool at[2] = {false, false};
  double reach[2] = {0, 0};
  std::vector<double> along, arc;  // the ball centre's arc length at sampled stations of the blend
  double largest = 0;              // the largest change of the weight (the profile's against the circle's) at a station
};

// The fade of `blend` at the ends that meet the next blend of the chain and are not mitred; `reach_factor` x the chord of the end section is the
// length of the fade, at most 0.45 of the blend. False with the reason in `why`.
bool plan_fade(const BRepAdaptor_Surface &surface, const Blend &blend, double reach_factor, Fade &fade, std::string &why);

// The weight of the conic at `along`: the profile's `profile_weight` away from the faded ends, `circle_weight` at them.
double faded_weight(const Fade &fade, double along, double circle_weight, double profile_weight);

// A contact point whose mitre displacement is below this fraction of the diagonal does not move (no re-trimming, no pin test).
constexpr double kStillFraction = 1e-6;

// The section of `blend` at `along` (contact points, apex, ball centre; curved: the curvature offsets of the quintic), mitred where the blend ends on a crease.
bool section_at(const BRepAdaptor_Surface &surface, const Blend &blend, double along, bool curved, double shape, Section &out, std::string &why);

// A number as the reasons print it (6 significant digits).
std::string number(double value);

// The volume the circular fillet removes over `blend`, integrated from its (mitred) circular sections: the area between the corner and the arc, along the
// path of the ball centre. A sanity window for the volume of the result where the blends meet across creases, not an independent oracle: OCCT's own solid
// there has blend faces that do not meet (they miss by r x turn) and cannot be integrated. False with the reason in `why`.
bool circular_section_volume(const Blend &blend, double &volume, std::string &why);

// Diagonal of the box of `solid`: the faces that are not in `blend_images` searched exactly (BRepBndLib::AddOptimal), those that are sampled (the
// optimal search takes seconds on the B-spline blend faces of a long chain; the sampled box is off by far less than the 1e-6 relative the gap limit needs).
double result_diagonal(const TopoDS_Shape &solid, const std::vector<TopoDS_Shape> &blend_images);

// Moves `section` (taken at `along`) by the mitre displacements of the ends of `blend` it is within reach of.
void apply_mitre(const Blend &blend, double along, Section &section);

// Finds the creases between the blends of a chain: for each pair of blends that meet at an end it computes the bisector plane of their end section planes
// and the displacement of each end section onto it. `blend_faces` maps a face to its index in `blends`. A crease the builder cannot mitre (a curved
// support, a size that varies, a rail of several pieces, a contact point pinned on an edge of the part that the plane does not contain) is a reason in `why`.
bool plan_mitres(std::vector<Blend> &blends, const TopTools_IndexedMapOfShape &blend_faces, const TopTools_IndexedDataMapOfShapeListOfShape &vertex_faces,
                 double diagonal, bool constant_size, std::string &why);

// An edge of a face to rebuild and the curve that takes its place; `vertex` are the vertices at the curve's start / end (null: the old edge's own).
struct Replacement {
  TopoDS_Edge old_edge;
  Handle(Geom_Curve) curve;
  TopoDS_Vertex vertex[2];
};
struct FaceEdit {
  TopoDS_Face face;
  std::vector<Replacement> replacements;
};

// `edit.face` with every replacement applied (new pcurves on its plane); false with the reason in `why`.
bool rebuild_face(const FaceEdit &edit, TopoDS_Face &out, std::string &why);

}  // namespace rails
}  // namespace blend
}  // namespace llull
