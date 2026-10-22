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
};

std::unique_ptr<ShapeList> new_shape_list();
void shape_list_add(ShapeList &list, const Shape &shape);

// Edge rounding: `edges` index the unique edges in explorer order ([] = all); `radius_end` NaN = constant radius.
std::unique_ptr<Shape> fillet_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double radius, double radius_end);
// Per-edge radius laws (SC-F3 `radii`): for edge k of `edges`, `laws` holds size, size_end (NaN = constant), n, then n (t, size) pairs
// (t in (0, 1) along the edge, increasing).
std::unique_ptr<Shape> fillet_laws(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws);
std::unique_ptr<Shape> chamfer_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double distance);
std::unique_ptr<Shape> blend_union(const ShapeList &list, double radius);
std::unique_ptr<Shape> shell_hollow(const Shape &shape, double thickness);
std::unique_ptr<Shape> shell_open(const Shape &shape, double thickness, rust::Slice<const double> open_near);

// Exact curve chains: `chain` = per segment a type code (0 line, 1 arc, 2 cubic Bezier) then its 2 / 3 / 4 xyz points.
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
bool chain_wire_ok(rust::Slice<const double> chain);
// Bicubic patches, 16 poles each (u along i, v along j), sewn at `tolerance`; null (never a throw) when OCC refuses one.
std::unique_ptr<Shape> bspline_patch_solid(rust::Slice<const double> poles, double tolerance);

// Exact face of a surface description trimmed by (u, v) polygon loops (cpp/surfaces.cxx). `kind`: 0 B-spline (degU, degV, nU, nV, knot counts, rational
// flag, poles i-major, weights, knots and multiplicities of u then v), 1 plane (origin, xDir, yDir), 2 cylinder (origin, axis, xDir, radius),
// 3 cone (apex, axis, xDir, semi-angle). `loops`: count, then per loop its point count, an outer flag and u v pairs; no outer loop keeps a
// B-spline's natural boundary. Null when OCC refuses; a throw (-> Err) for inconsistent data.
std::unique_ptr<Shape> surface_face(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> loops);
// The face lifted along its normal from offset `from` to `to` (> from): a sewn solid. `direction` is the lift direction at the first loop vertex.
std::unique_ptr<Shape> face_slab(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> loops, double from, double to,
                                 rust::Slice<const double> direction, double tolerance);

// Closed solid of fitted lateral B-spline faces (surface_face kind-0 layouts concatenated, `lengths` = f64 count of each): the faces are sewn into
// a shell whose two closed free boundaries get planar caps, then everything is sewn into a solid. Null when OCC refuses or the solid is invalid; a
// throw (-> Err) when the sewing leaves free edges (SWG_KERNEL_SEW_OPEN) or the shell does not have exactly two closed boundaries.
std::unique_ptr<Shape> sheet_solid(rust::Slice<const double> faces, rust::Slice<const uint32_t> lengths, double tolerance);

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
// BRepCheck_Analyzer validity.
bool is_valid_shape(const Shape &shape);
// Post-boolean ShapeUpgrade_UnifySameDomain (the shape itself when it fails).
std::unique_ptr<Shape> unified_shape(const Shape &shape);

}  // namespace llull
