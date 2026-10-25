// Shared pieces of the profile / face-blend builders (BLD M2, M4): the spandrel tool, its boolean application with persistent names, and the
// geometry helpers they use. Definitions live in blend_profile.cxx.
#pragma once

#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <Geom_Curve.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"

namespace llull {
namespace blend {

constexpr double kPi = 3.14159265358979323846;
// A face counts as "inside" for the legs when the point is IN or ON it (document units).
constexpr double kInsideTolerance = 1e-7;
// Normals closer than this to parallel / anti-parallel are not a corner.
constexpr double kTangentAngle = 1e-6;

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

// `current` after cutting (or fusing, per tool) every tool, with names carried by the boolean histories; false with the reason in `why`.
bool apply_tools(naming::Named &current, const std::vector<Tool> &tools, std::string &why);

}  // namespace blend
}  // namespace llull
