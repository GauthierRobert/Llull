// Drives the QuadriFlow pipeline exactly as its upstream main.cpp does (orientation field, scale, position field, index map), on an
// in-memory mesh. Single-threaded (no OpenMP / TBB) and seeded: the same input and parameters give the same quads.
#include <cmath>
#include <cstring>
#include <memory>

#include "config.hpp"
#include "optimizer.hpp"
#include "parametrizer.hpp"

#include "llull-quadflow/cpp/facade.hxx"
#include "llull-quadflow/src/lib.rs.h"

namespace llull_quadflow {

// Share of the whole run done when each stage starts (wall-clock shares measured on a 328k-triangle sphere asked for 40 000 quads, 110 s: max_flow 61 %, the tail after fix_valence 19 %; TECHNICAL_SPEC 13.8); the sink also gets every name, in order.
struct StageWeight {
  const char *name;
  double start;
};
constexpr StageWeight kStages[] = {
    {"prepare", 0.00},             {"orientation_field", 0.02}, {"scale", 0.045},       {"position_field", 0.047},
    {"integer_constraints", 0.14}, {"max_flow", 0.15},          {"fix_flips", 0.76},    {"final_positions", 0.77},
    {"extract_quads", 0.80},       {"fix_valence", 0.81},
};

static void announce(StageSink &sink, const char *name) {
  for (const auto &stage : kStages)
    if (std::strcmp(stage.name, name) == 0) {
      sink.report(rust::Str(name), stage.start);
      return;
    }
}

QuadMesh quad_remesh(rust::Slice<const double> positions, rust::Slice<const std::uint32_t> triangles, const QuadParams &params, StageSink &sink) {
  using namespace Eigen;
  auto field = std::make_unique<qflow::Parametrizer>();
  field->stage_hook = [&sink](const char *name) { announce(sink, name); };
  announce(sink, "prepare");
  const std::size_t vertex_count = positions.size() / 3, triangle_count = triangles.size() / 3;
  field->V.resize(3, vertex_count);
  for (std::size_t i = 0; i < vertex_count; ++i) field->V.col(i) = Vector3d(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
  field->F.resize(3, triangle_count);
  for (std::size_t i = 0; i < triangle_count; ++i)
    field->F.col(i) = Vector3i(static_cast<int>(triangles[3 * i]), static_cast<int>(triangles[3 * i + 1]), static_cast<int>(triangles[3 * i + 2]));
  field->NormalizeMesh();
  field->flag_preserve_sharp = params.preserve_sharp ? 1 : 0;
  field->sharp_cos_threshold = params.sharp_cos;
  field->flag_adaptive_scale = params.adaptive ? 1 : 0;
  field->flag_preserve_boundary = params.preserve_boundary ? 1 : 0;

  field->Initialize(params.target_faces);
  announce(sink, "orientation_field");
  qflow::Optimizer::optimize_orientations(field->hierarchy);
  field->ComputeOrientationSingularities();
  announce(sink, "scale");
  if (field->flag_adaptive_scale == 1) field->EstimateSlope();
  qflow::Optimizer::optimize_scale(field->hierarchy, field->rho, field->flag_adaptive_scale);
  field->flag_adaptive_scale = 1;
  announce(sink, "position_field");
  qflow::Optimizer::optimize_positions(field->hierarchy, field->flag_adaptive_scale);
  field->ComputePositionSingularities();
  field->ComputeIndexMap();

  QuadMesh mesh;
  mesh.positions.reserve(field->O_compact.size() * 3);
  for (const auto &vertex : field->O_compact) {
    Vector3d world = vertex * field->normalize_scale + field->normalize_offset;
    for (int k = 0; k < 3; ++k) mesh.positions.push_back(world[k]);
  }
  mesh.quads.reserve(field->F_compact.size() * 4);
  for (const auto &quad : field->F_compact)
    for (int k = 0; k < 4; ++k) mesh.quads.push_back(static_cast<std::uint32_t>(quad[k]));
  return mesh;
}

}  // namespace llull_quadflow
