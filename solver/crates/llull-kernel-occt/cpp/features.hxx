// Feature operations of the llull native kernel (RS-1, second slice): fillet, chamfer, blend, shell, exact curve faces, prism /
// revolution of a face, loft, sweep, B-spline subdivision patches and the BRepFeat hole / pocket makers. Each mirrors the
// opencascade.js builder of packages/kernel-occt (same OCCT algorithm, same parameters) so both kernels build the same B-rep.
// Shares `Shape` and the exception-to-Err trycatch with facade.hxx.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include <TopoDS_Shape.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

// Ordered shape list for multi-operand operations (blend).
class ShapeList {
 public:
  std::vector<TopoDS_Shape> shapes;
  std::vector<std::vector<std::string>> names;
  // some operand asks for the adaptive mass rule (Shape::refined_mass): the result keeps asking for it
  bool refined_mass = false;
};

std::unique_ptr<ShapeList> new_shape_list();
void shape_list_add(ShapeList &list, const Shape &shape);

// Edge rounding: `edges` index the unique edges in explorer order ([] = all); `radius_end` NaN = constant radius.
std::unique_ptr<Shape> fillet_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double radius, double radius_end);
// Per-edge radius laws (SC-F3 `radii`): for edge k of `edges`, `laws` holds size, size_end (NaN = constant), mode (0 smooth, 1 straight
// pieces), n, then n (t, size) pairs (t in (0, 1) along the contour, increasing).
std::unique_ptr<Shape> fillet_laws(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws);
// Profile blends (cpp/blend_profile.cxx): per edge 7 numbers: unique edge index, kind (0 conic, 1 curvature, 2 circular with two legs), rho / shape
// factor, size, size2 (NaN = size is a radius), side (unique face index carrying size, or -1), 0 (reserved). Null when the build fails; profile_reason says why ("" = builds).
std::unique_ptr<Shape> fillet_profile(const Shape &shape, rust::Slice<const double> specs);
rust::String profile_reason(const Shape &shape, rust::Slice<const double> specs);
// Rail-preserving profile blends (cpp/blend_rails.cxx): the circular fillet of `edges` with `laws` (the fillet_laws layout) re-skinned with the
// section `kind` (0 conic, 1 curvature) and `param` (rho / shape); curved edges and faces, any size law. Null when the build fails; rails_reason says why.
std::unique_ptr<Shape> fillet_rails(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, double kind, double param);
rust::String rails_reason(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws, double kind, double param);
// The profile blend of a fillet node (cpp/blend_profile.cxx): prism builder when `specs` (7 numbers per edge, as fillet_profile) is given and builds, corners
// where edges meet, else the rail builder with `edges` / `laws` / `kind` / `param` (as fillet_rails; `laws` empty = not eligible). Null when it fails;
// profile_blend_reason says why ("" = builds).
std::unique_ptr<Shape> fillet_profile_blend(const Shape &shape, rust::Slice<const double> specs, rust::Slice<const uint32_t> edges,
                                            rust::Slice<const double> laws, double kind, double param);
// The reason the last fillet_profile_blend of this thread returned null (it computed it while building).
rust::String profile_blend_last_reason();
rust::String shape_notes(const Shape &shape);
rust::String profile_blend_reason(const Shape &shape, rust::Slice<const double> specs, rust::Slice<const uint32_t> edges,
                                  rust::Slice<const double> laws, double kind, double param);
// Setback corners (cpp/blend_corner.cxx, BLD M3): `edges` = (unique edge index, radius) pairs; `corners` = per corner x, y, z, n, then n (unique edge index of
// an edge meeting there, setback distance) pairs. Null when the build fails; setback_reason says why ("" = builds, "[BLD_CODE] ..." names the code).
std::unique_ptr<Shape> fillet_setback(const Shape &shape, rust::Slice<const double> edges, rust::Slice<const double> corners);
rust::String setback_reason(const Shape &shape, rust::Slice<const double> edges, rust::Slice<const double> corners);
// Face blends (cpp/blend_faces.cxx): face_blend spec = unique index of face A, of face B, radius, section kind (0 conic, 1 curvature, 2 circular), rho / shape;
// full_round spec = unique indices of side 1, center, side 2. Null when the build fails; *_reason says why ("" = builds, "[BLD_CODE] ..." names the code).
std::unique_ptr<Shape> face_blend(const Shape &shape, rust::Slice<const double> spec);
rust::String face_blend_reason(const Shape &shape, rust::Slice<const double> spec);
std::unique_ptr<Shape> full_round(const Shape &shape, rust::Slice<const double> spec);
rust::String full_round_reason(const Shape &shape, rust::Slice<const double> spec);
std::unique_ptr<Shape> chamfer_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double distance);
// Chamfer with its first leg on a named face per edge (`faces[k]` = unique face index bounding `edges[k]`): two distances, or with `angle` a distance and an angle (radians) measured on that face.
std::unique_ptr<Shape> chamfer_sided(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first,
                                     double second, bool angle);
