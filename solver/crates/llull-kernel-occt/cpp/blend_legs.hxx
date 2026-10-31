// Plan and sections of the two-leg profile blend (cpp/blend_legs_plan.cxx, assembled by cpp/blend_legs.cxx; TECHNICAL_SPEC §13.34).
#pragma once

#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

namespace llull {
namespace blend {
namespace legs {

// How far (x the diagonal) the interpolated section poles may leave the true sections between two stations.
constexpr double kDeviationFraction = 1e-8;
// Stations along an edge before refinement, and the most refinement inserts.
constexpr int kFirstStations = 24, kMostStations = 6000;
// A built gap is accepted up to kGapAccepted x this fraction of the smaller true diagonal: the default g0 of check_blends, because a circular two-leg row is judged at g0 (a profile row at 5 x it).
constexpr double kGapLimit = 1e-6;
constexpr double kSewingFraction = 1e-6, kSewingCap = 1e-3;
// Stations at which the contact points are compared with the chamfer face.
constexpr int kLegChecks = 21;
// Two unit tangents closer than this to parallel have no apex.
constexpr double kDegenerate = 1e-6;
// Leg numbers of one edge in the `legs` array.
constexpr size_t kLegWidth = 6;

// One section of the blend: the contact points, the apex of their tangent lines and the weight of the conic. A curvature section (kind 1) is the quintic
// of curvature_poles: `bend_a`, `bend_b` are the offsets of its 3rd and 4th pole along the support normals that give it the supports' normal curvature (13.40).
struct Section {
  gp_Pnt a, t, b;
  double weight = 1;
  gp_Vec bend_a{0, 0, 0}, bend_b{0, 0, 0};
};

// The six poles of the curvature section of `s` for the shape parameter `shape`: A, A + 0.8 shape (T - A), the two bent middle poles, B + 0.8 shape (T - B), B.
std::vector<gp_Pnt> curvature_poles(const Section &s, double shape);

// One source edge and what its sections need.
struct EdgePlan {
  int index = 0;
  TopoDS_Edge edge;
  TopoDS_Face faces[2];  // faces[0] carries the first leg
  bool flip[2] = {false, false};
  double sign[2] = {1, 1};  // the side of normal x tangent that runs away from the edge inside face k
  bool convex = true;
  bool closed = false;
  double length = 0;
  double leg[4] = {0, 0, 0, 0};  // first start, first end, second start, second end (linear in the arc length)
  double at(int k, double s) const { return leg[2 * k] + (leg[2 * k + 1] - leg[2 * k]) * (s / length); }
};

// The volume of `shape`, and a number as the reasons print it (6 significant digits).
double volume_of(const TopoDS_Shape &shape);
std::string number_text(double value);

// The section of `plan` at arc length `s` from the start of the edge; false with the reason in `why`.
bool section_at(const EdgePlan &plan, const BRepAdaptor_Curve &curve, double s, int kind, double param, Section &out, std::string &why);

// The skin of the blend of `plan`, with stations inserted where the interpolated section poles miss the true ones by more than `limit` between two stations.
Handle(Geom_BSplineSurface) skin_edge(const EdgePlan &plan, const BRepAdaptor_Curve &curve, int kind, double param, double limit, std::string &why);

// The plan of one edge from its numbers; false with the reason in `why`.
bool make_plan(const TopoDS_Shape &shape, const TopTools_IndexedMapOfShape &unique_edges, const TopTools_IndexedMapOfShape &unique_faces,
               const TopTools_IndexedDataMapOfShapeListOfShape &owners, const double *numbers, double diagonal, EdgePlan &plan, std::string &why);

// The edge of `face` whose two vertices are the contact points `a`, `b` (either order) and the other face it joins, or false.
bool end_edge_of(const TopoDS_Face &face, const TopTools_IndexedDataMapOfShapeListOfShape &edge_faces, const gp_Pnt &a, const gp_Pnt &b, double tolerance,
                 TopoDS_Edge &edge, TopoDS_Face &neighbour);

}  // namespace legs
}  // namespace blend
}  // namespace llull
