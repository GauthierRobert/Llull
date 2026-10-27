// Drives the QuadriFlow pipeline exactly as its upstream main.cpp does (orientation field, scale, position field, index map), on an
// in-memory mesh. Single-threaded (no OpenMP / TBB) and seeded: the same input and parameters give the same quads.
#include <cmath>
#include <memory>

#include "config.hpp"
#include "optimizer.hpp"
#include "parametrizer.hpp"

#include "llull-quadflow/cpp/facade.hxx"
#include "llull-quadflow/src/lib.rs.h"

namespace llull_quadflow {

QuadMesh quad_remesh(rust::Slice<const double> positions, rust::Slice<const std::uint32_t> triangles, const QuadParams &params) {
  using namespace Eigen;
  auto field = std::make_unique<qflow::Parametrizer>();
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

  field->Initialize(params.target_faces);
  qflow::Optimizer::optimize_orientations(field->hierarchy);
  field->ComputeOrientationSingularities();
  if (field->flag_adaptive_scale == 1) field->EstimateSlope();
  qflow::Optimizer::optimize_scale(field->hierarchy, field->rho, field->flag_adaptive_scale);
  field->flag_adaptive_scale = 1;
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