// Variable chamfer (cpp/blend_chamfer.cxx, BLD M5): legs running linearly from `first` at the start of each listed edge to `last` at its end; symmetric when `faces` is
// empty, else the leg on the unique face `faces[k]` of edge k is the first and the other leg runs from `second` to `second_last`. Straight edges between planes and
// curved ones (arcs, B-splines, generator lines of a cylinder) between any two faces. Null when it cannot be built; chamfer_variable_reason says why ("" = builds).
std::unique_ptr<Shape> chamfer_variable(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first, double last,
                                        double second, double second_last);
rust::String chamfer_variable_reason(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first,
                                     double last, double second, double second_last);
// One fuse of the list whose joint edges are filleted: `radius` for every joint, except the joints nearest to the picks `joints` (x, y, z, radius per pick; a pick
// rounds its whole tangent chain). Null when it fails; blend_union_reason says why ("" = builds).
std::unique_ptr<Shape> blend_union(const ShapeList &list, double radius, rust::Slice<const double> joints);
rust::String blend_union_reason(const ShapeList &list, double radius, rust::Slice<const double> joints);
std::unique_ptr<Shape> shell_hollow(const Shape &shape, double thickness);
std::unique_ptr<Shape> shell_open(const Shape &shape, double thickness, rust::Slice<const double> open_near);

// Exact curve chains: `chain` = per segment a type code (0 line, 1 arc, 2 cubic Bezier, 3 ellipse quarter) then its 2 / 3 / 4 / 3 xyz points.
std::unique_ptr<Shape> chain_face(rust::Slice<const double> chain);
std::unique_ptr<Shape> circle_section(rust::Slice<const double> center, rust::Slice<const double> normal, double radius,
                                      double inner_radius);
std::unique_ptr<Shape> prism_of_face(const Shape &face, rust::Slice<const double> direction);
std::unique_ptr<Shape> revolution_of_face(const Shape &face, rust::Slice<const double> axis, double angle);
// ThruSections through closed chains: `chains` concatenated, `lengths` = number of f64 of each chain.
std::unique_ptr<Shape> skinned_solid(rust::Slice<const double> chains, rust::Slice<const uint32_t> lengths, bool ruled);
// ThruSections through B-spline sections (capability bsplineSections): `curves` concatenated, `lengths` = number of f64 of each one. A section is
// degree, pole count, distinct knot count, rational flag, closing flag, xyz poles, weights (rational only), knots, multiplicities; the closing
// flag adds the straight edge from the last pole back to the first. Null when OCC refuses; a throw (-> Err) when the data are inconsistent.
std::unique_ptr<Shape> skinned_solid_bsplines(rust::Slice<const double> curves, rust::Slice<const uint32_t> lengths, bool ruled);
std::unique_ptr<Shape> pipe_solid(rust::Slice<const double> spine, const Shape &section);
// MakePipe of `section` along the exact helix edge (capability helixEdge): origin xyz, axis xyz, x direction xyz, radius, end radius, turns,
// pitch, left-hand flag, start angle (15 numbers). Null when OCC refuses; a throw (-> Err) for inconsistent data.
std::unique_ptr<Shape> helix_pipe_solid(rust::Slice<const double> helix, const Shape &section);
// MakePipeShell fast path (capability pipeShell): trihedron mode, mode direction, homothetic law pairs, transition mode, tolerance, then probe points
// (xyz triples on the exact evaluator) and the largest distance they may lie from the BOUNDARY of the result (a probe inside a too fat pipe is a miss),
// then the expected volume (0 = unknown) the result must match within a relative 1e-4. Null when OCC refuses, a probe is missed or the volume differs.
std::unique_ptr<Shape> pipe_shell_solid(rust::Slice<const double> spine, const Shape &section, int32_t mode, rust::Slice<const double> direction,
                                        rust::Slice<const double> law, int32_t transition, double tolerance, rust::Slice<const double> probes,
                                        double check, double volume);
bool chain_wire_ok(rust::Slice<const double> chain);
// Bicubic patches, 16 poles each (u along i, v along j), sewn at `tolerance`; null (never a throw) when OCC refuses one.
std::unique_ptr<Shape> bspline_patch_solid(rust::Slice<const double> poles, double tolerance);

// Exact face of a surface description trimmed by (u, v) polygon loops (cpp/surfaces.cxx). `kind`: 0 B-spline (degU, degV, nU, nV, knot counts, rational
// flag, poles i-major, weights, knots and multiplicities of u then v), 1 plane (origin, xDir, yDir), 2 cylinder (origin, axis, xDir, radius),
// 3 cone (apex, axis, xDir, semi-angle), 4 sphere (centre, axis, xDir, radius; u azimuth, v latitude), 5 torus (centre, axis, xDir, major, minor radius). `loops`: count, then per loop its point count, an outer flag and u v pairs; no outer loop keeps a
// B-spline's natural boundary. Null when OCC refuses; a throw (-> Err) for inconsistent data.
std::unique_ptr<Shape> surface_face(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> loops);
// The face lifted along its normal from offset `from` to `to` (> from): a sewn solid. `direction` is the lift direction at the first loop vertex.
std::unique_ptr<Shape> face_slab(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> loops, double from, double to,
                                 rust::Slice<const double> direction, double tolerance);

