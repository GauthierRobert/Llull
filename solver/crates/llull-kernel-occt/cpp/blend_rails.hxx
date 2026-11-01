// Types and mitre pieces of the rail-preserving profile builder (cpp/blend_rails.cxx, cpp/blend_mitre.cxx; TECHNICAL_SPEC §13.11 and §13.16).
#pragma once

#include <functional>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
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

// An oblique end whose contact lines run past the end of a STRAIGHT edge between two FLAT faces while the size varies (TECHNICAL_SPEC §13.37): the size law is
// continued past the end vertex `vertex` (direction `outward`) by its end tangent, size(delta) = size + slope delta for delta > 0 (delta: distance beyond
// the vertex along the edge); `size` and `slope` are the radius of the rolling ball there and its derivative, measured on the circular blend.
struct Extension {
  bool active = false;
  gp_Pnt vertex;
  gp_Vec outward{0, 0, 0};
  double size = 0, slope = 0;
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
  bool oblique[2] = {false, false};  // the end edge is not an iso-line: the end face is flat but not square to the blend; the skin runs to the farther rail's end and is cut by its plane (13.35)
  double core[2] = {0, 0};      // the range along which both rails exist (lo / hi unless an end is oblique)
  double reach[2] = {0, 0};     // oblique ends: lo / hi as the rails give them, before lo / hi are widened by kObliqueMargin of the span
  gp_Pnt end_point[2];          // oblique ends: a point of the end plane and its outward normal (set from the circular solid)
  gp_Vec end_normal[2];
  bool curved[2] = {false, false};  // oblique ends: the end face is NOT flat; the skin is split by its surface and end_point / end_normal only size the margin (13.37)
  double end_sign[2] = {1.0, 1.0};  // curved ends: +1 when the surface normal du x dv of the end face points out of the solid, else -1
  std::vector<RailPiece> supports[2];  // the support faces along each rail
  Mitre mitre[2];
  Extension extend[2];          // oblique ends: the size law continued past the end of the edge (13.37)
  bool law_known = false;       // the law of the edge this blend rounds was found among the laws given: law_slope[0] / [1] is its derivative going outward at the first / last end of the edge (13.37)
  double law_slope[2] = {0, 0};
};

// The conic of a blend that ends on the next blend of its chain fades to the circular arc at that end (TECHNICAL_SPEC 13.19): the weight of the
// section goes from the profile's to the circle's, by a smooth quintic over `reach[end]` of arc length of the ball centre. The circular family is
// G1 across a junction whatever the walls' curvature does, which is what the apex of a conic is not.
struct Fade {
  bool active = false;
  bool at[2] = {false, false};
  double reach[2] = {0, 0};
  std::vector<double> along, arc;  // the ball centre's arc length at sampled stations of the blend
};

// The fade of `blend` at the ends that meet the next blend of the chain and are not mitred; `reach_factor` x the chord of the end section is the
// length of the fade, at most 0.45 of the blend. False with the reason in `why`.
bool plan_fade(const BRepAdaptor_Surface &surface, const Blend &blend, double reach_factor, Fade &fade, std::string &why);

// The weight of the conic at `along`: the profile's `profile_weight` away from the faded ends, `circle_weight` at them.
double faded_weight(const Fade &fade, double along, double circle_weight, double profile_weight);

// Every pole of the interpolated weight curve of a faded blend must exceed this (a NURBS weight is positive); false with the reason in `why`.
constexpr double kLeastWeight = 1e-9;
bool positive_weights(const Handle(Geom_BSplineCurve) &weights, std::string &why);

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

// `blend` (oblique ends, a straight `source` edge between flat faces): where a section of the skin lies beyond the end vertex of the edge, sets `extend` for that
// end to the continuation of the size law by its end tangent (TECHNICAL_SPEC §13.37); an end that needs nothing, or a blend this does not cover, stays as it
// was. False with the reason in `why` (the continued size reaches zero).
bool plan_extension(Blend &blend, const TopoDS_Edge &source, double diagonal, std::string &why);

// Scales `section` (the circular blend's, with ball radius `radius`) about its apex to the continued size when its apex lies beyond the end vertex of an `extend` end.
void continue_size(const Blend &blend, double radius, Section &section);

// An edge of a face to rebuild and the curve that takes its place; `vertex` are the vertices at the curve's start / end (null: the old edge's own).
struct Replacement {
  TopoDS_Edge old_edge;
  Handle(Geom_Curve) curve;
  TopoDS_Vertex vertex[2];
  double grow_limit = 0;  // oblique ends: the most the new curve may miss the old vertices by (their tolerance grows to hold it); 0: the vertices are used as they are, as before
};
struct FaceEdit {
  TopoDS_Face face;
  std::vector<Replacement> replacements;
};

// `edit.face` with every replacement applied (new pcurves on its plane); false with the reason in `why`.
bool rebuild_face(const FaceEdit &edit, TopoDS_Face &out, std::string &why);

// The contact lines of a blend with an oblique end are read from the circular blend's surface past the end of the shorter one (13.35): that extension must
// still lie on the support faces, to `limit`. False with the measured deviation in `why` (OCCT extends a surface of a varying size by extrapolation, which
// leaves the supports).
bool check_extension(const Blend &blend, double limit, std::string &why);

// The skin of a blend with an oblique end (13.35): `skin_face` runs past each oblique end plane; it is cut back to the solid's side of the plane (a box on the
// outer side), which leaves ONE face and, per oblique end, one curve in the plane: the new end edge, returned in `end_curves[side]`. The contact lines must
// meet that curve where the circular blend's own end edge has its vertices, to `gap_limit`. `diagonal` scales the cutting boxes. False with the reason in `why`.
bool trim_oblique(const TopoDS_Face &skin_face, const Blend &blend, double diagonal, double gap_limit, TopoDS_Face &trimmed,
                  Handle(Geom_Curve) (&end_curves)[2], std::string &why);

// How far `point` lies outside the solid past the end face of oblique end `side` of `blend`: the signed distance along the outward normal of the end plane, or
// (a curved end face, 13.37) of the nearest point of its surface; negative on the solid's side. False when the surface cannot be projected on.
bool end_height(const Blend &blend, int side, const gp_Pnt &point, double &height);

// The skin `face` split by the surface of the curved end face of oblique end `side` of `blend` (13.37) and cut back to the piece on the solid's side; false
// with the reason in `why`. `diagonal` scales the parameter box of the cutting face.
bool split_by_end_surface(TopoDS_Face &face, const Blend &blend, int side, double diagonal, std::string &why);

// The edits of a blend whose size is continued past an oblique end (13.37): the contact lines and the end curve now meet the end face at new points, so
// the end face, the two support faces and the edges they share with the end face are rebuilt around them (`edit_of` returns the edit of a face of the
// circular solid). `skin` is the untrimmed skin of the blend, `end_curves` the cut of it by the end planes. False with the reason in `why`.
bool extension_edits(const Blend &blend, const Handle(Geom_BSplineSurface) &skin, Handle(Geom_Curve) (&end_curves)[2], double gap_limit,
                     const TopTools_IndexedDataMapOfShapeListOfShape &edge_faces, const std::function<FaceEdit &(const TopoDS_Face &)> &edit_of,
                     std::string &why);

}  // namespace rails
}  // namespace blend
}  // namespace llull
