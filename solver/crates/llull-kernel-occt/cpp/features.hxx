// Feature operations of the llull native kernel (RS-1, second slice): fillet, chamfer, blend, shell, exact curve faces, prism /
// revolution of a face, loft, sweep, B-spline subdivision patches and the BRepFeat hole / pocket makers. Each mirrors the
// opencascade.js builder of packages/kernel-occt (same OCCT algorithm, same parameters) so both kernels build the same B-rep.
// Shares `Shape` and the exception-to-Err trycatch with facade.hxx.
#pragma once

#include <memory>
#include <vector>

#include <TopoDS_Shape.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

// Ordered shape list for multi-operand operations (blend).
class ShapeList {
 public:
  std::vector<TopoDS_Shape> shapes;
};

std::unique_ptr<ShapeList> new_shape_list();
void shape_list_add(ShapeList &list, const Shape &shape);

// Edge rounding: `edges` index the unique edges in explorer order ([] = all); `radius_end` NaN = constant radius.
std::unique_ptr<Shape> fillet_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double radius, double radius_end);
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
bool chain_wire_ok(rust::Slice<const double> chain);
// Bicubic patches, 16 poles each (u along i, v along j), sewn at `tolerance`; null (never a throw) when OCC refuses one.
std::unique_ptr<Shape> bspline_patch_solid(rust::Slice<const double> poles, double tolerance);

// BRepFeat_MakeRevol cut of the closed polygon `profile` (xyz triples) revolved 2 pi about (origin, normal).
std::unique_ptr<Shape> feature_revol_cut(const Shape &source, rust::Slice<const double> profile, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal);
// BRepFeat_MakePrism cut of the face of `chain` from the planar face of `source` on the frame plane that holds a probe point.
std::unique_ptr<Shape> feature_prism_cut(const Shape &source, rust::Slice<const double> chain, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal, rust::Slice<const double> probes, double length);
// BRepCheck_Analyzer validity.
bool is_valid_shape(const Shape &shape);
// Post-boolean ShapeUpgrade_UnifySameDomain (the shape itself when it fails).
std::unique_ptr<Shape> unified_shape(const Shape &shape);

}  // namespace llull
