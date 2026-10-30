// Shared pieces of the profile / face-blend builders (BLD M2, M4): the spandrel tool, its boolean application with persistent names, and the
// geometry helpers they use. Definitions live in blend_profile.cxx.
#pragma once

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <Geom_Curve.hxx>
#include <Standard_Failure.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"

namespace llull {
namespace blend {

// "OCCT failed: <exception type>[: <message>]": the message of a Standard_Failure is often empty, the type is what says what went wrong.
inline std::string occt_failure(const Standard_Failure &error) {
  std::string text = std::string("OCCT failed: ") + error.DynamicType()->Name();
  if (error.GetMessageString() != nullptr && error.GetMessageString()[0] != '\0') text += std::string(": ") + error.GetMessageString();
  return text;
}

constexpr double kPi = 3.14159265358979323846;
// A face counts as "inside" for the legs when the point is IN or ON it (document units).
constexpr double kInsideTolerance = 1e-7;
// Normals closer than this to parallel / anti-parallel are not a corner.
constexpr double kTangentAngle = 1e-6;
// A built gap is accepted up to this fraction of its limit: check_blends samples other points (and the entity may be placed or rotated after
// the fillet), so a gap a builder accepted must not read above the limit there. Shared by the rail and corner builders.
constexpr double kGapAccepted = 0.95;

// A blend tool and the persistent names of its faces; `convex` tools are cut from the source, the others fused to it.
struct Tool {
  TopoDS_Shape shape;
  std::vector<std::string> names;
  bool convex = true;
};

// A straight edge between two planar faces, with the frame the spandrel tools are built in: the two faces, their outward normals, the unit
// directions inside each face running away from the edge, the fold between the normals and whether the edge is convex.
struct EdgeFrame {
  TopoDS_Edge edge;
  gp_Pnt start, end;
  gp_Vec direction;
  double length = 0;
  TopoDS_Face faces[2];
  gp_Vec normals[2], inward[2];
  double fold = 0;
  bool convex = true;
};
// The frame of unique edge `index` of `shape`; false with the reason in `why` (`what` names the kind of blend in the messages).
bool edge_frame(const TopoDS_Shape &shape, int index, const char *what, EdgeFrame &frame, std::string &why);

// Whether both ends of the straight edge of `frame` lie on a planar face perpendicular to it (the other faces at each end vertex), so a prism
// along the edge can end flush; false with the reason in `why`.
bool ends_square(const TopoDS_Shape &shape, const EdgeFrame &frame, const char *what, std::string &why);

// Diagonal of the true bounding box of `shape` (BRepBndLib::AddOptimal without enlargement: the bounds mass_properties gives, so the length
// scale check_blends measures against). Construction tolerances use it; an acceptance limit uses the smaller of the source's and the result's.
double diagonal_of(const TopoDS_Shape &shape);
// Diagonal of the box of the VERTICES of `shape` (0 when it has none): the scale of the vertex-matching tolerance, which core computes the same way
// (geometry/blend/vertices.ts), never an acceptance limit.
double vertex_diagonal_of(const TopoDS_Shape &shape);

// Outward normal of a planar face (orientation applied).
gp_Vec normal_of(const TopoDS_Face &face);
// Outward normal of a planar face of `shape`: the oriented plane normal, flipped when a probe just off the face centre lies in the solid (the
// faces a chamfer builds can carry an orientation that points inward).
gp_Vec outward_normal(const TopoDS_Shape &shape, const TopoDS_Face &face);
// Whether `point` is IN or ON `face` (within kInsideTolerance).
bool inside(const TopoDS_Face &face, const gp_Pnt &point);

// The section curve of the spandrel from `a` to `b` around the corner `start` (kinds as for spandrel_tool); kind 2 with equal legs is the exact
// circular arc (an analytic cylinder face), anything else a Bezier curve.
Handle(Geom_Curve) section_curve(const gp_Pnt &start, const gp_Pnt &a, const gp_Pnt &b, int kind, double param, double wedge);

// The spandrel prism of one corner: the section outline corner `start` -> `a` (straight), `a` -> `b` (kind 0 conic with weight rho / (1 - rho),
// 1 quartic with zero end curvature, 2 conic with the circle weight sin(wedge / 2)), `b` -> `start` (straight), swept to `end`. The lateral
// face of the section curve is named `blend_name`. False with the reason in `why`.
bool spandrel_tool(const gp_Pnt &start, const gp_Pnt &end, const gp_Pnt &a, const gp_Pnt &b, int kind, double param, double wedge,
                   const std::string &blend_name, Tool &tool, std::string &why);

// The spandrel prism of an edge whose circular blend tapers: the ruled loft of the circular spandrel sections at the two ends (corner, leg points a, b
// of each, so the lateral face of the arcs is a cone), named `blend_name` on the arc face. False with the reason in `why`.
bool tapered_spandrel_tool(const gp_Pnt &start_from, const gp_Pnt &a_from, const gp_Pnt &b_from, const gp_Pnt &start_to, const gp_Pnt &a_to, const gp_Pnt &b_to,
                           double wedge, const std::string &blend_name, Tool &tool, std::string &why);

// `current` after cutting (or fusing, per tool) every tool, with names carried by the boolean histories; false with the reason in `why`.
bool apply_tools(naming::Named &current, const std::vector<Tool> &tools, std::string &why);

// The point of `support` nearest to `point`, `on`; false when the projection fails.
bool project_on_face(const TopoDS_Face &support, const gp_Pnt &point, gp_Pnt &on);

// What a curvature-continuous section must match at `point` of `support`: the curvature `kappa` of the face along the unit-free `direction` (in its
// tangent plane) measured toward the side of `toward` (a vector from the contact point to the other contact point), and that unit normal `nu`.
// False when the point does not project on the face or its parametrisation is degenerate there.
bool support_curvature(const TopoDS_Face &support, const gp_Pnt &point, const gp_Vec &direction, const gp_Vec &toward, gp_Vec &nu, double &kappa);

// The rail-preserving profile blend (cpp/blend_rails.cxx): the circular fillet of unique edges `edges` with `laws` (the fillet_laws layout) re-skinned with
// the section `kind` (0 conic, 1 curvature) and `param`. Null with the reason in `why`.
// `notes` receives the JSON object the built shape carries (Shape::notes): builder, measured gap, a reported fallback. A curvature profile that
// falls back to the zero-curvature quartic says so there.
std::unique_ptr<Shape> rails_blend(const Shape &source, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, int kind, double param,
                                   std::string &notes, std::string &why);

// The profile blend of edges that meet at vertices (cpp/blend_corner.cxx): one spandrel prism per edge of `radii` (unique edge index, radius), kind and
// param as for spandrel_tool, stopping at the least setback that leaves a patch at every vertex where rounded edges meet, each filled G1 to the
// blends and the supports. Null with the reason in `why` (no [BLD_CODE] prefix).
// `notes` receives the JSON the shape carries: the setback factor that built and, per corner, its vertex and the setback of each edge.
std::unique_ptr<Shape> profile_corner_blend(const Shape &source, const std::vector<std::pair<int, double>> &radii, int kind, double param,
                                            std::string &notes, std::string &why);

}  // namespace blend
}  // namespace llull