// Emboss / deboss / scribe tools (03 WRP, cpp/surfaces.cxx): a compound with one tool per region of `regions`. `regions`: region count, then per region its
// loop count and per loop an outer flag, the start u v, a segment count and per segment a kind (0 line: end u v; 1 B-spline pcurve: degree, pole count,
// rational flag, knot count, poles u v, weights (rational only), knots, multiplicities). A tool is the face-slab between offsets `from` and `to` of the
// `kind` surface (as face_slab), or with `faces_only` the trimmed face itself. Null when OCC refuses; a throw (-> Err) for inconsistent data.
std::unique_ptr<Shape> emboss_tools(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> regions, double from, double to,
                                    rust::Slice<const double> direction, double tolerance, bool faces_only);
// The curves of `chains` (chain count, then per chain: start u v, segment count, segments as in `regions`; open chains allowed) as a compound of edges on the
// `kind` surface: the tools of split_face_by_curves. Null when OCC refuses; a throw (-> Err) for inconsistent data.
std::unique_ptr<Shape> pcurve_edge_tools(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> chains);
// The same on the surface of face `face_index` (distinct faces of `source`, first-seen order), the chains in that face's own (u, v): any face kind.
std::unique_ptr<Shape> face_edge_tools(const Shape &source, uint32_t face_index, rust::Slice<const double> chains);
// `source` divided by the faces (or edges) of `tools` that lie on it (scribe, split): same volume, more faces; persistent names follow the history.
std::unique_ptr<Shape> split_shape(const Shape &source, const Shape &tools);

// Closed solid of fitted lateral B-spline faces (surface_face kind-0 layouts concatenated, `lengths` = f64 count of each): the faces are sewn into
// a shell whose two closed free boundaries get planar caps, then everything is sewn into a solid. Null when OCC refuses or the solid is invalid; a
// throw (-> Err) when the sewing leaves free edges (SWG_KERNEL_SEW_OPEN) or the shell does not have exactly two closed boundaries.
std::unique_ptr<Shape> sheet_solid(rust::Slice<const double> faces, rust::Slice<const uint32_t> lengths, double tolerance, int32_t caps_expected);

// `tag` names the tool faces (SC-N1: "hole<n>.<k>", "pocket<n>").
// BRepFeat_MakeRevol cut of the closed polygon `profile` (xyz triples) revolved 2 pi about (origin, normal).
std::unique_ptr<Shape> feature_revol_cut(const Shape &source, rust::Slice<const double> profile, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal, rust::Str tag);
// BRepFeat_MakePrism cut of the face of `chain` from the planar face of `source` on the frame plane that holds a probe point.
std::unique_ptr<Shape> feature_prism_cut(const Shape &source, rust::Slice<const double> chain, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal, rust::Slice<const double> probes, double length,
                                         rust::Str tag);
// Face operations (SC-F1, face_ops.cxx): draft about a neutral plane, push-pull one planar face, split faces along a plane.
std::unique_ptr<Shape> draft_faces(const Shape &shape, rust::Slice<const uint32_t> faces, double angle, rust::Slice<const double> pull,
                                   rust::Slice<const double> origin, rust::Slice<const double> normal);
std::unique_ptr<Shape> push_pull(const Shape &shape, uint32_t face, double distance);
std::unique_ptr<Shape> split_faces(const Shape &shape, rust::Slice<const uint32_t> faces, rust::Slice<const double> origin,
                                   rust::Slice<const double> normal);
// Face moves and deletion (04 DIR M6, face_moves.cxx): mode 0 offset (`value` along the surface normal), 1 translate (`a` = vector), 2 rotate (`a` = axis
// origin, `b` = axis direction, `value` = radians); delete = BRepAlgoAPI_Defeaturing. Null when OCC refuses or the result is not one valid solid.
std::unique_ptr<Shape> move_faces(const Shape &shape, rust::Slice<const uint32_t> faces, int32_t mode, rust::Slice<const double> a,
                                  rust::Slice<const double> b, double value, bool check);
std::unique_ptr<Shape> delete_faces(const Shape &shape, rust::Slice<const uint32_t> faces);
// BRepCheck_Analyzer validity.
bool is_valid_shape(const Shape &shape);
// Post-boolean ShapeUpgrade_UnifySameDomain (the shape itself when it fails).
std::unique_ptr<Shape> unified_shape(const Shape &shape);

}  // namespace llull
