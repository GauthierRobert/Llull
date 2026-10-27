// Narrow C++ facade over the vendored QuadriFlow (07 MSH M6): one call, an indexed triangle mesh in, an indexed quad mesh out.
#pragma once

#include <cstdint>

#include "rust/cxx.h"

namespace llull_quadflow {

struct QuadParams;
struct QuadMesh;

QuadMesh quad_remesh(rust::Slice<const double> positions, rust::Slice<const std::uint32_t> triangles, const QuadParams &params);

}  // namespace llull_quadflow
