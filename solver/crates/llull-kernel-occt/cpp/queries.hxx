// Query and exchange facade of the llull native kernel (RS-1): exact topology, the face-query port (01 §5.9), shape distance, STEP
// assembly export, STEP import + healing and B-rep blobs. Each function mirrors one packages/kernel-occt module (named at its
// definition) and answers JSON text ("null" = a null result), parsed once by Rust (src/queries.rs).
//
// Index rule (topology, faceQuery, fillet / chamfer edge selection): face / edge / vertex index k is the k-th distinct sub-shape in
// TopExp_Explorer order, distinct meaning TopoDS_Shape::IsSame (same TShape and location, any orientation), keeping the first
// occurrence and its orientation. That is exactly TopExp::MapShapes into a TopTools_IndexedMapOfShape (index k + 1), and exactly
// `uniqueSubShapes` of the retired opencascade.js kernel, the numbering the core commands rely on.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include <TopoDS_Compound.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

rust::String topology_json(const Shape &shape);

rust::String face_details_json(const Shape &shape, int32_t samples);
rust::String face_contains_json(const Shape &shape, int32_t face, rust::Slice<const double> point, double tolerance);
rust::String face_graph_json(const Shape &shape);
rust::String face_geometry_json(const Shape &shape, int32_t face);
rust::String project_on_face_json(const Shape &shape, int32_t face, rust::Slice<const double> points);
rust::String evaluate_face_json(const Shape &shape, int32_t face, rust::Slice<const double> uv);
rust::String face_samples_json(const Shape &shape, int32_t face, rust::Slice<const double> uv, int32_t nu, int32_t nv);
// Edge queries (cpp/edge_queries.cxx): `count` (2..1001) samples of one unique edge; "null" for a degenerate / boundary edge.
rust::String edge_samples_json(const Shape &shape, int32_t edge, int32_t count);
rust::String edge_continuity_json(const Shape &shape, int32_t edge, int32_t count);
// Blend face cross-sections (cpp/blend_sections.cxx): per uniform fraction of contact edge `edge_a` the radius of the circle through the contact points and the section mid point.
rust::String blend_sections_json(const Shape &shape, int32_t face, int32_t edge_a, int32_t edge_b, int32_t count);
// Failure report of a MakeFillet build (cpp/blends.cxx): `edges` ([] = all) and `laws` as for fillet_laws (one law then applies to every edge).
rust::String fillet_report_json(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws);
// Projection of curves onto faces (cpp/wrap.cxx): `curves` concatenated B-spline curves (degree, pole count, knot count, rational flag, xyz poles, weights, knots,
// multiplicities), `lengths` the f64 count of each; `mode` 0 along `direction`, 1 closest point within `max_distance`. JSON { curves: [{ source, face, t0, t1, curve, pcurve }], coverage }.
rust::String project_curves_json(const Shape &shape, rust::Slice<const uint32_t> faces, rust::Slice<const double> curves, rust::Slice<const uint32_t> lengths,
                                 int32_t mode, rust::Slice<const double> direction, double max_distance, double sample_step, double tolerance);
rust::String point_distances_json(const Shape &shape, rust::Slice<const double> points);
rust::String shape_distance_json(const Shape &a, const Shape &b);

// STEP assembly (occtStep.ts writeStepAssembly): parts are compounds, occurrences located references to them.
class StepAssembly {
 public:
  std::vector<TopoDS_Compound> parts;
  TopoDS_Compound root;
  bool root_made = false;
};

std::unique_ptr<StepAssembly> new_step_assembly();
int32_t assembly_part(StepAssembly &assembly);
void assembly_add_shape(StepAssembly &assembly, int32_t part, const Shape &shape);
// parent -1 = the root assembly.
void assembly_add_use(StepAssembly &assembly, int32_t parent, int32_t part, rust::Slice<const double> rotation,
                      rust::Slice<const double> position);
// "" when the STEP transfer is refused.
rust::String assembly_write(StepAssembly &assembly);

// B-rep blobs (occtImport.ts readBrepText) and STEP import + healing (occtImport.ts importStepShapes).
std::unique_ptr<Shape> read_brep(rust::Str text);
rust::String write_brep(const Shape &shape);
rust::String import_step_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew);
// The solids report of import_step_json for a shape any reader transferred (`roots` root entities, the file `content` for diagnostics);
// used by the STEP importer.
rust::String imported_shapes_json(const TopoDS_Shape &shape, int roots, const std::string &content, double precision, double max_tolerance,
                                  bool heal, bool sew);

}  // namespace llull
