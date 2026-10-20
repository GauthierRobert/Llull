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
// shared by the STEP and IGES importers.
rust::String imported_shapes_json(const TopoDS_Shape &shape, int roots, const std::string &content, double precision, double max_tolerance,
                                  bool heal, bool sew);
// IGES 5.3 import (IGESControl_Reader, read from a temporary file) with the same report as STEP.
rust::String import_iges_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew);

}  // namespace llull
